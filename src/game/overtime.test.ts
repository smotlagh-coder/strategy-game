import { describe, expect, it } from 'vitest';
import { MAX_OVERTIME_ROUNDS, MAX_ROUNDS } from '../data/nations';
import {
  buyResearch,
  computeScore,
  createInitialState,
  needsOvertime,
  nextRound,
  seatTable,
  startGame,
  tiedForTheLead,
} from './engine';
import type { GameState, NationId, NationState } from '../types';

function table(
  seats: NationId[],
  overrides: Partial<Record<NationId, Partial<NationState>>> = {},
): GameState {
  const base = createInitialState();
  const nations = { ...base.nations };
  for (const id of seats) {
    nations[id] = { ...nations[id], money: 30, ...(overrides[id] ?? {}) };
  }
  nations[seats[0]] = { ...nations[seats[0]], isHuman: true };
  return startGame({
    ...base,
    mode: 'two',
    turnOrder: seatTable(seats, { size: seats.length }),
    humanNations: [seats[0]],
    nations,
  });
}

/** The scoreboard as the last round ends, ready for the match to be called. */
function atFinalWhistle(s: GameState, round = MAX_ROUNDS): GameState {
  return { ...s, round, phase: 'roundSummary' };
}

describe('a level final round', () => {
  it('plays on instead of handing the title to whoever sorts first', () => {
    const s = atFinalWhistle(table(['us', 'uk']));
    expect(computeScore(s, 'us').total).toBe(computeScore(s, 'uk').total);
    expect(tiedForTheLead(s)).toEqual(['us', 'uk']);

    const after = nextRound(s);
    expect(after.phase).toBe('buy');
    expect(after.round).toBe(MAX_ROUNDS + 1);
    expect(after.maxRounds).toBe(MAX_ROUNDS + 1);
    expect(after.winner).toBeNull();
  });

  it('ends the war as scheduled once somebody is ahead', () => {
    let s = table(['us', 'uk']);
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    expect(tiedForTheLead(s)).toEqual([]);

    const after = nextRound(atFinalWhistle(s));
    expect(after.phase).toBe('gameOver');
    expect(after.winner).toBe('us');
    expect(after.maxRounds).toBe(MAX_ROUNDS);
  });

  it('only counts nations still in the fight as tied', () => {
    const s = table(['us', 'uk', 'france']);
    // France matches the leaders on points but is out, so there is nothing to
    // replay against it
    const locked = computeScore(s, 'us').total;
    let out = atFinalWhistle({
      ...s,
      nations: {
        ...s.nations,
        france: { ...s.nations.france, eliminated: true, lockedScore: locked },
      },
    });
    expect(tiedForTheLead(out)).toEqual(['us', 'uk']);

    // …and with a single nation left standing there is no tie at all
    out = {
      ...out,
      nations: { ...out.nations, uk: { ...out.nations.uk, eliminated: true } },
    };
    expect(tiedForTheLead(out)).toEqual([]);
    expect(nextRound(out).phase).toBe('gameOver');
  });
});

describe('overtime runs out', () => {
  it('grants no more than the capped number of extra rounds', () => {
    let s = atFinalWhistle(table(['us', 'uk']));
    for (let i = 0; i < MAX_OVERTIME_ROUNDS; i += 1) {
      expect(needsOvertime(s)).toBe(true);
      s = atFinalWhistle(nextRound(s), MAX_ROUNDS + i + 1);
    }

    expect(s.maxRounds).toBe(MAX_ROUNDS + MAX_OVERTIME_ROUNDS);
    expect(needsOvertime(s)).toBe(false);

    // Still level, so the tiebreakers finally settle it
    const after = nextRound(s);
    expect(after.phase).toBe('gameOver');
    expect(after.winner).not.toBeNull();
  });
});
