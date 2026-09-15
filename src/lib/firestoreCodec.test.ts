import { describe, expect, it } from 'vitest';
import {
  buyResearch,
  markHumanReady,
  touchHumanActivity,
  nextRound,
  finishStrikeResolution,
} from '../game/engine';
import { finishOnlineHumanPlanning } from '../game/ai';
import { assignNations, buildOnlineGameState } from './multiplayer';
import {
  decodeGameState,
  encodeGameState,
  findUnsupportedFirestoreValues,
} from './firestoreCodec';
import type { GameState, NationId, RoundScore } from '../types';

function threePlayerGame(): { state: GameState; nations: NationId[] } {
  const uids = ['uid-a', 'uid-b', 'uid-c'];
  const assignments = assignNations(uids);
  const state = buildOnlineGameState(
    assignments,
    { 'uid-a': 'Farshad · AAAAAA', 'uid-b': 'Kian · BBBBBB', 'uid-c': 'Daddy · CCCCCC' },
    'game-codec-1',
  );
  return { state, nations: uids.map((u) => assignments[u] as NationId) };
}

/** Everyone locks in → the room transitions past planning (populates scoreHistory). */
function playRoundToSummary(state: GameState, nations: NationId[]): GameState {
  let s = state;
  for (const id of nations) {
    const city = s.nations[id].cities.find((c) => !c.destroyed && !c.hasResearch);
    if (city) s = buyResearch(s, city.id, id);
    s = touchHumanActivity(s, id);
    s = markHumanReady(s, id);
  }
  s = finishOnlineHumanPlanning(s);
  if (s.phase === 'resolveStrikes') s = finishStrikeResolution(s);
  return s;
}

describe('firestore game state codec', () => {
  it('a fresh game is safe to write', () => {
    const { state } = threePlayerGame();
    expect(findUnsupportedFirestoreValues(encodeGameState(state))).toEqual([]);
  });

  it('flags nested arrays — the shape Firestore rejects', () => {
    const rows: RoundScore[] = [];
    expect(findUnsupportedFirestoreValues({ scoreHistory: [rows] })).toEqual([
      'scoreHistory[0] (nested array)',
    ]);
  });

  it('end-of-round state has score history yet still encodes safely', () => {
    const { state, nations } = threePlayerGame();
    const summary = playRoundToSummary(state, nations);

    // Guard the precondition: this is the write the last player to lock in makes.
    expect(summary.scoreHistory.length).toBeGreaterThan(0);
    expect(findUnsupportedFirestoreValues(summary as unknown)).not.toEqual([]);
    expect(findUnsupportedFirestoreValues(encodeGameState(summary))).toEqual([]);
  });

  it('later rounds keep encoding safely', () => {
    const { state, nations } = threePlayerGame();
    let s = playRoundToSummary(state, nations);
    s = nextRound(s);
    s = playRoundToSummary(s, nations.filter((id) => !s.nations[id].eliminated));
    expect(s.scoreHistory.length).toBeGreaterThan(1);
    expect(findUnsupportedFirestoreValues(encodeGameState(s))).toEqual([]);
  });

  it('round-trips score history', () => {
    const { state, nations } = threePlayerGame();
    const summary = playRoundToSummary(state, nations);
    const restored = decodeGameState(encodeGameState(summary) as unknown as GameState);
    expect(restored.scoreHistory).toEqual(summary.scoreHistory);
    expect(restored.roundScores).toEqual(summary.roundScores);
  });

  it('decodes legacy docs that stored raw arrays', () => {
    const legacy = { scoreHistory: [[{ nationId: 'us', total: 10 }]] } as unknown as GameState;
    expect(decodeGameState(legacy).scoreHistory).toEqual([[{ nationId: 'us', total: 10 }]]);
  });
});
