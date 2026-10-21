import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { Server as SocketServer, type Socket } from "socket.io";
import {
  beginNextRound,
  createGameState,
  endNegotiation,
  finishNegotiation,
  markPlayerConnected,
  resolveRound,
  renegotiateDeclaration,
  skipMissingInputs,
  submitDeclaration,
  submitFinalAction,
  submitWagers,
  validateTeamSizes,
  withPhaseDeadline,
  RuleError,
  GAME_CONFIG,
  type GameState,
  type Declaration,
  type FinalAction,
  type WagerPredicate,
  type Wager,
  type RoomSettings,
} from "@akher-tawqee/game-engine";
import { MemoryRoomStore, type GameRoom, type RoomPlayer, type RoomStore } from "./room-store.js";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 6;
const MAX_CHAT_LENGTH = 500;
const REQUEST_CACHE_MS = 30 * 60 * 1000;
const DEFAULT_PHASE_MS = 120_000;

interface Session {
  roomCode: string;
  playerId: string;
}

interface CommandEnvelope {
  version: 1;
  scope: "lobby" | "game";
  requestId: string;
  expectedStateVersion?: number;
  roomCode?: string;
  [key: string]: unknown;
}

interface AckResult {
  ok: boolean;
  requestId: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  snapshot?: Record<string, unknown>;
}

interface ServerOptions {
  host?: string;
  port?: number;
  webOrigin?: string;
  roomTtlMs?: number;
  store?: RoomStore;
}

interface CachedAck {
  expiresAt: number;
  result: AckResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeclaration(value: unknown): Declaration {
  if (!isRecord(value)) throw new RuleError("INVALID_DECLARATION", "الإعلان غير صالح");
  const declaration: Declaration = {};
  for (const key of ["targetLotId", "alternateLotId"] as const) {
    const item = value[key];
    if (item !== undefined) {
      if (typeof item !== "string" || item.length > 100) throw new RuleError("INVALID_DECLARATION", "اختيار القطعة غير صالح");
      declaration[key] = item;
    }
  }
  if (value.bidBand !== undefined) {
    if (value.bidBand !== "0-1" && value.bidBand !== "2-3") throw new RuleError("INVALID_DECLARATION", "نطاق العرض غير صالح");
    declaration.bidBand = value.bidBand;
  }
  if (value.stance !== undefined) {
    if (!isRecord(value.stance) || (value.stance.kind !== "trust" && value.stance.kind !== "doubt") || typeof value.stance.targetPlayerId !== "string") {
      throw new RuleError("INVALID_DECLARATION", "الموقف المعلن غير صالح");
    }
    declaration.stance = { kind: value.stance.kind, targetPlayerId: value.stance.targetPlayerId };
  }
  if (value.hiddenField !== undefined) {
    if (value.hiddenField !== "targetLotId" && value.hiddenField !== "bidBand" && value.hiddenField !== "stance") {
      throw new RuleError("INVALID_DECLARATION", "الحقل المختار للإخفاء غير صالح");
    }
    declaration.hiddenField = value.hiddenField;
  }
  return declaration;
}

function parseCardParameters(value: unknown): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new RuleError("INVALID_CARD_PARAMETERS", "خيارات البطاقة غير صالحة");
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key)
      || (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")
      || (typeof item === "string" && item.length > 100)
      || (typeof item === "number" && !Number.isFinite(item))) {
      throw new RuleError("INVALID_CARD_PARAMETERS", "إحدى قيم البطاقة غير صالحة");
    }
    result[key] = item;
  }
  return result;
}

function parseWagers(value: unknown): Omit<Wager, "locked" | "referenceDeclaration">[] {
  if (!Array.isArray(value)) throw new RuleError("INVALID_WAGERS", "قائمة التوقعات غير صالحة");
  return value.map((item): Omit<Wager, "locked" | "referenceDeclaration"> => {
    if (!isRecord(item) || typeof item.targetPlayerId !== "string" || (item.type !== "read" && item.type !== "influence") || typeof item.secondWager !== "boolean" || !isRecord(item.predicate)) {
      throw new RuleError("INVALID_WAGERS", "أحد التوقعات غير صالح");
    }
    const predicate = item.predicate;
    let parsed: WagerPredicate;
    if (predicate.kind === "final-lot" && typeof predicate.lotId === "string") {
      parsed = { kind: "final-lot", lotId: predicate.lotId };
    } else if (predicate.kind === "base-bid-at-least" && typeof predicate.amount === "number") {
      parsed = { kind: "base-bid-at-least", amount: predicate.amount };
    } else if (predicate.kind === "final-stance" && ["trust", "doubt", "pass"].includes(String(predicate.stance))) {
      if (predicate.targetPlayerId !== undefined && typeof predicate.targetPlayerId !== "string") throw new RuleError("INVALID_WAGERS", "هدف الموقف المتوقع غير صالح");
      parsed = {
        kind: "final-stance",
        stance: predicate.stance as "trust" | "doubt" | "pass",
        ...(typeof predicate.targetPlayerId === "string" ? { targetPlayerId: predicate.targetPlayerId } : {}),
      };
    } else if (predicate.kind === "lot-differs-from-declaration") {
      parsed = { kind: "lot-differs-from-declaration" };
    } else {
      throw new RuleError("INVALID_WAGERS", "نوع شرط التوقع غير مدعوم");
    }
    return { targetPlayerId: item.targetPlayerId, type: item.type, secondWager: item.secondWager, predicate: parsed };
  });
}

