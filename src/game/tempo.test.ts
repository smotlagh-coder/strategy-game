import { describe, expect, it } from 'vitest';
import { INCOME_PER_CITY, COSTS, MAX_SHIELDS_PER_ROUND, STARTING_MONEY } from '../data/nations';
import {
  buyBomb,
  buyNuclearTech,
  buyShield,
  canBuyBombs,
  canBuyShield,
  createInitialState,
  nextRound,
  queueStrike,
  seatTable,
  startGame,
} from './engine';
import type { GameState, NationId, NationState } from '../types';

/** Two-nation table so a strike has exactly one place to land. */
function table(overrides: Partial<Record<NationId, Partial<NationState>>> = {}): GameState {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'two',
    turnOrder: seatTable(['us', 'uk'], { size: 2 }),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: { ...base.nations.us, isHuman: true, ...(overrides.us ?? {}) },
      uk: { ...base.nations.uk, ...(overrides.uk ?? {}) },
    },
  });
}

describe('opening tempo', () => {
  it('prices a first strike inside the opening budget', () => {
    // Tech plus a warhead has to leave room for a defensive buy, or nobody
    // ever opens with an attack
    expect(COSTS.nuclearTech + COSTS.bomb).toBeLessThan(STARTING_MONEY - COSTS.shield);
  });

  it('pays enough each round to fund a real move', () => {
    // A healthy nation (3 cities) must still cover a shield or a warhead pack
    const healthyIncome = INCOME_PER_CITY * 3;
    expect(healthyIncome).toBeGreaterThanOrEqual(COSTS.shield);
    expect(healthyIncome).toBeGreaterThanOrEqual(COSTS.bomb + COSTS.drone);
  });

  it('lets a warhead fly the same round the tech is unlocked', () => {
    let s = table();
    expect(canBuyBombs(s, 'us')).toBe(false);

    s = buyNuclearTech(s, 'us');
    expect(canBuyBombs(s, 'us')).toBe(true);

    s = buyBomb(s, 'us');
    expect(s.nations.us.bombs).toBe(1);

    const target = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', target.id, 'us');
    expect(s.pendingStrikes).toHaveLength(1);
    expect(s.pendingStrikes[0]).toMatchObject({ attackerId: 'us', cityId: target.id });
  });
});

describe('shield rationing', () => {
  it('allows one install per round and no more', () => {
    let s = table({ us: { money: 30 } });
    expect(canBuyShield(s, 'us')).toBe(true);

    s = buyShield(s, s.nations.us.cities[0].id, 'us');
    expect(s.nations.us.shieldsBoughtThisRound).toBe(MAX_SHIELDS_PER_ROUND);
    expect(canBuyShield(s, 'us')).toBe(false);

    const blocked = buyShield(s, s.nations.us.cities[1].id, 'us');
    expect(blocked).toBe(s);
    expect(blocked.nations.us.cities.filter((c) => c.hasShield)).toHaveLength(1);
  });

  it('hands back the allowance at the start of the next round', () => {
    let s = table({ us: { money: 30 } });
    s = buyShield(s, s.nations.us.cities[0].id, 'us');
    s = nextRound({ ...s, phase: 'roundSummary' });

    expect(s.nations.us.shieldsBoughtThisRound).toBe(0);
    expect(canBuyShield(s, 'us')).toBe(true);
    s = buyShield(s, s.nations.us.cities[1].id, 'us');
    expect(s.nations.us.cities.filter((c) => c.hasShield)).toHaveLength(2);
  });

  it('cannot be dodged by covering a city that is already shielded', () => {
    let s = table({ us: { money: 30 } });
    const city = s.nations.us.cities[0].id;
    s = buyShield(s, city, 'us');
    const again = buyShield(s, city, 'us');
    expect(again).toBe(s);
  });
});
