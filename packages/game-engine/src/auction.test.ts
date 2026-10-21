import { describe, expect, it } from "vitest";
import { CARD_SOURCE } from "./cards.js";
import { getLotCount, resolveLotAuction, validateTeamSizes } from "./auction.js";
import { deterministicShuffle } from "./random.js";

describe("game rule primitives", () => {
  it("keeps the supplied card register at exactly 60 unique ids", () => {
    expect(CARD_SOURCE).toHaveLength(60);
    expect(new Set(CARD_SOURCE.map((card) => card.id)).size).toBe(60);
    expect(CARD_SOURCE.map((card) => card.id)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(new Set(CARD_SOURCE.map((card) => card.category)).size).toBe(4);
  });

  it("assigns the specified lot count for each player range", () => {
    expect([3, 4, 6, 7, 9, 10, 12].map(getLotCount)).toEqual([1, 2, 2, 3, 3, 4, 4]);
  });

  it("uses a deterministic shuffle for the same seed", () => {
    const values = Array.from({ length: 60 }, (_, index) => index + 1);
    expect(deterministicShuffle(values, 2026)).toEqual(deterministicShuffle(values, 2026));
    expect(deterministicShuffle(values, 2026).items).not.toEqual(values);
  });

  it("pays losing bids and breaks an effective-bid tie by fewer seals", () => {
    const result = resolveLotAuction("A", [
      { playerId: "p1", lotId: "A", baseBid: 2, seals: 0, influence: 4 },
      { playerId: "p2", lotId: "A", baseBid: 1, seals: 1, influence: 3, trustBonus: 1 },
    ]);
    expect(result.winnerPlayerId).toBe("p1");
    expect(result.bidResolutions.map((item) => item.influenceAfter)).toEqual([2, 2]);
  });

  it("awards no winner when the final tie has equal seals", () => {
    const result = resolveLotAuction("A", [
      { playerId: "p1", lotId: "A", baseBid: 2, seals: 1, influence: 4 },
      { playerId: "p2", lotId: "A", baseBid: 2, seals: 1, influence: 4 },
    ]);
    expect(result.winnerPlayerId).toBeUndefined();
    expect(result.tiedPlayerIds).toEqual(["p1", "p2"]);
  });

  it("validates only complete equal-sized team configurations", () => {
    expect(validateTeamSizes(4, [2, 2])).toBe(true);
    expect(validateTeamSizes(12, [3, 3, 3, 3])).toBe(true);
    expect(validateTeamSizes(5, [2, 3])).toBe(false);
    expect(validateTeamSizes(6, [2, 2, 2])).toBe(true);
    expect(validateTeamSizes(6, [3, 3])).toBe(true);
    expect(validateTeamSizes(3, [3])).toBe(false);
  });
});
