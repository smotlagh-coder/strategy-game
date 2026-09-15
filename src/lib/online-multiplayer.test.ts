import { describe, expect, it } from 'vitest';
import {
  buyResearch,
  buyShield,
  markHumanReady,
  allAliveHumansReady,
  touchHumanActivity,
  finishStrikeResolution,
  armAftermathTimer,
  nextRound,
  forfeitNation,
  aliveNations,
} from '../game/engine';
import { finishOnlineHumanPlanning } from '../game/ai';
import { assignNations, buildOnlineGameState } from './multiplayer';
import {
  applyRemoteGameSnapshot,
  mergeHumanPlanningWrite,
  mergeNationPlanning,
} from './onlineSync';
import { applyPublishedGame, nextGameSync } from './gameSync';
import type { GameState, NationId } from '../types';

function makeThreePlayerGame() {
  const uids = ['uid-a', 'uid-b', 'uid-c'];
  const names = {
    'uid-a': 'Alice · AAAAAA',
    'uid-b': 'Bob · BBBBBB',
    'uid-c': 'Cara · CCCCCC',
  };
  const assignments = assignNations(uids);
  const state = buildOnlineGameState(assignments, names, 'game-test-1');
  return { uids, names, assignments, state };
}

function completeSelections(state: GameState, nationId: NationId): GameState {
  let s = state;
  const city = s.nations[nationId].cities.find((c) => !c.destroyed && !c.hasResearch);
  if (city) s = buyResearch(s, city.id, nationId);
  const shieldCity = s.nations[nationId].cities.find(
    (c) => !c.destroyed && !c.hasShield && !c.hasResearch,
  );
  if (shieldCity) s = buyShield(s, shieldCity.id, nationId);
  s = touchHumanActivity(s, nationId);
  s = markHumanReady(s, nationId);
  return s;
}

/** In-memory 3-client room that mirrors Firestore merge + snapshot apply. */
class SimRoom {
  shared: GameState;
  clients: Record<string, GameState>;

  constructor(initial: GameState, uids: string[]) {
    this.shared = initial;
    this.clients = Object.fromEntries(uids.map((u) => [u, structuredClone(initial)]));
  }

  nationFor(uid: string): NationId {
    return this.clients[uid].uidToNation![uid] as NationId;
  }

  push(uid: string, local: GameState) {
    const nationId = this.nationFor(uid);
    this.shared = mergeHumanPlanningWrite(this.shared, local, nationId);
    // Broadcast to all clients
    for (const other of Object.keys(this.clients)) {
      const myNation = this.nationFor(other);
      this.clients[other] = applyRemoteGameSnapshot(
        this.clients[other],
        this.shared,
        myNation,
      );
    }
  }

  /** Detect phase oscillation / blank-state loops. */
  pump(max = 50): { phases: string[]; looped: boolean } {
    const phases: string[] = [];
    for (let i = 0; i < max; i += 1) {
      const before = this.shared.phase;
      phases.push(`${before}:${this.shared.planningComplete ? 1 : 0}`);
      // Each client re-applies shared (as if snapshot fired again)
      for (const uid of Object.keys(this.clients)) {
        this.clients[uid] = applyRemoteGameSnapshot(
          this.clients[uid],
          this.shared,
          this.nationFor(uid),
        );
      }
      // Re-merge from each client (stale concurrent writers)
      for (const uid of Object.keys(this.clients)) {
        this.shared = mergeHumanPlanningWrite(
          this.shared,
          this.clients[uid],
          this.nationFor(uid),
        );
      }
      const key = `${this.shared.phase}:${this.shared.planningComplete ? 1 : 0}`;
      if (phases.filter((p) => p === key).length > 8) {
        return { phases, looped: true };
      }
      if (
        this.shared.phase === 'resolveStrikes' ||
        this.shared.phase === 'roundSummary' ||
        this.shared.phase === 'gameOver'
      ) {
        // Stable terminal?
        const stable = phases.slice(-3).every((p) => p.startsWith(this.shared.phase));
        if (stable && phases.length > 3) return { phases, looped: false };
      }
    }
    return { phases, looped: false };
  }
}

