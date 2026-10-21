import { GAME_CONFIG } from "./constants.js";
import { calculateEffectiveBid, resolveLotAuction } from "./auction.js";
import { drawCardForPlayer, drawLots, RuleError } from "./game.js";
import { CARD_SOURCE } from "./cards.js";
import type { CardResponse, Declaration, FinalAction, FormalContractCondition, GameEvent, GamePlayerState, GameState, Wager, WagerPredicate } from "./types.js";

function event(state: GameState, type: string, visibility: GameEvent["visibility"], payload: Record<string, unknown>, ownerPlayerId?: string): GameEvent {
  const sequence = state.events.length + 1;
  return {
    id: `${state.gameId}:${sequence}`,
    sequence,
    roundIndex: state.roundIndex,
    type,
    visibility,
    payload,
    ...(ownerPlayerId ? { ownerPlayerId } : {}),
  };
}

function update(state: GameState, values: Partial<GameState>, newEvents: GameEvent[] = []): GameState {
  return { ...state, ...values, stateVersion: state.stateVersion + 1, events: [...state.events, ...newEvents] };
}

function requirePlayer(state: GameState, playerId: string): GamePlayerState {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) throw new RuleError("PLAYER_NOT_FOUND", "This player is not seated in the game");
  return player;
}

function validateTarget(state: GameState, playerId: string, targetPlayerId?: string): void {
  if (!targetPlayerId) return;
  if (targetPlayerId === playerId) throw new RuleError("SELF_TARGET", "You cannot target yourself");
  if (!state.players.some((player) => player.id === targetPlayerId)) throw new RuleError("INVALID_TARGET", "Choose a player in this room");
}

function maybeAdvance(state: GameState, phase: GameState["phase"], ready: (player: GamePlayerState) => boolean): GameState {
  if (!state.players.every(ready)) return state;
  return { ...state, phase, phaseDeadlineAt: undefined };
}

export function submitDeclaration(
  state: GameState,
  playerId: string,
  declaration: Declaration,
  cardId?: number,
  cardParameters: Record<string, string | number | boolean> = {},
): GameState {
  if (state.phase !== "declaration") throw new RuleError("WRONG_PHASE", "Declarations are closed");
  const player = requirePlayer(state, playerId);
  if (player.declaration) throw new RuleError("ALREADY_LOCKED", "Your declaration is already locked");
  if (declaration.targetLotId && !state.lots.some((lot) => lot.id === declaration.targetLotId)) {
    throw new RuleError("INVALID_LOT", "Choose a lot currently open this round");
  }
  if (declaration.alternateLotId && !state.lots.some((lot) => lot.id === declaration.alternateLotId)) {
    throw new RuleError("INVALID_LOT", "Choose an alternate lot currently open this round");
  }
  if (declaration.alternateLotId === declaration.targetLotId && declaration.alternateLotId) {
    throw new RuleError("DUPLICATE_LOT", "Choose two different lots");
  }
  validateTarget(state, playerId, declaration.stance?.targetPlayerId);
  if (player.forcedAnnouncement && !declaration.targetLotId) {
    throw new RuleError("FORCED_ANNOUNCEMENT", "Your suspicion requires an early lot announcement");
  }
  if (cardId !== undefined && !player.hand.includes(cardId)) throw new RuleError("CARD_NOT_IN_HAND", "That card is not in your hand");
  if (cardId !== 23 && declaration.hiddenField !== undefined) {
    throw new RuleError("INVALID_DECLARATION", "Only card 23 can hide a declaration field");
  }
  if (cardId === 23 && (!declaration.hiddenField || declaration[declaration.hiddenField] === undefined)) {
    throw new RuleError("INVALID_DECLARATION", "Card 23 must select one declaration field to hide");
  }
  const declarationCardParameters: Record<number, string[]> = {
    17: ["targetLotId"], 27: ["direction"], 28: ["firstNextLotId"], 37: ["targetLotId"],
    57: ["targetLotId"], 60: ["lastPageChoice"],
  };
  if (cardId !== undefined && !CARD_SOURCE.some((card) => card.id === cardId)) {
    throw new RuleError("INVALID_CARD", "البطاقة دي مش موجودة في اللعبة");
  }
  if (cardId === undefined && Object.keys(cardParameters).length > 0) {
    throw new RuleError("INVALID_CARD_PARAMETERS", "اختار البطاقة الأول");
  }
  const allowedParameters = declarationCardParameters[cardId ?? 0] ?? [];
  if (Object.keys(cardParameters).some((key) => !allowedParameters.includes(key))) {
    throw new RuleError("INVALID_CARD_PARAMETERS", "اختيارات البطاقة دي مش مفهومة");
  }
  for (const key of ["targetLotId", "firstNextLotId"]) {
    const selected = cardParameters[key];
    if (selected !== undefined && (typeof selected !== "string" || (key === "targetLotId" && !state.lots.some((lot) => lot.id === selected)))) {
      throw new RuleError("INVALID_LOT", "اختار قطعة مفتوحة وصالحة للكارت");
    }
  }
  if (cardId !== undefined && [17, 37, 57].includes(cardId) && typeof cardParameters.targetLotId !== "string") {
    throw new RuleError("INVALID_CARD_PARAMETERS", "الكارت ده محتاج تختار قطعة");
  }
  if (cardId === 27 && cardParameters.direction !== "up" && cardParameters.direction !== "down") {
    throw new RuleError("INVALID_CARD_PARAMETERS", "اختار تزود العرض ولا تقلله");
  }
  const nextTwoLots = state.lotDeck.slice(state.lotDeckCursor, state.lotDeckCursor + 2);
  if (cardId === 28 && nextTwoLots.length === 2 && (typeof cardParameters.firstNextLotId !== "string" || !nextTwoLots.includes(cardParameters.firstNextLotId))) {
    throw new RuleError("INVALID_CARD_PARAMETERS", "اختار ترتيب أول قطعتين للجولة الجاية");
  }
  if (cardId === 60 && cardParameters.lastPageChoice !== "bid" && cardParameters.lastPageChoice !== "suspicion") {
    throw new RuleError("INVALID_CARD_PARAMETERS", "اختار تأثير الصفحة الأخيرة");
  }
  if (cardId === 16 || cardId === 19) {
    if (!declaration.targetLotId || !declaration.alternateLotId) {
      throw new RuleError("INVALID_DECLARATION", `البطاقة ${cardId} محتاجة إعلان قطعتين مختلفتين`);
    }
  }
  if (cardId === 29 && !declaration.illusionStance) {
    throw new RuleError("INVALID_DECLARATION", "اختار العلامة اللي هتعلنها مع كارت السراب");
  }
  if (cardId !== 29 && declaration.illusionStance !== undefined) {
    throw new RuleError("INVALID_DECLARATION", "العلامة الوهمية خاصة بكارت السراب");
  }

  const players = state.players.map((item) => item.id === playerId
    ? {
      ...item,
      declaration: structuredClone(declaration),
      originalDeclaration: structuredClone(declaration),
      declarationChange: undefined,
      lockedCardId: cardId,
      cardParameters: structuredClone(cardParameters),
    }
    : item);
  let next = update(state, { players });
  next = maybeAdvance(next, "wager-commit", (item) => Boolean(item.declaration));
  if (next.phase === "wager-commit") {
    next = {
      ...next,
      events: [...next.events, event(next, "declarations-revealed", "public", {
        declarations: next.players.map((item) => ({
          playerId: item.id,
          declaration: declarationForPublic(item),
          ...(item.lockedCardId === 23 ? { oneFieldHidden: true } : {}),
        })),
      })],
    };
  }
  return next;
}

function validatePredicate(predicate: WagerPredicate): void {
  switch (predicate.kind) {
    case "final-lot":
      if (!predicate.lotId) throw new RuleError("INVALID_PREDICATE", "Choose a lot");
      return;
    case "base-bid-at-least":
      if (!Number.isInteger(predicate.amount) || predicate.amount < 1 || predicate.amount > GAME_CONFIG.baseBidMaximum) {
        throw new RuleError("INVALID_PREDICATE", "Bid prediction must be between 1 and 3");
      }
      return;
    case "final-stance":
      return;
    case "lot-differs-from-declaration":
      return;
  }
}

function declarationForPublic(player: GamePlayerState): Declaration {
  const declaration = player.declaration ?? {};
  if (player.lockedCardId === 18) return {};
  if (player.lockedCardId !== 23 || !declaration.hiddenField) {
    const { hiddenField: _privateField, ...visible } = declaration;
    return visible;
  }
  const { [declaration.hiddenField]: _hidden, hiddenField: _privateField, ...visible } = declaration;
  return visible;
}

function publicDeclarationAfterWagers(player: GamePlayerState): Declaration {
  const declaration = { ...(player.declaration ?? {}) };
  const hiddenField = declaration.hiddenField;
  delete declaration.hiddenField;
  if (player.lockedCardId === 23 && hiddenField) delete declaration[hiddenField];
  return declaration;
}

export function submitWagers(state: GameState, playerId: string, wagers: readonly Omit<Wager, "locked" | "referenceDeclaration">[]): GameState {
  if (state.phase !== "wager-commit") throw new RuleError("WRONG_PHASE", "Wagers are not being accepted");
  const player = requirePlayer(state, playerId);
  if (player.wagersLocked) throw new RuleError("ALREADY_LOCKED", "Your wagers are already locked");
  if (wagers.length > 2) throw new RuleError("TOO_MANY_WAGERS", "A player may lock at most two wagers");
  let secondCount = 0;
  let freeCount = 0;
  for (const wager of wagers) {
    if (wager.targetPlayerId === playerId) throw new RuleError("SELF_WAGER", "You cannot wager on your own action");
    if (!state.players.some((target) => target.id === wager.targetPlayerId)) throw new RuleError("INVALID_TARGET", "Choose another player in this game");
    validatePredicate(wager.predicate);
    if (wager.secondWager) secondCount += 1;
    else freeCount += 1;
    if (wager.type === "influence" && !player.lockedCardId) {
      throw new RuleError("INFLUENCE_WAGER_REQUIRES_EFFECT", "An influence wager requires your locked card or an accepted contract");
    }
  }
  if (secondCount > 1 || freeCount > 1) throw new RuleError("TOO_MANY_WAGERS", "Choose at most one free wager and one optional second wager");
  if (secondCount > 0 && freeCount === 0) throw new RuleError("SECOND_WAGER_REQUIRES_FIRST", "The optional second wager requires a free wager in the same submission");
  const cost = secondCount * GAME_CONFIG.optionalSecondWagerCost;
  if (cost > player.influence) throw new RuleError("INSUFFICIENT_INFLUENCE", "You cannot afford a second wager");
  const saved: Wager[] = wagers.map((wager) => ({
    ...structuredClone(wager),
    locked: true,
    ...(wager.predicate.kind === "lot-differs-from-declaration"
      ? (() => {
          const target = state.players.find((item) => item.id === wager.targetPlayerId);
          const hiddenLot = target?.lockedCardId === 18
            || (target?.lockedCardId === 23 && target.declaration?.hiddenField === "targetLotId");
          return { referenceDeclaration: hiddenLot ? {} : structuredClone(target?.declaration ?? {}) };
        })()
      : {}),
  }));
  const players = state.players.map((item) => item.id === playerId
    ? { ...item, wagers: saved, wagersLocked: true, influence: item.influence - cost }
    : item);
  let next = maybeAdvance(update(state, { players }), "negotiation", (item) => item.wagersLocked);
  if (next.phase === "negotiation") {
    next = {
      ...next,
      events: [...next.events, event(next, "masked-announcements-revealed", "public", {
        declarations: next.players.filter((item) => item.lockedCardId === 18).map((item) => ({
          playerId: item.id,
          declaration: item.declaration ?? {},
        })),
      })],
    };
  }
  return next;
}

export function finishNegotiation(
  state: GameState,
  playerId: string,
  cardParameters: Record<string, string | number | boolean> = {},
): GameState {
  if (state.phase !== "negotiation") throw new RuleError("WRONG_PHASE", "Negotiation is not active");
  const player = requirePlayer(state, playerId);
  if (player.ready) throw new RuleError("ALREADY_READY", "You already finished negotiating");
  const targetPlayerId = cardParameters.targetPlayerId;
  if ([2, 7, 8, 12, 20, 21, 25, 26, 31, 33, 34, 36, 38, 39, 41, 42, 44, 45, 46, 59].includes(player.lockedCardId ?? 0)) {
    if (targetPlayerId !== undefined) {
      if (typeof targetPlayerId !== "string") throw new RuleError("INVALID_CARD_TARGET", "Choose a player for this card");
      if (!(player.lockedCardId === 46 && targetPlayerId === playerId)) validateTarget(state, playerId, targetPlayerId);
    }
    if (Object.keys(cardParameters).some((key) => key !== "targetPlayerId")) throw new RuleError("INVALID_CARD_PARAMETERS", "This card accepts only a player target");
  } else if (Object.keys(cardParameters).length > 0) {
    throw new RuleError("INVALID_CARD_PARAMETERS", "This card does not accept negotiation parameters");
  }
  const players = state.players.map((item) => item.id === playerId
    ? { ...item, ready: true, cardParameters: { ...item.cardParameters, ...structuredClone(cardParameters) } }
    : item);
  const next = update(state, { players });
  return maybeAdvance(next, "final-action", (item) => item.ready);
}

