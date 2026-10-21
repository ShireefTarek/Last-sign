import { GAME_CONFIG } from "./constants.js";
import type { BidEntry, LotAuctionResult } from "./types.js";

export function getLotCount(playerCount: number): number {
  return Math.min(4, Math.ceil(playerCount / 3));
}

export function calculateEffectiveBid(entry: BidEntry): { effectiveBid: number; calculation: string[] } {
  const calculation = [`الأساس ${entry.baseBid}`];
  let total = entry.baseBid;
  if (entry.trustBonus) {
    total += entry.trustBonus;
    calculation.push(`ثقة +${entry.trustBonus}`);
  }
  if (entry.cardBonus) {
    total += entry.cardBonus;
    calculation.push(`بطاقات +${entry.cardBonus}`);
  }
  if (entry.cardPenalty) {
    total -= entry.cardPenalty;
    calculation.push(`تأثيرات سالبة −${entry.cardPenalty}`);
  }
  const effectiveBid = Math.max(0, Math.min(GAME_CONFIG.effectiveBidMaximum, total));
  calculation.push(`النتيجة ${effectiveBid} (ضمن 0–${GAME_CONFIG.effectiveBidMaximum})`);
  return { effectiveBid, calculation };
}

/**
 * Resolves one lot using only explicit inputs. Ties use fewer seals; an exact
 * remaining tie has no winner. Every non-withdrawn competitor pays their base
 * bid, including losing bids.
 */
export function resolveLotAuction(
  lotId: string,
  bids: readonly BidEntry[],
  tieBreakCardPlayerIds: readonly string[] = [],
): LotAuctionResult {
  const eligible = bids.filter((bid) => bid.lotId === lotId && !bid.withdrawn);
  const withdrawn = bids.filter((bid) => bid.lotId === lotId && bid.withdrawn).map((bid) => ({
    playerId: bid.playerId,
    lotId,
    baseBid: bid.baseBid,
    effectiveBid: 0,
    influenceAfter: bid.influence,
    won: false,
    calculation: ["انسحب صاحب العرض ورجعله عرضه الأساسي"],
  }));
  for (const bid of eligible) {
    if (!Number.isInteger(bid.baseBid) || bid.baseBid < GAME_CONFIG.baseBidMinimum || bid.baseBid > GAME_CONFIG.baseBidMaximum) {
      throw new Error(`Invalid base bid for ${bid.playerId}`);
    }
    if (bid.baseBid > bid.influence) {
      throw new Error(`Player ${bid.playerId} cannot afford base bid`);
    }
  }

  const calculated = eligible.map((bid) => ({
    bid,
    ...calculateEffectiveBid(bid),
    influenceAfter: bid.influence - bid.baseBid,
  }));
  if (calculated.length === 0) return { lotId, tiedPlayerIds: [], bidResolutions: withdrawn };

  const highest = Math.max(...calculated.map((item) => item.effectiveBid));
  const originalFinalists = calculated.filter((item) => item.effectiveBid === highest);
  let finalists = originalFinalists;
  if (finalists.length > 1) {
    const fewestSeals = Math.min(...finalists.map((item) => item.bid.seals));
    finalists = finalists.filter((item) => item.bid.seals === fewestSeals);
  }
  let cardTieBreakWinner: (typeof finalists)[number] | undefined;
  if (finalists.length > 1) {
    const tieBreakCardPlayers = new Set(tieBreakCardPlayerIds);
    cardTieBreakWinner = finalists.find((item) => tieBreakCardPlayers.has(item.bid.playerId)
      && originalFinalists.some((other) => other.bid.seals > item.bid.seals)
      && item.bid.influence - item.bid.baseBid >= 1);
  }
  const winner = finalists.length === 1 ? finalists[0] : cardTieBreakWinner;
  const tiedPlayerIds = winner ? [] : finalists.map((item) => item.bid.playerId);
  return {
    lotId,
    ...(winner ? { winnerPlayerId: winner.bid.playerId } : {}),
    ...(cardTieBreakWinner ? { cardTieBreakPlayerId: cardTieBreakWinner.bid.playerId } : {}),
    tiedPlayerIds,
    bidResolutions: [...calculated.map((item) => ({
      playerId: item.bid.playerId,
      lotId,
      baseBid: item.bid.baseBid,
      effectiveBid: item.effectiveBid,
      influenceAfter: item.influenceAfter,
      won: item.bid.playerId === winner?.bid.playerId,
      calculation: item.calculation,
    })), ...withdrawn],
  };
}

export function finalScore(seals: number, wagerScore: number): number {
  return GAME_CONFIG.sealScore * seals + wagerScore;
}

export function validateTeamSizes(playerCount: number, teamSizes: readonly number[]): boolean {
  if (playerCount < 4 || playerCount > GAME_CONFIG.maximumPlayers) return false;
  if (teamSizes.length < 2 || teamSizes.length > 4) return false;
  if (!teamSizes.every((size) => size === 2 || size === 3)) return false;
  return teamSizes.every((size) => size === teamSizes[0]) && teamSizes.reduce((sum, size) => sum + size, 0) === playerCount;
}
