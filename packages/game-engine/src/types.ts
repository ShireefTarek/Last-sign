export type GameMode = "free-for-all" | "teams";
export type CardCategory = "bargaining" | "misdirection" | "pressure" | "response-protection";
export type GamePhase =
  | "round-start"
  | "declaration"
  | "wager-commit"
  | "negotiation"
  | "final-action"
  | "resolution"
  | "round-summary"
  | "complete";

export type LotRewardType = "influence" | "draw-card" | "remove-suspicion";

export interface RoomSettings {
  mode: GameMode;
  roundLimit: number;
  chatEnabled: boolean;
  negotiationSeconds: number;
  teamSizes?: number[];
}

export interface ParticipantSeed {
  id: string;
  displayName: string;
  seatIndex: number;
  teamId?: string;
}

export interface Declaration {
  targetLotId?: string;
  alternateLotId?: string;
  bidBand?: "0-1" | "2-3";
  stance?: { kind: "trust" | "doubt"; targetPlayerId: string };
  /** Private choice used only by card 23; omitted from public declaration projections. */
  hiddenField?: "targetLotId" | "bidBand" | "stance";
}

export type WagerPredicate =
  | { kind: "final-lot"; lotId: string }
  | { kind: "base-bid-at-least"; amount: number }
  | { kind: "final-stance"; stance: "trust" | "doubt" | "pass"; targetPlayerId?: string }
  | { kind: "lot-differs-from-declaration" };

export interface Wager {
  targetPlayerId: string;
  type: "read" | "influence";
  predicate: WagerPredicate;
  secondWager: boolean;
  referenceDeclaration?: Declaration;
  locked: boolean;
}

export interface FinalStance {
  kind: "trust" | "doubt" | "pass";
  targetPlayerId?: string;
}

export interface FinalAction {
  lotId?: string;
  baseBid: number;
  stance: FinalStance;
  cardId?: number;
  cardParameters?: Record<string, string | number | boolean>;
  locked: boolean;
}

export interface GamePlayerState extends ParticipantSeed {
  influence: number;
  seals: number;
  suspicion: number;
  wagerScore: number;
  hand: number[];
  lockedCardId: number | undefined;
  cardParameters: Record<string, string | number | boolean>;
  declaration: Declaration | undefined;
  originalDeclaration: Declaration | undefined;
  declarationChange: { fromLotId: string; toLotId: string } | undefined;
  wagers: Wager[];
  wagersLocked: boolean;
  action: FinalAction | undefined;
  connected: boolean;
  ready: boolean;
  forcedAnnouncement: boolean;
}

export interface LotDefinition {
  id: string;
  nameAr: string;
  nameEn: string;
  rewardType: LotRewardType;
  rewardAmount: number;
}

export interface LotState extends LotDefinition {
  status: "open" | "won" | "unclaimed";
  winnerPlayerId?: string;
}

export interface GameEvent {
  id: string;
  sequence: number;
  roundIndex: number;
  type: string;
  visibility: "public" | "owner-only" | "server-only";
  actorPlayerId?: string;
  ownerPlayerId?: string;
  payload: Record<string, unknown>;
}

export interface GameState {
  gameId: string;
  mode: GameMode;
  settings: RoomSettings;
  roundIndex: number;
  phase: GamePhase;
  stateVersion: number;
  firstSeatIndex: number;
  scandal: number;
  finalRoundMarked: boolean;
  finalRoundIndex: number | undefined;
  randomState: number;
  cardDrawPile: number[];
  cardDiscardPile: number[];
  lotDeck: string[];
  lotDeckCursor: number;
  lots: LotState[];
  players: GamePlayerState[];
  events: GameEvent[];
  phaseDeadlineAt: number | undefined;
  paused: boolean;
}

export interface BidEntry {
  playerId: string;
  lotId: string;
  baseBid: number;
  seals: number;
  influence: number;
  trustBonus?: number;
  cardBonus?: number;
  cardPenalty?: number;
  withdrawn?: boolean;
}

export interface BidResolution {
  playerId: string;
  lotId: string;
  baseBid: number;
  effectiveBid: number;
  influenceAfter: number;
  won: boolean;
  calculation: string[];
}

export interface LotAuctionResult {
  lotId: string;
  winnerPlayerId?: string;
  tiedPlayerIds: string[];
  bidResolutions: BidResolution[];
}
