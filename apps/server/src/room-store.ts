import type { GameState, RoomSettings } from "@akher-tawqee/game-engine";

export interface RoomPlayer {
  id: string;
  displayName: string;
  seatIndex: number;
  reconnectTokenHash: string;
  socketId: string | undefined;
  connected: boolean;
  ready: boolean;
}

export interface GameRoom {
  code: string;
  createdAt: number;
  lastActivityAt: number;
  hostPlayerId: string;
  settings: RoomSettings;
  status: "lobby" | "playing" | "complete";
  version: number;
  players: RoomPlayer[];
  game: GameState | undefined;
}

export interface RoomStore {
  get(code: string): GameRoom | undefined;
  set(room: GameRoom): void;
  delete(code: string): void;
  all(): GameRoom[];
  prune(now: number, ttlMs: number): string[];
}

export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, GameRoom>();

  get(code: string): GameRoom | undefined {
    return this.rooms.get(code);
  }

  set(room: GameRoom): void {
    this.rooms.set(room.code, room);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  all(): GameRoom[] {
    return [...this.rooms.values()];
  }

  prune(now: number, ttlMs: number): string[] {
    const expired: string[] = [];
    for (const room of this.rooms.values()) {
      if (now - room.lastActivityAt < ttlMs) continue;
      this.rooms.delete(room.code);
      expired.push(room.code);
    }
    return expired;
  }
}