function parseFinalAction(value: unknown): Omit<FinalAction, "locked"> {
  if (!isRecord(value) || typeof value.baseBid !== "number" || !isRecord(value.stance)) {
    throw new RuleError("INVALID_ACTION", "الاختيار النهائي غير صالح");
  }
  if (!["trust", "doubt", "pass"].includes(String(value.stance.kind))) throw new RuleError("INVALID_ACTION", "الموقف النهائي غير صالح");
  if (value.stance.targetPlayerId !== undefined && typeof value.stance.targetPlayerId !== "string") throw new RuleError("INVALID_ACTION", "هدف الموقف غير صالح");
  if (value.lotId !== undefined && typeof value.lotId !== "string") throw new RuleError("INVALID_ACTION", "القطعة المختارة غير صالحة");
  if (value.cardId !== undefined && typeof value.cardId !== "number") throw new RuleError("INVALID_ACTION", "معرّف البطاقة غير صالح");
  if (value.cardParameters !== undefined && !isRecord(value.cardParameters)) throw new RuleError("INVALID_ACTION", "خيارات البطاقة غير صالحة");
  const cardParameters = parseCardParameters(value.cardParameters);
  return {
    ...(typeof value.lotId === "string" ? { lotId: value.lotId } : {}),
    baseBid: value.baseBid,
    stance: {
      kind: value.stance.kind as "trust" | "doubt" | "pass",
      ...(typeof value.stance.targetPlayerId === "string" ? { targetPlayerId: value.stance.targetPlayerId } : {}),
    },
    ...(typeof value.cardId === "number" ? { cardId: value.cardId } : {}),
    ...(value.cardParameters === undefined ? {} : { cardParameters }),
  };
}

function commandEnvelope(value: unknown, expectedScope?: CommandEnvelope["scope"]): CommandEnvelope {
  if (!isRecord(value)) throw new RuleError("INVALID_REQUEST", "Request body must be an object");
  if (value.version !== 1 || (value.scope !== "lobby" && value.scope !== "game")) {
    throw new RuleError("INVALID_ENVELOPE", "Request protocol version or scope is invalid");
  }
  if (expectedScope && value.scope !== expectedScope) throw new RuleError("INVALID_SCOPE", "Request scope does not match this action");
  if (typeof value.requestId !== "string" || value.requestId.length < 8 || value.requestId.length > 100) {
    throw new RuleError("INVALID_REQUEST_ID", "A unique requestId is required");
  }
  return value as unknown as CommandEnvelope;
}

function createRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  return code;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function cleanDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new RuleError("INVALID_NAME", "أدخل اسماً ظاهراً بين حرف واحد و20 حرفاً");
  const name = value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/gu, " ").trim();
  const length = [...name].length;
  if (length < 1 || length > 20) throw new RuleError("INVALID_NAME", "الاسم يجب أن يكون بين حرف واحد و20 حرفاً");
  return name;
}

function defaultSettings(playerCount = 3): RoomSettings {
  return {
    mode: "free-for-all",
    roundLimit: GAME_CONFIG.defaultRoundLimit,
    chatEnabled: false,
    negotiationSeconds: playerCount <= 6 ? 90 : 120,
  };
}

