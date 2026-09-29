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
  it('pays $18M per city, $10M research, 10% sanctions capped at 40%', () => {
    expect(INCOME_PER_CITY).toBe(18);
    expect(RESEARCH_INCOME).toBe(10);
    expect(SANCTION_PENALTY).toBe(0.1);
  });
});

describe('applyIncome', () => {
  it('pays $18M per standing city once per round starting in round 2', () => {
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
      money: 10,
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
    // gross 54 + 10 = 64, −10% → 57.6 → 58, + previous 10 → 68
    expect(s.nations.us.money).toBe(68);
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
    // 3 cities × $18 = $54, four sanctions would be 40% under the cap: 32.4 → 32
    expect(s.nations.us.money).toBe(32);
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
        us: { ...base.nations.us, money: 20, incomeRound: undefined },
      },
    });
    expect(s.nations.us.money).toBe(20 + INCOME_PER_CITY * 3);
    expect(s.nations.us.incomeRound).toBe(2);
  });
});

describe('mergeNationPlanning money', () => {
  it('does not discard income against a stale pre-income snapshot', () => {
    const base = createInitialState().nations.us;
    const withIncome = { ...base, money: 50, incomeRound: 2, isHuman: true };
    const stale = { ...base, money: 20, incomeRound: undefined, isHuman: true };
    const merged = mergeNationPlanning(stale, withIncome);
    expect(merged.money).toBe(50);
    expect(merged.incomeRound).toBe(2);
  });
});