export function offerFormalContract(
  state: GameState,
  proposerPlayerId: string,
  targetPlayerId: string,
  condition: FormalContractCondition,
): GameState {
  if (state.phase !== "negotiation") throw new RuleError("WRONG_PHASE", "العقد بيتعرض وقت التفاوض بس");
  const proposer = requirePlayer(state, proposerPlayerId);
  const target = requirePlayer(state, targetPlayerId);
  if (proposer.lockedCardId !== 2) throw new RuleError("CARD_NOT_LOCKED", "محتاج تلعب كارت العقد الأول");
  if (proposer.ready || target.id === proposer.id) throw new RuleError("INVALID_CONTRACT", "اختار لاعب تاني ولسه ما قفلش تفاوضه");
  if (state.formalContract?.status === "pending" || state.formalContract?.status === "accepted") {
    throw new RuleError("CONTRACT_EXISTS", "في عقد تاني مفتوح في المجلس");
  }
  if (condition.kind === "no-bid") {
    if (![proposer.id, target.id].includes(condition.playerId) || !state.lots.some((lot) => lot.id === condition.lotId)) {
      throw new RuleError("INVALID_CONTRACT", "شرط العقد لازم يخص واحد من الطرفين وقطعة مفتوحة");
    }
  } else if (condition.kind === "transfer") {
    if (![proposer.id, target.id].includes(condition.fromPlayerId) || ![proposer.id, target.id].includes(condition.toPlayerId)
      || condition.fromPlayerId === condition.toPlayerId || !Number.isInteger(condition.amount) || condition.amount < 1 || condition.amount > 3) {
      throw new RuleError("INVALID_CONTRACT", "تفاصيل تحويل النفوذ في العقد مش صالحة");
    }
  }
  const formalContract = { proposerPlayerId, targetPlayerId, condition: structuredClone(condition), status: "pending" as const };
  const players = state.players.map((item) => item.id === proposer.id
    ? { ...item, cardParameters: { ...item.cardParameters, targetPlayerId } }
    : item);
  const next = update(state, { formalContract, players });
  return { ...next, events: [...next.events, event(next, "contract-offered", "public", { formalContract })] };
}

export function respondFormalContract(state: GameState, playerId: string, accept: boolean): GameState {
  if (state.phase !== "negotiation") throw new RuleError("WRONG_PHASE", "وقت قبول العقود خلص");
  const contract = state.formalContract;
  if (!contract || contract.status !== "pending" || contract.targetPlayerId !== playerId) {
    throw new RuleError("NO_CONTRACT_OFFER", "مفيش عرض عقد مستني ردك");
  }
  if (!accept) {
    const formalContract = { ...contract, status: "declined" as const };
    const next = update(state, { formalContract });
    return { ...next, events: [...next.events, event(next, "contract-declined", "public", { formalContract })] };
  }
  const proposer = requirePlayer(state, contract.proposerPlayerId);
  const target = requirePlayer(state, contract.targetPlayerId);
  if (proposer.influence < 1 || target.influence < 1) throw new RuleError("INSUFFICIENT_INFLUENCE", "كل طرف محتاج نقطة نفوذ يحطها أمان");
  const players = state.players.map((item) => item.id === proposer.id || item.id === target.id
    ? { ...item, influence: item.influence - 1 }
    : item);
  const formalContract = { ...contract, status: "accepted" as const };
  const next = update(state, { formalContract, players });
  return { ...next, events: [...next.events, event(next, "contract-accepted", "public", { formalContract, escrowEach: 1 })] };
}

export function endNegotiation(state: GameState): GameState {
  if (state.phase !== "negotiation") throw new RuleError("WRONG_PHASE", "Negotiation is not active");
  return update(state, {
    phase: "final-action",
    phaseDeadlineAt: undefined,
    players: state.players.map((player) => ({ ...player, ready: false })),
  });
}

export function renegotiateDeclaration(state: GameState, playerId: string, targetLotId: string): GameState {
  if (state.phase !== "negotiation" && state.phase !== "final-action") {
    throw new RuleError("WRONG_PHASE", "The declaration can only change before final action lock");
  }
  const player = requirePlayer(state, playerId);
  if (player.lockedCardId !== 11) throw new RuleError("CARD_NOT_LOCKED", "Card 11 must be locked to change a declaration");
  if (player.declarationChange) throw new RuleError("ALREADY_USED", "Card 11 has already changed this declaration");
  if ((state.phase === "negotiation" && player.ready) || (state.phase === "final-action" && player.action)) {
    throw new RuleError("ALREADY_LOCKED", "Your next action is already locked");
  }
  const originalLotId = player.declaration?.targetLotId;
  if (!originalLotId) throw new RuleError("INVALID_DECLARATION", "Card 11 requires an announced lot");
  if (!state.lots.some((lot) => lot.id === targetLotId)) throw new RuleError("INVALID_LOT", "Choose an open lot");
  if (targetLotId === player.declaration?.targetLotId) throw new RuleError("SAME_LOT", "Choose a different lot");
  if (player.influence < 1) throw new RuleError("INSUFFICIENT_INFLUENCE", "Card 11 costs 1 influence");

  const players = state.players.map((item) => item.id === playerId
    ? {
      ...item,
      influence: item.influence - 1,
      declaration: { ...item.declaration!, targetLotId },
      declarationChange: { fromLotId: originalLotId, toLotId: targetLotId },
    }
    : item);
  const next = update(state, { players });
  return {
    ...next,
    events: [...next.events, event(next, "declaration-renegotiated", "public", {
      playerId,
      cardId: 11,
      fromLotId: originalLotId,
      toLotId: targetLotId,
      influenceCost: 1,
    })],
  };
}

export function submitFinalAction(state: GameState, playerId: string, action: Omit<FinalAction, "locked">): GameState {
  if (state.phase !== "final-action") throw new RuleError("WRONG_PHASE", "Final actions are not being accepted");
  const player = requirePlayer(state, playerId);
  if (player.action) throw new RuleError("ALREADY_LOCKED", "Your final action is already locked");
  if (!Number.isInteger(action.baseBid) || action.baseBid < GAME_CONFIG.baseBidMinimum || action.baseBid > GAME_CONFIG.baseBidMaximum) {
    throw new RuleError("INVALID_BID", "Base bid must be between 0 and 3");
  }
  if (action.baseBid > player.influence) throw new RuleError("INSUFFICIENT_INFLUENCE", "Your base bid exceeds available influence");
  if (action.lotId && !state.lots.some((lot) => lot.id === action.lotId)) throw new RuleError("INVALID_LOT", "Choose an open lot");
  if (!action.lotId && action.baseBid !== 0) throw new RuleError("PASS_WITH_BID", "Passing means no lot and no bid");
  validateTarget(state, playerId, action.stance.targetPlayerId);
  if (action.cardId !== undefined && action.cardId !== player.lockedCardId) {
    throw new RuleError("CARD_NOT_LOCKED", "Only the card locked at declaration may be played");
  }
  if (player.lockedCardId === 3 && action.lotId && player.influence < action.baseBid + 1) {
    throw new RuleError("INSUFFICIENT_INFLUENCE", "Card 3 needs one influence in addition to the base bid");
  }
  if (player.lockedCardId === 27 && action.lotId && player.influence < action.baseBid + 1) {
    throw new RuleError("INSUFFICIENT_INFLUENCE", "كارت التصحيح محتاج نقطة نفوذ زيادة عن عرضك");
  }
  const finalAction: FinalAction = {
    ...structuredClone(action),
    ...(player.lockedCardId === undefined ? {} : { cardId: player.lockedCardId }),
    locked: true,
  };
  const players = state.players.map((item) => item.id === playerId ? { ...item, action: finalAction } : item);
  let next = update(state, { players });
  next = maybeAdvance(next, "resolution", (item) => Boolean(item.action));
  if (next.phase === "resolution") {
    const spotlight = next.players.find((item) => item.lockedCardId === 38 && typeof item.cardParameters.targetPlayerId === "string");
    const spotlightTarget = spotlight?.cardParameters.targetPlayerId;
    next = {
      ...next,
      events: [...next.events, event(next, "actions-revealed", "public", {
        actions: next.players.map((item) => {
          if (!spotlightTarget || item.id === spotlightTarget || !item.action) return { playerId: item.id, action: item.action };
          const { stance: _hiddenStance, ...visibleAction } = item.action;
          return { playerId: item.id, action: visibleAction };
        }),
      }), ...(spotlightTarget ? [event(next, "stance-revealed-early", "public", {
        sourcePlayerId: spotlight!.id,
        targetPlayerId: spotlightTarget,
        stance: next.players.find((item) => item.id === spotlightTarget)?.action?.stance,
      })] : [])],
    };
  }
  return next;
}

function waxCancelledSources(state: GameState): Set<string> {
  const shields = new Set(state.players.filter((player) => player.lockedCardId === 46 && typeof player.cardParameters.targetPlayerId === "string")
    .map((player) => player.cardParameters.targetPlayerId as string));
  const consumed = new Set<string>();
  const canceled = new Set<string>();
  const leaders = Math.max(0, ...state.players.map((player) => player.seals));
  for (const owner of state.players) {
    const targetId = owner.cardParameters.targetPlayerId;
    if (typeof targetId !== "string" || !shields.has(targetId) || consumed.has(targetId)) continue;
    const target = state.players.find((player) => player.id === targetId);
    if (!target) continue;
    const availableHand = target.hand.some((cardId) => cardId !== target.lockedCardId);
    let eligible = owner.lockedCardId === 33 && availableHand;
    if ([39, 42].includes(owner.lockedCardId ?? 0)) eligible = availableHand || target.influence > 0;
    if (owner.lockedCardId === 34) eligible = Boolean(target.action);
    if (owner.lockedCardId === 36) eligible = target.suspicion >= 1 && target.suspicion < GAME_CONFIG.maximumSuspicion;
    if (owner.lockedCardId === 41) eligible = target.seals === leaders;
    if (owner.lockedCardId === 44) eligible = target.seals > owner.seals;
    if (owner.lockedCardId === 45 && target.action?.lotId) {
      const bids = state.players.filter((player) => player.action?.lotId === target.action?.lotId).map((player) => player.action?.baseBid ?? 0);
      eligible = target.action.baseBid >= Math.max(0, ...bids)
        && (target.influence > 0 || target.suspicion < GAME_CONFIG.maximumSuspicion);
    }
    const announcedLotId = target.declaration?.targetLotId;
    const changedLot = Boolean(announcedLotId && target.action?.lotId !== announcedLotId);
    if (owner.lockedCardId === 21) eligible = Boolean(announcedLotId && !changedLot && target.suspicion < GAME_CONFIG.maximumSuspicion && !(target.lockedCardId === 23 && target.declaration?.hiddenField === "targetLotId"));
    if (owner.lockedCardId === 31) eligible = Boolean(announcedLotId && changedLot && target.suspicion < GAME_CONFIG.maximumSuspicion && !(target.lockedCardId === 23 && target.declaration?.hiddenField === "targetLotId"));
    if (owner.lockedCardId === 26) eligible = owner.suspicion > 0 && target.suspicion < GAME_CONFIG.maximumSuspicion;
    if (!eligible) continue;
    canceled.add(owner.id);
    consumed.add(targetId);
  }
  return canceled;
}

function canReflectEffect(state: GameState, owner: GamePlayerState, target: GamePlayerState): boolean {
  const effectId = owner.lockedCardId;
  return effectId === 33 && target.hand.some((cardId) => cardId !== target.lockedCardId)
    || effectId === 34 && Boolean(target.action)
    || effectId === 36 && target.suspicion >= 1 && target.suspicion < GAME_CONFIG.maximumSuspicion
    || effectId === 21 && target.suspicion < GAME_CONFIG.maximumSuspicion && Boolean(target.declaration?.targetLotId) && target.action?.lotId === target.declaration?.targetLotId
    || effectId === 26 && owner.suspicion > 0 && target.suspicion > 0 && target.suspicion < GAME_CONFIG.maximumSuspicion
    || effectId === 31 && target.suspicion < GAME_CONFIG.maximumSuspicion && Boolean(target.declaration?.targetLotId) && target.action?.lotId !== target.declaration?.targetLotId
    || effectId === 39 || effectId === 42
    || effectId === 41 && target.seals === Math.max(0, ...state.players.map((player) => player.seals))
    || effectId === 45 && Boolean(target.action?.lotId)
      && target.action!.baseBid >= Math.max(0, ...state.players.filter((player) => player.action?.lotId === target.action?.lotId).map((player) => player.action?.baseBid ?? 0))
      && (target.influence > 0 || target.suspicion < GAME_CONFIG.maximumSuspicion);
}

