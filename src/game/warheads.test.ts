import { describe, expect, it } from 'vitest';
import { COSTS, MAX_HYDROGEN_PER_GAME, MAX_MAGNETIC_PER_GAME } from '../data/nations';
import {
  applyQueuedStrike,
  buyBombs,
  buyHydrogenBomb,
  buyMagneticBomb,
  createInitialState,
  laserInterceptsLeft,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  startGame,
  totalWarheads,
} from './engine';
import type { GameState, NationId, NationState } from '../types';

function table(tweaks: Partial<Record<NationId, Partial<NationState>>> = {}): GameState {
  const base = createInitialState();
  const order = seatTable(['us', 'uk', 'russia', 'china', 'france']);
  const nations = { ...base.nations };
  for (const id of order) {
    nations[id] = {
      ...nations[id],
      isHuman: id === 'us',
      money: 40,
      hasNuclearTech: true,
      nuclearTechUnlockedRound: 0,
      ...(tweaks[id] ?? {}),
    };
  }
  return startGame({
    ...base,
    mode: 'single',
    turnOrder: order,
    humanNations: ['us'],
    nations,
  });
}

describe('warhead arsenal', () => {
  it('prices specialty warheads above a nuclear and at/above bunker cost for hydrogen', () => {
    expect(COSTS.bomb).toBe(2);
    expect(COSTS.bombMagnetic).toBeGreaterThan(COSTS.laser);
    expect(COSTS.bombHydrogen).toBeGreaterThanOrEqual(COSTS.underground);
    expect(COSTS.ballisticMissileTech).toBe(3);
  });

  it('caps hydrogen at one and magnetic at two for the match', () => {
    let s = table();
    s = buyHydrogenBomb(s, 'us');
    expect(s.nations.us.hydrogenBombs).toBe(1);
    expect(buyHydrogenBomb(s, 'us')).toBe(s);
    expect(MAX_HYDROGEN_PER_GAME).toBe(1);

    s = buyMagneticBomb(s, 'us');
    s = buyMagneticBomb(s, 'us');
    expect(s.nations.us.magneticBombs).toBe(2);
    expect(buyMagneticBomb(s, 'us')).toBe(s);
    expect(MAX_MAGNETIC_PER_GAME).toBe(2);
  });

  it('lets a hydrogen bomb destroy a bunker city', () => {
    let s = table({
      us: { hydrogenBombs: 1, bombs: 0, hasSpyNetwork: true },
    });
    const city = s.nations.uk.cities[0];
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c, i) =>
            i === 0 ? { ...c, isUnderground: true } : c,
          ),
        },
      },
    };
    s = queueStrike(s, 'uk', city.id, 'us', 'hydrogen');
    expect(s.pendingStrikes).toHaveLength(1);
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(s.nations.uk.cities[0].destroyed).toBe(true);
    expect(s.nations.uk.cities[0].isUnderground).toBe(false);
  });

  it('kills laser cover when a magnetic bomb is locked, so a drone gets through', () => {
    let s = table({
      us: {
        magneticBombs: 1,
        bombs: 0,
        drones: 1,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        hasSpyNetwork: true,
      },
    });
    const battery = s.nations.uk.cities[0];
    const target = s.nations.uk.cities[1];
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c) =>
            c.id === battery.id ? { ...c, hasLaser: true } : c,
          ),
        },
      },
    };
    expect(laserInterceptsLeft(s, 'uk')).toBeGreaterThan(0);
    s = queueStrike(s, 'uk', target.id, 'us', 'magnetic');
    expect(s.nations.uk.laserOfflineThisRound).toBe(true);
    expect(laserInterceptsLeft(s, 'uk')).toBe(0);
    expect(s.pendingStrikes).toHaveLength(1);

    s = queueStrike(s, 'uk', target.id, 'us', 'drone');
    expect(s.pendingStrikes).toHaveLength(2);
    expect(s.nations.us.drones).toBe(0);

    const ordered = orderStrikesForResolution(s.pendingStrikes);
    expect(ordered[0].weapon).toBe('drone');
    // Drone lands first under a dark laser sky
    s = applyQueuedStrike(s, ordered[0]);
    expect(s.roundEvents.map((e) => e.kind)).toContain('droneDamage');
    expect(s.roundEvents.map((e) => e.kind)).not.toContain('dronesIntercepted');
    // Magnetic then finishes the open city (write-off clears the repair bill)
    s = applyQueuedStrike(s, ordered[1]);
    expect(s.nations.uk.cities.find((c) => c.id === target.id)?.destroyed).toBe(true);
  });

  it('still stocks nuclear bombs under the round cap after specialty buys', () => {
    let s = table();
    s = buyBombs(s, 3, 'us');
    expect(s.nations.us.bombs).toBe(3);
    expect(buyBombs(s, 1, 'us').nations.us.bombs).toBe(3);
    s = buyMagneticBomb(s, 'us');
    expect(totalWarheads(s.nations.us)).toBe(4);
  });
});
