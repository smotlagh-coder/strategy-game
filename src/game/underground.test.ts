import { describe, expect, it } from 'vitest';
import { COSTS, DRONE_DAMAGE } from '../data/nations';
import { pickBombTarget, pickDroneTarget } from './ai';
import {
  applyQueuedStrike,
  buyShield,
  buyUnderground,
  canBuyUnderground,
  createInitialState,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  seesCity,
  startGame,
} from './engine';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState } from '../types';

/** US (armed) against a UK that can afford to dig. */
function table(usExtra: Partial<GameState['nations']['us']> = {}) {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'two',
    turnOrder: seatTable(['us', 'uk']),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: {
        ...base.nations.us,
        isHuman: true,
        money: 20,
        hasNuclearTech: true,
        nuclearTechUnlockedRound: 0,
        bombs: 2,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        drones: 2,
        // The attacker runs a spy service unless a test says otherwise, so
        // targeting reasons about the bunker instead of guessing past it
        hasSpyNetwork: true,
        ...usExtra,
      },
      uk: { ...base.nations.uk, money: 20 },
    },
  });
}

describe('buying an underground city', () => {
  it('costs $5M and marks the chosen city', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    expect(s.nations.uk.money).toBe(20 - COSTS.underground);
    expect(s.nations.uk.cities[0].isUnderground).toBe(true);
  });

  it('allows only one bunker city per nation for the whole match', () => {
    let s = table();
    s = buyUnderground(s, s.nations.uk.cities[0].id, 'uk');
    expect(canBuyUnderground(s, 'uk')).toBe(false);

    const second = s.nations.uk.cities[1].id;
    const after = buyUnderground(s, second, 'uk');
    expect(after.nations.uk.cities[1].isUnderground).toBeFalsy();
    expect(after.nations.uk.money).toBe(s.nations.uk.money);
  });

  it('is not offered without the money', () => {
    const base = table();
    const s: GameState = {
      ...base,
      nations: { ...base.nations, uk: { ...base.nations.uk, money: COSTS.underground - 0.5 } },
    };
    expect(canBuyUnderground(s, 'uk')).toBe(false);
  });

  it('refuses a shield on a bunker city, since it cannot be hit', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    const after = buyShield(s, city.id, 'uk');
    expect(after.nations.uk.cities[0].hasShield).toBeFalsy();
    expect(after.nations.uk.money).toBe(s.nations.uk.money);
  });

  it('scraps a surface shield when the city is dug in', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyShield(s, city.id, 'uk');
    expect(s.nations.uk.cities[0].hasShield).toBe(true);
    s = buyUnderground(s, city.id, 'uk');
    expect(s.nations.uk.cities[0].isUnderground).toBe(true);
    expect(s.nations.uk.cities[0].hasShield).toBe(false);
  });
});

describe('surviving attacks underground', () => {
  it('cannot be picked as a bomb target by an attacker who can see it', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us');
    expect(s.pendingStrikes).toHaveLength(0);
    expect(s.nations.us.bombs).toBe(2);
  });

  it('takes the blind attacker\'s warhead and breaks it against the rock', () => {
    let s = table({ hasSpyNetwork: false });
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us');
    // No eyes on the target, so the warhead is spent finding out
    expect(s.pendingStrikes).toHaveLength(1);
    expect(s.nations.us.bombs).toBe(1);

    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(s.nations.uk.cities[0].destroyed).toBe(false);
    expect(s.roundEvents.some((e) => e.kind === 'strikeAbsorbed')).toBe(true);
  });

  it('puts the bunker on every map once a warhead breaks on it', () => {
    let s = table({ hasSpyNetwork: false });
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us');
    expect(seesCity(s, 'us', 'uk', city.id)).toBe(false);

    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    // Not just the attacker: the bystanders watched it bounce too
    for (const viewer of s.turnOrder) {
      expect(seesCity(s, viewer, 'uk', city.id)).toBe(true);
    }
    // And nobody spends a second warhead learning the same lesson
    const rearmed: GameState = {
      ...s,
      nations: { ...s.nations, us: { ...s.nations.us, bombs: 1, citiesStruckThisRound: [] } },
    };
    expect(queueStrike(rearmed, 'uk', city.id, 'us')).toBe(rearmed);
  });

  it('absorbs a warhead that was queued before the city went underground', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = buyUnderground(s, city.id, 'uk');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);

    const hit = s.nations.uk.cities.find((c) => c.id === city.id)!;
    expect(hit.destroyed).toBe(false);
    expect(s.roundEvents.some((e) => e.kind === 'strikeAbsorbed')).toBe(true);
  });

  it('holds even when drones swarm the same city alongside the bomb', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = buyUnderground(s, city.id, 'uk');

    for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
      s = applyQueuedStrike(s, strike);
    }

    const hit = s.nations.uk.cities.find((c) => c.id === city.id)!;
    expect(hit.destroyed).toBe(false);
    // The swarm cannot break the city, and the bunker halves the repair bill
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE / 2);
  });

  it('still owes the drone repair bill when swarmed on its own', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    expect(s.pendingStrikes).toHaveLength(1);

    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE / 2);
    expect(s.nations.uk.cities.find((c) => c.id === city.id)?.isUnderground).toBe(true);
  });

  it('keeps the nation alive once its other cities are gone', () => {
    let s = table();
    const [first, second, third] = s.nations.uk.cities;
    s = buyUnderground(s, first.id, 'uk');
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c) =>
            c.id === second.id || c.id === third.id
              ? { ...c, destroyed: true, hasShield: false, hasResearch: false }
              : c,
          ),
        },
      },
    };
    s = queueStrike(s, 'uk', first.id, 'us', 'drone');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(s.nations.uk.eliminated).toBe(false);
  });
});

describe('AI awareness', () => {
  it('never aims a warhead at a bunker city it can see', () => {
    // Head-to-head table so the pickers have exactly one rival to choose from
    let s: GameState = { ...table(), turnOrder: ['us', 'uk'] };
    for (const city of s.nations.uk.cities.slice(1)) {
      s = {
        ...s,
        nations: {
          ...s.nations,
          uk: {
            ...s.nations.uk,
            cities: s.nations.uk.cities.map((c) =>
              c.id === city.id ? { ...c, destroyed: true } : c,
            ),
          },
        },
      };
    }
    const survivor = s.nations.uk.cities[0];
    s = buyUnderground(s, survivor.id, 'uk');

    const target = pickBombTarget(s, 'us');
    expect(target?.cityId).not.toBe(survivor.id);

    // Drones still hurt its treasury, so they remain fair game
    expect(pickDroneTarget(s, 'us')?.cityId).toBe(survivor.id);
  });
});

describe('online merge', () => {
  it('keeps a bunker city that only one snapshot knows about', () => {
    const base = createInitialState().nations.us;
    const remote = base;
    const local = {
      ...base,
      cities: base.cities.map((c, i) => (i === 0 ? { ...c, isUnderground: true } : c)),
    };
    const merged = mergeNationPlanning(remote, local);
    expect(merged.cities[0].isUnderground).toBe(true);
  });
});