export function openCardResponseWindow(state: GameState): GameState {
  if (state.phase !== "resolution") return state;
  const prompts: CardResponse[] = [];
  const waxCanceled = waxCancelledSources(state);
  const reflectionSourceByTarget = new Map<string, GamePlayerState>();
  for (const owner of state.players) {
    const targetId = owner.cardParameters.targetPlayerId;
    if (typeof targetId !== "string" || waxCanceled.has(owner.id)) continue;
    const target = state.players.find((player) => player.id === targetId);
    if (target?.lockedCardId === 52 && !reflectionSourceByTarget.has(target.id) && canReflectEffect(state, owner, target)) {
      reflectionSourceByTarget.set(target.id, owner);
    }
  }
  for (const owner of state.players) {
    if (![33, 39, 42, 45].includes(owner.lockedCardId ?? 0)) continue;
    const targetPlayerId = owner.cardParameters.targetPlayerId;
    if (waxCanceled.has(owner.id)) continue;
    const target = typeof targetPlayerId === "string" ? state.players.find((item) => item.id === targetPlayerId) : undefined;
    if (!target || target.id === owner.id) continue;
    if (owner.lockedCardId === 45 && !target.action?.lotId) continue;
    if (owner.lockedCardId === 45 && target.action?.lotId) {
      const bids = state.players.filter((item) => item.action?.lotId === target.action?.lotId).map((item) => item.action?.baseBid ?? 0);
      if ((target.action.baseBid ?? 0) < Math.max(0, ...bids)) continue;
      if (target.influence < 1 && target.suspicion >= GAME_CONFIG.maximumSuspicion) continue;
    }
    if (reflectionSourceByTarget.get(target.id)?.id === owner.id) continue;
    prompts.push({ sourcePlayerId: owner.id, targetPlayerId: target.id, cardId: owner.lockedCardId as 33 | 39 | 42 | 45, resolved: false });
  }
  for (const [targetPlayerId, owner] of reflectionSourceByTarget) {
    prompts.push({ sourcePlayerId: owner.id, targetPlayerId, cardId: 52, effectCardId: owner.lockedCardId!, resolved: false });
  }
  for (const owner of state.players) {
    const targetId = owner.cardParameters.targetPlayerId;
    if (typeof targetId !== "string" || waxCanceled.has(owner.id)) continue;
    const target = state.players.find((player) => player.id === targetId);
    if (!target || !canReflectEffect(state, owner, target)) continue;
    if (target.lockedCardId === 58 && [34, 36].includes(owner.lockedCardId ?? 0)) {
      prompts.push({ sourcePlayerId: owner.id, targetPlayerId: target.id, cardId: 58, effectCardId: owner.lockedCardId!, resolved: false });
    }
  }
  if (prompts.length === 0) return state;
  return { ...state, phase: "card-response", cardResponses: prompts, phaseDeadlineAt: undefined, stateVersion: state.stateVersion + 1 };
}

export function respondToCardEffect(
  state: GameState,
  playerId: string,
  sourcePlayerId: string,
  cardId: number,
  choice: "pay" | "reveal-card" | "reveal-category" | "suspicion" | "reflect" | "allow" | "defer" | "cancel",
  revealedCardId?: number,
): GameState {
  if (state.phase !== "card-response") throw new RuleError("WRONG_PHASE", "مفيش كارت مستني رد دلوقتي");
  const player = requirePlayer(state, playerId);
  const prompt = (state.cardResponses ?? []).find((item) => item.sourcePlayerId === sourcePlayerId && item.targetPlayerId === playerId && item.cardId === cardId && !item.resolved);
  if (!prompt) throw new RuleError("NO_CARD_PROMPT", "مفيش طلب الكارت ده عندك");
  const availableCards = player.hand.filter((heldCardId) => heldCardId !== player.lockedCardId);
  if (choice === "pay" && player.influence < 1) throw new RuleError("INSUFFICIENT_INFLUENCE", "معكش نفوذ كفاية للدفع");
  if (choice === "cancel" && player.influence - (player.action?.baseBid ?? 0) < 1) throw new RuleError("INSUFFICIENT_INFLUENCE", "محتاج نقطة نفوذ زيادة عن مزايدتك عشان تلغي التأثير");
  if (choice === "reveal-card" || choice === "reveal-category") {
    if (!Number.isInteger(revealedCardId) || !availableCards.includes(revealedCardId!)) throw new RuleError("INVALID_CARD_RESPONSE", "اختار كارت من إيدك لسه ما لعبتوش");
  }
  const allowed = prompt.cardId === 52 ? ["reflect", "allow"]
    : prompt.cardId === 58 ? ["defer", "allow", "cancel"]
      : prompt.cardId === 33 ? ["reveal-card"]
    : prompt.cardId === 39 ? ["pay", "reveal-card"]
      : prompt.cardId === 42 ? ["pay", "reveal-category"]
        : ["pay", "suspicion"];
  if (!allowed.includes(choice)) throw new RuleError("INVALID_CARD_RESPONSE", "الرد ده مش متاح على الكارت ده");
  const cardResponses = (state.cardResponses ?? []).map((item) => item === prompt
    ? { ...item, choice, ...(revealedCardId === undefined ? {} : { revealedCardId }), resolved: true }
    : item);
  const allResolved = cardResponses.every((item) => item.resolved);
  const followUps: CardResponse[] = [];
  if (allResolved) {
    for (const response of cardResponses.filter((item) => item.cardId === 52 && item.effectCardId !== undefined)) {
      if (![33, 39, 42, 45].includes(response.effectCardId ?? 0)) continue;
      const targetPlayerId = response.choice === "reflect" ? response.sourcePlayerId : response.targetPlayerId;
      if (cardResponses.some((item) => item.sourcePlayerId === response.sourcePlayerId && item.targetPlayerId === targetPlayerId && item.cardId === response.effectCardId)) continue;
      followUps.push({
        sourcePlayerId: response.sourcePlayerId,
        targetPlayerId,
        cardId: response.effectCardId as 33 | 39 | 42 | 45,
        ...(response.choice === "reflect" ? { effectCardId: 52 } : {}),
        resolved: false,
      });
    }
  }
  const hasFollowUps = followUps.length > 0;
  const next = {
    ...state,
    cardResponses: [...cardResponses, ...followUps],
    phase: allResolved && !hasFollowUps ? "resolution" as const : "card-response" as const,
    phaseDeadlineAt: allResolved && !hasFollowUps ? undefined : state.phaseDeadlineAt,
    stateVersion: state.stateVersion + 1,
  };
  return allResolved && !hasFollowUps ? { ...next, events: [...next.events, event(next, "card-responses-locked", "public", { cardResponses: next.cardResponses ?? [] })] } : next;
}

export function payToCancelPendingPressure(state: GameState, playerId: string, sourcePlayerId: string, sourceCardId: number): GameState {
  if (state.phase === "complete" || state.phase === "round-summary") throw new RuleError("WRONG_PHASE", "مفيش التزام مفتوح للدفع دلوقتي");
  const player = requirePlayer(state, playerId);
  if (player.influence < 1) throw new RuleError("INSUFFICIENT_INFLUENCE", "محتاج نقطة نفوذ عشان تلغي التأثير المؤجل");
  const pending = state.pendingPressureEffects ?? [];
  const index = pending.findIndex((effect) => effect.targetPlayerId === playerId && effect.sourcePlayerId === sourcePlayerId && effect.sourceCardId === sourceCardId);
  if (index < 0) throw new RuleError("NO_PENDING_EFFECT", "مفيش تأثير مؤجل مطابق لطلبك");
  const players = state.players.map((item) => item.id === playerId ? changeInfluence(item, -1) : item);
  const pendingPressureEffects = pending.filter((_, itemIndex) => itemIndex !== index);
  const next = update(state, { players, pendingPressureEffects });
  return { ...next, events: [...next.events, event(next, "pending-pressure-canceled", "public", { playerId, sourcePlayerId, sourceCardId, influenceCost: 1 })] };
}

function wagerMatches(predicate: WagerPredicate, target: GamePlayerState, wager: Wager): boolean | "void" {
  const action = target.action;
  if (!action) return false;
  switch (predicate.kind) {
    case "final-lot": return action.lotId === predicate.lotId;
    case "base-bid-at-least": return action.baseBid >= predicate.amount;
    case "final-stance": return action.stance.kind === predicate.stance
      && (predicate.targetPlayerId === undefined || action.stance.targetPlayerId === predicate.targetPlayerId);
    case "lot-differs-from-declaration": {
      const reference = wager.referenceDeclaration;
      if (!reference?.targetLotId) return "void";
      return action.lotId !== reference.targetLotId;
    }
  }
}

export interface RoundResolution {
  state: GameState;
  lots: GameState["lots"];
  publicSummary: Record<string, unknown>;
}

function changeInfluence(player: GamePlayerState, amount: number): GamePlayerState {
  return { ...player, influence: Math.max(0, Math.min(GAME_CONFIG.maximumInfluence, player.influence + amount)) };
}

function changeSuspicion(player: GamePlayerState, amount: number): GamePlayerState {
  return { ...player, suspicion: Math.max(0, Math.min(GAME_CONFIG.maximumSuspicion, player.suspicion + amount)) };
}

