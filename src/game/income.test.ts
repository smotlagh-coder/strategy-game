import { describe, expect, it } from 'vitest';
import { BASE_INCOME, RESEARCH_INCOME, SANCTION_PENALTY } from '../data/nations';
import {
  applyIncome,
  createInitialState,
  ensureIncome,
  nextRound,
  startGame,
} from './engine';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { NationId } from '../types';

describe('economy constants', () => {
  it('uses $3M base, $1.5M research, 10% sanctions', () => {
    expect(BASE_INCOME).toBe(3);
    expect(RESEARCH_INCOME).toBe(1.5);
    expect(SANCTION_PENALTY).toBe(0.1);
  });
});

describe('applyIncome', () => {
  it('pays $3M once per round starting in round 2', () => {
    let s = startGame({
      ...createInitialState(),
      mode: 'single',
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
    expect(s.nations.us.money).toBe(3);
    expect(s.nations.us.incomeRound).toBe(2);

    const again = applyIncome(s);
    expect(again.nations.us.money).toBe(3);
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
      nations: { ...base.nations, us, uk },
    });
    // gross 3 + 1.5 = 4.5, −10% → 4.05, + previous 1 → 5.05
    expect(s.nations.us.money).toBe(5.05);
  });

  it('ensureIncome pays nations missing incomeRound after sync', () => {
    const base = createInitialState();
    const s = ensureIncome({
      ...base,
      round: 2,
      phase: 'buy',
      nations: {
        ...base.nations,
        us: { ...base.nations.us, money: 2, incomeRound: undefined },
      },
    });
    expect(s.nations.us.money).toBe(5);
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
