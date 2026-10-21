import { describe, expect, it } from "vitest";
import { createGameState } from "./game.js";
import { beginNextRound, finishNegotiation, renegotiateDeclaration, resolveRound, submitDeclaration, submitFinalAction, submitWagers, type RoundResolution } from "./round.js";
import type { Declaration, FinalAction, GameState } from "./types.js";

function players(count = 3) {
  return Array.from({ length: count }, (_, seatIndex) => ({ id: `p${seatIndex + 1}`, displayName: `Player ${seatIndex + 1}`, seatIndex }));
}

function resolveSimpleRound(state: GameState, targetLotId: string): GameState {
  let next = state;
  for (const player of next.players) next = submitDeclaration(next, player.id, {});
  for (const player of next.players) next = submitWagers(next, player.id, []);
  for (const player of next.players) next = finishNegotiation(next, player.id);
  const firstPlayerId = next.players[0]!.id;
  next = submitFinalAction(next, firstPlayerId, { lotId: targetLotId, baseBid: 0, stance: { kind: "pass" } });
  for (const player of next.players.slice(1)) next = submitFinalAction(next, player.id, { baseBid: 0, stance: { kind: "pass" } });
  return resolveRound(next).state;
}

function makeState(roundLimit = 6, count = 3): GameState {
  return createGameState({
    gameId: "test-game",
    participants: players(count),
    settings: { mode: "free-for-all", roundLimit, chatEnabled: false, negotiationSeconds: 90 },
    seed: 1234,
  });
}

function giveCard(state: GameState, playerId: string, cardId: number): GameState {
  return {
    ...state,
    cardDrawPile: state.cardDrawPile.filter((id) => id !== cardId),
    players: state.players.map((player) => ({
      ...player,
      hand: player.id === playerId
        ? [cardId, ...player.hand.filter((id) => id !== cardId)]
        : player.hand.filter((id) => id !== cardId),
    })),
  };
}

function resolveCardRound(input: {
  cardId: number;
  playerCount?: number;
  declaration: Declaration;
  declarations?: Record<string, Declaration>;
  cardParameters?: Record<string, string | number | boolean>;
  actions: Record<string, Omit<FinalAction, "locked">>;
}) {
  let state = giveCard(makeState(6, input.playerCount ?? 3), "p1", input.cardId);
  for (const player of state.players) {
    state = submitDeclaration(
      state,
      player.id,
      player.id === "p1" ? input.declaration : input.declarations?.[player.id] ?? {},
      player.id === "p1" ? input.cardId : undefined,
      player.id === "p1" && input.cardId === 37 ? input.cardParameters : {},
    );
  }
  for (const player of state.players) state = submitWagers(state, player.id, []);
  for (const player of state.players) state = finishNegotiation(state, player.id, player.id === "p1" && [8, 12, 21, 25, 26, 31].includes(input.cardId) ? input.cardParameters : {});
  for (const player of state.players) {
    const action = input.actions[player.id] ?? { baseBid: 0, stance: { kind: "pass" as const } };
    state = submitFinalAction(state, player.id, action);
  }
  return resolveRound(state);
}

function audit(round: RoundResolution) {
  return round.publicSummary as unknown as {
    lotResults: Array<{
      winnerPlayerId?: string;
      bidResolutions: Array<{ playerId: string; effectiveBid: number; influenceAfter: number; calculation: string[] }>;
    }>;
    cardEffects: Array<Record<string, unknown> & { cardId: number }>;
  };
}