export function resolveRound(state: GameState): RoundResolution {
  if (state.phase !== "resolution") throw new RuleError("WRONG_PHASE", "The round is not ready to resolve");
  const cardEffects: Array<Record<string, unknown>> = [];
  const recordCard = (player: GamePlayerState, status: "applied" | "no-op", reason: string, change?: Record<string, unknown>) => {
    if (player.lockedCardId === undefined) return;
    cardEffects.push({ playerId: player.id, cardId: player.lockedCardId, status, reason, ...change });
  };
  const responseFor = (sourcePlayerId: string, cardId: number) => (state.cardResponses ?? []).find((item) => item.sourcePlayerId === sourcePlayerId && item.cardId === cardId);
  const waxCanceled = waxCancelledSources(state);
  const reflectedSources = new Set((state.cardResponses ?? []).filter((item) => item.cardId === 52 && item.choice === "reflect").map((item) => item.sourcePlayerId));
  const deferredSources = new Set((state.cardResponses ?? []).filter((item) => item.cardId === 58 && item.choice === "defer").map((item) => item.sourcePlayerId));
  const canceledPressureSources = new Set((state.cardResponses ?? []).filter((item) => item.cardId === 58 && item.choice === "cancel").map((item) => item.sourcePlayerId));
  const blockedPressureSources = new Set([...deferredSources, ...canceledPressureSources]);
  for (const player of state.players) {
    if (player.lockedCardId === 10) {
      const gain = Math.min(1, GAME_CONFIG.maximumInfluence - player.influence);
      recordCard(player, gain ? "applied" : "no-op", gain ? "advance-granted" : "already-at-influence-cap", { influence: gain });
    }
  }
  const trustBonuses = new Map<string, number>();
  for (const owner of state.players) {
    const stance = owner.action?.stance;
    if (stance?.kind !== "trust" || !stance.targetPlayerId || !owner.action?.lotId) continue;
    const target = state.players.find((item) => item.id === stance.targetPlayerId);
    if (target?.action?.lotId === owner.action.lotId) trustBonuses.set(target.id, (trustBonuses.get(target.id) ?? 0) + 1);
  }

  // Card 6 adds one point once when at least one real player trusts its owner
  // on the same lot; ordinary trust markers continue to stack independently.
  for (const player of state.players) {
    if (player.lockedCardId !== 6 || !player.action?.lotId) continue;
    const trusted = state.players.some((owner) => owner.id !== player.id
      && owner.action?.stance.kind === "trust"
      && owner.action.stance.targetPlayerId === player.id
      && owner.action.lotId === player.action?.lotId);
    if (trusted) {
      trustBonuses.set(player.id, (trustBonuses.get(player.id) ?? 0) + 1);
      recordCard(player, "applied", "trusted-on-same-lot", { bidBonus: 1 });
    } else {
      recordCard(player, "no-op", "no-trust-on-same-lot");
    }
  }

  const originalCrowdCounts = new Map(state.lots.map((lot) => [lot.id, state.players.filter((player) => player.action?.lotId === lot.id).length]));
  const phantomMarkerCounts = new Map(state.lots.map((lot) => [lot.id, state.players.filter((player) => player.lockedCardId === 17 && player.cardParameters.targetLotId === lot.id).length]));
  const originalEffectCrowdCounts = new Map(state.lots.map((lot) => [lot.id, (originalCrowdCounts.get(lot.id) ?? 0) + (phantomMarkerCounts.get(lot.id) ?? 0)]));
  const resolvedActions = new Map(state.players.map((player) => [player.id, player.action]));
  const movementPenalty = new Set<string>();
  const movementCost = new Set<string>();
  const movementResult = new Map<string, string>();
  const chooseLessCrowded = (fromLotId: string) => state.lots
    .filter((lot) => lot.id !== fromLotId && (originalEffectCrowdCounts.get(lot.id) ?? 0) < (originalEffectCrowdCounts.get(fromLotId) ?? 0))
    .sort((left, right) => (originalEffectCrowdCounts.get(left.id) ?? 0) - (originalEffectCrowdCounts.get(right.id) ?? 0)
      || state.lots.findIndex((lot) => lot.id === left.id) - state.lots.findIndex((lot) => lot.id === right.id))[0]?.id;
  for (const player of state.players) {
    const action = player.action;
    if (!action?.lotId) continue;
    let destination: string | undefined;
    if (player.lockedCardId === 19 && player.declaration?.alternateLotId) {
      const first = player.declaration.targetLotId;
      const second = player.declaration.alternateLotId;
      const firstCount = originalEffectCrowdCounts.get(first ?? "") ?? Infinity;
      const secondCount = originalEffectCrowdCounts.get(second) ?? Infinity;
      destination = firstCount < secondCount ? first : secondCount < firstCount ? second : undefined;
      if (destination) movementPenalty.add(player.id);
    } else if (player.lockedCardId === 24 && (originalCrowdCounts.get(action.lotId) ?? 0) >= 3) {
      destination = chooseLessCrowded(action.lotId);
      if (destination) {
        const reserved = 1;
        if (player.influence < action.baseBid + reserved) destination = undefined;
        else { movementCost.add(player.id); movementPenalty.add(player.id); }
      }
    } else if (player.lockedCardId === 30) {
      const currentBids = state.players.filter((other) => other.id !== player.id && other.action?.lotId === action.lotId)
        .map((other) => other.action?.baseBid ?? 0);
      if (action.baseBid < Math.max(0, ...currentBids)) {
        destination = chooseLessCrowded(action.lotId);
        if (destination) {
          const reserved = 1;
          if (player.influence < action.baseBid + reserved) destination = undefined;
          else movementCost.add(player.id);
        }
      }
    }
    if (destination && destination !== action.lotId) {
      resolvedActions.set(player.id, { ...action, lotId: destination });
      movementResult.set(player.id, destination);
    }
  }
  const resolutionPlayers = state.players.map((player) => ({ ...player, action: resolvedActions.get(player.id) }));
  const crowdCounts = new Map(state.lots.map((lot) => [lot.id, resolutionPlayers.filter((player) => player.action?.lotId === lot.id).length]));
  const effectCrowdCounts = new Map(state.lots.map((lot) => [lot.id, (crowdCounts.get(lot.id) ?? 0) + (phantomMarkerCounts.get(lot.id) ?? 0)]));
  const maxCrowd = Math.max(0, ...crowdCounts.values());
  const minCrowd = Math.min(...crowdCounts.values());
  const maxEffectCrowd = Math.max(0, ...effectCrowdCounts.values());
  const minEffectCrowd = Math.min(...effectCrowdCounts.values());
  const umbrellaBlockedByPlayer = new Map<string, string>();
  const umbrellaPreventedSources = new Set<string>();
  const reserveUmbrella = (sourcePlayerId: string, targetPlayerId: string) => {
    const target = state.players.find((player) => player.id === targetPlayerId);
    if (target?.lockedCardId !== 50 || target.suspicion >= GAME_CONFIG.maximumSuspicion || umbrellaBlockedByPlayer.has(targetPlayerId)) return;
    umbrellaBlockedByPlayer.set(targetPlayerId, sourcePlayerId);
    umbrellaPreventedSources.add(sourcePlayerId);
  };
  for (const owner of state.players) {
    if (waxCanceled.has(owner.id) || blockedPressureSources.has(owner.id)) continue;
    const targetId = reflectedSources.has(owner.id) ? owner.id : owner.cardParameters.targetPlayerId;
    const target = typeof targetId === "string" ? state.players.find((player) => player.id === targetId) : undefined;
    if (!target) continue;
    if (owner.lockedCardId === 34 && target.action && target.action.baseBid < 2) reserveUmbrella(owner.id, target.id);
    if (owner.lockedCardId === 36 && target.suspicion >= 1 && target.suspicion < GAME_CONFIG.maximumSuspicion) reserveUmbrella(owner.id, target.id);
    if (owner.lockedCardId === 31) {
      const originalTarget = state.players.find((player) => player.id === owner.cardParameters.targetPlayerId);
      const changed = Boolean(originalTarget?.declaration?.targetLotId && originalTarget.action?.lotId !== originalTarget.declaration.targetLotId);
      if (changed) reserveUmbrella(owner.id, target.id);
    }
    if (owner.lockedCardId === 45) {
      const response = responseFor(owner.id, 45);
      if (response?.choice === "suspicion") reserveUmbrella(owner.id, response.targetPlayerId);
    }
  }
  const initialPressureSuspicionTargets = new Set<string>();
  const taxPaidByTarget = new Map<string, number>();
  const conditionPaidByTarget = new Map<string, number>();
  const harshFees = new Map(state.players.map((player) => {
    const action = player.action;
    const targetedCount = state.players.filter((owner) => owner.lockedCardId === 37
      && owner.cardParameters.targetLotId === player.originalDeclaration?.targetLotId
      && player.declarationChange?.fromLotId !== owner.cardParameters.targetLotId
      && !(player.lockedCardId === 23 && player.originalDeclaration?.hiddenField === "targetLotId")
      && !(resolvedActions.get(player.id)?.lotId && resolvedActions.get(player.id)?.lotId !== owner.cardParameters.targetLotId)).length;
    const card3Cost = player.lockedCardId === 3 && action?.lotId ? 1 : 0;
    const targetTaxCount = state.players.filter((owner) => owner.lockedCardId === 34
      && (reflectedSources.has(owner.id) ? owner.id : owner.cardParameters.targetPlayerId) === player.id
      && !waxCanceled.has(owner.id) && !blockedPressureSources.has(owner.id)).length;
    const targetTax = targetTaxCount && action && action.baseBid >= 2 ? targetTaxCount : 0;
    const taxOwner = state.players.find((owner) => owner.lockedCardId === 34
      && (reflectedSources.has(owner.id) ? owner.id : owner.cardParameters.targetPlayerId) === player.id
      && !waxCanceled.has(owner.id) && !blockedPressureSources.has(owner.id));
    if (targetTaxCount && action && action.baseBid < 2 && taxOwner && !umbrellaPreventedSources.has(taxOwner.id)) initialPressureSuspicionTargets.add(player.id);
    const badReputation = state.players.some((owner) => owner.lockedCardId === 36
      && (reflectedSources.has(owner.id) ? owner.id : owner.cardParameters.targetPlayerId) === player.id
      && !waxCanceled.has(owner.id) && !blockedPressureSources.has(owner.id));
    const reputationOwner = state.players.find((owner) => owner.lockedCardId === 36
      && (reflectedSources.has(owner.id) ? owner.id : owner.cardParameters.targetPlayerId) === player.id
      && !waxCanceled.has(owner.id) && !blockedPressureSources.has(owner.id));
    if (badReputation && player.suspicion >= 1 && player.suspicion < GAME_CONFIG.maximumSuspicion
      && reputationOwner && !umbrellaPreventedSources.has(reputationOwner.id)) initialPressureSuspicionTargets.add(player.id);
    const conditionCount = action && action.baseBid < 1 ? targetedCount : 0;
    const movementFee = movementCost.has(player.id) ? 1 : 0;
    const card27Fee = player.lockedCardId === 27 && action?.lotId ? 1 : 0;
    const resolutionAdvance = player.lockedCardId === 10 ? 1 : 0;
    const payable = Math.max(0, player.influence + resolutionAdvance - (action?.baseBid ?? 0) - card3Cost);
    const mandatoryBidAdjustments = movementFee + card27Fee;
    const paidAdjustments = Math.min(mandatoryBidAdjustments, payable);
    const paidTax = Math.min(targetTax, Math.max(0, payable - paidAdjustments));
    const paidCondition = Math.min(conditionCount, Math.max(0, payable - paidAdjustments - paidTax));
    taxPaidByTarget.set(player.id, paidTax);
    conditionPaidByTarget.set(player.id, paidCondition);
    return [player.id, paidAdjustments + paidTax + paidCondition] as const;
  }));
  const invoiceActive = state.players.some((player) => player.lockedCardId === 40);
  const invoiceFees = new Map(state.players.map((player) => {
    const action = player.action;
    if (!invoiceActive || !action) return [player.id, 0] as const;
    const card3Cost = player.lockedCardId === 3 && action.lotId ? 1 : 0;
    const afterBidAndOtherCosts = player.influence - action.baseBid - card3Cost - (harshFees.get(player.id) ?? 0);
    return [player.id, afterBidAndOtherCosts >= 4 ? 1 : 0] as const;
  }));

  function makeBidEntry(player: GamePlayerState, lotId: string, lastBidBonus = false, allowMirrorCopy = true) {
    const action = player.action!;
    const params = { ...player.cardParameters, ...action.cardParameters };
    let cardBonus = 0;
    if (player.lockedCardId === 1 && player.declaration?.targetLotId === lotId) cardBonus += 1;
    if (player.lockedCardId === 3 && action.lotId) cardBonus += 2;
    if (player.lockedCardId === 16 && player.declaration?.alternateLotId) {
      const firstCount = effectCrowdCounts.get(player.declaration.targetLotId ?? "") ?? Infinity;
      const secondCount = effectCrowdCounts.get(player.declaration.alternateLotId) ?? Infinity;
      if (action.lotId === player.declaration.targetLotId && firstCount < secondCount) cardBonus += 1;
      if (action.lotId === player.declaration.alternateLotId && secondCount < firstCount) cardBonus += 1;
    }
    if (player.lockedCardId === 22 && player.declaration?.bidBand) {
      const announcedHigh = player.declaration.bidBand === "2-3";
      const actualHigh = action.baseBid >= 2;
      if (announcedHigh !== actualHigh) cardBonus += 1;
    }
    const crowdPressureCount = state.players.filter((owner) => owner.lockedCardId === 35).length;
    const spotlightOwners = state.players.filter((owner) => owner.lockedCardId === 41
      && (reflectedSources.has(owner.id) ? owner.id : owner.cardParameters.targetPlayerId) === player.id
      && !waxCanceled.has(owner.id)).length;
    const leader = player.seals === Math.max(0, ...state.players.map((item) => item.seals));
    const copied = allowMirrorCopy && player.lockedCardId === 20 ? state.players.find((owner) => owner.id === params.targetPlayerId) : undefined;
    const copiedAction = copied ? resolvedActions.get(copied.id) : undefined;
    let copiedModifier = 0;
    if (copied && copiedAction?.lotId === lotId) {
      if (copied.lockedCardId === 1 && copied.declaration?.targetLotId === lotId) copiedModifier = 1;
      if (copied.lockedCardId === 3) copiedModifier = 1;
      if (copied.lockedCardId === 6 && state.players.some((trusting) => trusting.id !== copied.id && trusting.action?.stance.kind === "trust" && trusting.action.stance.targetPlayerId === copied.id && resolvedActions.get(trusting.id)?.lotId === lotId)) copiedModifier = 1;
      if (copied.lockedCardId === 16 && copied.declaration?.alternateLotId) {
        const firstCount = effectCrowdCounts.get(copied.declaration.targetLotId ?? "") ?? Infinity;
        const secondCount = effectCrowdCounts.get(copied.declaration.alternateLotId) ?? Infinity;
        if ((copiedAction.lotId === copied.declaration.targetLotId && firstCount < secondCount) || (copiedAction.lotId === copied.declaration.alternateLotId && secondCount < firstCount)) copiedModifier = 1;
      }
      if (copied.lockedCardId === 22 && copied.declaration?.bidBand && (copied.declaration.bidBand === "2-3") !== (copiedAction.baseBid >= 2)) copiedModifier = 1;
      if (copied.lockedCardId === 27) copiedModifier = copied.cardParameters.direction === "down" ? -1 : 1;
      if (copied.lockedCardId === 35 && maxCrowd >= 3 && crowdCounts.get(lotId) === maxCrowd) copiedModifier = -1;
      if ((copied.lockedCardId === 19 || copied.lockedCardId === 24) && movementPenalty.has(copied.id)) copiedModifier = -1;
      if (copied.lockedCardId === 14) {
        const theirEntry = makeBidEntry({ ...copied, action: copiedAction }, lotId, false, false);
        const theirsEffective = calculateEffectiveBid(theirEntry).effectiveBid;
        const highest = Math.max(-1, ...resolutionPlayers.filter((item) => item.id !== copied.id && item.action?.lotId === lotId)
          .map((item) => calculateEffectiveBid(makeBidEntry(item, lotId, false, false)).effectiveBid));
        if (theirsEffective === highest - 1 && theirEntry.influence - theirEntry.baseBid >= 1) copiedModifier = 1;
      }
    }
    const finalRound = state.finalRoundIndex === state.roundIndex || state.roundIndex >= state.settings.roundLimit || state.roundIndex >= GAME_CONFIG.maximumRoundLimit;
    const lastPageEligible = player.lockedCardId === 60 && finalRound && player.seals >= Math.max(...state.players.map((item) => item.seals)) - 1;
    const debtTargetId = player.cardParameters.targetPlayerId;
    const debtApplies = player.lockedCardId === 7 && typeof debtTargetId === "string" && (state.contractBreachHistory ?? []).some((item) => item.roundIndex === state.roundIndex - 1 && item.victimPlayerId === player.id && item.breacherPlayerId === debtTargetId);
    const cardPenalty = (crowdPressureCount > 0 && maxCrowd >= 3 && crowdCounts.get(lotId) === maxCrowd ? crowdPressureCount : 0)
      + (spotlightOwners > 0 && leader ? spotlightOwners : 0)
      + (movementPenalty.has(player.id) ? 1 : 0)
      + (copiedModifier < 0 ? 1 : 0)
      + (player.lockedCardId === 27 && params.direction === "down" ? 1 : 0);
    if (copiedModifier > 0) cardBonus += 1;
    if (debtApplies && resolvedActions.get(debtTargetId as string)?.lotId === lotId) cardBonus += 1;
    if (lastPageEligible && player.cardParameters.lastPageChoice === "bid") cardBonus += 1;
    if (player.lockedCardId === 27 && action.lotId && params.direction === "up") cardBonus += 1;
    if (lastBidBonus) cardBonus += 1;
    const advance = player.lockedCardId === 10 ? 1 : 0;
    const cardCost = player.lockedCardId === 3 && action.lotId ? 1 : 0;
    return {
      playerId: player.id,
      lotId,
      baseBid: action.baseBid,
      ...(player.lockedCardId === 49 ? { withdrawn: true } : {}),
      seals: player.seals,
      influence: Math.max(0, Math.min(GAME_CONFIG.maximumInfluence, player.influence + advance) - cardCost - (harshFees.get(player.id) ?? 0) - (invoiceFees.get(player.id) ?? 0) - (lastBidBonus ? 1 : 0)),
      trustBonus: trustBonuses.get(player.id) ?? 0,
      cardBonus,
      ...(cardPenalty ? { cardPenalty } : {}),
    };
  }

  const actionPlayers = resolutionPlayers.filter((player) => player.action?.lotId);
  const wonPlayerIds = new Set<string>();
  const lotResults = state.lots.map((lot) => {
    // A player can earn at most one seal per round. Lots are resolved in the
    // public lot order so this rule never depends on packet arrival order.
    const candidates = actionPlayers.filter((player) => player.action?.lotId === lot.id && !wonPlayerIds.has(player.id));
    let entries = candidates.map((player) => makeBidEntry(player, lot.id));
    const beforeLastBid = entries.map((entry) => ({ entry, effective: calculateEffectiveBid(entry).effectiveBid }));
    const highestBeforeLastBid = Math.max(-1, ...beforeLastBid.filter((item) => !item.entry.withdrawn).map((item) => item.effective));
    entries = entries.map((entry) => {
      const player = resolutionPlayers.find((item) => item.id === entry.playerId)!;
      const current = beforeLastBid.find((item) => item.entry.playerId === player.id)!;
      const remainingAfterBaseBid = entry.influence - entry.baseBid;
      const triggersLastBid = !entry.withdrawn && player.lockedCardId === 14
        && current.effective === highestBeforeLastBid - 1
        && remainingAfterBaseBid >= 1;
      if (player.lockedCardId === 14) recordCard(player,
        triggersLastBid ? "applied" : "no-op",
        triggersLastBid ? "one-below-highest-paid-one" : "not-one-below-or-unaffordable",
        triggersLastBid ? { influenceCost: 1, bidBonus: 1 } : undefined);
      return triggersLastBid ? makeBidEntry(player, lot.id, true) : entry;
    });
    const result = resolveLotAuction(lot.id, entries, candidates
      .filter((player) => player.lockedCardId === 9)
      .map((player) => player.id));
    if (result.cardTieBreakPlayerId) {
      result.bidResolutions = result.bidResolutions.map((bid) => bid.playerId === result.cardTieBreakPlayerId
        ? { ...bid, influenceAfter: Math.max(0, bid.influenceAfter - 1), calculation: [...bid.calculation, "كارت 9 حسم تعادل بعد قاعدة الأختام مقابل نفوذ واحد"] }
        : bid);
    }
    if (result.winnerPlayerId) wonPlayerIds.add(result.winnerPlayerId);
    return result;
  });
  for (const result of lotResults) {
    const winner = result.winnerPlayerId ? state.players.find((player) => player.id === result.winnerPlayerId) : undefined;
    if (!winner || winner.lockedCardId !== 5 || (winner.action?.baseBid ?? 0) < 2) continue;
    result.bidResolutions = result.bidResolutions.map((bid) => bid.playerId === winner.id
      ? { ...bid, effectiveBid: Math.max(0, bid.effectiveBid - 1), calculation: [...bid.calculation, "بعد الحسم: بطاقة 5 تخفّض عرضها 1 ولا تغيّر الفائز"] }
      : bid);
  }
  let players = resolutionPlayers.map((player) => {
    const result = lotResults.flatMap((lot) => lot.bidResolutions).find((bid) => bid.playerId === player.id);
    const action = player.action;
    const gainedSuspicion = state.players.some((owner) => owner.action?.stance.kind === "doubt" && owner.action.stance.targetPlayerId === player.id) ? 1 : 0;
    const contradictedBand = player.lockedCardId === 22 && Boolean(player.declaration?.bidBand)
      && (player.declaration!.bidBand === "2-3") !== ((action?.baseBid ?? 0) >= 2);
    const entry = result;
    let influence = entry?.influenceAfter ?? player.influence;
    if (!entry) influence = Math.max(0, influence - (harshFees.get(player.id) ?? 0) - (invoiceFees.get(player.id) ?? 0));
    if (player.lockedCardId === 10 && !entry) influence = Math.min(GAME_CONFIG.maximumInfluence, influence + 1);
    const illusionConflict = player.lockedCardId === 29 && Boolean(action?.stance.kind !== player.declaration?.illusionStance);
    let suspicion = Math.max(0, Math.min(GAME_CONFIG.maximumSuspicion, player.suspicion + gainedSuspicion + (contradictedBand ? 1 : 0)
      + (illusionConflict ? 1 : 0) + (initialPressureSuspicionTargets.has(player.id) ? 1 : 0)));
    const won = result?.won ?? false;
    if (player.lockedCardId === 10 && won) {
      influence = Math.max(0, influence - 2);
      recordCard(player, "applied", "won-a-lot-and-repaid-advance", { influencePaid: 2 });
    }
    if (player.lockedCardId === 10 && !won) suspicion = Math.min(GAME_CONFIG.maximumSuspicion, suspicion + 1);
    return {
      ...player,
      influence,
      seals: player.seals + (won ? 1 : 0),
      suspicion,
      forcedAnnouncement: false,
      action,
    };
  });
  const lots = state.lots.map((lot) => {
    const result = lotResults.find((item) => item.lotId === lot.id);
    if (!result?.winnerPlayerId) return { ...lot, status: "unclaimed" as const };
    return { ...lot, status: "won" as const, winnerPlayerId: result.winnerPlayerId };
  });

  let current: GameState = { ...state, players, lots };
  const canceledPressureEffects = (state.cardResponses ?? []).filter((item) => item.cardId === 58 && item.choice === "cancel");
  if (canceledPressureEffects.length) {
    const canceledTargets = new Set(canceledPressureEffects.map((response) => response.targetPlayerId));
    current = { ...current, players: current.players.map((player) => canceledTargets.has(player.id) ? changeInfluence(player, -1) : player),
      events: [...current.events, event(current, "deferred-pressure-canceled", "public", { effects: canceledPressureEffects, influenceCostEach: 1 })] };
  }
  const deferredEffects = (state.cardResponses ?? []).filter((item) => item.cardId === 58 && item.choice === "defer" && item.effectCardId === 34 || item.cardId === 58 && item.choice === "defer" && item.effectCardId === 36)
    .flatMap((response) => {
      const source = state.players.find((player) => player.id === response.sourcePlayerId);
      const target = state.players.find((player) => player.id === response.targetPlayerId);
      if (!source || !target) return [];
      const kind = response.effectCardId === 34 && (target.action?.baseBid ?? 0) >= 2 ? "influence" as const : "suspicion" as const;
      const noNextRound = state.roundIndex >= state.settings.roundLimit || state.roundIndex >= GAME_CONFIG.maximumRoundLimit || state.finalRoundIndex === state.roundIndex;
      return [{ sourcePlayerId: source.id, targetPlayerId: target.id, sourceCardId: response.effectCardId as 34 | 36, kind, amount: 1 as const, dueRoundIndex: noNextRound ? state.roundIndex : state.roundIndex + 1 }];
    });
  if (deferredEffects.length) current = { ...current, pendingPressureEffects: [...(state.pendingPressureEffects ?? []), ...deferredEffects] };
  for (const player of state.players.filter((item) => item.lockedCardId === 17)) {
    current = { ...current, events: [...current.events, event(current, "phantom-competitor-placed", "public", {
      playerId: player.id,
      lotId: player.cardParameters.targetLotId,
      realBidsUnaffected: true,
    })] };
  }
  const stanceSpotlight = state.players.find((player) => player.lockedCardId === 38 && typeof player.cardParameters.targetPlayerId === "string");
  if (stanceSpotlight) {
    const revealedPlayer = state.players.find((player) => player.id === stanceSpotlight.cardParameters.targetPlayerId);
    if (revealedPlayer?.action?.stance.kind !== "pass") current = { ...current, events: [...current.events, event(current, "spotlighted-stance-revealed", "public", {
      sourcePlayerId: stanceSpotlight.id,
      playerId: revealedPlayer!.id,
      stance: revealedPlayer!.action!.stance,
    })] };
    current = { ...current, events: [...current.events, event(current, "remaining-stances-revealed", "public", {
      sourcePlayerId: stanceSpotlight.id,
      stances: state.players.filter((player) => player.id !== stanceSpotlight.cardParameters.targetPlayerId && player.action?.stance.kind !== "pass")
        .map((player) => ({ playerId: player.id, stance: player.action?.stance })),
    })] };
  }
  const protectedRewardLots = new Set(state.players.filter((player) => player.lockedCardId === 57).map((player) => String(player.cardParameters.targetLotId ?? "")));
  const rewardlessWinners = new Set(state.players.filter((owner) => owner.lockedCardId === 44 && !waxCanceled.has(owner.id))
    .map((owner) => {
      const targetId = owner.cardParameters.targetPlayerId;
      const target = state.players.find((item) => item.id === targetId);
      return target && target.seals > owner.seals ? target.id : "";
    }).filter(Boolean));
  if (state.formalContract?.status === "accepted") {
    const contract = state.formalContract;
    const condition = contract.condition;
    const partyIds = [contract.proposerPlayerId, contract.targetPlayerId];
    const finalLot = (id: string) => current.players.find((player) => player.id === id)?.action?.lotId;
    let breaches: string[] = [];
    if (condition.kind === "no-bid") {
      const boundAction = current.players.find((player) => player.id === condition.playerId)?.action;
      if (boundAction?.lotId === condition.lotId && boundAction.baseBid > 0) breaches = [condition.playerId];
    } else if (condition.kind === "different-lots") {
      const first = finalLot(contract.proposerPlayerId);
      const second = finalLot(contract.targetPlayerId);
      if (!first || !second || first === second) breaches = partyIds;
    } else {
      const from = current.players.find((player) => player.id === condition.fromPlayerId);
      if (!from || from.influence < condition.amount) breaches = [condition.fromPlayerId];
      else current = { ...current, players: current.players.map((player) => player.id === condition.fromPlayerId
        ? changeInfluence(player, -condition.amount)
        : player.id === condition.toPlayerId ? changeInfluence(player, condition.amount) : player) };
    }
    let status: NonNullable<GameState["formalContract"]>["status"];
    if (!breaches.length) {
      status = "fulfilled";
      current = { ...current, players: current.players.map((player) => partyIds.includes(player.id) ? changeInfluence(player, 2) : player) };
    } else if (breaches.length === 2) {
      status = "breached";
      current = { ...current, players: current.players.map((player) => partyIds.includes(player.id) ? changeInfluence(player, 1) : player) };
    } else {
      const breacher = breaches[0]!;
      const victim = partyIds.find((id) => id !== breacher)!;
      const voided = current.players.some((player) => player.id === victim && player.lockedCardId === 55);
      status = voided ? "voided" : "breached";
      current = { ...current, players: current.players.map((player) => player.id === (voided ? breacher : victim)
        ? changeInfluence(player, voided ? 1 : 2)
        : player.id === (voided ? victim : breacher) && voided ? changeInfluence(player, 1) : player) };
      current = { ...current, contractBreachHistory: [...(current.contractBreachHistory ?? []), { roundIndex: state.roundIndex, breacherPlayerId: breacher, victimPlayerId: victim }] };
    }
    const formalContract = { ...contract, status, ...(breaches.length ? { breachPlayerIds: breaches } : {}) };
    current = { ...current, formalContract, events: [...current.events, event(current, "contract-settled", "public", { formalContract })] };
    const proposer = state.players.find((player) => player.id === contract.proposerPlayerId)!;
    recordCard(proposer, "applied", `contract-${status}`, { formalContract });
    for (const player of state.players.filter((item) => item.lockedCardId === 55)) {
      recordCard(player, status === "voided" && !breaches.includes(player.id) ? "applied" : "no-op", status === "voided" ? "prevented-escrow-transfer" : "no-breached-contract-to-void");
    }
  } else {
    const proposer = state.players.find((player) => player.lockedCardId === 2);
    if (proposer) recordCard(proposer, "no-op", state.formalContract?.status === "pending" ? "contract-was-not-accepted" : "no-contract-offer");
    for (const player of state.players.filter((item) => item.lockedCardId === 55)) recordCard(player, "no-op", "no-accepted-contract-breach");
  }
  for (const player of state.players.filter((item) => item.lockedCardId === 7)) {
    const targetId = player.cardParameters.targetPlayerId;
    const applies = typeof targetId === "string" && (state.contractBreachHistory ?? []).some((item) => item.roundIndex === state.roundIndex - 1
      && item.victimPlayerId === player.id && item.breacherPlayerId === targetId)
      && current.players.find((item) => item.id === targetId)?.action?.lotId === player.action?.lotId
      && Boolean(player.action?.lotId);
    recordCard(player, applies ? "applied" : "no-op", applies ? "contract-breacher-chose-the-same-lot" : "no-qualifying-last-round-breach-or-lot");
  }
  for (const player of state.players.filter((item) => item.lockedCardId === 28)) {
    const firstNextLotId = player.cardParameters.firstNextLotId;
    const nextTwo = current.lotDeck.slice(current.lotDeckCursor, current.lotDeckCursor + 2);
    const hasNextRound = state.roundIndex < state.settings.roundLimit && state.roundIndex < GAME_CONFIG.maximumRoundLimit && state.finalRoundIndex !== state.roundIndex;
    const firstHolder = state.players.find((item) => item.lockedCardId === 28);
    if (player.id !== firstHolder?.id) {
      recordCard(player, "no-op", "another-player-won-the-simultaneous-order-choice");
    } else if (hasNextRound && typeof firstNextLotId === "string" && nextTwo.includes(firstNextLotId) && nextTwo.length === 2) {
      const ordered = firstNextLotId === nextTwo[0] ? nextTwo : [nextTwo[1]!, nextTwo[0]!];
      current = { ...current, lotDeck: [...current.lotDeck.slice(0, current.lotDeckCursor), ...ordered, ...current.lotDeck.slice(current.lotDeckCursor + 2)] };
      recordCard(player, "applied", "reordered-next-round-lots", { nextLots: ordered });
    } else recordCard(player, "no-op", hasNextRound ? "not-enough-lots-remain-for-a-next-round-preview" : "there-is-no-next-round");
  }
  for (const player of state.players.filter((item) => item.lockedCardId === 19 || item.lockedCardId === 24 || item.lockedCardId === 30)) {
    const destination = movementResult.get(player.id);
    recordCard(player, destination ? "applied" : "no-op", destination ? "moved-to-a-less-crowded-lot" : "no-eligible-less-crowded-lot", destination ? {
      fromLotId: player.action?.lotId,
      toLotId: destination,
      influenceCost: movementCost.has(player.id) ? 1 : 0,
      bidPenalty: movementPenalty.has(player.id) ? 1 : 0,
    } : undefined);
  }
  const scandalCards = state.players.filter((player) => player.lockedCardId === 32 || player.lockedCardId === 35 || player.lockedCardId === 43)
    .sort((left, right) => left.lockedCardId! - right.lockedCardId!
      || ((left.seatIndex - state.firstSeatIndex + state.players.length) % state.players.length)
        - ((right.seatIndex - state.firstSeatIndex + state.players.length) % state.players.length));
  for (const player of scandalCards) {
    const before = current.scandal;
    const requested = player.lockedCardId === 32 ? 2
      : player.lockedCardId === 35 ? (maxCrowd >= 3 ? 1 : 0)
        : before >= 6 ? 2 : 1;
    const after = Math.min(GAME_CONFIG.maximumScandal, before + requested);
    current = { ...current, scandal: after };
    recordCard(player, after > before ? "applied" : "no-op", after > before ? "scandal-increased" : player.lockedCardId === 35 && maxCrowd < 3 ? "fewer-than-three-real-competitors" : "scandal-already-at-cap", {
      scandalBefore: before,
      scandalAdded: after - before,
      scandalAfter: after,
    });
  }
  for (const player of state.players) {
    if (player.lockedCardId !== 56) continue;
    const before = current.scandal;
    const after = Math.max(0, before - 1);
    current = {
      ...current,
      scandal: after,
      players: current.players.map((target) => target.id === player.id ? changeSuspicion(target, 1) : target),
    };
    recordCard(player, "applied", "scandal-reduced-and-owner-gains-suspicion", {
      scandalBefore: before,
      scandalAfter: after,
      suspicionAdded: 1,
    });
  }
  const wagerSummary: Array<Record<string, unknown>> = [];
  players = current.players.map((bettor) => {
    let wagerScore = bettor.wagerScore;
    let influence = bettor.influence;
    for (const wager of bettor.wagers) {
      const target = current.players.find((item) => item.id === wager.targetPlayerId);
      const result = target ? wagerMatches(wager.predicate, target, wager) : "void";
      const delta = result === "void" ? 0 : result ? GAME_CONFIG.wagerWin : GAME_CONFIG.wagerLoss;
      wagerScore += delta;
      const refund = result === "void" && wager.secondWager ? GAME_CONFIG.optionalSecondWagerCost : 0;
      influence = Math.min(GAME_CONFIG.maximumInfluence, influence + refund);
      wagerSummary.push({ bettorPlayerId: bettor.id, targetPlayerId: wager.targetPlayerId, predicate: wager.predicate, result, delta, refund });
    }
    return { ...bettor, wagerScore, influence };
  });
  current = { ...current, players };

  const playerById = new Map(current.players.map((player) => [player.id, player]));
  for (const owner of state.players) {
    const targetId = owner.cardParameters.targetPlayerId;
    if (owner.lockedCardId === 8 || owner.lockedCardId === 12) {
      if (typeof targetId !== "string") {
        recordCard(owner, "no-op", "no-target-selected");
        continue;
      }
      const target = playerById.get(targetId);
      const ownerAction = owner.action;
      if (target?.action?.lotId && ownerAction?.lotId && target.action.lotId !== ownerAction.lotId) {
        current = { ...current, players: current.players.map((player) => player.id === owner.id || player.id === target.id ? changeInfluence(player, 1) : player) };
        recordCard(owner, "applied", "chosen-player-used-a-different-lot", { targetPlayerId: target.id, influenceEach: 1 });
        if (owner.lockedCardId === 8) recordCard(target, "applied", "broker-shared-reward", { sourcePlayerId: owner.id, influence: 1 });
      } else {
        recordCard(owner, "no-op", "pair-did-not-choose-two-different-lots", { targetPlayerId: targetId });
      }
    }
  }

  for (const owner of state.players) {
    if (![21, 25, 26, 31].includes(owner.lockedCardId ?? 0)) continue;
    const targetId = owner.cardParameters.targetPlayerId;
    if (waxCanceled.has(owner.id)) {
      recordCard(owner, "no-op", "wax-seal-canceled-this-targeted-effect", { targetPlayerId: targetId });
      continue;
    }
    const currentOwner = current.players.find((player) => player.id === owner.id)!;
    const target = typeof targetId === "string" ? current.players.find((player) => player.id === targetId) : undefined;
    if (!target) {
      recordCard(owner, "no-op", "no-target-selected");
      continue;
    }

    if (reflectedSources.has(owner.id)) {
      if (owner.lockedCardId === 26 && target.suspicion > 0) {
        current = { ...current, players: current.players.map((player) => player.id === target.id ? changeSuspicion(player, -1) : player.id === owner.id ? changeSuspicion(player, 1) : player) };
        recordCard(owner, "applied", "reflected-suspicion-transfer-back-to-source", { targetPlayerId: target.id, suspicionReflected: 1 });
      } else if (owner.lockedCardId === 21 && target.action?.lotId === target.declaration?.targetLotId) {
        if (current.players.find((player) => player.id === owner.id)!.suspicion >= GAME_CONFIG.maximumSuspicion) {
          recordCard(owner, "no-op", "reflected-suspicion-had-no-room-at-source", { targetPlayerId: owner.id });
        } else {
          current = { ...current, players: current.players.map((player) => player.id === owner.id ? changeSuspicion(player, 1) : player) };
          recordCard(owner, "applied", "reflected-suspicion-to-source", { targetPlayerId: target.id, suspicionReflected: 1 });
        }
      } else if (owner.lockedCardId === 31 && target.action?.lotId !== target.declaration?.targetLotId) {
        if (current.players.find((player) => player.id === owner.id)!.suspicion >= GAME_CONFIG.maximumSuspicion) {
          recordCard(owner, "no-op", "reflected-suspicion-had-no-room-at-source", { targetPlayerId: owner.id });
        } else if (umbrellaPreventedSources.has(owner.id)) {
          recordCard(owner, "no-op", "reflected-suspicion-prevented-by-card-50", { targetPlayerId: owner.id });
        } else {
          current = { ...current, players: current.players.map((player) => player.id === owner.id ? changeSuspicion(player, 1) : player) };
          recordCard(owner, "applied", "reflected-suspicion-to-source", { targetPlayerId: target.id, suspicionReflected: 1 });
        }
      } else recordCard(owner, "no-op", "reflected-effect-had-no-negative-result-to-send-back", { targetPlayerId: target.id });
      continue;
    }
    if (owner.lockedCardId === 26) {
      if (currentOwner.suspicion <= 0) {
        recordCard(owner, "no-op", "owner-has-no-suspicion-to-transfer", { targetPlayerId: target.id });
        continue;
      }
      current = { ...current, players: current.players.map((player) => player.id === owner.id
        ? changeSuspicion(player, -1)
        : player.id === target.id ? changeSuspicion(player, 1) : player) };
      recordCard(owner, "applied", "transferred-one-suspicion", { targetPlayerId: target.id, suspicionMoved: 1 });
      continue;
    }

    const announcedLotId = target.declaration?.targetLotId;
    const lotWasHidden = target.lockedCardId === 23 && target.declaration?.hiddenField === "targetLotId";
    if (!announcedLotId || lotWasHidden) {
      recordCard(owner, "no-op", "target-has-no-public-lot-announcement", { targetPlayerId: target.id });
      continue;
    }
    const changedLot = target.action?.lotId !== announcedLotId;
    if (owner.lockedCardId === 21) {
      if (changedLot) {
        current = { ...current, players: current.players.map((player) => player.id === owner.id ? changeInfluence(player, 1) : player) };
        recordCard(owner, "applied", "target-changed-the-announced-lot", { targetPlayerId: target.id, influence: 1 });
      } else {
        if (target.suspicion >= GAME_CONFIG.maximumSuspicion) recordCard(owner, "no-op", "target-suspicion-already-at-cap", { targetPlayerId: target.id });
        else {
          current = { ...current, players: current.players.map((player) => player.id === target.id ? changeSuspicion(player, 1) : player) };
          recordCard(owner, "applied", "target-kept-the-announced-lot", { targetPlayerId: target.id, suspicionAdded: 1 });
        }
      }
    } else if (owner.lockedCardId === 25) {
      const repeated = publicDeclarationAfterWagers(target);
      current = { ...current, events: [...current.events, event(current, "declaration-repeated", "public", {
        ownerPlayerId: owner.id,
        targetPlayerId: target.id,
        declaration: repeated,
      })] };
      if (changedLot) {
        current = { ...current, players: current.players.map((player) => player.id === owner.id ? changeInfluence(player, 1) : player) };
        recordCard(owner, "applied", "target-changed-the-repeated-declaration", { targetPlayerId: target.id, influence: 1 });
      } else recordCard(owner, "no-op", "target-kept-the-repeated-declaration", { targetPlayerId: target.id });
    } else if (changedLot) {
      if (target.suspicion >= GAME_CONFIG.maximumSuspicion) recordCard(owner, "no-op", "target-suspicion-already-at-cap", { targetPlayerId: target.id });
      else if (umbrellaPreventedSources.has(owner.id)) recordCard(owner, "no-op", "target-suspicion-prevented-by-card-50", { targetPlayerId: target.id });
      else {
        current = { ...current, players: current.players.map((player) => player.id === target.id ? changeSuspicion(player, 1) : player) };
        recordCard(owner, "applied", "target-changed-the-announced-lot", { targetPlayerId: target.id, suspicionAdded: 1 });
      }
    } else {
      const cost = Math.min(1, currentOwner.influence);
      current = { ...current, players: current.players.map((player) => player.id === owner.id ? changeInfluence(player, -1) : player) };
      recordCard(owner, "applied", "target-kept-the-announced-lot-owner-pays", { targetPlayerId: target.id, influenceCost: cost });
    }
  }

  for (const owner of state.players.filter((player) => player.lockedCardId === 59)) {
    const targetId = owner.cardParameters.targetPlayerId;
    const target = typeof targetId === "string" ? current.players.find((player) => player.id === targetId) : undefined;
    if (!target) {
      recordCard(owner, "no-op", "no-target-selected");
      continue;
    }
    const trusted = target.action?.stance.kind === "trust" && target.action.stance.targetPlayerId === owner.id;
    const removed = target.suspicion > 0;
    current = { ...current, players: current.players.map((player) => player.id === target.id ? changeSuspicion(player, -1) : player.id === owner.id && trusted ? changeInfluence(player, 1) : player) };
    recordCard(owner, removed || trusted ? "applied" : "no-op", removed || trusted ? "mutual-rescue-resolved" : "target-had-no-suspicion-and-did-not-trust", { targetPlayerId: target.id, suspicionRemoved: removed ? 1 : 0, trustReward: trusted ? 1 : 0 });
  }

  const winnerForPlayer = new Map(lotResults.filter((result) => result.winnerPlayerId).map((result) => [result.winnerPlayerId!, result.lotId]));
  current = { ...current, players: current.players.map((player) => {
    const wonLotId = winnerForPlayer.get(player.id);
    let next = player;
    if (player.lockedCardId === 1) {
      const applied = Boolean(wonLotId && player.declaration?.targetLotId === wonLotId);
      recordCard(player, applied ? "applied" : "no-op", applied ? "won-announced-lot" : "did-not-win-announced-lot", applied ? { bidBonus: 1 } : undefined);
    }
    if (player.lockedCardId === 3) {
      const applied = Boolean(player.action?.lotId);
      recordCard(player, applied ? "applied" : "no-op", applied ? "paid-one-for-two-bid-points" : "passed-without-auction", applied ? { influenceCost: 1, bidBonus: 2 } : undefined);
    }
    if (player.lockedCardId === 16) {
      const firstCount = effectCrowdCounts.get(player.declaration?.targetLotId ?? "") ?? Infinity;
      const secondCount = effectCrowdCounts.get(player.declaration?.alternateLotId ?? "") ?? Infinity;
      const applied = Boolean(player.action?.lotId && ((player.action.lotId === player.declaration?.targetLotId && firstCount < secondCount)
        || (player.action.lotId === player.declaration?.alternateLotId && secondCount < firstCount)));
      recordCard(player, applied ? "applied" : "no-op", applied ? "selected-the-less-crowded-announced-lot" : "not-on-less-crowded-announced-lot", applied ? { bidBonus: 1 } : undefined);
    }
    if (player.lockedCardId === 4 || player.lockedCardId === 48) {
      const paidBid = player.action?.baseBid ?? 0;
      if (!wonLotId && paidBid > 0) {
        next = changeInfluence(next, Math.min(1, paidBid));
        recordCard(player, "applied", "lost-after-paying-nonzero-bid", { refund: Math.min(1, paidBid) });
      } else recordCard(player, "no-op", paidBid === 0 ? "no-nonzero-bid" : "won-a-lot");
    }
    if (player.lockedCardId === 11) {
      recordCard(player, player.declarationChange ? "applied" : "no-op",
        player.declarationChange ? "paid-to-update-public-declaration" : "declaration-not-renegotiated",
        player.declarationChange ? { ...player.declarationChange, influenceCost: 1 } : undefined);
    }
    if (player.lockedCardId === 27) recordCard(player, player.action?.lotId ? "applied" : "no-op", player.action?.lotId ? "paid-to-adjust-effective-bid" : "passed-without-an-effective-bid", player.action?.lotId ? { direction: player.cardParameters.direction, influenceCost: 1, effectiveBidChange: player.cardParameters.direction === "down" ? -1 : 1 } : undefined);
    if (player.lockedCardId === 29) {
      const conflict = player.action?.stance.kind !== player.declaration?.illusionStance;
      recordCard(player, conflict ? "applied" : "no-op", conflict ? "real-stance-conflicted-with-announced-symbol" : "real-stance-matched-announced-symbol", conflict ? { suspicionAdded: 1 } : undefined);
    }
    if (player.lockedCardId === 22) {
      const contradicted = Boolean(player.declaration?.bidBand)
        && (player.declaration!.bidBand === "2-3") !== ((player.action?.baseBid ?? 0) >= 2);
      recordCard(player, contradicted ? "applied" : "no-op",
        contradicted ? "base-bid-contradicted-announced-band" : "base-bid-matched-or-no-band",
        contradicted ? { bidBonus: 1, suspicionAdded: 1 } : undefined);
    }
    if (player.lockedCardId === 9) {
      const tieBreak = lotResults.find((result) => result.cardTieBreakPlayerId === player.id);
      const wonLot = lotResults.find((result) => result.winnerPlayerId === player.id);
      recordCard(player, tieBreak ? "applied" : "no-op",
        tieBreak ? "paid-one-influence-to-break-a-remaining-effective-bid-tie" : wonLot ? "global-fewer-seals-rule-already-gave-a-unique-winner" : "no-qualifying-tie-or-no-influence-to-claim-it",
        tieBreak ? { lotId: tieBreak.lotId, influenceCost: 1 } : undefined);
    }
    if (player.lockedCardId === 35) {
      const affected = maxCrowd >= 3
        ? state.players.filter((target) => target.action?.lotId && crowdCounts.get(target.action.lotId) === maxCrowd)
        : [];
      recordCard(player, affected.length ? "applied" : "no-op",
        affected.length ? "most-crowded-real-competitors-lose-one-effective-bid" : "fewer-than-three-real-competitors",
        affected.length ? { targetPlayerIds: affected.map((target) => target.id), bidPenaltyEach: 1, scandalAdded: 1 } : undefined);
    }
    if (player.lockedCardId === 47) {
      if (next.suspicion > 0) {
        next = changeSuspicion(next, -1);
        recordCard(player, "applied", "removed-one-suspicion", { suspicionRemoved: 1 });
      } else {
        next = changeInfluence(next, 1);
        recordCard(player, "applied", "no-suspicion-gained-influence", { influence: 1 });
      }
    }
    if (player.lockedCardId === 60 && player.cardParameters.lastPageChoice === "suspicion") {
      const qualifies = player.seals >= Math.max(...state.players.map((item) => item.seals)) - 1
        && (state.finalRoundIndex === state.roundIndex || state.roundIndex >= state.settings.roundLimit || state.roundIndex >= GAME_CONFIG.maximumRoundLimit);
      if (qualifies) next = changeSuspicion(next, -1);
    }
    if (player.lockedCardId === 5) {
      if (wonLotId && (player.action?.baseBid ?? 0) >= 2) {
        next = changeInfluence(next, 1);
        recordCard(player, "applied", "won-with-base-bid-two-or-three", { refund: 1, winnerUnchanged: true });
      } else recordCard(player, "no-op", wonLotId ? "base-bid-below-two" : "did-not-win");
    }
    if (player.lockedCardId === 10 && !wonLotId && !player.action?.lotId) {
      // Passing still receives the advance and its fixed suspicion cost.
      recordCard(player, "applied", "no-lot-won", { suspicion: 1 });
    }
    if (player.lockedCardId === 13) {
      const count = wonLotId ? crowdCounts.get(wonLotId) ?? 0 : 0;
      if (wonLotId && count === 2) {
        next = changeInfluence(next, 1);
        recordCard(player, "applied", "won-lot-with-exactly-two-real-competitors", { influence: 1 });
      } else recordCard(player, "no-op", wonLotId ? "competitor-count-not-two" : "did-not-win");
    }
    if (player.lockedCardId === 15) {
      if (wonLotId && effectCrowdCounts.get(wonLotId) === maxEffectCrowd) {
        next = changeInfluence(next, 1);
        recordCard(player, "applied", "won-a-most-crowded-lot", { influence: 1 });
      } else if (wonLotId && effectCrowdCounts.get(wonLotId) === minEffectCrowd) {
        next = changeSuspicion(next, -1);
        recordCard(player, "applied", "won-a-least-crowded-lot", { suspicionRemoved: 1 });
      } else recordCard(player, "no-op", "winning-lot-does-not-qualify-as-most-or-least-crowded");
    }
    if (player.lockedCardId === 37) {
      const targetLotId = player.cardParameters.targetLotId;
      const affected = state.players.filter((target) => target.originalDeclaration?.targetLotId === targetLotId
        && target.declarationChange?.fromLotId !== targetLotId
        && !(target.lockedCardId === 23 && target.originalDeclaration?.hiddenField === "targetLotId")
        && !(resolvedActions.get(target.id)?.lotId && resolvedActions.get(target.id)?.lotId !== targetLotId));
      recordCard(player, affected.length ? "applied" : "no-op",
        affected.length ? "announcers-must-bid-at-least-one-or-pay" : "no-player-announced-target-lot",
        { targetLotId, affectedPlayerIds: affected.map((target) => target.id), totalInfluencePaid: affected.reduce((sum, target) => sum + (conditionPaidByTarget.get(target.id) ?? 0), 0) });
    }
    if (player.lockedCardId === 40) {
      const eligible = state.players.filter((target) => (invoiceFees.get(target.id) ?? 0) > 0);
      recordCard(player, eligible.length ? "applied" : "no-op",
        eligible.length ? "influence-invoice-collected" : "no-player-had-four-remaining-influence",
        { paidPlayerIds: eligible.map((target) => target.id), influenceEach: 1 });
    }
    if (player.lockedCardId === 17) recordCard(player, "applied", "phantom-marker-displayed-without-changing-real-bid-count", { lotId: player.cardParameters.targetLotId });
    if (player.lockedCardId === 34) {
      const target = state.players.find((item) => item.id === player.cardParameters.targetPlayerId);
      const targetForEffect = reflectedSources.has(player.id) ? state.players.find((item) => item.id === player.id) : target;
      const deferred = deferredSources.has(player.id);
      const canceled = canceledPressureSources.has(player.id);
      const umbrellaPrevented = umbrellaPreventedSources.has(player.id) && (targetForEffect?.action?.baseBid ?? 2) < 2;
      const validTarget = Boolean(targetForEffect?.action && !waxCanceled.has(player.id));
      const targetBaseBid = targetForEffect?.action?.baseBid ?? 0;
      const highBidTaxPaid = Boolean(targetForEffect && (taxPaidByTarget.get(targetForEffect.id) ?? 0) > 0);
      const lowBidSuspicionApplied = Boolean(targetForEffect?.action && targetBaseBid < 2
        && targetForEffect.suspicion < GAME_CONFIG.maximumSuspicion && !umbrellaPrevented);
      const applied = validTarget && (targetBaseBid >= 2 ? highBidTaxPaid : lowBidSuspicionApplied);
      recordCard(player, deferred ? "applied" : applied && !canceled ? "applied" : "no-op", deferred ? "pressure-effect-deferred-by-card-58" : canceled ? "pressure-effect-canceled-by-card-58" : umbrellaPrevented ? "low-bid-suspicion-prevented-by-card-50" : !validTarget ? "no-valid-unshielded-target" : targetBaseBid >= 2 ? highBidTaxPaid ? "target-paid-auction-tax" : "target-could-not-pay-auction-tax" : lowBidSuspicionApplied ? "target-gained-suspicion-from-low-bid" : "target-suspicion-already-at-cap");
    }
    if (player.lockedCardId === 36) {
      const target = state.players.find((item) => item.id === player.cardParameters.targetPlayerId);
      const targetForEffect = reflectedSources.has(player.id) ? state.players.find((item) => item.id === player.id) : target;
      const deferred = deferredSources.has(player.id);
      const canceled = canceledPressureSources.has(player.id);
      const applied = Boolean(targetForEffect && targetForEffect.suspicion >= 1 && targetForEffect.suspicion < GAME_CONFIG.maximumSuspicion && !waxCanceled.has(player.id) && !deferred);
      const umbrellaPrevented = umbrellaPreventedSources.has(player.id);
      recordCard(player, deferred ? "applied" : applied && !umbrellaPrevented && !canceled ? "applied" : "no-op", deferred ? "pressure-effect-deferred-by-card-58" : canceled ? "pressure-effect-canceled-by-card-58" : umbrellaPrevented ? "suspicion-prevented-by-card-50" : applied ? "target-already-had-suspicion" : "target-had-no-suspicion-or-was-shielded", applied && !umbrellaPrevented && !canceled ? { targetPlayerId: targetForEffect!.id, suspicionAdded: 1, ...(reflectedSources.has(player.id) ? { reflected: true } : {}) } : undefined);
    }
    if (player.lockedCardId === 38) {
      const target = state.players.find((item) => item.id === player.cardParameters.targetPlayerId);
      recordCard(player, target?.action?.stance.kind !== "pass" && Boolean(target) ? "applied" : "no-op", target?.action?.stance.kind !== "pass" ? "target-stance-revealed-before-the-rest" : "target-submitted-no-stance");
    }
    if (player.lockedCardId === 41) {
      const target = state.players.find((item) => item.id === player.cardParameters.targetPlayerId);
      const targetForEffect = reflectedSources.has(player.id) ? player : target;
      const applied = Boolean(targetForEffect && targetForEffect.seals === Math.max(...state.players.map((item) => item.seals)) && !waxCanceled.has(player.id));
      recordCard(player, applied ? "applied" : "no-op", applied ? "spotlight-reduced-a-leader-bid" : "target-was-not-an-unshielded-leader", applied ? { targetPlayerId: targetForEffect!.id, bidPenalty: 1, ...(reflectedSources.has(player.id) ? { reflected: true } : {}) } : undefined);
    }
    if (player.lockedCardId === 44) {
      const targetId = player.cardParameters.targetPlayerId;
      const applied = typeof targetId === "string" && rewardlessWinners.has(targetId) && winnerForPlayer.has(targetId) && !protectedRewardLots.has(winnerForPlayer.get(targetId)!);
      recordCard(player, applied ? "applied" : "no-op", applied ? "leader-won-seal-without-printed-reward" : "target-did-not-win-or-was-not-ahead-on-seals", applied ? { targetPlayerId: targetId, rewardDisabled: true } : undefined);
    }
    if (player.lockedCardId === 46) {
      const targetId = player.cardParameters.targetPlayerId;
      const incoming = typeof targetId === "string" && state.players.some((owner) => waxCanceled.has(owner.id) && owner.cardParameters.targetPlayerId === targetId);
      recordCard(player, incoming ? "applied" : "no-op", incoming ? "wax-shield-canceled-first-targeted-effect" : "no-targeted-card-effect-arrived", incoming ? { targetPlayerId: targetId } : undefined);
    }
    if (player.lockedCardId === 52) {
      const reflected = (state.cardResponses ?? []).some((response) => response.cardId === 52 && response.targetPlayerId === player.id && response.choice === "reflect");
      recordCard(player, reflected ? "applied" : "no-op", reflected ? "reflected-one-targeted-negative-effect" : "no-reflectable-effect-was-reflected");
    }
    if (player.lockedCardId === 58) {
      const delayed = (state.cardResponses ?? []).filter((response) => response.cardId === 58 && response.targetPlayerId === player.id && response.choice === "defer").length;
      const canceled = (state.cardResponses ?? []).filter((response) => response.cardId === 58 && response.targetPlayerId === player.id && response.choice === "cancel").length;
      recordCard(player, delayed || canceled ? "applied" : "no-op", canceled ? "paid-to-cancel-the-pressure-effect" : delayed ? "delayed-a-pressure-effect-to-next-round-end" : "no-delayable-pressure-effect-arrived", delayed || canceled ? { effectsDelayed: delayed, effectsCanceled: canceled } : undefined);
    }
    if (player.lockedCardId === 49) recordCard(player, player.action?.lotId ? "applied" : "no-op", player.action?.lotId ? "withdrew-and-refunded-full-base-bid" : "passed-without-an-auction", player.action?.lotId ? { refund: player.action.baseBid } : undefined);
    if (player.lockedCardId === 50) {
      const incomingSourceId = umbrellaBlockedByPlayer.get(player.id);
      recordCard(player, incomingSourceId ? "applied" : "no-op", incomingSourceId ? "umbrella-prevented-one-pressure-suspicion" : "no-pressure-suspicion-to-prevent", incomingSourceId ? { suspicionPrevented: 1, sourcePlayerId: incomingSourceId } : undefined);
    }
    if (player.lockedCardId === 51) recordCard(player, "no-op", "no-card-attempted-to-change-this-players-lot");
    if (player.lockedCardId === 53) recordCard(player, "no-op", "no-card-in-the-current-set-can-remove-a-seal");
    if (player.lockedCardId === 57) recordCard(player, protectedRewardLots.has(String(player.cardParameters.targetLotId ?? "")) ? "applied" : "no-op", "selected-lot-reward-protection-checked", { lotId: player.cardParameters.targetLotId });
    if (player.lockedCardId === 60) {
      const qualifies = player.seals >= Math.max(...state.players.map((item) => item.seals)) - 1
        && (state.finalRoundIndex === state.roundIndex || state.roundIndex >= state.settings.roundLimit || state.roundIndex >= GAME_CONFIG.maximumRoundLimit);
      const choice = player.cardParameters.lastPageChoice;
      recordCard(player, qualifies ? "applied" : "no-op", qualifies ? "final-round-last-page-choice" : "not-in-final-round-or-too-far-behind", qualifies ? { choice } : undefined);
    }
    return next;
  }) };

  // The reward is applied only after winners are fixed. A card draw is private.
  for (const lot of lots) {
    if (!lot.winnerPlayerId) continue;
    const player = current.players.find((item) => item.id === lot.winnerPlayerId)!;
    if (rewardlessWinners.has(player.id) && !protectedRewardLots.has(lot.id)) continue;
    if (lot.rewardType === "influence") {
      current = { ...current, players: current.players.map((item) => item.id === player.id
        ? { ...item, influence: Math.min(GAME_CONFIG.maximumInfluence, item.influence + lot.rewardAmount) }
        : item) };
    } else if (lot.rewardType === "remove-suspicion") {
      current = { ...current, players: current.players.map((item) => item.id === player.id
        ? { ...item, suspicion: Math.max(0, item.suspicion - lot.rewardAmount) }
        : item) };
    } else {
      const drawn = drawCardForPlayer(current, player.id);
      current = drawn;
    }
  }
  for (const owner of state.players) {
    if (owner.lockedCardId !== 54) continue;
    if (wonPlayerIds.has(owner.id)) {
      recordCard(owner, "no-op", "won-a-lot-this-round");
      continue;
    }
    current = { ...current, players: current.players.map((item) => item.id === owner.id ? changeInfluence(item, 1) : item) };
    recordCard(owner, "applied", "no-lot-won-gained-influence", { influence: 1 });
  }

  for (const owner of state.players) {
    if (![33, 39, 42, 45].includes(owner.lockedCardId ?? 0)) continue;
    if (waxCanceled.has(owner.id)) {
      recordCard(owner, "no-op", "wax-seal-canceled-this-targeted-effect", { targetPlayerId: owner.cardParameters.targetPlayerId });
      continue;
    }
    const saved = responseFor(owner.id, owner.lockedCardId as 33 | 39 | 42 | 45);
    const targetId = saved?.effectCardId === 52 ? owner.id : owner.cardParameters.targetPlayerId;
    const target = typeof targetId === "string" ? current.players.find((item) => item.id === targetId) : undefined;
    if (!target || (owner.lockedCardId === 45 && saved?.effectCardId !== 52 && !target.action?.lotId)) {
      recordCard(owner, "no-op", owner.lockedCardId === 45 ? "target-did-not-enter-an-auction" : "no-target-selected");
      continue;
    }
    const eligibleCards = target.hand.filter((cardId) => cardId !== target.lockedCardId);
    const defaultChoice: CardResponse["choice"] = owner.lockedCardId === 33 ? (eligibleCards.length ? "reveal-card" : undefined)
      : owner.lockedCardId === 39 || owner.lockedCardId === 42 ? (target.influence > 0 ? "pay" : eligibleCards.length ? (owner.lockedCardId === 39 ? "reveal-card" : "reveal-category") : undefined)
        : target.influence > 0 ? "pay" : "suspicion";
    const choice = saved?.choice ?? defaultChoice;
    if (owner.lockedCardId === 33 || owner.lockedCardId === 39 || owner.lockedCardId === 42) {
      if ((choice === "reveal-card" || choice === "reveal-category") && eligibleCards.length > 0) {
        const cardId = saved?.revealedCardId ?? eligibleCards[0]!;
        const sourceCard = CARD_SOURCE.find((card) => card.id === cardId);
        const revealed = owner.lockedCardId === 42
          ? { category: sourceCard?.category ?? "unknown" }
          : { cardId, name: sourceCard?.name ?? `بطاقة ${cardId}` };
        current = { ...current, events: [...current.events, event(current, "target-card-revealed", "public", {
          sourcePlayerId: owner.id,
          targetPlayerId: target.id,
          sourceCardId: owner.lockedCardId,
          ...revealed,
        })] };
        recordCard(owner, "applied", owner.lockedCardId === 33 ? "target-selected-one-card-to-reveal" : owner.lockedCardId === 39 ? "target-chose-card-reveal" : "target-chose-card-category", { targetPlayerId: target.id, ...revealed });
      } else if (choice === "pay" && target.influence > 0) {
        current = { ...current, players: current.players.map((item) => item.id === target.id ? changeInfluence(item, -1) : item) };
        recordCard(owner, "applied", "target-paid-one-influence", { targetPlayerId: target.id, influenceCost: 1 });
      } else recordCard(owner, "no-op", "target-has-no-valid-response", { targetPlayerId: target.id });
    } else if (choice === "pay" && target.influence > 0) {
      current = { ...current, players: current.players.map((item) => item.id === target.id ? changeInfluence(item, -1) : item) };
      recordCard(owner, "applied", "target-paid-one-influence", { targetPlayerId: target.id, influenceCost: 1 });
    } else if (choice === "suspicion" && target.suspicion < GAME_CONFIG.maximumSuspicion && !umbrellaPreventedSources.has(owner.id)) {
      current = { ...current, players: current.players.map((item) => item.id === target.id ? changeSuspicion(item, 1) : item) };
      recordCard(owner, "applied", "target-took-one-suspicion", { targetPlayerId: target.id, suspicionAdded: 1 });
    } else if (choice === "suspicion") {
      recordCard(owner, "no-op", target.suspicion >= GAME_CONFIG.maximumSuspicion ? "target-suspicion-already-at-cap" : "target-suspicion-prevented-by-card-50", { targetPlayerId: target.id });
    } else recordCard(owner, "no-op", "target-had-no-valid-response", { targetPlayerId: target.id });
  }

  const duePressure = (current.pendingPressureEffects ?? []).filter((effect) => effect.dueRoundIndex <= state.roundIndex);
  if (duePressure.length) {
    let updatedPlayers = current.players;
    for (const effect of duePressure) updatedPlayers = updatedPlayers.map((player) => player.id !== effect.targetPlayerId ? player
      : effect.kind === "influence" ? changeInfluence(player, -effect.amount) : changeSuspicion(player, effect.amount));
    current = { ...current, players: updatedPlayers, pendingPressureEffects: (current.pendingPressureEffects ?? []).filter((effect) => effect.dueRoundIndex > state.roundIndex),
      events: [...current.events, event(current, "deferred-pressure-resolved", "public", { effects: duePressure })] };
  }

  const playerEvents: GameEvent[] = [];
  for (const player of current.players) {
    if (player.suspicion >= GAME_CONFIG.maximumSuspicion) {
      playerEvents.push(event(current, "forced-announcement-scheduled", "public", { playerId: player.id }));
    }
    if (player.lockedCardId !== undefined) current = {
      ...current,
      cardDiscardPile: [...current.cardDiscardPile, player.lockedCardId],
    };
  }
  const startScandal = state.scandal;
  // Once scheduled, the final round index is immutable. In particular, a
  // scandal that remains at 8 during the final round must not schedule a
  // second final round.
  const finalRoundIndex = state.finalRoundIndex
    ?? (current.scandal >= GAME_CONFIG.scandalFinalThreshold && state.roundIndex < GAME_CONFIG.maximumRoundLimit
      ? state.roundIndex + 1
      : undefined);
  const atEnd = state.roundIndex >= state.settings.roundLimit
    || state.roundIndex >= GAME_CONFIG.maximumRoundLimit
    || finalRoundIndex === state.roundIndex;
  const cleanPlayers = current.players.map((player) => ({
    ...player,
    ...(player.suspicion >= GAME_CONFIG.maximumSuspicion && !atEnd
      ? { suspicion: 1, forcedAnnouncement: true }
      : { forcedAnnouncement: false }),
    lockedCardId: undefined,
    cardParameters: {},
    hand: player.lockedCardId === undefined ? player.hand : player.hand.filter((cardId) => cardId !== player.lockedCardId),
    declaration: undefined,
    originalDeclaration: undefined,
    declarationChange: undefined,
    wagers: [],
    wagersLocked: false,
    action: undefined,
    ready: false,
  }));
  const summary = {
    roundIndex: state.roundIndex,
    startScandal,
    endScandal: current.scandal,
    declarations: state.players.map((player) => ({
      playerId: player.id,
      declaration: player.originalDeclaration ?? player.declaration ?? {},
      currentDeclaration: player.declaration ?? {},
      declarationChange: player.declarationChange,
      hiddenField: player.lockedCardId === 23 ? player.action?.cardParameters?.hiddenField : undefined,
    })),
    formalContract: current.formalContract,
    finalActions: current.players.map((player) => ({
      playerId: player.id,
      action: player.action,
      cardId: player.lockedCardId,
      cardParameters: player.cardParameters,
    })),
    cardEffects,
    cardResponses: state.cardResponses ?? [],
    lotResults,
    lots,
    wagers: wagerSummary,
    standings: cleanPlayers.map((player) => ({
      playerId: player.id,
      seals: player.seals,
      wagerScore: player.wagerScore,
      influence: player.influence,
      suspicion: player.suspicion,
    })),
  };
  const finalEvents = [...current.events, ...playerEvents, event(current, "round-resolved", "public", summary)];
  current = {
    ...current,
    players: cleanPlayers,
    phase: atEnd ? "complete" : "round-summary",
    finalRoundMarked: finalRoundIndex !== undefined,
    finalRoundIndex,
    events: finalEvents,
    stateVersion: state.stateVersion + 1,
    phaseDeadlineAt: undefined,
  };
  return { state: current, lots, publicSummary: summary };
}

