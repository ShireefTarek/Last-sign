import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import { createGameServer } from "./server.js";

type Reply = {
  ok: boolean;
  requestId: string;
  data?: { room?: Room; player?: { playerId: string }; reconnectToken?: string; private?: { playerId?: string; game?: { hand?: number[] } } };
  error?: { code: string; message: string };
};
type Room = {
  roomCode: string;
  version: number;
  status: string;
  players: Array<{ playerId: string; displayName: string }>;
  game?: { gameId: string; roundIndex: number; stateVersion: number; phase: string; players: Array<Record<string, unknown>>; events: Array<{ type: string; payload: Record<string, unknown> & { lotIds?: string[] } }> };
};

const clients: Socket[] = [];
let server: ReturnType<typeof createGameServer>;
let baseUrl: string;

function nextId(): string {
  return globalThis.crypto.randomUUID();
}

async function connectClient(): Promise<Socket> {
  const socket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

function command(socket: Socket, event: string, scope: "lobby" | "game", fields: Record<string, unknown> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    socket.timeout(3_000).emit(event, { version: 1, scope, requestId: nextId(), ...fields }, (timeout: Error | null, reply: Reply) => {
      if (timeout) reject(timeout);
      else resolve(reply);
    });
  });
}

function gameFields(room: Room): Record<string, unknown> {
  const game = room.game!;
  return { expectedStateVersion: game.stateVersion, gameId: game.gameId, roundIndex: game.roundIndex };
}

