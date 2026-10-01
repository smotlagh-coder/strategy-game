import { afterAll, describe, expect, it } from 'vitest';
import {
  acceptAlliance,
  allianceOf,
  alliancePairs,
  allyOf,
  areAllies,
  incomingInvites,
  leaveAlliance,
  outgoingInvite,
  proposeAlliance,
  tributeFrom,
} from '../game/alliance';
import { aiWouldAccept, proposeAllianceWithReply } from '../game/allianceAi';
import { runOnlineAiPlanning } from '../game/ai';
import { ensureIncome, nextRound } from '../game/engine';
import { mergeHumanPlanningWrite } from './onlineSync';
import { allianceProblems, makeRoom, patchNation, rng, roomAtRound2, type SimRoom } from './simRoom';
import type { GameState, NationId } from '../types';

/** Every client and the shared doc agree on who is allied with whom. */
function pactsOf(s: GameState): string {
  return alliancePairs(s)
    .map((p) => p.join('+'))
    .sort()
    .join(',');
}

function expectEveryoneAgrees(room: SimRoom) {
  const want = pactsOf(room.shared);
  for (const uid of room.uids) expect(pactsOf(room.clients[uid]), uid).toBe(want);
}

function expectConsistent(room: SimRoom) {
  expect(allianceProblems(room.shared)).toEqual([]);
  for (const uid of room.uids) expect(allianceProblems(room.clients[uid]), uid).toEqual([]);
}

describe('alliances online: human to human', () => {
  it('an invitation and its acceptance reach every client', () => {
    const room = roomAtRound2();
    const [a, b] = room.uids;
    const nb = room.nationFor(b);
    const na = room.nationFor(a);

    room.act(a, (s) => proposeAlliance(s, nb, na));
    // everyone sees the offer, the invitee can answer it
    for (const uid of room.uids) expect(allianceOf(room.view(uid).nations[na]).with).toBe(nb);
    expect(incomingInvites(room.view(b), nb)).toEqual([na]);

    room.act(b, (s) => acceptAlliance(s, na, nb));
    expect(areAllies(room.shared, na, nb)).toBe(true);
    expectEveryoneAgrees(room);
    expectConsistent(room);
  });

  it('crossing invitations sent at the same moment become a pact', () => {
    const room = roomAtRound2();
    const [a, b] = room.uids;
    const na = room.nationFor(a);
    const nb = room.nationFor(b);

    // both click Invite before either sees the other's invitation
    const localA = room.edit(a, (s) => proposeAlliance(s, nb, na));
    const localB = room.edit(b, (s) => proposeAlliance(s, na, nb));
    room.push(a, localA);
    room.push(b, localB);
    room.settle();

    expect(areAllies(room.shared, na, nb)).toBe(true);
    expectEveryoneAgrees(room);
    expectConsistent(room);
  });

  it('a stale client cannot undo a pact when it pushes late', () => {
    const room = roomAtRound2();
    const [a, b] = room.uids;
    const na = room.nationFor(a);
    const nb = room.nationFor(b);
    const staleB = structuredClone(room.view(b));
    const staleA = structuredClone(room.view(a));

    room.act(a, (s) => proposeAlliance(s, nb, na));
    room.act(b, (s) => acceptAlliance(s, na, nb));

    // both still hold the pre-pact picture and push it
    room.push(b, staleB);
    room.push(a, staleA);
    room.settle();

    expect(areAllies(room.shared, na, nb)).toBe(true);
    expectEveryoneAgrees(room);
  });

  it('leaving ends the pact for the partner too, and a stale push cannot revive it', () => {
    const room = roomAtRound2();
    const [a, b] = room.uids;
    const na = room.nationFor(a);
    const nb = room.nationFor(b);
    room.act(a, (s) => proposeAlliance(s, nb, na, 10));
    room.act(b, (s) => acceptAlliance(s, na, nb));
    const stalePartner = structuredClone(room.view(b));
    expect(tributeFrom(room.shared, na)).toBe(10);

    room.act(a, (s) => leaveAlliance(s, na));

    for (const uid of room.uids) {
      const v = room.view(uid);
      expect(areAllies(v, na, nb), uid).toBe(false);
      expect(tributeFrom(v, na), uid).toBe(0);
      expect(tributeFrom(v, nb), uid).toBe(0);
      // nothing left hanging between the two of them (AI nations may be asking either of them)
      expect(incomingInvites(v, na), uid).not.toContain(nb);
      expect(incomingInvites(v, nb), uid).not.toContain(na);
      expect(outgoingInvite(v, nb), uid).toBeNull();
    }

    room.push(b, stalePartner);
    room.settle();
    expect(areAllies(room.shared, na, nb)).toBe(false);
    expectEveryoneAgrees(room);
    expectConsistent(room);
  });

  it('accepting while allied moves the pact and frees the old partner on every client', () => {
    const room = roomAtRound2();
    const [a, b, c] = room.uids;
    const na = room.nationFor(a);
    const nb = room.nationFor(b);
    const nc = room.nationFor(c);
    room.act(a, (s) => proposeAlliance(s, nb, na, 10));
    room.act(b, (s) => acceptAlliance(s, na, nb));
    expect(areAllies(room.shared, na, nb)).toBe(true);

    // c asks a, who is already allied with b
    room.act(c, (s) => proposeAlliance(s, na, nc));
    expect(allyOf(room.shared, na)).toBe(nb);
    expect(incomingInvites(room.view(a), na)).toContain(nc);

    room.act(a, (s) => acceptAlliance(s, nc, na));
    for (const uid of room.uids) {
      const v = room.view(uid);
      expect(areAllies(v, na, nc), uid).toBe(true);
      expect(allyOf(v, nb), uid).toBeNull();
      expect(outgoingInvite(v, nb), uid).toBeNull();
      expect(tributeFrom(v, nb), uid).toBe(0);
    }
    expectConsistent(room);
  });
});

