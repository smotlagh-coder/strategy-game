import { describe, expect, it } from 'vitest';
import { allScores, applyQueuedStrike, createInitialState, finishStrikeResolution, nextRound, orderStrikesForResolution, seatTable, startGame } from './engine';
import { runAllAiUntilHumanOrSummary } from './ai';
import type { GameState } from '../types';

const trace: string[] = [];

function play(seed: number): GameState {
  const base = createInitialState();
  let s = startGame({ ...base, mode: 'single', turnOrder: seatTable([], { rng: () => ((seed * 9301 + 49297) % 233280) / 233280 }), humanNations: [] });
  for (let guard = 0; guard < 40; guard += 1) {
    if (s.phase === 'gameOver') break;
    s = runAllAiUntilHumanOrSummary(s);
    trace.push(`r${s.round} ${s.phase} pending=${s.pendingStrikes.length}`);
    if (s.phase === 'resolveStrikes') {
      // The UI applies each strike during the cinema, then closes the round
      for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
        s = applyQueuedStrike(s, strike);
      }
      s = finishStrikeResolution(s);
    }
    trace.push(`  after r${s.round} ${s.phase} events=${s.roundEvents.map((e) => e.kind).join(',')}`);
    if (s.phase === 'roundSummary') { if (s.round >= s.maxRounds) break; s = nextRound(s); }
  }
  return s;
}

describe('tmp texture', () => {
  it('reports how violent an all-AI match is', () => {
    let destroyed = 0, shields = 0, lasers = 0, bombsUsed = 0, dronesUsed = 0, research = 0;
    const games = 40;
    for (let g = 0; g < games; g += 1) {
      const end = play(g + 1);
      for (const id of end.turnOrder) {
        const n = end.nations[id];
        destroyed += n.cities.filter((c) => c.destroyed).length;
        shields += n.cities.filter((c) => c.hasShield).length;
        lasers += n.cities.filter((c) => c.hasLaser).length;
        bombsUsed += n.bombsUsed;
        dronesUsed += n.dronesUsed;
        research += n.cities.filter((c) => c.hasResearch && !c.destroyed).length;
      }
      void allScores(end);
    }
    trace.length = 0;
    const one = play(1);
    throw new Error(JSON.stringify({ trace: trace.slice(0, 16), phase: one.phase, round: one.round, events: one.log.filter((l)=>l.tone==='attack').map((l)=>l.text).slice(0,6), perGame: { destroyed: +(destroyed/games).toFixed(2), bombsUsed: +(bombsUsed/games).toFixed(2), dronesUsed: +(dronesUsed/games).toFixed(2), shields: +(shields/games).toFixed(2), lasers: +(lasers/games).toFixed(2), research: +(research/games).toFixed(2) } }));
  });
});