describe("real Socket.IO room and round flow", () => {
  beforeEach(async () => {
    server = createGameServer({ host: "127.0.0.1", port: 0 });
    await server.listen(0, "127.0.0.1");
    const address = server.httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const socket of clients.splice(0)) socket.disconnect();
    await server.close();
  });

  it("plays a full first round while keeping each hand private", async () => {
    const host = await connectClient();
    const guestOne = await connectClient();
    const guestTwo = await connectClient();
    const created = await command(host, "CREATE_ROOM", "lobby", { displayName: "المضيف" });
    expect(created.ok).toBe(true);
    let room = created.data!.room!;
    const hostId = created.data!.player!.playerId;
    const guestOneJoin = await command(guestOne, "JOIN_ROOM", "lobby", { roomCode: room.roomCode, displayName: "ضيف ١" });
    expect(guestOneJoin.ok).toBe(true);
    room = guestOneJoin.data!.room!;
    const guestTwoJoin = await command(guestTwo, "JOIN_ROOM", "lobby", { roomCode: room.roomCode, displayName: "ضيف ٢" });
    expect(guestTwoJoin.ok).toBe(true);
    room = guestTwoJoin.data!.room!;
    const guestTwoId = guestTwoJoin.data!.player!.playerId;

    const denied = await command(guestOne, "UPDATE_ROOM_SETTINGS", "lobby", {
      expectedStateVersion: room.version,
      settings: { roundLimit: 2 },
    });
    expect(denied.error?.code).toBe("HOST_ONLY");
    const duplicateName = await command(await connectClient(), "JOIN_ROOM", "lobby", { roomCode: room.roomCode, displayName: "ضيف ١" });
    expect(duplicateName.error?.code).toBe("DUPLICATE_NAME");

    const readyOne = await command(guestOne, "READY", "lobby", { expectedStateVersion: room.version, ready: true });
    expect(readyOne.ok).toBe(true);
    room = readyOne.data!.room!;
    const readyTwo = await command(guestTwo, "READY", "lobby", { expectedStateVersion: room.version, ready: true });
    expect(readyTwo.ok).toBe(true);
    room = readyTwo.data!.room!;
    const started = await command(host, "START_GAME", "lobby", { expectedStateVersion: room.version });
    expect(started.ok).toBe(true);
    room = started.data!.room!;
    expect(room.game?.phase).toBe("declaration");
    expect(room.game?.players.every((player) => !("hand" in player))).toBe(true);

    let privateAck = await command(host, "SUBMIT_DECLARATION", "game", {
      ...gameFields(room), declaration: { targetLotId: room.game!.players[0] ? room.game!.events[0]?.payload.lotIds?.[0] : undefined },
    });
    // The selected lot is read from the public room snapshot, which stays identical for all clients.
    expect(privateAck.ok).toBe(true);
    room = privateAck.data!.room!;
    for (const socket of [guestOne, guestTwo]) {
      privateAck = await command(socket, "SUBMIT_DECLARATION", "game", { ...gameFields(room), declaration: {} });
      expect(privateAck.ok).toBe(true);
      room = privateAck.data!.room!;
    }
    expect(room.game?.phase).toBe("wager-commit");
    for (const socket of [host, guestOne, guestTwo]) {
      privateAck = await command(socket, "SUBMIT_WAGERS", "game", { ...gameFields(room), wagers: [] });
      expect(privateAck.ok).toBe(true);
      room = privateAck.data!.room!;
    }
    expect(room.game?.phase).toBe("negotiation");
    for (const socket of [host, guestOne, guestTwo]) {
      privateAck = await command(socket, "FINISH_NEGOTIATION", "game", gameFields(room));
      expect(privateAck.ok).toBe(true);
      room = privateAck.data!.room!;
    }
    expect(room.game?.phase).toBe("final-action");
    const lotId = room.game!.events.find((event) => event.type === "round-started")!.payload.lotIds![0] as string;
    for (const [index, socket] of [host, guestOne, guestTwo].entries()) {
      privateAck = await command(socket, "SUBMIT_FINAL_ACTION", "game", {
        ...gameFields(room),
        action: { ...(index === 0 ? { lotId } : {}), baseBid: 0, stance: { kind: "pass" } },
      });
      expect(privateAck.ok).toBe(true);
      room = privateAck.data!.room!;
    }
    expect(room.game?.phase).toBe("round-summary");
    expect(room.game?.events.some((event) => event.type === "round-resolved")).toBe(true);
    expect(room.game?.players.find((player) => player.playerId === hostId)?.seals).toBe(1);
    expect(guestTwoId).toBeTruthy();
    expect(privateAck.data?.private?.game?.hand?.length).toBeGreaterThan(0);

    const reconnectToken = guestTwoJoin.data!.reconnectToken!;
    guestTwo.disconnect();
    const replacement = await connectClient();
    const restored = await command(replacement, "RECONNECT", "lobby", { roomCode: room.roomCode, reconnectToken });
    expect(restored.ok).toBe(true);
    expect(restored.data?.private?.playerId).toBe(guestTwoId);
    expect(restored.data?.private?.game?.hand?.length).toBeGreaterThan(0);
  });

  it("rejects invalid seat credentials and enforces the twelve-seat cap", async () => {
    const host = await connectClient();
    let response = await command(host, "CREATE_ROOM", "lobby", { displayName: "المضيف" });
    let room = response.data!.room!;
    for (let seat = 2; seat <= 12; seat += 1) {
      const socket = await connectClient();
      response = await command(socket, "JOIN_ROOM", "lobby", { roomCode: room.roomCode, displayName: `لاعب ${seat}` });
      expect(response.ok).toBe(true);
      room = response.data!.room!;
    }
    const extra = await connectClient();
    const full = await command(extra, "JOIN_ROOM", "lobby", { roomCode: room.roomCode, displayName: "زائد" });
    expect(full.error?.code).toBe("ROOM_FULL");
    const invalid = await command(extra, "RECONNECT", "lobby", { roomCode: room.roomCode, reconnectToken: "invalid" });
    expect(invalid.error?.code).toBe("INVALID_CREDENTIAL");
  });

  it("finishes six-round matches with three and twelve independent clients", async () => {
    const simulate = async (playerCount: number) => {
      const seats: Socket[] = [];
      const host = await connectClient();
      seats.push(host);
      let response = await command(host, "CREATE_ROOM", "lobby", { displayName: `Host ${playerCount}` });
      expect(response.ok).toBe(true);
      let room = response.data!.room!;
      for (let seat = 1; seat < playerCount; seat += 1) {
        const socket = await connectClient();
        seats.push(socket);
        response = await command(socket, "JOIN_ROOM", "lobby", { roomCode: room.roomCode, displayName: `P${playerCount}-${seat}` });
        expect(response.ok).toBe(true);
        room = response.data!.room!;
      }
      for (const socket of seats.slice(1)) {
        response = await command(socket, "READY", "lobby", { expectedStateVersion: room.version, ready: true });
        expect(response.ok).toBe(true);
        room = response.data!.room!;
      }
      response = await command(host, "START_GAME", "lobby", { expectedStateVersion: room.version });
      expect(response.ok).toBe(true);
      room = response.data!.room!;
      for (let round = 1; round <= 6; round += 1) {
        for (const socket of seats) {
          response = await command(socket, "SUBMIT_DECLARATION", "game", { ...gameFields(room), declaration: {} });
          expect(response.ok).toBe(true);
          room = response.data!.room!;
        }
        for (const socket of seats) {
          response = await command(socket, "SUBMIT_WAGERS", "game", { ...gameFields(room), wagers: [] });
          expect(response.ok).toBe(true);
          room = response.data!.room!;
        }
        for (const socket of seats) {
          response = await command(socket, "FINISH_NEGOTIATION", "game", gameFields(room));
          expect(response.ok).toBe(true);
          room = response.data!.room!;
        }
        for (const socket of seats) {
          response = await command(socket, "SUBMIT_FINAL_ACTION", "game", {
            ...gameFields(room), action: { baseBid: 0, stance: { kind: "pass" } },
          });
          expect(response.ok).toBe(true);
          room = response.data!.room!;
        }
        if (round < 6) {
          expect(room.game?.phase).toBe("round-summary");
          response = await command(host, "NEXT_ROUND", "game", gameFields(room));
          expect(response.ok).toBe(true);
          room = response.data!.room!;
        }
      }
      expect(room.status).toBe("complete");
      expect(room.game?.roundIndex).toBe(6);
      expect(room.game?.players).toHaveLength(playerCount);
    };

    // A dozen seats exercise the full lobby limit and four simultaneous lots.
    await simulate(3);
    await simulate(12);
  }, 120_000);
});