describe('alliances online: AI nations', () => {
  /** A human with enough to interest any AI. */
  function appealing(room: SimRoom, uid: string) {
    patchNation(room, room.nationFor(uid), {
      hasSpyNetwork: true,
      hasAerospaceTech: true,
      hasNuclearTech: true,
    });
  }

  const aiAt = (s: GameState) => s.turnOrder.filter((id) => !s.nations[id].isHuman);

  /** Start from a table where nobody has teamed up yet, so every AI is free to answer. */
  function unpaired(room: SimRoom) {
    for (const id of room.shared.turnOrder) patchNation(room, id, { alliance: undefined });
  }

  it('an AI that says yes to a human stays allied on every client', () => {
    const room = roomAtRound2(2, 'ai-yes');
    const [a] = room.uids;
    const na = room.nationFor(a);
    unpaired(room);
    appealing(room, a);
    const ai = aiAt(room.shared).find(
      (id) => !allyOf(room.shared, id) && aiWouldAccept(room.view(a), id, na, 0),
    );
    expect(ai, 'some AI should want an appealing human').toBeDefined();

    room.act(a, (s) => proposeAllianceWithReply(s, ai!, na, 0));
    expect(areAllies(room.view(a), na, ai!)).toBe(true);

    // the AI's own reply has to survive the server merge and every snapshot
    room.settle();
    expect(areAllies(room.shared, na, ai!)).toBe(true);
    expectEveryoneAgrees(room);
    expectConsistent(room);
  });

  it('an AI that says no is remembered as having said no', () => {
    const room = roomAtRound2(2, 'ai-no');
    const [a] = room.uids;
    const na = room.nationFor(a);
    unpaired(room);
    // nothing to offer, and asking for money on top
    const ai = aiAt(room.shared).find((id) => !aiWouldAccept(room.view(a), id, na, -10));
    expect(ai).toBeDefined();
    room.act(a, (s) => proposeAllianceWithReply(s, ai!, na, -10));
    room.settle();
    expect(areAllies(room.shared, na, ai!)).toBe(false);
    expect(outgoingInvite(room.shared, na)?.declined).toBe(true);
  });

  it('every client computes the same AI pacts at the start of a round', () => {
    const mapOf = (v: GameState) =>
      JSON.stringify(v.turnOrder.map((id) => [id, v.nations[id].alliance ?? null]));
    let pacts = 0;
    for (let n = 0; n < 10; n += 1) {
      const room = makeRoom(3, `ai-determinism-${n}`);
      const summary = room.playRound();
      // an independent run from the same shared state, as a fourth client would do
      const independent = runOnlineAiPlanning(ensureIncome(nextRound(structuredClone(summary))));
      room.advance();
      for (const uid of room.uids) {
        expect(mapOf(room.view(uid)), `${uid} in game ${n}`).toBe(mapOf(independent));
      }
      // an AI either settles a pact with another AI or sends a human an invitation
      pacts += alliancePairs(independent).length;
      pacts += independent.turnOrder.filter(
        (id) => !independent.nations[id].isHuman && outgoingInvite(independent, id),
      ).length;
      expectConsistent(room);
    }
    // not vacuous: across ten tables the AI does reach out or pair up
    expect(pacts).toBeGreaterThan(0);
  });

  it('running the AI on a finished round changes nothing, and a forced rerun never breaks a pact', () => {
    for (let n = 0; n < 6; n += 1) {
      const room = roomAtRound2(2, `ai-idem-${n}`);
      const once = room.view(room.uids[0]);
      // the real guard: a round whose AI planning is done is left alone
      expect(runOnlineAiPlanning(once)).toBe(once);
      // forced again, standings have moved on (the AI bought things), so it may reach new
      // pacts — but the ones already made stand, and the table stays consistent
      const twice = runOnlineAiPlanning({ ...once, aiPlanningComplete: false });
      for (const [a, b] of alliancePairs(once)) {
        expect(areAllies(twice, a, b), `${a}+${b} in game ${n}`).toBe(true);
      }
      expect(allianceProblems(twice)).toEqual([]);
    }
  });
});

