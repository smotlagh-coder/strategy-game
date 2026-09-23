import { describe, expect, it } from 'vitest';
import { COSTS, DRONE_DAMAGE, MAX_DRONES_PER_ROUND } from '../data/nations';
import {
  applyIncome,
  applyQueuedStrike,
  buyAerospaceTech,
  buyDrones,
  canBuyDrones,
  createInitialState,
  droneDamageFor,
  finishStrikeResolution,
  maxDronesPurchasable,
  nextRound,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  startGame,
} from './engine';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState, NationId } from '../types';

/** Two-nation table with cash on hand, ready for the drone rules. */
function table(overrides: Partial<Record<NationId, Partial<GameState['nations']['us']>>> = {}) {
  const base = createInitialState();
  const s = startGame({
    ...base,
    mode: 'two',
    turnOrder: seatTable(['us', 'uk']),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: { ...base.nations.us, isHuman: true, money: 20, ...(overrides.us ?? {}) },
      uk: { ...base.nations.uk, money: 20, ...(overrides.uk ?? {}) },
    },
  });
  return s;
}

/** A nation holding drones (and optionally bombs) ready to launch this round. */
function armed(extra: Partial<GameState['nations']['us']> = {}) {
  return table({
    us: {
      hasAerospaceTech: true,
      // Unlocked in an earlier round, so packs can be bought and launched now
      aerospaceTechUnlockedRound: 0,
      drones: 2,
      hasNuclearTech: true,
      nuclearTechUnlockedRound: 0,
      bombs: 1,
      ...extra,
    },
  });
}

describe('drone economy', () => {
  it('prices packs at $1M and the tech at $2M', () => {
    expect(COSTS.drone).toBe(1);
    expect(COSTS.aerospaceTech).toBe(2);
    expect(DRONE_DAMAGE).toBe(1.5);
  });

  it('lets packs fly the same round Aerospace Tech is bought', () => {
    let s = table();
    expect(canBuyDrones(s, 'us')).toBe(false);
    s = buyAerospaceTech(s, 'us');
    expect(s.nations.us.money).toBe(20 - COSTS.aerospaceTech);
    expect(canBuyDrones(s, 'us')).toBe(true);
    expect(buyDrones(s, 2, 'us').nations.us.drones).toBe(2);

    s = nextRound({ ...s, phase: 'roundSummary' });
    expect(canBuyDrones(s, 'us')).toBe(true);
  });

  it('caps purchases at three packs per round', () => {
    const s = armed({ drones: 0 });
    expect(maxDronesPurchasable(s, 'us')).toBe(MAX_DRONES_PER_ROUND);
    const bought = buyDrones(s, 5, 'us');
    expect(bought.nations.us.drones).toBe(MAX_DRONES_PER_ROUND);
    expect(bought.nations.us.money).toBe(20 - MAX_DRONES_PER_ROUND * COSTS.drone);
    expect(maxDronesPurchasable(bought, 'us')).toBe(0);
  });

  it('spends a pack per launch and blocks a repeat swarm on the same city', () => {
    let s = armed();
    const city = s.nations.uk.cities[0].id;
    s = queueStrike(s, 'uk', city, 'us', 'drone');
    expect(s.nations.us.drones).toBe(1);
    expect(s.nations.us.dronesUsed).toBe(1);
    expect(s.pendingStrikes).toHaveLength(1);

    s = queueStrike(s, 'uk', city, 'us', 'drone');
    expect(s.pendingStrikes).toHaveLength(1);
    expect(s.nations.us.drones).toBe(1);
  });

  it('lets a bomb and a swarm share one city without touching the other stock', () => {
    let s = armed();
    const city = s.nations.uk.cities[0].id;
    s = queueStrike(s, 'uk', city, 'us');
    s = queueStrike(s, 'uk', city, 'us', 'drone');
    expect(s.pendingStrikes.map((p) => p.weapon)).toEqual(['nuke', 'drone']);
    expect(s.nations.us.bombs).toBe(0);
    expect(s.nations.us.drones).toBe(1);
  });
});

describe('drone damage', () => {
  it('leaves the city and its shield standing, and bills the repair', () => {
    let s = armed();
    const city = s.nations.uk.cities.find((c) => !c.destroyed)!;
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c) =>
            c.id === city.id ? { ...c, hasShield: true } : c,
          ),
        },
      },
    };
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);

    const hit = s.nations.uk.cities.find((c) => c.id === city.id)!;
    expect(hit.destroyed).toBe(false);
    expect(hit.hasShield).toBe(true);
    // The shield took the brunt, so only half the bill
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE / 2);
    expect(s.roundEvents.some((e) => e.kind === 'droneDamage')).toBe(true);
  });

  it('bills an undefended city the full amount', () => {
    let s = armed();
    const city = s.nations.uk.cities.find((c) => !c.hasShield && !c.isUnderground)!;
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE);
    expect(droneDamageFor(city)).toBe(DRONE_DAMAGE);
  });

  it('halves the bill for a shielded or bunkered city', () => {
    expect(droneDamageFor({ hasShield: true, isUnderground: false })).toBe(DRONE_DAMAGE / 2);
    expect(droneDamageFor({ hasShield: false, isUnderground: true })).toBe(DRONE_DAMAGE / 2);
    expect(droneDamageFor({ hasShield: false, isUnderground: false })).toBe(DRONE_DAMAGE);
  });

  it('records the halved amount on the round event so recaps read true', () => {
    let s = armed();
    const city = s.nations.uk.cities[0];
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c) =>
            c.id === city.id ? { ...c, hasShield: true } : c,
          ),
        },
      },
    };
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);

    const event = s.roundEvents.find((e) => e.kind === 'droneDamage')!;
    expect(event.amount).toBe(DRONE_DAMAGE / 2);
  });

  it('deducts the repair bill from the next round of income', () => {
    let s = armed();
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    s = finishStrikeResolution(s);

    const before = s.nations.uk.money;
    s = nextRound(s);
    const entry = s.lastIncomeLedger.find((e) => e.nationId === 'uk')!;
    expect(entry.droneDamage).toBe(DRONE_DAMAGE);
    expect(s.nations.uk.money).toBe(+(before + entry.revenue - DRONE_DAMAGE).toFixed(2));
    expect(s.nations.uk.pendingDroneDamage).toBe(0);
  });

  it('never bills a treasury below zero', () => {
    let s = armed();
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: { ...s.nations.uk, money: 0, pendingDroneDamage: 99 },
      },
    };
    s = applyIncome({ ...s, round: 2 });
    expect(s.nations.uk.money).toBe(0);
  });
});