function validateSettings(value: unknown, current: RoomSettings, playerCount: number): RoomSettings {
  if (!isRecord(value)) throw new RuleError("INVALID_SETTINGS", "Room settings must be an object");
  const mode = value.mode ?? current.mode;
  if (mode !== "free-for-all" && mode !== "teams") throw new RuleError("INVALID_SETTINGS", "اختَر نمط لعب صحيحاً");
  const roundLimit = value.roundLimit ?? current.roundLimit;
  if (!Number.isInteger(roundLimit) || (roundLimit as number) < 1 || (roundLimit as number) > GAME_CONFIG.maximumRoundLimit) {
    throw new RuleError("INVALID_SETTINGS", "عدد الجولات يجب أن يكون بين 1 و7");
  }
  const chatEnabled = value.chatEnabled ?? current.chatEnabled;
  if (typeof chatEnabled !== "boolean") throw new RuleError("INVALID_SETTINGS", "إعداد الدردشة غير صالح");
  const negotiationSeconds = value.negotiationSeconds ?? current.negotiationSeconds;
  if (!Number.isInteger(negotiationSeconds) || (negotiationSeconds as number) < 30 || (negotiationSeconds as number) > 300) {
    throw new RuleError("INVALID_SETTINGS", "مدة التفاوض يجب أن تكون بين 30 و300 ثانية");
  }
  let teamSizes: number[] | undefined;
  if (value.teamSizes !== undefined) {
    if (!Array.isArray(value.teamSizes) || !value.teamSizes.every((size) => Number.isInteger(size))) {
      throw new RuleError("INVALID_TEAMS", "تكوين الفرق غير صالح");
    }
    teamSizes = value.teamSizes as number[];
  } else if (current.teamSizes) {
    teamSizes = current.teamSizes;
  }
  if (mode === "teams" && teamSizes && teamSizes.reduce((sum, size) => sum + size, 0) > GAME_CONFIG.maximumPlayers) {
    throw new RuleError("INVALID_TEAMS", "تكوين الفرق يتجاوز الحد الأقصى للاعبين");
  }
  return {
    mode,
    roundLimit: roundLimit as number,
    chatEnabled,
    negotiationSeconds: negotiationSeconds as number,
    ...(teamSizes === undefined ? {} : { teamSizes }),
  };
}

function publicGameSnapshot(game: GameState): Record<string, unknown> {
  const revealDeclarations = game.phase !== "declaration";
  const revealActions = ["round-summary", "complete"].includes(game.phase);
  return {
    gameId: game.gameId,
    mode: game.mode,
    roundIndex: game.roundIndex,
    roundLimit: game.settings.roundLimit,
    phase: game.phase,
    stateVersion: game.stateVersion,
    scandal: game.scandal,
    finalRoundMarked: game.finalRoundMarked,
    deadlineAt: game.phaseDeadlineAt,
    paused: game.paused,
    lots: game.lots.map((lot) => ({ ...lot })),
    players: game.players.map((player) => ({
      playerId: player.id,
      displayName: player.displayName,
      seatIndex: player.seatIndex,
      teamId: player.teamId,
      influence: player.influence,
      seals: player.seals,
      suspicion: player.suspicion,
      wagerScore: player.wagerScore,
      connected: player.connected,
      ready: player.ready,
      declarationLocked: player.declaration !== undefined,
      declarationChange: player.declarationChange,
      declarationMasked: player.lockedCardId === 18 && game.phase === "wager-commit",
      oneDeclarationFieldHidden: player.lockedCardId === 23,
      ...(revealDeclarations ? { declaration: publicDeclaration(player, game.phase) } : {}),
      actionLocked: player.action !== undefined,
      ...(revealActions ? { action: player.action } : {}),
    })),
    events: game.events.filter((item) => item.visibility === "public").map((item) => ({
      id: item.id,
      sequence: item.sequence,
      roundIndex: item.roundIndex,
      type: item.type,
      actorPlayerId: item.actorPlayerId,
      payload: item.payload,
    })),
  };
}

function privateGameSnapshot(game: GameState, playerId: string): Record<string, unknown> {
  const player = game.players.find((item) => item.id === playerId);
  if (!player) throw new RuleError("PLAYER_NOT_FOUND", "Player is not seated in this game");
  return {
    playerId,
    hand: [...player.hand],
    lockedCardId: player.lockedCardId,
    cardParameters: player.cardParameters,
    declaration: player.declaration,
    wagers: player.wagers,
    wagersLocked: player.wagersLocked,
    action: player.action,
    forcedAnnouncement: player.forcedAnnouncement,
    events: game.events.filter((item) => item.visibility === "owner-only" && item.ownerPlayerId === playerId).map((item) => item.payload),
  };
}

function publicDeclaration(player: GameState["players"][number], phase: GameState["phase"]): unknown {
  const declaration = player.declaration;
  if (!declaration) return undefined;
  if (player.lockedCardId === 18 && phase === "wager-commit") return {};
  if (player.lockedCardId === 23 && declaration.hiddenField) {
    const { [declaration.hiddenField]: _hidden, hiddenField: _privateField, ...visible } = declaration;
    return visible;
  }
  const { hiddenField: _privateField, ...visible } = declaration;
  return visible;
}

function publicRoomSnapshot(room: GameRoom): Record<string, unknown> {
  return {
    roomCode: room.code,
    status: room.status,
    version: room.version,
    hostPlayerId: room.hostPlayerId,
    settings: structuredClone(room.settings),
    players: room.players.map((player) => ({
      playerId: player.id,
      displayName: player.displayName,
      seatIndex: player.seatIndex,
      isHost: player.id === room.hostPlayerId,
      ready: player.ready,
      connected: player.connected,
    })),
    ...(room.game ? { game: publicGameSnapshot(room.game) } : {}),
  };
}