describe('alliances online: pact money', () => {
  it('moves exactly once per round however many clients compute the income', () => {
    const room = roomAtRound2(2, 'pact-money');
    const [a, b] = room.uids;
    const na = room.nationFor(a);
    const nb = room.nationFor(b);
    room.act(a, (s) => proposeAlliance(s, nb, na, 10));
    room.act(b, (s) => acceptAlliance(s, na, nb));

    room.playRound();
    const beforePay = room.shared;
    const r3 = room.advance();
    expect(r3.round).toBe(3);

    const entry = (s: GameState, id: NationId) => s.lastIncomeLedger.find((e) => e.nationId === id);
    expect(entry(r3, na)?.pactTransfer).toBe(-10);
    expect(entry(r3, nb)?.pactTransfer).toBe(10);

    // against the same round with no pact: the payer is $10M down, the payee $10M up
    // (only this pact is removed — other pacts at the table change who is sanctioned)
    const free = (s: GameState): GameState => ({
      ...s,
      nations: {
        ...s.nations,
        [na]: { ...s.nations[na], alliance: undefined },
        [nb]: { ...s.nations[nb], alliance: undefined },
      },
    });
    const without = nextRound(free(beforePay));
    expect(r3.nations[na].money).toBeCloseTo(without.nations[na].money - 10, 6);
    expect(r3.nations[nb].money).toBeCloseTo(without.nations[nb].money + 10, 6);

    // every client lands on the same treasuries and a second pass changes nothing
    for (const uid of room.uids) {
      const v = room.view(uid);
      expect(v.nations[na].money).toBeCloseTo(r3.nations[na].money, 6);
      expect(v.nations[nb].money).toBeCloseTo(r3.nations[nb].money, 6);
      const again = ensureIncome(v);
      expect(again.nations[na].money).toBeCloseTo(v.nations[na].money, 6);
    }
    room.settle();
    expect(room.shared.nations[na].money).toBeCloseTo(r3.nations[na].money, 6);
    expect(allianceProblems(room.shared)).toEqual([]);
  });

  it('stops the moment the pact ends, even before the next income', () => {
    const room = roomAtRound2(2, 'pact-money-stop');
    const [a, b] = room.uids;
    const na = room.nationFor(a);
    const nb = room.nationFor(b);
    room.act(a, (s) => proposeAlliance(s, nb, na, 10));
    room.act(b, (s) => acceptAlliance(s, na, nb));
    room.act(b, (s) => leaveAlliance(s, nb));

    room.playRound();
    const r3 = room.advance();
    for (const id of [na, nb]) {
      expect(r3.lastIncomeLedger.find((e) => e.nationId === id)?.pactTransfer ?? 0).toBe(0);
    }
  });
});