describe("deterministic round flow", () => {
  it("consumes locked cards and preserves declarations/actions in the audit summary", () => {
    const base = makeState();
    const initial = {
      ...base,
      cardDrawPile: base.cardDrawPile.filter((cardId) => cardId !== 1),
      players: base.players.map((item, index) => ({
        ...item,
        hand: item.hand.filter((cardId) => cardId !== 1).concat(index === 0 ? [1] : []),
      })),
    };
    const player = initial.players[0]!;
    let state = submitDeclaration(initial, player.id, { targetLotId: initial.lots[0]!.id }, 1);
    for (const other of state.players.filter((item) => item.id !== player.id)) state = submitDeclaration(state, other.id, {});
    for (const item of state.players) state = submitWagers(state, item.id, []);
    for (const item of state.players) state = finishNegotiation(state, item.id);
    for (const item of state.players) state = submitFinalAction(state, item.id, {
      ...(item.id === player.id ? { lotId: initial.lots[0]!.id } : {}),
      baseBid: 0,
      stance: { kind: "pass" },
    });
    const resolved = resolveRound(state).state;
    const summary = [...resolved.events].reverse().find((event) => event.type === "round-resolved")?.payload as Record<string, unknown>;
    expect(summary.finalActions).toHaveLength(3);
    expect(summary.declarations).toHaveLength(3);
    expect(resolved.players.find((item) => item.id === player.id)?.hand).not.toContain(1);
  });

  it("schedules one final round at scandal 8 and ends after that round", () => {
    let state = { ...makeState(), roundIndex: 5, scandal: 8 };
    state = resolveSimpleRound(state, state.lots[0]!.id);
    expect(state.phase).toBe("round-summary");
    expect(state.finalRoundIndex).toBe(6);
    state = beginNextRound(state);
    expect(state.roundIndex).toBe(6);
    state = resolveSimpleRound(state, state.lots[0]!.id);
    expect(state.phase).toBe("complete");
    expect(state.finalRoundIndex).toBe(6);
  });

  it("resolves representative bargaining cards and records their effects", () => {
    const announcedLot = makeState().lots[0]!.id;
    const opening = resolveCardRound({
      cardId: 1,
      declaration: { targetLotId: announcedLot },
      actions: { p1: { lotId: announcedLot, baseBid: 0, stance: { kind: "pass" } } },
    });
    expect(audit(opening).lotResults[0]?.bidResolutions[0]?.effectiveBid).toBe(1);
    expect(audit(opening).cardEffects).toContainEqual(expect.objectContaining({ cardId: 1, status: "applied" }));

    const increase = resolveCardRound({
      cardId: 3,
      declaration: {},
      actions: { p1: { lotId: announcedLot, baseBid: 2, stance: { kind: "pass" } } },
    });
    const increaseBid = audit(increase).lotResults[0]?.bidResolutions.find((bid) => bid.playerId === "p1");
    expect(increaseBid?.effectiveBid).toBe(4);
    expect(increaseBid?.influenceAfter).toBe(2);

    const insurance = resolveCardRound({
      cardId: 4,
      declaration: {},
      actions: {
        p1: { lotId: announcedLot, baseBid: 1, stance: { kind: "pass" } },
        p2: { lotId: announcedLot, baseBid: 2, stance: { kind: "pass" } },
      },
    });
    expect(insurance.state.players.find((player) => player.id === "p1")?.influence).toBe(5);
    expect(audit(insurance).cardEffects).toContainEqual(expect.objectContaining({ cardId: 4, status: "applied", refund: 1 }));
  });

  it("applies Half Price after the winner is fixed", () => {
    const lotId = makeState().lots[0]!.id;
    const resolution = resolveCardRound({
      cardId: 5,
      declaration: {},
      actions: { p1: { lotId, baseBid: 2, stance: { kind: "pass" } } },
    });
    const result = audit(resolution).lotResults[0]!;
    expect(result.winnerPlayerId).toBe("p1");
    expect(result.bidResolutions[0]?.effectiveBid).toBe(1);
    expect(result.bidResolutions[0]?.calculation.at(-1)).toContain("ولا تغيّر الفائز");
  });

  it("applies Measured Acceptance to a lot tied for most and least crowded", () => {
    const lotId = makeState().lots[0]!.id;
    const resolution = resolveCardRound({
      cardId: 15,
      declaration: {},
      actions: { p1: { lotId, baseBid: 0, stance: { kind: "pass" } } },
    });
    const effect = audit(resolution).cardEffects.find((card) => card.cardId === 15);
    expect(effect).toMatchObject({ status: "applied", reason: "won-a-most-crowded-lot", influence: 1 });
  });

  it("lets card 11 update the public declaration while wagers keep the original reference", () => {
    let state = giveCard(makeState(6, 4), "p1", 11);
    const [firstLot, secondLot] = state.lots;
    expect(firstLot).toBeDefined();
    expect(secondLot).toBeDefined();
    for (const player of state.players) {
      state = submitDeclaration(state, player.id, player.id === "p1" ? { targetLotId: firstLot!.id } : {}, player.id === "p1" ? 11 : undefined);
    }
    for (const player of state.players) {
      state = submitWagers(state, player.id, player.id === "p2" ? [{
        targetPlayerId: "p1",
        type: "read",
        predicate: { kind: "lot-differs-from-declaration" },
        secondWager: false,
      }] : []);
    }
    for (const player of state.players) state = finishNegotiation(state, player.id);
    state = renegotiateDeclaration(state, "p1", secondLot!.id);
    expect(state.players.find((player) => player.id === "p1")).toMatchObject({
      influence: 4,
      originalDeclaration: { targetLotId: firstLot!.id },
      declaration: { targetLotId: secondLot!.id },
      declarationChange: { fromLotId: firstLot!.id, toLotId: secondLot!.id },
    });
    for (const player of state.players) {
      state = submitFinalAction(state, player.id, player.id === "p1"
        ? { lotId: secondLot!.id, baseBid: 0, stance: { kind: "pass" } }
        : { baseBid: 0, stance: { kind: "pass" } });
    }
    const resolved = resolveRound(state);
    expect(resolved.state.players.find((player) => player.id === "p2")?.wagerScore).toBe(2);
    expect(audit(resolved).cardEffects).toContainEqual(expect.objectContaining({
      cardId: 11,
      status: "applied",
      fromLotId: firstLot!.id,
      toLotId: secondLot!.id,
      influenceCost: 1,
    }));
  });

  it("charges card 37 on the original announcement even if a player freely changes lots", () => {
    const [announcedLot, alternateLot] = makeState(6, 4).lots;
    expect(announcedLot).toBeDefined();
    expect(alternateLot).toBeDefined();
    const resolution = resolveCardRound({
      cardId: 37,
      playerCount: 4,
      declaration: { targetLotId: announcedLot!.id },
      declarations: { p2: { targetLotId: announcedLot!.id }, p3: { targetLotId: announcedLot!.id } },
      cardParameters: { targetLotId: announcedLot!.id },
      actions: {
        p1: { lotId: announcedLot!.id, baseBid: 0, stance: { kind: "pass" } },
        p2: { lotId: alternateLot!.id, baseBid: 0, stance: { kind: "pass" } },
        p3: { lotId: alternateLot!.id, baseBid: 1, stance: { kind: "pass" } },
      },
    });
    const influenceAfter = audit(resolution).lotResults.flatMap((lot) => lot.bidResolutions);
    expect(influenceAfter.find((bid) => bid.playerId === "p1")?.influenceAfter).toBe(4);
    expect(influenceAfter.find((bid) => bid.playerId === "p2")?.influenceAfter).toBe(4);
    expect(influenceAfter.find((bid) => bid.playerId === "p3")?.influenceAfter).toBe(4);
    expect(audit(resolution).cardEffects).toContainEqual(expect.objectContaining({
      cardId: 37,
      status: "applied",
      targetLotId: announcedLot!.id,
      affectedPlayerIds: ["p1", "p2", "p3"],
      totalInfluencePaid: 2,
    }));
  });

  it("rewards a contradicted announced bid band and adds suspicion", () => {
    const lotId = makeState().lots[0]!.id;
    const resolution = resolveCardRound({
      cardId: 22,
      declaration: { bidBand: "0-1" },
      actions: { p1: { lotId, baseBid: 2, stance: { kind: "pass" } } },
    });
    const bid = audit(resolution).lotResults.flatMap((lot) => lot.bidResolutions).find((item) => item.playerId === "p1");
    expect(bid?.effectiveBid).toBe(3);
    expect(resolution.state.players.find((player) => player.id === "p1")?.suspicion).toBe(1);
    expect(audit(resolution).cardEffects).toContainEqual(expect.objectContaining({
      cardId: 22,
      status: "applied",
      reason: "base-bid-contradicted-announced-band",
    }));
  });

  it("charges card 40 against influence remaining after bids are committed", () => {
    const [firstLot, secondLot] = makeState(6, 4).lots;
    const resolution = resolveCardRound({
      cardId: 40,
      playerCount: 4,
      declaration: {},
      actions: {
        p1: { lotId: firstLot!.id, baseBid: 2, stance: { kind: "pass" } },
        p2: { lotId: firstLot!.id, baseBid: 0, stance: { kind: "pass" } },
        p3: { lotId: secondLot!.id, baseBid: 3, stance: { kind: "pass" } },
      },
    });
    const bids = audit(resolution).lotResults.flatMap((lot) => lot.bidResolutions);
    expect(bids.find((bid) => bid.playerId === "p1")?.influenceAfter).toBe(3);
    expect(bids.find((bid) => bid.playerId === "p2")?.influenceAfter).toBe(4);
    expect(resolution.state.players.find((player) => player.id === "p4")?.influence).toBe(4);
    expect(audit(resolution).cardEffects).toContainEqual(expect.objectContaining({
      cardId: 40,
      status: "applied",
      paidPlayerIds: ["p2", "p4"],
      influenceEach: 1,
    }));
  });

  it("applies crowd pressure to each real competitor on tied most-crowded lots", () => {
    const [crowdedLot, otherLot] = makeState(6, 4).lots;
    const resolution = resolveCardRound({
      cardId: 35,
      playerCount: 4,
      declaration: {},
      declarations: {
        p2: { targetLotId: crowdedLot!.id },
        p3: { targetLotId: crowdedLot!.id },
      },
      actions: {
        p1: { lotId: crowdedLot!.id, baseBid: 2, stance: { kind: "pass" } },
        p2: { lotId: crowdedLot!.id, baseBid: 2, stance: { kind: "pass" } },
        p3: { lotId: crowdedLot!.id, baseBid: 2, stance: { kind: "pass" } },
        p4: { lotId: otherLot!.id, baseBid: 2, stance: { kind: "pass" } },
      },
    });
    const bids = audit(resolution).lotResults.flatMap((lot) => lot.bidResolutions);
    expect(bids.filter((bid) => ["p1", "p2", "p3"].includes(bid.playerId)).map((bid) => bid.effectiveBid)).toEqual([1, 1, 1]);
    expect(bids.find((bid) => bid.playerId === "p4")?.effectiveBid).toBe(2);
    expect(resolution.state.scandal).toBe(1);
    expect(audit(resolution).cardEffects).toContainEqual(expect.objectContaining({
      cardId: 35,
      status: "applied",
      targetPlayerIds: ["p1", "p2", "p3"],
      bidPenaltyEach: 1,
      scandalAdded: 1,
    }));
  });

  it("resolves target cards 21 and 25 from the target's final lot", () => {
    const [announcedLot, finalLot] = makeState(6, 4).lots;
    const base = {
      playerCount: 4,
      declaration: {},
      declarations: { p2: { targetLotId: announcedLot!.id } },
      cardParameters: { targetPlayerId: "p2" },
      actions: { p2: { lotId: finalLot!.id, baseBid: 0, stance: { kind: "pass" as const } } },
    };
    const rumor = resolveCardRound({ cardId: 21, ...base });
    expect(rumor.state.players.find((player) => player.id === "p1")?.influence).toBe(6);
    expect(audit(rumor).cardEffects).toContainEqual(expect.objectContaining({ cardId: 21, status: "applied", reason: "target-changed-the-announced-lot" }));

    const echo = resolveCardRound({ cardId: 25, ...base });
    expect(echo.state.players.find((player) => player.id === "p1")?.influence).toBe(6);
    expect(echo.state.events).toContainEqual(expect.objectContaining({
      type: "declaration-repeated",
      visibility: "public",
      payload: expect.objectContaining({ targetPlayerId: "p2", declaration: { targetLotId: announcedLot!.id } }),
    }));
  });

  it("moves suspicion with card 26 and schedules the normal forced announcement", () => {
    let state = giveCard(makeState(), "p1", 26);
    state = {
      ...state,
      players: state.players.map((player) => player.id === "p1" ? { ...player, suspicion: 1 } : player.id === "p2" ? { ...player, suspicion: 2 } : player),
    };
    for (const player of state.players) state = submitDeclaration(state, player.id, {}, player.id === "p1" ? 26 : undefined);
    for (const player of state.players) state = submitWagers(state, player.id, []);
    for (const player of state.players) state = finishNegotiation(state, player.id, player.id === "p1" ? { targetPlayerId: "p2" } : {});
    for (const player of state.players) state = submitFinalAction(state, player.id, { baseBid: 0, stance: { kind: "pass" } });
    const resolved = resolveRound(state);
    expect(resolved.state.players.find((player) => player.id === "p1")?.suspicion).toBe(0);
    expect(resolved.state.players.find((player) => player.id === "p2")).toMatchObject({ suspicion: 1, forcedAnnouncement: true });
    expect(audit(resolved).cardEffects).toContainEqual(expect.objectContaining({ cardId: 26, status: "applied", suspicionMoved: 1 }));
  });

  it("applies card 31 to a changed target or charges its owner when the lot stays the same", () => {
    const [announcedLot, alternateLot] = makeState(6, 4).lots;
    const changed = resolveCardRound({
      cardId: 31,
      playerCount: 4,
      declaration: {},
      declarations: { p2: { targetLotId: announcedLot!.id } },
      cardParameters: { targetPlayerId: "p2" },
      actions: { p2: { lotId: alternateLot!.id, baseBid: 0, stance: { kind: "pass" } } },
    });
    expect(changed.state.players.find((player) => player.id === "p2")?.suspicion).toBe(1);
    expect(changed.state.players.find((player) => player.id === "p1")?.influence).toBe(5);

    const kept = resolveCardRound({
      cardId: 31,
      playerCount: 4,
      declaration: {},
      declarations: { p2: { targetLotId: announcedLot!.id } },
      cardParameters: { targetPlayerId: "p2" },
      actions: { p2: { lotId: announcedLot!.id, baseBid: 0, stance: { kind: "pass" } } },
    });
    expect(kept.state.players.find((player) => player.id === "p1")?.influence).toBe(4);
    expect(audit(kept).cardEffects).toContainEqual(expect.objectContaining({ cardId: 31, status: "applied", influenceCost: 1 }));
  });

  it("applies cumulative scandal before making the round-end check", () => {
    let state = { ...makeState(), scandal: 6 };
    state = giveCard(state, "p1", 43);
    for (const player of state.players) state = submitDeclaration(state, player.id, {}, player.id === "p1" ? 43 : undefined);
    for (const player of state.players) state = submitWagers(state, player.id, []);
    for (const player of state.players) state = finishNegotiation(state, player.id);
    for (const player of state.players) state = submitFinalAction(state, player.id, { baseBid: 0, stance: { kind: "pass" } });
    const resolved = resolveRound(state);
    expect(resolved.state.scandal).toBe(8);
    expect(resolved.state.finalRoundIndex).toBe(2);
    expect(audit(resolved).cardEffects).toContainEqual(expect.objectContaining({
      cardId: 43,
      status: "applied",
      scandalBefore: 6,
      scandalAdded: 2,
      scandalAfter: 8,
    }));
  });

  it("allows a later short truce to lower scandal before the round-end final-round check", () => {
    let state = { ...makeState(), scandal: 6 };
    state = giveCard(state, "p1", 32);
    state = giveCard(state, "p2", 56);
    for (const player of state.players) {
      state = submitDeclaration(state, player.id, {}, player.id === "p1" ? 32 : player.id === "p2" ? 56 : undefined);
    }
    for (const player of state.players) state = submitWagers(state, player.id, []);
    for (const player of state.players) state = finishNegotiation(state, player.id);
    for (const player of state.players) state = submitFinalAction(state, player.id, { baseBid: 0, stance: { kind: "pass" } });
    const resolved = resolveRound(state);
    expect(resolved.state.scandal).toBe(7);
    expect(resolved.state.finalRoundIndex).toBeUndefined();
    expect(resolved.state.players.find((player) => player.id === "p2")?.suspicion).toBe(1);
  });

  it("applies documented record and emergency fund at settlement", () => {
    let state = giveCard(makeState(), "p1", 47);
    state = {
      ...state,
      players: state.players.map((player) => player.id === "p1" ? { ...player, suspicion: 1 } : player),
    };
    for (const player of state.players) state = submitDeclaration(state, player.id, {}, player.id === "p1" ? 47 : undefined);
    for (const player of state.players) state = submitWagers(state, player.id, []);
    for (const player of state.players) state = finishNegotiation(state, player.id);
    for (const player of state.players) state = submitFinalAction(state, player.id, { baseBid: 0, stance: { kind: "pass" } });
    const record = resolveRound(state);
    expect(record.state.players.find((player) => player.id === "p1")?.suspicion).toBe(0);
    expect(audit(record).cardEffects).toContainEqual(expect.objectContaining({ cardId: 47, status: "applied", suspicionRemoved: 1 }));

    const reserve = resolveCardRound({ cardId: 54, declaration: {}, actions: {} });
    expect(reserve.state.players.find((player) => player.id === "p1")?.influence).toBe(6);
    expect(audit(reserve).cardEffects).toContainEqual(expect.objectContaining({ cardId: 54, status: "applied", influence: 1 }));
  });

  it("refunds a losing bid with card 48", () => {
    const lotId = makeState().lots[0]!.id;
    const resolution = resolveCardRound({
      cardId: 48,
      declaration: {},
      actions: {
        p1: { lotId, baseBid: 1, stance: { kind: "pass" } },
        p2: { lotId, baseBid: 2, stance: { kind: "pass" } },
      },
    });
    expect(resolution.state.players.find((player) => player.id === "p1")?.influence).toBe(5);
    expect(audit(resolution).cardEffects).toContainEqual(expect.objectContaining({ cardId: 48, status: "applied", refund: 1 }));
  });

  it("keeps negotiation-target cards private and resolves their choices", () => {
    const lots = makeState(6, 4).lots;
    const resolution = resolveCardRound({
      cardId: 8,
      playerCount: 4,
      declaration: {},
      cardParameters: { targetPlayerId: "p2" },
      actions: {
        p1: { lotId: lots[0]!.id, baseBid: 0, stance: { kind: "pass" } },
        p2: { lotId: lots[1]!.id, baseBid: 0, stance: { kind: "pass" } },
      },
    });
    expect(audit(resolution).cardEffects).toContainEqual(expect.objectContaining({
      cardId: 8,
      status: "applied",
      reason: "chosen-player-used-a-different-lot",
      influenceEach: 1,
    }));
  });

  it("settles Heirs' Advance and the paid Last Bid condition", () => {
    const lotId = makeState().lots[0]!.id;
    const advance = resolveCardRound({
      cardId: 10,
      declaration: {},
      actions: {},
    });
    expect(advance.state.players.find((player) => player.id === "p1")).toMatchObject({ influence: 6, suspicion: 1 });

    const lastBid = resolveCardRound({
      cardId: 14,
      declaration: {},
      actions: {
        p1: { lotId, baseBid: 1, stance: { kind: "pass" } },
        p2: { lotId, baseBid: 2, stance: { kind: "pass" } },
      },
    });
    expect(audit(lastBid).lotResults[0]?.winnerPlayerId).toBeUndefined();
    expect(audit(lastBid).lotResults[0]?.bidResolutions.find((bid) => bid.playerId === "p1")?.effectiveBid).toBe(2);
    expect(audit(lastBid).cardEffects).toContainEqual(expect.objectContaining({ cardId: 14, status: "applied" }));
  });

  it("hides card 18 announcements until wager lock and excludes hidden declarations from wagers", () => {
    let state = giveCard(makeState(), "p2", 18);
    const lotId = state.lots[0]!.id;
    for (const player of state.players) {
      state = submitDeclaration(state, player.id, player.id === "p2" ? { targetLotId: lotId } : {}, player.id === "p2" ? 18 : undefined);
    }
    const declarations = state.events.find((event) => event.type === "declarations-revealed")?.payload.declarations as Array<{ playerId: string; declaration: Record<string, unknown> }>;
    expect(declarations.find((item) => item.playerId === "p2")?.declaration).toEqual({});
    const wagerers = state.players.map((player) => player.id);
    for (const playerId of wagerers) {
      state = submitWagers(state, playerId, playerId === "p1" ? [{
        targetPlayerId: "p2", type: "read", secondWager: false,
        predicate: { kind: "lot-differs-from-declaration" },
      }] : []);
    }
    const reveal = state.events.find((event) => event.type === "masked-announcements-revealed")?.payload.declarations as Array<{ playerId: string; declaration: Record<string, unknown> }>;
    expect(reveal.find((item) => item.playerId === "p2")?.declaration.targetLotId).toBe(lotId);
    for (const player of state.players) state = finishNegotiation(state, player.id);
    for (const player of state.players) state = submitFinalAction(state, player.id, { baseBid: 0, stance: { kind: "pass" } });
    const resolved = resolveRound(state);
    const summary = resolved.publicSummary.wagers as Array<{ result: boolean | "void"; refund: number }>;
    expect(summary[0]?.result).toBe("void");
  });

  it("freezes wager references to the target and refunds a second wager on a hidden field", () => {
    let state = giveCard(makeState(), "p2", 23);
    const lotId = state.lots[0]!.id;
    for (const player of state.players) {
      state = submitDeclaration(state, player.id, player.id === "p2"
        ? { targetLotId: lotId, hiddenField: "targetLotId" }
        : {}, player.id === "p2" ? 23 : undefined);
    }
    for (const player of state.players) {
      state = submitWagers(state, player.id, player.id === "p1" ? [
        { targetPlayerId: "p2", type: "read", secondWager: false, predicate: { kind: "final-lot", lotId } },
        { targetPlayerId: "p2", type: "read", secondWager: true, predicate: { kind: "lot-differs-from-declaration" } },
      ] : []);
    }
    const bettor = state.players.find((player) => player.id === "p1")!;
    expect(bettor.wagers[1]?.referenceDeclaration).toEqual({});
    expect(bettor.influence).toBe(4);
    for (const player of state.players) state = finishNegotiation(state, player.id);
    for (const player of state.players) state = submitFinalAction(state, player.id, { baseBid: 0, stance: { kind: "pass" } });
    const result = resolveRound(state);
    const wagerResults = result.publicSummary.wagers as Array<{ bettorPlayerId: string; result: boolean | "void"; refund: number }>;
    expect(wagerResults.find((wager) => wager.bettorPlayerId === "p1" && wager.result === "void")?.refund).toBe(1);
    expect(result.state.players.find((player) => player.id === "p1")?.influence).toBe(5);
  });
});