export function beginNextRound(state: GameState, deadlineAt?: number): GameState {
  if (state.phase !== "round-summary") throw new RuleError("WRONG_PHASE", "The next round is not available yet");
  if (state.roundIndex >= state.settings.roundLimit || state.roundIndex >= GAME_CONFIG.maximumRoundLimit || state.finalRoundIndex === state.roundIndex) {
    return update(state, { phase: "complete", phaseDeadlineAt: undefined });
  }
  let players: GamePlayerState[] = state.players.map((player) => ({
    ...player,
    influence: Math.min(GAME_CONFIG.maximumInfluence, player.influence + GAME_CONFIG.influencePerRound),
    ...(player.forcedAnnouncement ? { suspicion: 1 } : {}),
    lockedCardId: undefined,
    cardParameters: {},
    declaration: undefined,
    originalDeclaration: undefined,
    declarationChange: undefined,
    wagers: [],
    wagersLocked: false,
    action: undefined,
    ready: false,
  }));
  let current: GameState = {
    ...state,
    phase: "declaration",
    roundIndex: state.roundIndex + 1,
    stateVersion: state.stateVersion + 1,
    firstSeatIndex: (state.firstSeatIndex + 1) % players.length,
    players,
    lots: [],
    formalContract: undefined,
    cardResponses: [],
    phaseDeadlineAt: deadlineAt,
  };
  // Rotate the player order for tie-independent reveal/event ordering.
  const first = current.players.findIndex((player) => player.seatIndex === current.firstSeatIndex);
  players = [...current.players.slice(first), ...current.players.slice(0, first)];
  current = { ...current, players };
  current = drawCardForAll(current);
  return current;
}