// VITE_FUZZ_SEEDS=300 npx vitest run src/lib/alliance-online.test.ts for a long soak
const seeds = Number(import.meta.env.VITE_FUZZ_SEEDS ?? 12);
const fuzzStats = { runs: 0, formed: 0, left: 0, switched: 0, aiPacts: 0, transfers: 0 };

describe('alliances online: random play never breaks the table', () => {
  // Guards against the fuzz quietly doing nothing. Runs after the whole block, so it
  // does not depend on test order, and is skipped when only some seeds were selected.
  afterAll(() => {
    if (fuzzStats.runs < seeds) return;
    expect(fuzzStats.formed).toBeGreaterThan(0);
    expect(fuzzStats.left).toBeGreaterThan(0);
    expect(fuzzStats.aiPacts).toBeGreaterThan(0);
    expect(fuzzStats.transfers).toBeGreaterThan(0);
  });

  /** One human does something alliance-shaped at random. */
  function randomAction(room: SimRoom, uid: string, roll: () => number) {
    const me = room.nationFor(uid);
    const s = room.view(uid);
    const others = s.turnOrder.filter((id) => id !== me && !s.nations[id].eliminated);
    const pick = others[Math.floor(roll() * others.length)];
    const invites = incomingInvites(s, me);
    const r = roll();
    if (invites.length && r < 0.4) {
      if (allyOf(s, me)) fuzzStats.switched += 1;
      else fuzzStats.formed += 1;
      room.act(uid, (x) => acceptAlliance(x, invites[0], me));
    } else if (allyOf(s, me) && r < 0.6) {
      fuzzStats.left += 1;
      room.act(uid, (x) => leaveAlliance(x, me));
    } else if (r < 0.9) {
      const tribute = [0, 10, -10][Math.floor(roll() * 3)];
      room.act(uid, (x) => proposeAllianceWithReply(x, pick, me, tribute));
    } else {
      room.act(uid, (x) => x);
    }
  }

  for (let seed = 1; seed <= seeds; seed += 1) {
    it(`seed ${seed}: pacts stay consistent and agreed through three rounds`, () => {
      fuzzStats.runs += 1;
      const roll = rng(seed * 7919);
      const room = roomAtRound2(3, `fuzz-${seed}`);
      for (let round = 2; round <= 4; round += 1) {
        for (let step = 0; step < 6; step += 1) {
          randomAction(room, room.uids[Math.floor(roll() * room.uids.length)], roll);
          expect(allianceProblems(room.shared), `seed ${seed} round ${round} step ${step}`).toEqual([]);
        }
        room.settle();
        expectEveryoneAgrees(room);
        expectConsistent(room);
        const summary = room.playRound();
        fuzzStats.aiPacts += alliancePairs(summary).filter(
          ([x, y]) => !summary.nations[x].isHuman && !summary.nations[y].isHuman,
        ).length;
        fuzzStats.transfers += summary.lastIncomeLedger.filter((e) => e.pactTransfer).length;
        if (summary.phase === 'gameOver') break;
        // no strike landed on an ally
        const pairs = alliancePairs(summary);
        for (const e of summary.previousRoundEvents ?? []) {
          if (!e.attackerId) continue;
          const hit = pairs.some(
            ([x, y]) =>
              (x === e.attackerId && y === e.nationId) || (y === e.attackerId && x === e.nationId),
          );
          expect(hit, `${e.attackerId} struck its ally ${e.nationId} (${e.kind})`).toBe(false);
        }
        if (round < 4) room.advance();
        expectConsistent(room);
      }
    });
  }
});

describe('alliances online: server-side merge', () => {
  it('keeps the higher pact version even when a stale writer pushes later', () => {
    const room = roomAtRound2(2, 'merge-version');
    const [a, b] = room.uids;
    const na = room.nationFor(a);
    const nb = room.nationFor(b);
    const stale = structuredClone(room.view(b));
    room.act(a, (s) => proposeAlliance(s, nb, na));
    const merged = mergeHumanPlanningWrite(room.shared, stale, nb);
    expect(allianceOf(merged.nations[na]).with).toBe(nb);
  });
});
