import { CARD_SOURCE } from "./cards.js";
import { GAME_CONFIG } from "./constants.js";
import { getLotCount, validateTeamSizes } from "./auction.js";
import { LOT_CATALOG } from "./lots.js";
import { deterministicShuffle } from "./random.js";
import type { GameEvent, GamePlayerState, GameState, ParticipantSeed, RoomSettings } from "./types.js";

export class RuleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuleError";
  }
}

function appendEvent(state: GameState, event: Omit<GameEvent, "id" | "sequence" | "roundIndex">): GameState {
  const sequence = state.events.length + 1;
  const fullEvent: GameEvent = {
    ...event,
    id: `${state.gameId}:${sequence}`,
    sequence,
    roundIndex: state.roundIndex,
  };
  return { ...state, events: [...state.events, fullEvent] };
}

function drawCard(state: GameState, player: GamePlayerState): { state: GameState; player: GamePlayerState } {
  if (player.hand.length >= GAME_CONFIG.handLimit) return { state, player };
  let current = state;
  if (current.cardDrawPile.length === 0 && current.cardDiscardPile.length > 0) {
    const shuffled = deterministicShuffle(current.cardDiscardPile, current.randomState);
    current = {
      ...current,
      cardDrawPile: shuffled.items,
      cardDiscardPile: [],
      randomState: shuffled.state,
    };
    current = appendEvent(current, {
      type: "card-pile-shuffled",
      visibility: "server-only",
      payload: { count: shuffled.items.length },
    });
  }
  const cardId = current.cardDrawPile[0];
  if (cardId === undefined) return { state: current, player };
  current = { ...current, cardDrawPile: current.cardDrawPile.slice(1) };
  current = appendEvent(current, {
    type: "card-drawn",
    visibility: "owner-only",
    ownerPlayerId: player.id,
    payload: { cardId },
  });
  return { state: current, player: { ...player, hand: [...player.hand, cardId] } };
}

function makeLotDeck(seed: number): { order: string[]; state: number } {
  const shuffled = deterministicShuffle(LOT_CATALOG.map((lot) => lot.id), seed);
  return { order: shuffled.items, state: shuffled.state };
}

export function drawLots(state: GameState): GameState {
  const count = getLotCount(state.players.length);
  let { lotDeck, lotDeckCursor, randomState } = state;
  const needFreshDeck = lotDeck.length - lotDeckCursor < count;
  if (needFreshDeck) {
    const shuffled = makeLotDeck(randomState);
    lotDeck = shuffled.order;
    lotDeckCursor = 0;
    randomState = shuffled.state;
  }
  const ids = lotDeck.slice(lotDeckCursor, lotDeckCursor + count);
  const lots = ids.map((id) => {
    const definition = LOT_CATALOG.find((lot) => lot.id === id);
    if (!definition) throw new RuleError("INVALID_LOT_DECK", `Unknown lot ${id}`);
    return { ...definition, status: "open" as const };
  });
  return {
    ...state,
    lotDeck,
    lotDeckCursor: lotDeckCursor + count,
    randomState,
    lots,
  };
}

export function createGameState(input: {
  gameId: string;
  participants: readonly ParticipantSeed[];
  settings: RoomSettings;
  seed: number;
  firstSeatIndex?: number;
}): GameState {
  const { participants, settings } = input;
  if (participants.length < GAME_CONFIG.minimumPlayers || participants.length > GAME_CONFIG.maximumPlayers) {
    throw new RuleError("INVALID_PLAYER_COUNT", `Games require ${GAME_CONFIG.minimumPlayers}–${GAME_CONFIG.maximumPlayers} players`);
  }
  if (settings.mode === "teams" && !validateTeamSizes(participants.length, settings.teamSizes ?? [])) {
    throw new RuleError("INVALID_TEAMS", "Team mode requires complete, equal teams of two or three");
  }
  if (!Number.isInteger(settings.roundLimit) || settings.roundLimit < 1 || settings.roundLimit > GAME_CONFIG.maximumRoundLimit) {
    throw new RuleError("INVALID_ROUND_LIMIT", `Round limit must be between 1 and ${GAME_CONFIG.maximumRoundLimit}`);
  }

  const shuffledCards = deterministicShuffle(CARD_SOURCE.map((card) => card.id), input.seed >>> 0);
  let remaining = shuffledCards.items;
  const players: GamePlayerState[] = participants.map((participant) => {
    const hand = remaining.slice(0, GAME_CONFIG.initialHandSize);
    remaining = remaining.slice(GAME_CONFIG.initialHandSize);
    return {
      ...participant,
      influence: GAME_CONFIG.startingInfluence,
      seals: GAME_CONFIG.startingSeals,
      suspicion: GAME_CONFIG.startingSuspicion,
      wagerScore: 0,
      hand,
      lockedCardId: undefined,
      cardParameters: {},
      declaration: undefined,
      originalDeclaration: undefined,
      declarationChange: undefined,
      action: undefined,
      wagers: [],
      wagersLocked: false,
      connected: true,
      ready: false,
      forcedAnnouncement: false,
    };
  });
  const lotSeed = shuffledCards.state;
  const lotDeck = makeLotDeck(lotSeed);
  const state: GameState = {
    gameId: input.gameId,
    mode: settings.mode,
    settings: { ...settings },
    roundIndex: 0,
    phase: "round-start",
    stateVersion: 1,
    firstSeatIndex: input.firstSeatIndex ?? 0,
    scandal: 0,
    finalRoundMarked: false,
    randomState: lotDeck.state,
    cardDrawPile: remaining,
    cardDiscardPile: [],
    lotDeck: lotDeck.order,
    lotDeckCursor: 0,
    lots: [],
    players,
    events: [],
    phaseDeadlineAt: undefined,
    finalRoundIndex: undefined,
    paused: false,
  };
  let current: GameState = {
    ...state,
    roundIndex: 1,
    phase: "declaration",
    stateVersion: 2,
    players: players.map((player) => ({
      ...player,
      influence: Math.min(GAME_CONFIG.maximumInfluence, player.influence + GAME_CONFIG.influencePerRound),
      ready: false,
      declaration: undefined,
      originalDeclaration: undefined,
      declarationChange: undefined,
      wagers: [],
      wagersLocked: false,
      action: undefined,
    })),
  };
  current = drawLots(current);
  current = appendEvent(current, {
    type: "round-started",
    visibility: "public",
    payload: { roundIndex: 1, lotIds: current.lots.map((lot) => lot.id) },
  });
  for (const player of current.players) {
    const drawn = drawCard(current, player);
    current = drawn.state;
    current = {
      ...current,
      players: current.players.map((item) => item.id === player.id ? drawn.player : item),
    };
  }
  return current;
}

export function drawCardForPlayer(state: GameState, playerId: string): GameState {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) throw new RuleError("PLAYER_NOT_FOUND", "Player is not in this game");
  const drawn = drawCard(state, player);
  return {
    ...drawn.state,
    players: drawn.state.players.map((item) => item.id === playerId ? drawn.player : item),
  };
}

export function withPhaseDeadline(state: GameState, deadlineAt: number): GameState {
  return { ...state, phaseDeadlineAt: deadlineAt, stateVersion: state.stateVersion + 1 };
}

export function markPlayerConnected(state: GameState, playerId: string, connected: boolean): GameState {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) throw new RuleError("PLAYER_NOT_FOUND", "Player is not in this game");
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    players: state.players.map((item) => item.id === playerId ? { ...item, connected } : item),
  };
}
