import { GAME_CONFIG } from "./constants.js";
import { calculateEffectiveBid, resolveLotAuction } from "./auction.js";
import { drawCardForPlayer, drawLots, RuleError } from "./game.js";
import type { Declaration, FinalAction, GameEvent, GamePlayerState, GameState, Wager, WagerPredicate } from "./types.js";

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
  if (cardId === 37) {
    if (Object.keys(cardParameters).some((key) => key !== "targetLotId") || typeof cardParameters.targetLotId !== "string") {
      throw new RuleError("INVALID_CARD_PARAMETERS", "Card 37 requires one target lot");
    }
    if (!state.lots.some((lot) => lot.id === cardParameters.targetLotId)) {
      throw new RuleError("INVALID_LOT", "Choose an open lot for card 37");
    }
  } else if (Object.keys(cardParameters).length > 0) {
    throw new RuleError("INVALID_CARD_PARAMETERS", "This card does not accept those parameters");
  }
  if (cardId !== undefined && ![1, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 15, 16, 18, 21, 22, 23, 25, 26, 31, 32, 35, 37, 40, 43, 47, 48, 54, 56].includes(cardId)) {
    throw new RuleError("CARD_NOT_IMPLEMENTED", "This card is recorded but its effect is not available yet");
  }
  if (cardId !== 37 && Object.keys(cardParameters).length > 0) {
    throw new RuleError("INVALID_CARD_PARAMETERS", "This card does not accept those parameters");
  }
  if (cardId === 16 && (!declaration.targetLotId || !declaration.alternateLotId)) {
    throw new RuleError("INVALID_DECLARATION", "Card 16 requires two different announced lots");
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
  if ([8, 12, 21, 25, 26, 31].includes(player.lockedCardId ?? 0)) {
    if (targetPlayerId !== undefined) {
      if (typeof targetPlayerId !== "string") throw new RuleError("INVALID_CARD_TARGET", "Choose a player for this card");
      validateTarget(state, playerId, targetPlayerId);
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
  const finalAction: FinalAction = {
    ...structuredClone(action),
    ...(player.lockedCardId === undefined ? {} : { cardId: player.lockedCardId }),
    locked: true,
  };
  const players = state.players.map((item) => item.id === playerId ? { ...item, action: finalAction } : item);
  let next = update(state, { players });
  next = maybeAdvance(next, "resolution", (item) => Boolean(item.action));
  if (next.phase === "resolution") {
    next = {
      ...next,
      events: [...next.events, event(next, "actions-revealed", "public", {
        actions: next.players.map((item) => ({ playerId: item.id, action: item.action })),
      })],
    };
  }
  return next;
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

  const crowdCounts = new Map(state.lots.map((lot) => [lot.id, state.players.filter((player) => player.action?.lotId === lot.id).length]));
  const maxCrowd = Math.max(0, ...crowdCounts.values());
  const minCrowd = Math.min(...crowdCounts.values());
  const harshFees = new Map(state.players.map((player) => {
    const action = player.action;
    const targetedCount = state.players.filter((owner) => owner.lockedCardId === 37
      && owner.cardParameters.targetLotId === player.originalDeclaration?.targetLotId).length;
    const card3Cost = player.lockedCardId === 3 && action?.lotId ? 1 : 0;
    const chargeCount = action && action.baseBid < 1 ? targetedCount : 0;
    const payable = Math.max(0, player.influence - (action?.baseBid ?? 0) - card3Cost);
    return [player.id, Math.min(chargeCount, payable)] as const;
  }));
  const invoiceActive = state.players.some((player) => player.lockedCardId === 40);
  const invoiceFees = new Map(state.players.map((player) => {
    const action = player.action;
    if (!invoiceActive || !action) return [player.id, 0] as const;
    const card3Cost = player.lockedCardId === 3 && action.lotId ? 1 : 0;
    const afterBidAndOtherCosts = player.influence - action.baseBid - card3Cost - (harshFees.get(player.id) ?? 0);
    return [player.id, afterBidAndOtherCosts >= 4 ? 1 : 0] as const;
  }));

  function makeBidEntry(player: GamePlayerState, lotId: string, lastBidBonus = false) {
    const action = player.action!;
    const params = { ...player.cardParameters, ...action.cardParameters };
    let cardBonus = 0;
    if (player.lockedCardId === 1 && player.declaration?.targetLotId === lotId) cardBonus += 1;
    if (player.lockedCardId === 3 && action.lotId) cardBonus += 2;
    if (player.lockedCardId === 16 && player.declaration?.alternateLotId) {
      const firstCount = crowdCounts.get(player.declaration.targetLotId ?? "") ?? Infinity;
      const secondCount = crowdCounts.get(player.declaration.alternateLotId) ?? Infinity;
      if (action.lotId === player.declaration.targetLotId && firstCount < secondCount) cardBonus += 1;
      if (action.lotId === player.declaration.alternateLotId && secondCount < firstCount) cardBonus += 1;
    }
    if (player.lockedCardId === 22 && player.declaration?.bidBand) {
      const announcedHigh = player.declaration.bidBand === "2-3";
      const actualHigh = action.baseBid >= 2;
      if (announcedHigh !== actualHigh) cardBonus += 1;
    }
    const crowdPressureCount = state.players.filter((owner) => owner.lockedCardId === 35).length;
    const cardPenalty = crowdPressureCount > 0 && maxCrowd >= 3 && crowdCounts.get(lotId) === maxCrowd ? crowdPressureCount : 0;
    if (lastBidBonus) cardBonus += 1;
    const advance = player.lockedCardId === 10 ? 1 : 0;
    const cardCost = player.lockedCardId === 3 && action.lotId ? 1 : 0;
    return {
      playerId: player.id,
      lotId,
      baseBid: action.baseBid,
      seals: player.seals,
      influence: Math.max(0, Math.min(GAME_CONFIG.maximumInfluence, player.influence + advance) - cardCost - (harshFees.get(player.id) ?? 0) - (invoiceFees.get(player.id) ?? 0) - (lastBidBonus ? 1 : 0)),
      trustBonus: trustBonuses.get(player.id) ?? 0,
      cardBonus,
      ...(cardPenalty ? { cardPenalty } : {}),
    };
  }

  const actionPlayers = state.players.filter((player) => player.action?.lotId);
  const wonPlayerIds = new Set<string>();
  const lotResults = state.lots.map((lot) => {
    // A player can earn at most one seal per round. Lots are resolved in the
    // public lot order so this rule never depends on packet arrival order.
    const candidates = actionPlayers.filter((player) => player.action?.lotId === lot.id && !wonPlayerIds.has(player.id));
    let entries = candidates.map((player) => makeBidEntry(player, lot.id));
    const beforeLastBid = entries.map((entry) => ({ entry, effective: calculateEffectiveBid(entry).effectiveBid }));
    const highestBeforeLastBid = Math.max(-1, ...beforeLastBid.map((item) => item.effective));
    entries = entries.map((entry) => {
      const player = state.players.find((item) => item.id === entry.playerId)!;
      const current = beforeLastBid.find((item) => item.entry.playerId === player.id)!;
      const remainingAfterBaseBid = entry.influence - entry.baseBid;
      const triggersLastBid = player.lockedCardId === 14
        && current.effective === highestBeforeLastBid - 1
        && remainingAfterBaseBid >= 1;
      if (player.lockedCardId === 14) recordCard(player,
        triggersLastBid ? "applied" : "no-op",
        triggersLastBid ? "one-below-highest-paid-one" : "not-one-below-or-unaffordable",
        triggersLastBid ? { influenceCost: 1, bidBonus: 1 } : undefined);
      return triggersLastBid ? makeBidEntry(player, lot.id, true) : entry;
    });
    const result = resolveLotAuction(lot.id, entries);
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
  let players = state.players.map((player) => {
    const result = lotResults.flatMap((lot) => lot.bidResolutions).find((bid) => bid.playerId === player.id);
    const action = player.action;
    const gainedSuspicion = state.players.some((owner) => owner.action?.stance.kind === "doubt" && owner.action.stance.targetPlayerId === player.id) ? 1 : 0;
    const contradictedBand = player.lockedCardId === 22 && Boolean(player.declaration?.bidBand)
      && (player.declaration!.bidBand === "2-3") !== ((action?.baseBid ?? 0) >= 2);
    const entry = result;
    let influence = entry?.influenceAfter ?? player.influence;
    if (!entry) influence = Math.max(0, influence - (harshFees.get(player.id) ?? 0) - (invoiceFees.get(player.id) ?? 0));
    if (player.lockedCardId === 10 && !entry) influence = Math.min(GAME_CONFIG.maximumInfluence, influence + 1);
    let suspicion = Math.max(0, Math.min(GAME_CONFIG.maximumSuspicion, player.suspicion + gainedSuspicion + (contradictedBand ? 1 : 0)));
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
    const currentOwner = current.players.find((player) => player.id === owner.id)!;
    const target = typeof targetId === "string" ? current.players.find((player) => player.id === targetId) : undefined;
    if (!target) {
      recordCard(owner, "no-op", "no-target-selected");
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
        current = { ...current, players: current.players.map((player) => player.id === target.id ? changeSuspicion(player, 1) : player) };
        recordCard(owner, "applied", "target-kept-the-announced-lot", { targetPlayerId: target.id, suspicionAdded: 1 });
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
      current = { ...current, players: current.players.map((player) => player.id === target.id ? changeSuspicion(player, 1) : player) };
      recordCard(owner, "applied", "target-changed-the-announced-lot", { targetPlayerId: target.id, suspicionAdded: 1 });
    } else {
      const cost = Math.min(1, currentOwner.influence);
      current = { ...current, players: current.players.map((player) => player.id === owner.id ? changeInfluence(player, -1) : player) };
      recordCard(owner, "applied", "target-kept-the-announced-lot-owner-pays", { targetPlayerId: target.id, influenceCost: cost });
    }
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
      const firstCount = crowdCounts.get(player.declaration?.targetLotId ?? "") ?? Infinity;
      const secondCount = crowdCounts.get(player.declaration?.alternateLotId ?? "") ?? Infinity;
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
    if (player.lockedCardId === 22) {
      const contradicted = Boolean(player.declaration?.bidBand)
        && (player.declaration!.bidBand === "2-3") !== ((player.action?.baseBid ?? 0) >= 2);
      recordCard(player, contradicted ? "applied" : "no-op",
        contradicted ? "base-bid-contradicted-announced-band" : "base-bid-matched-or-no-band",
        contradicted ? { bidBonus: 1, suspicionAdded: 1 } : undefined);
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
      if (wonLotId && crowdCounts.get(wonLotId) === maxCrowd) {
        next = changeInfluence(next, 1);
        recordCard(player, "applied", "won-a-most-crowded-lot", { influence: 1 });
      } else if (wonLotId && crowdCounts.get(wonLotId) === minCrowd) {
        next = changeSuspicion(next, -1);
        recordCard(player, "applied", "won-a-least-crowded-lot", { suspicionRemoved: 1 });
      } else recordCard(player, "no-op", "winning-lot-does-not-qualify-as-most-or-least-crowded");
    }
    if (player.lockedCardId === 37) {
      const targetLotId = player.cardParameters.targetLotId;
      const affected = state.players.filter((target) => target.originalDeclaration?.targetLotId === targetLotId);
      recordCard(player, affected.length ? "applied" : "no-op",
        affected.length ? "announcers-must-bid-at-least-one-or-pay" : "no-player-announced-target-lot",
        { targetLotId, affectedPlayerIds: affected.map((target) => target.id), totalInfluencePaid: affected.reduce((sum, target) => sum + (harshFees.get(target.id) ?? 0), 0) });
    }
    if (player.lockedCardId === 40) {
      const eligible = state.players.filter((target) => (invoiceFees.get(target.id) ?? 0) > 0);
      recordCard(player, eligible.length ? "applied" : "no-op",
        eligible.length ? "influence-invoice-collected" : "no-player-had-four-remaining-influence",
        { paidPlayerIds: eligible.map((target) => target.id), influenceEach: 1 });
    }
    return next;
  }) };

  // The reward is applied only after winners are fixed. A card draw is private.
  for (const lot of lots) {
    if (!lot.winnerPlayerId) continue;
    const player = current.players.find((item) => item.id === lot.winnerPlayerId)!;
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
    if (owner.lockedCardId !== 54 || wonPlayerIds.has(owner.id)) continue;
    current = { ...current, players: current.players.map((item) => item.id === owner.id ? changeInfluence(item, 1) : item) };
    recordCard(owner, "applied", "no-lot-won-gained-influence", { influence: 1 });
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
    finalActions: state.players.map((player) => ({
      playerId: player.id,
      action: player.action,
      cardId: player.lockedCardId,
      cardParameters: player.cardParameters,
    })),
    cardEffects,
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
  }
  return { ...current, ...(nextDeadline === undefined ? {} : { phaseDeadlineAt: nextDeadline }) };
}