function drawCardForAll(state: GameState): GameState {
  let current = state;
  for (const player of [...current.players]) current = drawCardForPlayer(current, player.id);
  return drawLots(current);
}

export function skipMissingInputs(state: GameState, nextDeadline?: number): GameState {
  let current = state;
  if (state.phase === "declaration") {
    for (const player of current.players.filter((item) => !item.declaration)) {
      current = submitDeclaration(current, player.id, player.forcedAnnouncement && current.lots[0] ? { targetLotId: current.lots[0].id } : {});
    }
  } else if (state.phase === "wager-commit") {
    for (const player of current.players.filter((item) => !item.wagersLocked)) current = submitWagers(current, player.id, []);
  } else if (state.phase === "negotiation") {
    current = endNegotiation(current);
  } else if (state.phase === "final-action") {
    for (const player of current.players.filter((item) => !item.action)) {
      current = submitFinalAction(current, player.id, { baseBid: 0, stance: { kind: "pass" } });
    }
  } else if (state.phase === "card-response") {
    const cardResponses = (current.cardResponses ?? []).map((prompt) => {
      if (prompt.resolved) return prompt;
      const target = current.players.find((item) => item.id === prompt.targetPlayerId);
      const availableCards = target?.hand.filter((cardId) => cardId !== target.lockedCardId) ?? [];
      const choice: CardResponse["choice"] = prompt.cardId === 33 ? (availableCards.length ? "reveal-card" : undefined)
        : prompt.cardId === 39 ? (target?.influence ? "pay" : availableCards.length ? "reveal-card" : undefined)
          : prompt.cardId === 42 ? (target?.influence ? "pay" : availableCards.length ? "reveal-category" : undefined)
            : prompt.cardId === 45 ? target?.influence ? "pay" : "suspicion"
              : "allow";
      return { ...prompt, ...(choice ? { choice } : {}), ...(availableCards[0] === undefined ? {} : { revealedCardId: availableCards[0] }), resolved: true };
    });
    const followUps: CardResponse[] = [];
    for (const response of cardResponses.filter((item) => item.cardId === 52 && item.effectCardId !== undefined)) {
      if (![33, 39, 42, 45].includes(response.effectCardId ?? 0)) continue;
      const targetPlayerId = response.choice === "reflect" ? response.sourcePlayerId : response.targetPlayerId;
      if (cardResponses.some((item) => item.sourcePlayerId === response.sourcePlayerId && item.targetPlayerId === targetPlayerId && item.cardId === response.effectCardId)) continue;
      followUps.push({
        sourcePlayerId: response.sourcePlayerId,
        targetPlayerId,
        cardId: response.effectCardId as 33 | 39 | 42 | 45,
        ...(response.choice === "reflect" ? { effectCardId: 52 } : {}),
        resolved: false,
      });
    }
    current = {
      ...current,
      cardResponses: [...cardResponses, ...followUps],
      phase: followUps.length ? "card-response" : "resolution",
      phaseDeadlineAt: undefined,
      stateVersion: current.stateVersion + 1,
    };
  }
  return { ...current, ...(nextDeadline === undefined ? {} : { phaseDeadlineAt: nextDeadline }) };
}
