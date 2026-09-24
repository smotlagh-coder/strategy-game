import { describe, expect, it } from 'vitest';
import { INCOME_PER_CITY, RESEARCH_INCOME, SANCTION_PENALTY } from '../data/nations';
import {
  applyIncome,
  createInitialState,
  ensureIncome,
  nextRound,
  seatTable,
  startGame,
} from './engine';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { NationId } from '../types';

describe('economy constants', () => {
  it('pays $1.75M per city, $1M research, 10% sanctions capped at 40%', () => {
    expect(INCOME_PER_CITY).toBe(1.75);
    expect(RESEARCH_INCOME).toBe(1);
    expect(SANCTION_PENALTY).toBe(0.1);
  });
});

describe('applyIncome', () => {
  it('pays $1.75M per standing city once per round starting in round 2', () => {
    let s = startGame({
      ...createInitialState(),
      mode: 'single',
      turnOrder: seatTable(['us']),
      humanNations: ['us'],
      nations: {
        ...createInitialState().nations,
        us: { ...createInitialState().nations.us, isHuman: true, money: 0 },
      },
    });
    expect(s.round).toBe(1);
    expect(applyIncome(s).nations.us.money).toBe(0);

    s = { ...s, phase: 'roundSummary', round: 1 };
    s = nextRound(s);
    expect(s.round).toBe(2);
    // Three cities still standing → 3 × income per city
    expect(s.nations.us.money).toBe(INCOME_PER_CITY * 3);
    expect(s.nations.us.incomeRound).toBe(2);

    const again = applyIncome(s);
    expect(again.nations.us.money).toBe(INCOME_PER_CITY * 3);
  });

  it('scales income down when cities are gone', () => {
    const base = createInitialState();
    const us = {
      ...base.nations.us,
      money: 0,
      cities: base.nations.us.cities.map((c, i) =>
        i === 0 ? c : { ...c, destroyed: true },
      ),
    };
    const s = applyIncome({
      ...base,
      round: 2,
      phase: 'buy',
      turnOrder: seatTable(['us']),
      nations: { ...base.nations, us },
    });
    expect(s.nations.us.money).toBe(INCOME_PER_CITY);
  });

  it('adds research income and applies 10% sanctions', () => {
    const base = createInitialState();
    const us = {
      ...base.nations.us,
      money: 1,
      cities: base.nations.us.cities.map((c, i) =>
        i === 0 ? { ...c, hasResearch: true } : c,
      ),
    };
    const uk = {
      ...base.nations.uk,
      sanctions: ['us' as NationId],
    };
    const s = applyIncome({
      ...base,
      round: 2,
      phase: 'buy',
      turnOrder: seatTable(['us', 'uk']),
      nations: { ...base.nations, us, uk },
    });
    // gross 5.25 + 1.0 = 6.25, −10% → 5.625, + previous 1 → 6.625
    expect(s.nations.us.money).toBe(6.63);
  });

  it('caps stacked sanctions so four rivals cannot wipe the treasury', () => {
    const base = createInitialState();
    const us = { ...base.nations.us, money: 0 };
    const seats = ['us', 'uk', 'france', 'russia', 'china'] as NationId[];
    const nations = { ...base.nations, us };
    for (const id of seats.slice(1)) {
      nations[id] = { ...nations[id], sanctions: ['us'] };
    }
    const s = applyIncome({
      ...base,
      round: 2,
      phase: 'buy',
      turnOrder: seatTable(seats, { size: 5 }),
      nations,
    });
    // 3 cities × $1.75 = $5.25, four sanctions would be 40% under the cap
    expect(s.nations.us.money).toBe(3.15);
  });

  it('ensureIncome pays nations missing incomeRound after sync', () => {
    const base = createInitialState();
    const s = ensureIncome({
      ...base,
      round: 2,
      phase: 'buy',
      turnOrder: seatTable(['us']),
      nations: {
        ...base.nations,
        us: { ...base.nations.us, money: 2, incomeRound: undefined },
      },
    });
    expect(s.nations.us.money).toBe(2 + INCOME_PER_CITY * 3);
    expect(s.nations.us.incomeRound).toBe(2);
  });
});

describe('mergeNationPlanning money', () => {
  it('does not discard income against a stale pre-income snapshot', () => {
    const base = createInitialState().nations.us;
    const withIncome = { ...base, money: 5, incomeRound: 2, isHuman: true };
    const stale = { ...base, money: 2, incomeRound: undefined, isHuman: true };
    const merged = mergeNationPlanning(stale, withIncome);
    expect(merged.money).toBe(5);
    expect(merged.incomeRound).toBe(2);
  });
});
