export type GameMode = "free-for-all" | "teams";
export type CardCategory = "bargaining" | "misdirection" | "pressure" | "response-protection";
export type GamePhase =
  | "round-start"
  | "declaration"
  | "wager-commit"
  | "negotiation"
  | "final-action"
  | "card-response"
  | "resolution"
  | "round-summary"
  | "complete";

export type LotRewardType = "influence" | "draw-card" | "remove-suspicion";

export interface RoomSettings {
  mode: GameMode;
  roundLimit: number;
  chatEnabled: boolean;
  negotiationSeconds: number;
  storyId?: string;
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
  illusionStance?: "trust" | "doubt";
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

export interface CardResponse {
  sourcePlayerId: string;
  targetPlayerId: string;
  cardId: 33 | 39 | 42 | 45 | 52 | 58;
  effectCardId?: number;
  choice?: "pay" | "reveal-card" | "reveal-category" | "suspicion" | "reflect" | "allow" | "defer" | "cancel";
  revealedCardId?: number;
  resolved: boolean;
}

export interface PendingPressureEffect {
  sourcePlayerId: string;
  targetPlayerId: string;
  sourceCardId: 34 | 36;
  kind: "influence" | "suspicion";
  amount: 1;
  dueRoundIndex: number;
}

export type FormalContractCondition =
  | { kind: "no-bid"; playerId: string; lotId: string }
  | { kind: "different-lots" }
  | { kind: "transfer"; fromPlayerId: string; toPlayerId: string; amount: number };

export interface FormalContract {
  proposerPlayerId: string;
  targetPlayerId: string;
  condition: FormalContractCondition;
  status: "pending" | "accepted" | "declined" | "fulfilled" | "breached" | "voided";
  breachPlayerIds?: string[];
}

export interface ContractBreachRecord {
  roundIndex: number;
  breacherPlayerId: string;
  victimPlayerId: string;
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
  cardResponses?: CardResponse[];
  formalContract?: FormalContract | undefined;
  contractBreachHistory?: ContractBreachRecord[];
  pendingPressureEffects?: PendingPressureEffect[];
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
  cardTieBreakPlayerId?: string;
  tiedPlayerIds: string[];
  bidResolutions: BidResolution[];
}