describe('3-player online simulation', () => {
  it('assigns three distinct nations', () => {
    const { assignments, uids } = makeThreePlayerGame();
    const nations = uids.map((u) => assignments[u]);
    expect(new Set(nations).size).toBe(3);
  });

  it('buildOnlineGameState starts in buy with three humans', () => {
    const { state } = makeThreePlayerGame();
    expect(state.mode).toBe('online');
    expect(state.phase).toBe('buy');
    expect(state.humanNations).toHaveLength(3);
    expect(state.planningComplete).toBe(false);
    expect(state.aiPlanningComplete).toBe(true);
    const aiIds = state.turnOrder.filter((id) => !state.nations[id].isHuman);
    for (const id of aiIds) {
      expect(state.nations[id].hasNuclearTech).toBe(true);
      expect(state.nations[id].money).toBeLessThan(10);
    }
  });

  it('merges research and shields without wiping them', () => {
    const { state, uids } = makeThreePlayerGame();
    const nationId = state.uidToNation![uids[0]] as NationId;
    const withResearch = buyResearch(
      state,
      state.nations[nationId].cities[0].id,
      nationId,
    );
    const withShield = buyShield(
      state,
      state.nations[nationId].cities[1].id,
      nationId,
    );
    const merged = mergeNationPlanning(
      withResearch.nations[nationId],
      withShield.nations[nationId],
    );
    expect(merged.cities[0].hasResearch).toBe(true);
    expect(merged.cities[1].hasShield).toBe(true);
  });

  it('does not crash mergeNationPlanning with undefined (blank-screen guard)', () => {
    const { state, uids } = makeThreePlayerGame();
    const nationId = state.uidToNation![uids[0]] as NationId;
    expect(() => mergeNationPlanning(undefined, state.nations[nationId])).not.toThrow();
    expect(() => mergeNationPlanning(state.nations[nationId], undefined)).not.toThrow();
  });

  it('advances to strikes/summary after all three finish selections', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);

    for (const uid of uids) {
      const nationId = room.nationFor(uid);
      const local = completeSelections(room.clients[uid], nationId);
      room.clients[uid] = local;
      room.push(uid, local);
    }

    expect(allAliveHumansReady(room.shared)).toBe(true);
    expect(
      room.shared.phase === 'resolveStrikes' ||
        room.shared.phase === 'roundSummary' ||
        room.shared.phase === 'gameOver',
    ).toBe(true);
    expect(room.shared.planningComplete).toBe(true);

    // Research/shields from each human still present
    for (const uid of uids) {
      const nid = room.nationFor(uid);
      const n = room.shared.nations[nid];
      const upgraded = n.cities.some((c) => c.hasResearch || c.hasShield);
      expect(upgraded).toBe(true);
    }

    // AI must also have spent and upgraded (not sit on starting cash)
    const aiIds = room.shared.turnOrder.filter((id) => !room.shared.nations[id].isHuman);
    expect(aiIds.length).toBeGreaterThan(0);
    for (const id of aiIds) {
      const n = room.shared.nations[id];
      expect(n.hasNuclearTech).toBe(true);
      expect(n.money).toBeLessThan(10);
      expect(n.cities.some((c) => c.hasResearch || c.hasShield)).toBe(true);
    }
  });

  it('finishOnlineHumanPlanning is idempotent (no re-entry loop)', () => {
    const { state, uids } = makeThreePlayerGame();
    let s = state;
    for (const uid of uids) {
      s = completeSelections(s, s.uidToNation![uid] as NationId);
    }
    const once = finishOnlineHumanPlanning(s);
    const twice = finishOnlineHumanPlanning(once);
    expect(twice.planningComplete).toBe(true);
    expect(twice.phase).toBe(once.phase);
    expect(twice.currentTurnIndex).toBe(once.currentTurnIndex);
    expect(twice.pendingStrikes.length).toBe(once.pendingStrikes.length);
  });

  it('does not oscillate when three clients keep syncing after planning', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);

    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }

    const { looped, phases } = room.pump(40);
    expect(looped).toBe(false);
    expect(
      room.shared.phase === 'resolveStrikes' ||
        room.shared.phase === 'roundSummary' ||
        room.shared.phase === 'gameOver',
    ).toBe(true);
    // Should not flip back to buy planning
    const late = phases.slice(-10);
    expect(late.some((p) => p.startsWith('buy:0'))).toBe(false);
  });

  it('keeps each client renderable (valid phase + own nation)', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }
    room.pump(20);

    const renderable = new Set([
      'buy',
      'action',
      'resolveStrikes',
      'roundSummary',
      'gameOver',
      'income',
    ]);
    for (const uid of uids) {
      const c = room.clients[uid];
      expect(renderable.has(c.phase)).toBe(true);
      const myNation = c.uidToNation?.[uid];
      expect(myNation).toBeTruthy();
      expect(c.nations[myNation!]).toBeTruthy();
    }
  });

  it('stale mid-selection write cannot clear another player ready flag', () => {
    const { state, uids } = makeThreePlayerGame();
    const [a, b, c] = uids;
    let shared = state;

    const aDone = completeSelections(state, state.uidToNation![a] as NationId);
    shared = mergeHumanPlanningWrite(shared, aDone, state.uidToNation![a] as NationId);

    const bDone = completeSelections(shared, shared.uidToNation![b] as NationId);
    shared = mergeHumanPlanningWrite(shared, bDone, shared.uidToNation![b] as NationId);

    // Stale write from C before they finished, and without A/B ready flags
    const cStale = touchHumanActivity(state, state.uidToNation![c] as NationId);
    shared = mergeHumanPlanningWrite(shared, cStale, state.uidToNation![c] as NationId);

    expect(shared.humanReady?.[shared.uidToNation![a] as NationId]).toBe(true);
    expect(shared.humanReady?.[shared.uidToNation![b] as NationId]).toBe(true);
  });

  it('stale resolveStrikes cannot overwrite roundSummary', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }

    // Force shared into summary (as the resolve lock holder would)
    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') {
      summary = finishStrikeResolution(summary);
    }
    expect(summary.phase === 'roundSummary' || summary.phase === 'gameOver').toBe(true);
    room.shared = summary;
    for (const uid of uids) {
      room.clients[uid] = applyRemoteGameSnapshot(
        room.clients[uid],
        room.shared,
        room.nationFor(uid),
      );
    }

    // Stale client still on resolveStrikes pushes
    const staleUid = uids[0];
    const stale: GameState = {
      ...room.clients[staleUid],
      phase: 'resolveStrikes',
      planningComplete: true,
    };
    room.push(staleUid, stale);

    expect(room.shared.phase).not.toBe('resolveStrikes');
    expect(
      room.shared.phase === 'roundSummary' || room.shared.phase === 'gameOver',
    ).toBe(true);
    for (const uid of uids) {
      expect(room.clients[uid].phase).not.toBe('resolveStrikes');
    }
  });

  it('nextRound from host syncs every client into round 2 buy', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }

    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') {
      summary = finishStrikeResolution(summary);
    }
    room.shared = summary;
    for (const uid of uids) {
      room.clients[uid] = applyRemoteGameSnapshot(
        { ...room.clients[uid], phase: 'resolveStrikes', planningComplete: true },
        room.shared,
        room.nationFor(uid),
      );
    }

    // Host advances
    const host = uids[0];
    const advanced = nextRound(room.shared);
    room.shared = advanced;
    for (const uid of uids) {
      room.clients[uid] = applyRemoteGameSnapshot(
        room.clients[uid],
        room.shared,
        room.nationFor(uid),
      );
    }

    expect(advanced.round).toBe(2);
    expect(advanced.phase).toBe('buy');
    expect(advanced.planningComplete).toBe(false);
    for (const uid of uids) {
      expect(room.clients[uid].round).toBe(2);
      expect(room.clients[uid].phase).toBe('buy');
      expect(room.clients[uid].planningComplete).toBe(false);
      // Snapshot apply runs AI planning for the new round
      expect(room.clients[uid].aiPlanningComplete).toBe(true);
    }

    // Stale round-1 summary write cannot pull the room backwards
    room.push(host, { ...summary, phase: 'roundSummary' });
    expect(room.shared.round).toBe(2);
    expect(room.shared.phase).toBe('buy');
  });

  it('full round loop: plan → resolve → next round → AI plans again', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);

    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }
    expect(room.shared.planningComplete).toBe(true);

    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') {
      summary = finishStrikeResolution(summary);
    }
    expect(summary.phase === 'roundSummary' || summary.phase === 'gameOver').toBe(true);
    if (summary.phase === 'gameOver') return;

    const r2 = nextRound(summary);
    room.shared = r2;
    for (const uid of uids) {
      room.clients[uid] = applyRemoteGameSnapshot(room.clients[uid], room.shared, room.nationFor(uid));
    }

    expect(room.shared.round).toBe(2);
    expect(room.clients[uids[0]].aiPlanningComplete).toBe(true);

    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }

    expect(allAliveHumansReady(room.shared)).toBe(true);
    expect(room.shared.planningComplete).toBe(true);
    expect(
      room.shared.phase === 'resolveStrikes' ||
        room.shared.phase === 'roundSummary' ||
        room.shared.phase === 'gameOver',
    ).toBe(true);
  });

  it('applyRemote keeps local in-progress buys while merging peer ready flags', () => {
    const { state, uids } = makeThreePlayerGame();
    const [a, b] = uids;
    const nationA = state.uidToNation![a] as NationId;
    const nationB = state.uidToNation![b] as NationId;

    let remote = markHumanReady(touchHumanActivity(state, nationB), nationB);
    remote = mergeHumanPlanningWrite(state, remote, nationB);

    const localCity = state.nations[nationA].cities.find((c) => !c.hasResearch)!;
    const local = buyResearch(state, localCity.id, nationA);

    const applied = applyRemoteGameSnapshot(local, remote, nationA);
    expect(applied.nations[nationA].cities.find((c) => c.id === localCity.id)?.hasResearch).toBe(
      true,
    );
    expect(applied.humanReady?.[nationB]).toBe(true);
    expect(applied.humanReady?.[nationA]).toBeFalsy();
    expect(applied.aiPlanningComplete).toBe(true);
  });

  it('late guest finish adopts round 2 when host already advanced', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    const [host, guest, other] = uids;

    // Host + other finish; advance shared to round 2
    for (const uid of [host, other]) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }
    // Guest also finishes on round 1 locally (slow network)
    const guestLocal = completeSelections(room.clients[guest], room.nationFor(guest));
    room.clients[guest] = guestLocal;
    room.push(guest, guestLocal);

    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') summary = finishStrikeResolution(summary);
    if (summary.phase === 'roundSummary') {
      room.shared = nextRound(summary);
    }

    // Guest still on round 1 receives / merges the advanced room
    const adopted = applyRemoteGameSnapshot(
      guestLocal,
      room.shared,
      room.nationFor(guest),
    );
    expect(adopted.round).toBe(2);
    expect(adopted.phase).toBe('buy');
    expect(adopted.planningComplete).toBe(false);
  });

  it('forfeitNation burns all cities and marks the nation OUT', () => {
    const { state, uids } = makeThreePlayerGame();
    const leaver = uids[1];
    const nationId = state.uidToNation![leaver] as NationId;

    const after = forfeitNation(state, nationId);
    expect(after.nations[nationId].eliminated).toBe(true);
    expect(after.nations[nationId].isHuman).toBe(false);
    expect(after.nations[nationId].cities.every((c) => c.destroyed)).toBe(true);
    expect(after.nations[nationId].bombs).toBe(0);
    expect(after.uidToNation?.[leaver]).toBeUndefined();
    expect(after.humanNations).not.toContain(nationId);
    expect(aliveNations(after)).not.toContain(nationId);

    // Peers adopt forfeit via remote snapshot even with stale local human copy
    const peer = applyRemoteGameSnapshot(state, after, state.uidToNation![uids[0]] as NationId);
    expect(peer.nations[nationId].eliminated).toBe(true);
    expect(peer.nations[nationId].cities.every((c) => c.destroyed)).toBe(true);
  });

  it('forfeit of the last blocker unblocks remaining humans', () => {
    const { state, uids } = makeThreePlayerGame();
    const [a, b, c] = uids;
    let s = completeSelections(state, state.uidToNation![a] as NationId);
    s = completeSelections(s, state.uidToNation![b] as NationId);
    expect(allAliveHumansReady(s)).toBe(false);

    s = forfeitNation(s, state.uidToNation![c] as NationId);
    expect(allAliveHumansReady(s)).toBe(true);
    expect(s.nations[state.uidToNation![c] as NationId].eliminated).toBe(true);
  });

  it('late peers still on roundSummary all adopt round 2 from shared advance', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }

    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') summary = finishStrikeResolution(summary);
    expect(summary.phase).toBe('roundSummary');
    room.shared = summary;
    for (const uid of uids) {
      room.clients[uid] = applyRemoteGameSnapshot(
        room.clients[uid],
        room.shared,
        room.nationFor(uid),
      );
    }

    // First client advances the shared room (transaction winner)
    room.shared = nextRound(summary);

    // Every other client — still looking at local roundSummary — adopts R2
    for (const uid of uids) {
      expect(room.clients[uid].phase).toBe('roundSummary');
      room.clients[uid] = applyRemoteGameSnapshot(
        room.clients[uid],
        room.shared,
        room.nationFor(uid),
      );
      expect(room.clients[uid].round).toBe(2);
      expect(room.clients[uid].phase).toBe('buy');
    }
  });

  it('client still on buy adopts remote aftermath instead of staying on the board', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }
    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') summary = finishStrikeResolution(summary);
    expect(summary.phase).toBe('roundSummary');

    const stuck = uids[1];
    const adopted = applyRemoteGameSnapshot(
      { ...room.clients[stuck], phase: 'buy', planningComplete: false },
      summary,
      room.nationFor(stuck),
    );
    expect(adopted.phase).toBe('roundSummary');
    expect(adopted.aftermathEndsAt == null).toBe(true);
  });

  it('peer still resolving adopts published aftermath and shared strategy timer', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }

    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') summary = finishStrikeResolution(summary);
    expect(summary.phase).toBe('roundSummary');
    summary = armAftermathTimer(summary);
    expect(summary.aftermathEndsAt).toBeTruthy();
    room.shared = summary;

    const peer = uids[1];
    const adopted = applyRemoteGameSnapshot(
      { ...room.clients[peer], phase: 'resolveStrikes', planningComplete: true },
      room.shared,
      room.nationFor(peer),
    );
    expect(adopted.phase).toBe('roundSummary');
    expect(adopted.aftermathEndsAt).toBe(summary.aftermathEndsAt);
  });

  it('planning write from a locally advanced client cannot publish the next round', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }
    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') summary = finishStrikeResolution(summary);
    expect(summary.phase).toBe('roundSummary');

    const leaked = nextRound(summary);
    const kept = mergeHumanPlanningWrite(summary, leaked, room.nationFor(uids[0]));
    expect(kept.round).toBe(1);
    expect(kept.phase).toBe('roundSummary');
  });

  it('local aftermath without a published clock yields to shared planning', () => {
    const { state, uids } = makeThreePlayerGame();
    const nation = state.uidToNation![uids[0]] as NationId;
    const localSummary = {
      ...state,
      phase: 'roundSummary' as const,
      planningComplete: true,
    };
    const adopted = applyPublishedGame(
      localSummary,
      state,
      nation,
      nextGameSync(undefined, 'playerReady', 1, 1, { nationId: nation }),
    );
    expect(adopted.phase).toBe('buy');
    expect(adopted.round).toBe(1);
  });

  it('published dropout event names the leaver and is a follow-clock kind', () => {
    const sync = nextGameSync(undefined, 'dropout', 1, 1, {
      nationId: 'us',
      playerName: 'Farshad',
      nationName: 'United States',
    });
    expect(sync.kind).toBe('dropout');
    expect(sync.playerName).toBe('Farshad');
    expect(sync.seq).toBe(1);
  });

  it('published roundStart event forces every client onto the new round', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }
    let summary = room.shared;
    if (summary.phase === 'resolveStrikes') summary = finishStrikeResolution(summary);
    const r2 = nextRound(summary);
    const sync = nextGameSync(undefined, 'roundStart', r2.round);

    for (const uid of uids) {
      const stuckOnBoard = {
        ...room.clients[uid],
        phase: 'buy' as const,
        planningComplete: false,
      };
      const adopted = applyPublishedGame(stuckOnBoard, r2, room.nationFor(uid), sync);
      expect(adopted.round).toBe(2);
      expect(adopted.phase).toBe('buy');
    }
  });

  it('any client can publish resolve once everyone is ready, freeing stuck peers', () => {
    const { state, uids } = makeThreePlayerGame();
    const room = new SimRoom(state, uids);
    for (const uid of uids) {
      const local = completeSelections(room.clients[uid], room.nationFor(uid));
      room.clients[uid] = local;
      room.push(uid, local);
    }

    // Shared doc has everyone ready but nobody published the transition yet.
    const stalled: GameState = {
      ...room.shared,
      phase: 'buy',
      planningComplete: false,
      aiPlanningComplete: false,
    };
    expect(allAliveHumansReady(stalled)).toBe(true);

    // Mirrors the publishPlanningComplete transaction body.
    const published = finishOnlineHumanPlanning(stalled);
    expect(published.planningComplete).toBe(true);
    expect(published.phase).not.toBe('buy');

    const sync = nextGameSync(undefined, 'resolve', published.round);
    for (const uid of uids) {
      const stuckWatchingAi: GameState = {
        ...room.clients[uid],
        phase: 'buy',
        planningComplete: false,
      };
      const adopted = applyPublishedGame(
        stuckWatchingAi,
        published,
        room.nationFor(uid),
        sync,
      );
      expect(adopted.planningComplete).toBe(true);
      expect(adopted.phase).toBe(published.phase);
    }
  });
});