describe('shields busy with drones', () => {
  it('lets a warhead through when a swarm hits the same city', () => {
    let s = armed();
    const city = s.nations.uk.cities[0];
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c) =>
            c.id === city.id ? { ...c, hasShield: true } : c,
          ),
        },
      },
    };
    s = queueStrike(s, 'uk', city.id, 'us');
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');

    for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
      s = applyQueuedStrike(s, strike);
    }

    const hit = s.nations.uk.cities.find((c) => c.id === city.id)!;
    expect(hit.destroyed).toBe(true);
    // Rubble is never repaired, so the swarm's bill dies with the city
    expect(s.nations.uk.pendingDroneDamage).toBe(0);
    expect(s.roundEvents.some((e) => e.kind === 'droneDamage')).toBe(false);
  });

  it('still only strips the shield when the warhead flies alone', () => {
    let s = armed();
    const city = s.nations.uk.cities[0];
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c) =>
            c.id === city.id ? { ...c, hasShield: true } : c,
          ),
        },
      },
    };
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);

    const hit = s.nations.uk.cities.find((c) => c.id === city.id)!;
    expect(hit.destroyed).toBe(false);
    expect(hit.hasShield).toBe(false);
  });

  it('writes off the repair bill for a city the warhead levels', () => {
    let s = armed({ drones: 2, bombs: 1 });
    const [doomed, spared] = s.nations.uk.cities;
    s = queueStrike(s, 'uk', doomed.id, 'us');
    s = queueStrike(s, 'uk', doomed.id, 'us', 'drone');
    s = queueStrike(s, 'uk', spared.id, 'us', 'drone');

    for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
      s = applyQueuedStrike(s, strike);
    }

    expect(s.nations.uk.cities.find((c) => c.id === doomed.id)!.destroyed).toBe(true);
    // Only the surviving city still owes repairs
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE);
    const billed = s.roundEvents.filter((e) => e.kind === 'droneDamage');
    expect(billed.map((e) => e.cityId)).toEqual([spared.id]);
  });

  it('keeps the bill when the warhead only breaks the shield', () => {
    let s = armed({ drones: 1, bombs: 1 });
    const city = s.nations.uk.cities[0];
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c) =>
            // A laser downs the escort, so the shield is free to stop the warhead
            c.id === city.id ? { ...c, hasShield: true, hasLaser: false } : c,
          ),
        },
      },
    };
    // Swarm a different city so the shield stays free and the city survives
    s = queueStrike(s, 'uk', city.id, 'us');
    s = queueStrike(s, 'uk', s.nations.uk.cities[1].id, 'us', 'drone');
    for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
      s = applyQueuedStrike(s, strike);
    }

    expect(s.nations.uk.cities[0].destroyed).toBe(false);
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE);
  });

  it('resolves every swarm before the warheads', () => {
    const strikes = orderStrikesForResolution([
      { attackerId: 'us', targetNationId: 'uk', cityId: 'a', weapon: 'nuke' },
      { attackerId: 'us', targetNationId: 'uk', cityId: 'a', weapon: 'drone' },
      { attackerId: 'uk', targetNationId: 'us', cityId: 'b' },
    ]);
    expect(strikes.map((s) => s.weapon)).toEqual(['drone', 'nuke', undefined]);
  });
});

describe('online merge', () => {
  it('derives drone stock from the buy and launch counters', () => {
    const base = createInitialState().nations.us;
    // Remote saw the purchase, local saw the launch — neither has the full story
    const remote = { ...base, drones: 3, dronesBoughtThisRound: 3, dronesUsed: 0 };
    const local = { ...base, drones: 2, dronesBoughtThisRound: 3, dronesUsed: 1 };
    const merged = mergeNationPlanning(remote, local);
    expect(merged.drones).toBe(2);
    expect(merged.dronesUsed).toBe(1);
  });

  it('keeps aerospace tech and the outstanding repair bill', () => {
    const base = createInitialState().nations.us;
    const remote = { ...base, hasAerospaceTech: true, aerospaceTechUnlockedRound: 2 };
    const local = { ...base, pendingDroneDamage: DRONE_DAMAGE };
    const merged = mergeNationPlanning(remote, local);
    expect(merged.hasAerospaceTech).toBe(true);
    expect(merged.aerospaceTechUnlockedRound).toBe(2);
    expect(merged.pendingDroneDamage).toBe(DRONE_DAMAGE);
  });
});
