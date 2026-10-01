import {
  buyResearch,
  buyShield,
  finishStrikeResolution,
  markHumanReady,
  nextRound,
  touchHumanActivity,
} from '../game/engine';
import { applyRemoteGameSnapshot, mergeHumanPlanningWrite } from './onlineSync';
import { assignNations, buildOnlineGameState } from './multiplayer';
import { allyOf, tributeFrom } from '../game/alliance';
import type { GameState, NationId, NationState } from '../types';

/**
 * Test harness: an in-memory room that mirrors what Firestore does — every
 * client edits only its own nation, pushes through the server-side merge, and
 * applies the broadcast snapshot. Not shipped, only imported by tests.
 */
export class SimRoom {
  shared: GameState;
  clients: Record<string, GameState>;
  uids: string[];

  constructor(initial: GameState, uids: string[]) {
    this.uids = uids;
    this.shared = initial;
    this.clients = Object.fromEntries(uids.map((u) => [u, structuredClone(initial)]));
  }

  nationFor(uid: string): NationId {
    return this.clients[uid].uidToNation![uid] as NationId;
  }

  /** The client's view of its own state. */
  view(uid: string): GameState {
    return this.clients[uid];
  }

  /** A client edits its own copy locally (no network yet). */
  edit(uid: string, fn: (s: GameState) => GameState): GameState {
    this.clients[uid] = fn(this.clients[uid]);
    return this.clients[uid];
  }

  /** Push the client's current state through the merge and broadcast to everyone. */
  push(uid: string, local: GameState = this.clients[uid]) {
    this.shared = mergeHumanPlanningWrite(this.shared, local, this.nationFor(uid));
    this.broadcast();
  }

  /** Edit locally, then push — what a click does. */
  act(uid: string, fn: (s: GameState) => GameState) {
    this.push(uid, this.edit(uid, fn));
  }

  broadcast() {
    for (const uid of this.uids) {
      this.clients[uid] = applyRemoteGameSnapshot(this.clients[uid], this.shared, this.nationFor(uid));
    }
  }

  /** Every client re-reads the room and re-pushes until nothing moves. */
  settle(rounds = 4) {
    for (let i = 0; i < rounds; i += 1) {
      this.broadcast();
      for (const uid of this.uids) {
        this.shared = mergeHumanPlanningWrite(this.shared, this.clients[uid], this.nationFor(uid));
      }
    }
    this.broadcast();
  }

  /** Everyone buys something small and locks in; the host then runs the round forward. */
  playRound() {
    for (const uid of this.uids) {
      const id = this.nationFor(uid);
      this.act(uid, (s) => {
        let next = s;
        const city = next.nations[id].cities.find((c) => !c.destroyed && !c.hasResearch);
        if (city) next = buyResearch(next, city.id, id);
        const shielded = next.nations[id].cities.find(
          (c) => !c.destroyed && !c.hasShield && !c.hasResearch,
        );
        if (shielded) next = buyShield(next, shielded.id, id);
        return markHumanReady(touchHumanActivity(next, id), id);
      });
    }
    let summary = this.shared;
    if (summary.phase === 'resolveStrikes') summary = finishStrikeResolution(summary);
    this.shared = summary;
    this.broadcast();
    return summary;
  }

  /** Move the room into the next round, as the host's published advance does. */
  advance() {
    const next = nextRound(this.shared);
    this.shared = next;
    this.broadcast();
    return next;
  }
}

export function makeRoom(humans: number, gameId = 'alliance-room'): SimRoom {
  const uids = ['uid-a', 'uid-b', 'uid-c', 'uid-d'].slice(0, humans);
  const names = Object.fromEntries(uids.map((u, i) => [u, `Player ${i + 1}`]));
  const state = buildOnlineGameState(assignNations(uids), names, gameId);
  return new SimRoom(state, uids);
}

/** A room that has played round 1 and sits at the start of round 2. */
export function roomAtRound2(humans = 3, gameId = 'alliance-room'): SimRoom {
  const room = makeRoom(humans, gameId);
  room.playRound();
  room.advance();
  // In a live room somebody's client has already pushed the new round; without
  // this the first writer's copy always wins the merge and hides stale-read bugs.
  room.settle();
  return room;
}

/** Small deterministic generator for seeded scenarios. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


/** Change a nation everywhere at once (shared doc and every client) — test setup only. */
export function patchNation(room: SimRoom, id: NationId, patch: Partial<NationState>) {
  const apply = (s: GameState): GameState => ({
    ...s,
    nations: { ...s.nations, [id]: { ...s.nations[id], ...patch } },
  });
  room.shared = apply(room.shared);
  for (const uid of room.uids) room.clients[uid] = apply(room.clients[uid]);
}

/**
 * Things that must hold in any state, however the pointers got there. Returns a
 * list of human-readable problems (empty when the table is consistent).
 */
export function allianceProblems(state: GameState): string[] {
  const problems: string[] = [];
  for (const id of state.turnOrder) {
    const n = state.nations[id];
    if (n.eliminated) continue;
    const a = n.alliance;
    if (a?.with === id) problems.push(`${id} points at itself`);
    if (n.money < 0) problems.push(`${id} has negative money (${n.money})`);
    const ally = allyOf(state, id);
    if (ally) {
      if (allyOf(state, ally) !== id) problems.push(`${id}→${ally} is not mutual`);
      if (state.nations[ally].eliminated) problems.push(`${id} is allied with the fallen ${ally}`);
      if (tributeFrom(state, id) !== -tributeFrom(state, ally)) {
        problems.push(`${id}/${ally} disagree on the money terms`);
      }
    } else if (a?.with && a.proposalId === 0) {
      // Pointers that were never an invitation are accepted pacts; if the other
      // side no longer points back, something forgot to clear this one.
      const target = state.nations[a.with];
      if (target && !target.eliminated && (state.round > 1)) {
        problems.push(`${id} still points at ${a.with} after the pact ended`);
      }
    }
  }
  const ledger = state.lastIncomeLedger ?? [];
  const moved = ledger.reduce((sum, e) => sum + (e.pactTransfer ?? 0), 0);
  if (Math.abs(moved) > 1e-6) problems.push(`pact money does not net to zero (${moved})`);
  return problems;
}
