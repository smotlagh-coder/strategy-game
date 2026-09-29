import { describe, expect, it } from 'vitest';
import { MAX_ROUNDS } from '../data/nations';
import {
  allScores,
  buyResearch,
  compareScores,
  computeScore,
  createInitialState,
  nextRound,
  rankNationIds,
  seatTable,
  startGame,
} from './engine';
import type { GameState, NationId, NationState, RoundScore } from '../types';

function table(
  seats: NationId[],
  overrides: Partial<Record<NationId, Partial<NationState>>> = {},
): GameState {
  const base = createInitialState();
  const nations = { ...base.nations };
  for (const id of seats) {
    nations[id] = { ...nations[id], money: 300, ...(overrides[id] ?? {}) };
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

/** What finishStrikeResolution leaves behind after the last battle. */
function afterFinalBattle(s: GameState): GameState {
  return {
    ...s,
    round: MAX_ROUNDS,
    phase: 'roundSummary',
    previousRoundNumber: MAX_ROUNDS,
    roundScores: allScores(s),
  };
}

describe('final standings', () => {
  it('ranks an eliminated nation below every living one on every screen', () => {
    const s = table(['us', 'uk', 'france'], {
      france: { eliminated: true, lockedScore: 500 },
    });
    expect(computeScore(s, 'france').total).toBe(500);
    // The board table and the SuperPower table share one ordering
    const board = rankNationIds(s, s.turnOrder);
    expect(board[board.length - 1]).toBe('france');
    expect(board).toEqual(allScores(s).map((r) => r.nationId));
  });

  it('breaks level totals the way the title is decided: cities, then attack, then survival', () => {
    const row = (nationId: NationId, over: Partial<RoundScore> = {}): RoundScore => ({
      nationId,
      citiesLeft: 3,
      researchCenters: 0,
      shields: 0,
      bunkers: 0,
      roundsSurvived: 6,
      citySurvivalPoints: 10,
      attackPoints: 0,
      angelPoints: 0,
      infamyPoints: 0,
      total: 100,
      eliminated: false,
      ...over,
    });
    const order = (rows: RoundScore[]) => rows.sort(compareScores).map((r) => r.nationId);
    expect(order([row('uk'), row('us', { citiesLeft: 4 })])).toEqual(['us', 'uk']);
    expect(order([row('uk'), row('us', { attackPoints: 5 })])).toEqual(['us', 'uk']);
    expect(order([row('uk'), row('us', { citySurvivalPoints: 11 })])).toEqual(['us', 'uk']);
    expect(order([row('us'), row('uk')])).toEqual(['uk', 'us']);
  });

  it('crowns exactly the table the final board showed, whatever changes after', () => {
    let s = table(['us', 'uk']);
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    const settled = afterFinalBattle(s);
    expect(settled.roundScores[0].nationId).toBe('us');

    // A late purchase lifts uk past us — it must not reach the SuperPower table
    const late: GameState = {
      ...settled,
      nations: {
        ...settled.nations,
        uk: { ...settled.nations.uk, citySurvivalPoints: 500 },
      },
    };
    const done = nextRound(late);
    expect(done.phase).toBe('gameOver');
    expect(done.winner).toBe('us');
    expect(done.roundScores.map((r) => [r.nationId, r.total])).toEqual(
      settled.roundScores.map((r) => [r.nationId, r.total]),
    );
  });
});
