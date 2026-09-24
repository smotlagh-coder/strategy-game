import { describe, expect, it } from 'vitest';
import {
  buyResearch,
  markHumanReady,
  touchHumanActivity,
  researchCount,
  nextRound,
  finishStrikeResolution,
} from './engine';
import { finishOnlineHumanPlanning, runOnlineAiPlanning } from './ai';
import { assignNations, buildOnlineGameState } from '../lib/multiplayer';
import type { NationId } from '../types';

describe('online AI planning', () => {
  it('AI nations buy at round start before humans finish', () => {
    const uids = ['uid-a', 'uid-b', 'uid-c'];
    const names = {
      'uid-a': 'Alice',
      'uid-b': 'Bob',
      'uid-c': 'Cara',
    };
    const assignments = assignNations(uids);
    const s = buildOnlineGameState(assignments, names, 'game-ai-1');
    expect(s.aiPlanningComplete).toBe(true);

    const aiIds = s.turnOrder.filter((id) => !s.nations[id].isHuman);
    expect(aiIds.length).toBeGreaterThan(0);
    for (const id of aiIds) {
      const n = s.nations[id];
      // The opening turn goes on research and a shield, not on an arsenal
      expect(researchCount(s, id) + n.cities.filter((c) => c.hasShield).length).toBeGreaterThan(0);
      expect(n.money).toBeLessThan(10);
    }
  });

  it('finishing humans advances to strikes after AI already planned', () => {
    const uids = ['uid-a', 'uid-b', 'uid-c'];
    const names = {
      'uid-a': 'Alice',
      'uid-b': 'Bob',
      'uid-c': 'Cara',
    };
    const assignments = assignNations(uids);
    let s = buildOnlineGameState(assignments, names, 'game-ai-2');

    for (const uid of uids) {
      const nid = s.uidToNation![uid] as NationId;
      const city = s.nations[nid].cities.find((c) => !c.destroyed && !c.hasResearch)!;
      s = buyResearch(s, city.id, nid);
      s = touchHumanActivity(s, nid);
      s = markHumanReady(s, nid);
    }

    const after = finishOnlineHumanPlanning(s);
    expect(
      after.phase === 'resolveStrikes' ||
        after.phase === 'roundSummary' ||
        after.phase === 'gameOver',
    ).toBe(true);
  });

  it('runOnlineAiPlanning is idempotent', () => {
    const uids = ['uid-a', 'uid-b'];
    const names = { 'uid-a': 'Alice', 'uid-b': 'Bob' };
    const s = buildOnlineGameState(assignNations(uids), names, 'game-ai-4');
    const once = runOnlineAiPlanning(s);
    const twice = runOnlineAiPlanning(once);
    expect(twice).toEqual(once);
  });

  it('finishOnlineHumanPlanning no-ops until all humans are ready', () => {
    const uids = ['uid-a', 'uid-b'];
    const names = { 'uid-a': 'Alice', 'uid-b': 'Bob' };
    let s = buildOnlineGameState(assignNations(uids), names, 'game-ai-5');
    const nid = s.uidToNation![uids[0]] as NationId;
    s = markHumanReady(touchHumanActivity(s, nid), nid);
    const stuck = finishOnlineHumanPlanning(s);
    expect(stuck.phase).toBe('buy');
    expect(stuck.planningComplete).toBeFalsy();
  });

  it('next round re-runs AI planning', () => {
    const uids = ['uid-a', 'uid-b'];
    const names = { 'uid-a': 'Alice', 'uid-b': 'Bob' };
    const assignments = assignNations(uids);
    let s = buildOnlineGameState(assignments, names, 'game-ai-3');
    for (const uid of uids) {
      const nid = s.uidToNation![uid] as NationId;
      s = markHumanReady(touchHumanActivity(s, nid), nid);
    }
    s = finishOnlineHumanPlanning(s);
    if (s.phase === 'resolveStrikes') s = finishStrikeResolution(s);
    s = nextRound(s);
    expect(s.aiPlanningComplete).toBe(false);
    s = runOnlineAiPlanning(s);
    expect(s.aiPlanningComplete).toBe(true);
    const aiIds = s.turnOrder.filter((id) => !s.nations[id].isHuman);
    // Round-1 dig-outs can leave a nation short of the $6M strike package once
    // income scales with cities — arming is still the goal for anyone who can.
    expect(aiIds.some((id) => s.nations[id].hasNuclearTech)).toBe(true);
    for (const id of aiIds) {
      expect(researchCount(s, id)).toBeGreaterThan(0);
    }
  });
});