function makePrivateSnapshot(room: GameRoom, player: RoomPlayer): Record<string, unknown> {
  return {
    roomCode: room.code,
    playerId: player.id,
    ...(room.game ? { game: privateGameSnapshot(room.game, player.id) } : {}),
  };
}

function asSession(socket: Socket): Session | undefined {
  const value = socket.data.session;
  if (!isRecord(value) || typeof value.roomCode !== "string" || typeof value.playerId !== "string") return undefined;
  return { roomCode: value.roomCode, playerId: value.playerId };
}

function makeResponse(requestId: string, data: Record<string, unknown>): AckResult {
  return { ok: true, requestId, data };
}

function makeError(requestId: string, code: string, message: string, snapshot?: Record<string, unknown>): AckResult {
  return { ok: false, requestId, error: { code, message }, ...(snapshot ? { snapshot } : {}) };
}

export function createGameServer(options: ServerOptions = {}) {
  const app: Express = express();
  const httpServer: HttpServer = createHttpServer(app);
  const store = options.store ?? new MemoryRoomStore();
  const ttlMs = options.roomTtlMs ?? Number(process.env.ROOM_TTL_HOURS ?? GAME_CONFIG.completedRoomTtlHours) * 60 * 60 * 1000;
  const origin = options.webOrigin ?? process.env.WEB_ORIGIN;
  const io = new SocketServer(httpServer, {
    ...(origin ? { cors: { origin, methods: ["GET", "POST"] } } : {}),
    serveClient: false,
  });
  const timers = new Map<string, NodeJS.Timeout>();
  const ackCache = new Map<string, CachedAck>();
  const chatMessages = new Map<string, number[]>();
  const tableActionMessages = new Map<string, number[]>();
  let cleanupTimer: NodeJS.Timeout | undefined;

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "akher-tawqee-server", protocolVersion: 1 });
  });
  const webDist = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/.*/, (_request, response) => response.sendFile(resolve(webDist, "index.html")));
  }

  function clearTimer(code: string): void {
    const timer = timers.get(code);
    if (timer) clearTimeout(timer);
    timers.delete(code);
  }

  function phaseDuration(game: GameState): number {
    return game.phase === "negotiation" ? game.settings.negotiationSeconds * 1000 : DEFAULT_PHASE_MS;
  }

  function scheduleTimeout(room: GameRoom, game: GameState, deadlineAt: number): void {
    if (["round-summary", "complete"].includes(game.phase)) {
      clearTimer(room.code);
      return;
    }
    clearTimer(room.code);
    const expectedVersion = game.stateVersion;
    const timer = setTimeout(() => {
      timers.delete(room.code);
      const currentRoom = store.get(room.code);
      if (!currentRoom?.game || currentRoom.game.stateVersion !== expectedVersion) return;
      try {
        let next = skipMissingInputs(currentRoom.game);
        if (next.phase === "resolution") next = resolveRound(next).state;
        if (!["round-summary", "complete"].includes(next.phase)) next = updateGameDeadline(currentRoom, next);
        currentRoom.game = next;
        currentRoom.status = next.phase === "complete" ? "complete" : "playing";
        currentRoom.lastActivityAt = Date.now();
        publish(currentRoom);
      } catch (error) {
        io.to(room.code).emit("VALIDATION_ERROR", { code: "TIMEOUT_RESOLUTION_FAILED", message: error instanceof Error ? error.message : "تعذر حسم المهلة" });
      }
    }, Math.max(0, deadlineAt - Date.now()));
    timer.unref();
    timers.set(room.code, timer);
  }

  function updateGameDeadline(room: GameRoom, game: GameState): GameState {
    if (["round-summary", "complete"].includes(game.phase)) {
      clearTimer(room.code);
      return { ...game, phaseDeadlineAt: undefined };
    }
    const withDeadline = withPhaseDeadline(game, Date.now() + phaseDuration(game));
    scheduleTimeout(room, withDeadline, withDeadline.phaseDeadlineAt!);
    return withDeadline;
  }

  function publish(room: GameRoom): void {
    store.set(room);
    const snapshot = publicRoomSnapshot(room);
    io.to(room.code).emit("ROOM_SNAPSHOT", snapshot);
    for (const player of room.players) {
      if (!player.socketId) continue;
      const socket = io.sockets.sockets.get(player.socketId);
      socket?.emit("PLAYER_PRIVATE_SNAPSHOT", makePrivateSnapshot(room, player));
    }
  }

  function ensureCurrent(socket: Socket, envelope: CommandEnvelope, scope: CommandEnvelope["scope"]): { room: GameRoom; player: RoomPlayer } {
    if (envelope.scope !== scope) throw new RuleError("INVALID_SCOPE", `This action requires ${scope} scope`);
    const session = asSession(socket);
    if (!session) throw new RuleError("UNAUTHENTICATED", "Create or join a room first");
    const room = store.get(session.roomCode);
    const player = room?.players.find((item) => item.id === session.playerId);
    if (!room || !player) throw new RuleError("ROOM_NOT_FOUND", "This room or seat has expired");
    if (envelope.expectedStateVersion === undefined) {
      throw new RuleError("MISSING_STATE_VERSION", "Established-room commands require the current state version");
    }
    const actual = scope === "game" ? room.game?.stateVersion : room.version;
    if (actual === undefined || envelope.expectedStateVersion !== actual) {
      throw new RuleError("STALE_STATE", "The room changed; the latest snapshot is attached");
    }
    if (scope === "game") {
      if (!room.game) throw new RuleError("GAME_NOT_STARTED", "اللعبة لم تبدأ");
      if (envelope.gameId !== room.game.gameId || envelope.roundIndex !== room.game.roundIndex) {
        throw new RuleError("STALE_STATE", "معرّف اللعبة أو الجولة لا يطابق الحالة الحالية");
      }
    }
    room.lastActivityAt = Date.now();
    return { room, player };
  }

  function request(
    socket: Socket,
    eventName: string,
    raw: unknown,
    ack: ((result: AckResult) => void) | undefined,
    expectedScope: CommandEnvelope["scope"],
    handler: (envelope: CommandEnvelope) => AckResult,
  ): void {
    let requestId = "unknown";
    let actor = asSession(socket)?.playerId ?? socket.id;
    try {
      const envelope = commandEnvelope(raw, expectedScope);
      requestId = envelope.requestId;
      actor = asSession(socket)?.playerId ?? socket.id;
      const cacheKey = `${actor}:${requestId}`;
      const cached = ackCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        ack?.(structuredClone(cached.result));
        return;
      }
      const result = handler(envelope);
      ackCache.set(cacheKey, { expiresAt: Date.now() + REQUEST_CACHE_MS, result: structuredClone(result) });
      ack?.(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "حدث خطأ غير متوقع";
      const code = error instanceof RuleError ? error.code : "INTERNAL_ERROR";
      const session = asSession(socket);
      const room = session ? store.get(session.roomCode) : undefined;
      const snapshot = room ? publicRoomSnapshot(room) : undefined;
      const result = makeError(requestId, code, message, snapshot);
      ack?.(result);
      if (code === "INTERNAL_ERROR") console.error(`[${eventName}]`, error);
    }
  }

  function issueCredentials(socket: Socket, room: GameRoom, player: RoomPlayer, token: string): AckResult {
    socket.data.session = { roomCode: room.code, playerId: player.id } satisfies Session;
    player.socketId = socket.id;
    player.connected = true;
    room.lastActivityAt = Date.now();
    room.version += 1;
    socket.join(room.code);
    publish(room);
    return makeResponse(randomUUID(), {
      room: publicRoomSnapshot(room),
      player: { playerId: player.id },
      reconnectToken: token,
    });
  }

  function ensureNoDuplicateName(room: GameRoom, displayName: string): void {
    const normalized = displayName.toLocaleLowerCase("ar");
    if (room.players.some((player) => player.displayName.toLocaleLowerCase("ar") === normalized)) {
      throw new RuleError("DUPLICATE_NAME", "هذا الاسم مستخدم في الغرفة؛ اختر اسماً آخر");
    }
  }

  io.on("connection", (socket) => {
    socket.on("TABLE_ACTION", (raw: unknown) => {
      const session = asSession(socket);
      if (!session || !isRecord(raw)) return;
      const room = store.get(session.roomCode);
      const player = room?.players.find((item) => item.id === session.playerId && item.socketId === socket.id);
      if (!room || !player) return;

      const now = Date.now();
      const recent = (tableActionMessages.get(socket.id) ?? []).filter((sentAt) => now - sentAt < 5_000);
      if (recent.length >= 18) return;
      recent.push(now);
      tableActionMessages.set(socket.id, recent);

      const rawLook = isRecord(raw.lookAt) ? raw.lookAt : {};
      const lookKind = rawLook.kind;
      let lookAt: { kind: string; playerId?: string } = { kind: "center" };
      if (lookKind === "center" || lookKind === "documents" || lookKind === "cards" || lookKind === "left" || lookKind === "right") {
        lookAt = { kind: lookKind };
      } else if (lookKind === "player" && typeof rawLook.playerId === "string" && room.players.some((item) => item.id === rawLook.playerId)) {
        lookAt = { kind: "player", playerId: rawLook.playerId };
      }

      const gestures = new Set(["wave", "point", "thinking", "shrug", "agree"]);
      const gesture = typeof raw.gesture === "string" && gestures.has(raw.gesture) ? raw.gesture : null;
      room.lastActivityAt = now;
      io.to(room.code).emit("TABLE_ACTION", { playerId: player.id, lookAt, gesture, updatedAt: now });
    });

    socket.on("CREATE_ROOM", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "CREATE_ROOM", raw, ack, "lobby", (envelope) => {
      if (asSession(socket)) throw new RuleError("ALREADY_IN_ROOM", "غادر الغرفة الحالية قبل إنشاء غرفة أخرى");
      const displayName = cleanDisplayName(envelope.displayName);
      let code = createRoomCode();
      while (store.get(code)) code = createRoomCode();
      const token = randomBytes(32).toString("base64url");
      const player: RoomPlayer = {
        id: randomUUID(),
        displayName,
        seatIndex: 0,
        reconnectTokenHash: hashToken(token),
        socketId: socket.id,
        connected: true,
        ready: true,
      };
      const room: GameRoom = {
        code,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        hostPlayerId: player.id,
        settings: defaultSettings(),
        status: "lobby",
        version: 1,
        players: [player],
        game: undefined,
      };
      store.set(room);
      socket.data.session = { roomCode: room.code, playerId: player.id } satisfies Session;
      socket.join(room.code);
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room), player: { playerId: player.id }, reconnectToken: token });
    }));

    socket.on("JOIN_ROOM", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "JOIN_ROOM", raw, ack, "lobby", (envelope) => {
      if (asSession(socket)) throw new RuleError("ALREADY_IN_ROOM", "غادر الغرفة الحالية قبل الانضمام لغرفة أخرى");
      if (typeof envelope.roomCode !== "string") throw new RuleError("INVALID_ROOM_CODE", "أدخل رمز الغرفة");
      const code = envelope.roomCode.toUpperCase();
      const room = store.get(code);
      if (!room) throw new RuleError("ROOM_NOT_FOUND", "الغرفة غير موجودة أو انتهت صلاحيتها");
      if (room.status !== "lobby") throw new RuleError("ROOM_CLOSED", "اللعبة بدأت ولا تقبل لاعبين جدد");
      if (room.players.length >= GAME_CONFIG.maximumPlayers) throw new RuleError("ROOM_FULL", "اكتمل عدد المقاعد في الغرفة");
      const displayName = cleanDisplayName(envelope.displayName);
      ensureNoDuplicateName(room, displayName);
      const token = randomBytes(32).toString("base64url");
      const player: RoomPlayer = {
        id: randomUUID(),
        displayName,
        seatIndex: room.players.length,
        reconnectTokenHash: hashToken(token),
        socketId: socket.id,
        connected: true,
        ready: false,
      };
      room.players.push(player);
      room.version += 1;
      socket.data.session = { roomCode: room.code, playerId: player.id } satisfies Session;
      socket.join(room.code);
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room), player: { playerId: player.id }, reconnectToken: token });
    }));

    socket.on("RECONNECT", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "RECONNECT", raw, ack, "lobby", (envelope) => {
      if (typeof envelope.roomCode !== "string" || typeof envelope.reconnectToken !== "string") {
        throw new RuleError("INVALID_CREDENTIAL", "بيانات استعادة المقعد غير مكتملة");
      }
      const room = store.get(envelope.roomCode.toUpperCase());
      const player = room?.players.find((item) => tokenMatches(envelope.reconnectToken as string, item.reconnectTokenHash));
      if (!room || !player) throw new RuleError("INVALID_CREDENTIAL", "تعذر استعادة هذا المقعد");
      if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
      player.socketId = socket.id;
      player.connected = true;
      room.lastActivityAt = Date.now();
      room.version += 1;
      socket.data.session = { roomCode: room.code, playerId: player.id } satisfies Session;
      socket.join(room.code);
      if (room.game) {
        room.game = markPlayerConnected(room.game, player.id, true);
        if (room.game.phaseDeadlineAt !== undefined && !["round-summary", "complete"].includes(room.game.phase)) {
          scheduleTimeout(room, room.game, room.game.phaseDeadlineAt);
        }
      }
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room), player: { playerId: player.id }, private: makePrivateSnapshot(room, player) });
    }));

    socket.on("UPDATE_ROOM_SETTINGS", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "UPDATE_ROOM_SETTINGS", raw, ack, "lobby", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "lobby");
      if (room.status !== "lobby") throw new RuleError("ROOM_CLOSED", "لا يمكن تغيير الإعدادات بعد بدء اللعبة");
      if (player.id !== room.hostPlayerId) throw new RuleError("HOST_ONLY", "مضيف الغرفة وحده يغيّر الإعدادات");
      room.settings = validateSettings(envelope.settings, room.settings, room.players.length);
      room.version += 1;
      room.players = room.players.map((item) => ({ ...item, ready: item.id === room.hostPlayerId }));
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room) });
    }));

    socket.on("READY", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "READY", raw, ack, "lobby", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "lobby");
      if (room.status !== "lobby") throw new RuleError("ROOM_CLOSED", "الغرفة لم تعد في وضع الانتظار");
      player.ready = typeof envelope.ready === "boolean" ? envelope.ready : !player.ready;
      room.version += 1;
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room) });
    }));

    socket.on("START_GAME", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "START_GAME", raw, ack, "lobby", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "lobby");
      if (player.id !== room.hostPlayerId) throw new RuleError("HOST_ONLY", "مضيف الغرفة وحده يبدأ اللعبة");
      if (room.status !== "lobby") throw new RuleError("ROOM_CLOSED", "اللعبة بدأت بالفعل");
      if (room.players.length < GAME_CONFIG.minimumPlayers) throw new RuleError("NOT_ENOUGH_PLAYERS", "تحتاج الغرفة إلى 3 لاعبين على الأقل");
      if (!room.players.every((item) => item.ready)) throw new RuleError("PLAYERS_NOT_READY", "ينبغي أن يكون جميع اللاعبين مستعدين");
      if (room.settings.mode === "teams") {
        if (!validateTeamSizes(room.players.length, room.settings.teamSizes ?? [])) throw new RuleError("INVALID_TEAMS", "تكوين الفرق يجب أن يكون مكتملاً ومتساوياً");
        throw new RuleError("TEAM_MODE_NOT_READY", "نمط الفرق قيد التنفيذ ولم يُفعّل بعد");
      }
      let game = createGameState({
        gameId: randomUUID(),
        participants: room.players.map((item) => ({ id: item.id, displayName: item.displayName, seatIndex: item.seatIndex })),
        settings: room.settings,
        seed: randomBytes(4).readUInt32BE(0),
      });
      game = updateGameDeadline(room, game);
      room.game = game;
      room.status = "playing";
      room.version += 1;
      room.lastActivityAt = Date.now();
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room) });
    }));

    socket.on("SUBMIT_DECLARATION", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "SUBMIT_DECLARATION", raw, ack, "game", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "game");
      if (!room.game) throw new RuleError("GAME_NOT_STARTED", "اللعبة لم تبدأ");
      if (envelope.cardId !== undefined && !Number.isInteger(envelope.cardId)) throw new RuleError("INVALID_CARD", "معرّف البطاقة غير صالح");
      const before = room.game.phase;
      let next = submitDeclaration(
        room.game,
        player.id,
        parseDeclaration(envelope.declaration),
        typeof envelope.cardId === "number" ? envelope.cardId : undefined,
        parseCardParameters(envelope.cardParameters),
      );
      next = phaseTransitionDeadline(room, before, next);
      room.game = next;
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room), private: makePrivateSnapshot(room, player) });
    }));

    socket.on("SUBMIT_WAGERS", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "SUBMIT_WAGERS", raw, ack, "game", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "game");
      if (!room.game) throw new RuleError("GAME_NOT_STARTED", "اللعبة لم تبدأ");
      const before = room.game.phase;
      let next = submitWagers(room.game, player.id, parseWagers(envelope.wagers));
      next = phaseTransitionDeadline(room, before, next);
      room.game = next;
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room), private: makePrivateSnapshot(room, player) });
    }));

    socket.on("FINISH_NEGOTIATION", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "FINISH_NEGOTIATION", raw, ack, "game", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "game");
      if (!room.game) throw new RuleError("GAME_NOT_STARTED", "اللعبة لم تبدأ");
      const before = room.game.phase;
      let next = finishNegotiation(room.game, player.id, parseCardParameters(envelope.cardParameters));
      next = phaseTransitionDeadline(room, before, next);
      room.game = next;
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room) });
    }));

    socket.on("RENEGOTIATE_DECLARATION", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "RENEGOTIATE_DECLARATION", raw, ack, "game", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "game");
      if (!room.game) throw new RuleError("GAME_NOT_STARTED", "اللعبة لم تبدأ");
      if (typeof envelope.targetLotId !== "string") throw new RuleError("INVALID_LOT", "Choose a different lot");
      const before = room.game.phase;
      let next = renegotiateDeclaration(room.game, player.id, envelope.targetLotId);
      next = phaseTransitionDeadline(room, before, next);
      room.game = next;
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room) });
    }));

    socket.on("SUBMIT_FINAL_ACTION", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "SUBMIT_FINAL_ACTION", raw, ack, "game", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "game");
      if (!room.game) throw new RuleError("GAME_NOT_STARTED", "اللعبة لم تبدأ");
      const before = room.game.phase;
      let next = submitFinalAction(room.game, player.id, parseFinalAction(envelope.action));
      next = phaseTransitionDeadline(room, before, next);
      if (next.phase === "resolution") next = resolveRound(next).state;
      room.game = next;
      room.status = next.phase === "complete" ? "complete" : "playing";
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room), private: makePrivateSnapshot(room, player) });
    }));

    socket.on("NEXT_ROUND", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "NEXT_ROUND", raw, ack, "game", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "game");
      if (!room.game) throw new RuleError("GAME_NOT_STARTED", "اللعبة لم تبدأ");
      if (player.id !== room.hostPlayerId) throw new RuleError("HOST_ONLY", "مضيف الغرفة وحده يبدأ الجولة التالية");
      let next = beginNextRound(room.game, Date.now() + DEFAULT_PHASE_MS);
      if (next.phase !== "complete") next = updateGameDeadline(room, next);
      room.game = next;
      room.status = next.phase === "complete" ? "complete" : "playing";
      publish(room);
      return makeResponse(envelope.requestId, { room: publicRoomSnapshot(room) });
    }));

    socket.on("SEND_PUBLIC_CHAT", (raw: unknown, ack?: (result: AckResult) => void) => request(socket, "SEND_PUBLIC_CHAT", raw, ack, "lobby", (envelope) => {
      const { room, player } = ensureCurrent(socket, envelope, "lobby");
      if (!room.settings.chatEnabled) throw new RuleError("CHAT_DISABLED", "الدردشة غير مفعلة في هذه الغرفة");
      if (typeof envelope.message !== "string") throw new RuleError("INVALID_MESSAGE", "الرسالة غير صالحة");
      const message = envelope.message.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
      if (!message || [...message].length > MAX_CHAT_LENGTH) throw new RuleError("INVALID_MESSAGE", "الرسالة يجب ألا تتجاوز 500 حرف");
      const recent = (chatMessages.get(player.id) ?? []).filter((sentAt) => Date.now() - sentAt < 10_000);
      if (recent.length >= 5) throw new RuleError("RATE_LIMITED", "انتظر قليلاً قبل إرسال رسالة أخرى");
      recent.push(Date.now());
      chatMessages.set(player.id, recent);
      io.to(room.code).emit("PUBLIC_CHAT_MESSAGE", { playerId: player.id, displayName: player.displayName, message });
      return makeResponse(envelope.requestId, { delivered: true });
    }));

    socket.on("disconnect", () => {
      tableActionMessages.delete(socket.id);
      const session = asSession(socket);
      if (!session) return;
      const room = store.get(session.roomCode);
      if (!room) return;
      const player = room.players.find((item) => item.id === session.playerId);
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      player.socketId = undefined;
      room.version += 1;
      room.lastActivityAt = Date.now();
      if (room.game) room.game = markPlayerConnected(room.game, player.id, false);
      if (room.hostPlayerId === player.id) {
        const nextHost = room.players.find((item) => item.connected);
        if (nextHost) room.hostPlayerId = nextHost.id;
      }
      if (room.game && room.game.phaseDeadlineAt !== undefined && !["round-summary", "complete"].includes(room.game.phase)) {
        scheduleTimeout(room, room.game, room.game.phaseDeadlineAt);
      }
      publish(room);
    });
  });

  function phaseTransitionDeadline(room: GameRoom, before: GameState["phase"], after: GameState): GameState {
    if (before === after.phase) {
      if (after.phaseDeadlineAt !== undefined) scheduleTimeout(room, after, after.phaseDeadlineAt);
      return after;
    }
    if (["round-summary", "complete"].includes(after.phase)) {
      clearTimer(room.code);
      return { ...after, phaseDeadlineAt: undefined };
    }
    return updateGameDeadline(room, after);
  }

  const janitor = setInterval(() => {
    for (const code of store.prune(Date.now(), ttlMs)) clearTimer(code);
    const now = Date.now();
    for (const [key, cached] of ackCache) if (cached.expiresAt <= now) ackCache.delete(key);
  }, 60_000);
  janitor.unref();

  return {
    app,
    httpServer,
    io,
    store,
    listen: (port = options.port ?? Number(process.env.PORT ?? 4000), host = options.host ?? process.env.HOST ?? "0.0.0.0") =>
      new Promise<void>((resolveListen, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolveListen();
        });
      }),
    close: () => new Promise<void>((resolveClose, reject) => {
      clearInterval(janitor);
      for (const code of timers.keys()) clearTimer(code);
      io.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

export type { AckResult };
