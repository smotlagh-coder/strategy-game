import { describe, expect, it } from 'vitest';
import { COSTS } from '../data/nations';
import { createInitialState, seatTable, startGame } from './engine';
import {
  aerospaceBundleCost,
  ballisticBundleCost,
  buyBombsBundled,
  buyDronesBundled,
  buyHydrogenBundled,
  buyLaserBundled,
  buyMagneticBundled,
  canBuyLaserBundled,
  cheapestPurchase,
  isTreasuryLow,
  maxBombsBundled,
  maxDronesBundled,
} from './bundles';
import type { GameState, NationId } from '../types';

const SEATS: NationId[] = ['us', 'uk', 'russia'];

function table(money: number, patch: Partial<GameState['nations']['us']> = {}): GameState {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable(SEATS, { size: SEATS.length }),
    humanNations: ['us'],
    nations: {
      ...base.nations,
      us: { ...base.nations.us, isHuman: true, money, ...patch },
    },
  });
}

describe('tech bundled into the first purchase', () => {
  it('the first warhead unlocks Ballistic Missile Tech and charges for both', () => {
    const s = table(200);
    expect(s.nations.us.hasNuclearTech).toBe(false);
    expect(ballisticBundleCost(s, 'us')).toBe(COSTS.ballisticMissileTech);

    const next = buyBombsBundled(s, 1, 'us');
    expect(next.nations.us.hasNuclearTech).toBe(true);
    expect(next.nations.us.bombs).toBe(1);
    expect(next.nations.us.money).toBeCloseTo(200 - COSTS.ballisticMissileTech - COSTS.bomb, 5);
    // Owned now: nothing more to add
    expect(ballisticBundleCost(next, 'us')).toBe(0);
  });

  it('charges the tech once, however many warheads come after', () => {
    const s = buyBombsBundled(table(300), 2, 'us');
    const again = buyBombsBundled(s, 1, 'us');
    expect(again.nations.us.bombs).toBe(3);
    expect(again.nations.us.money).toBeCloseTo(
      300 - COSTS.ballisticMissileTech - 3 * COSTS.bomb,
      5,
    );
  });

  it('counts the tech when working out how many warheads are affordable', () => {
    const money = COSTS.ballisticMissileTech + COSTS.bomb * 2 + 1;
    expect(maxBombsBundled(table(money), 'us')).toBe(2);
    // Enough for the tech but not a warhead behind it
    expect(maxBombsBundled(table(COSTS.ballisticMissileTech), 'us')).toBe(0);
  });

  it('does nothing, and keeps the money, when the first warhead is out of reach', () => {
    const s = table(COSTS.ballisticMissileTech);
    const next = buyBombsBundled(s, 1, 'us');
    expect(next).toBe(s);
    expect(next.nations.us.hasNuclearTech).toBe(false);
  });

  it('magnetic and hydrogen bombs unlock the same tech', () => {
    const magnetic = buyMagneticBundled(table(200), 1, 'us');
    expect(magnetic.nations.us.hasNuclearTech).toBe(true);
    expect(magnetic.nations.us.magneticBombs).toBe(1);

    const hydrogen = buyHydrogenBundled(table(400), 'us');
    expect(hydrogen.nations.us.hasNuclearTech).toBe(true);
    expect(hydrogen.nations.us.hydrogenBombs).toBe(1);
  });

  it('the first drone pack unlocks Aerospace Tech', () => {
    const s = table(200);
    expect(aerospaceBundleCost(s, 'us')).toBe(COSTS.aerospaceTech);
    const next = buyDronesBundled(s, 2, 'us');
    expect(next.nations.us.hasAerospaceTech).toBe(true);
    expect(next.nations.us.drones).toBe(2);
    expect(next.nations.us.money).toBeCloseTo(200 - COSTS.aerospaceTech - 2 * COSTS.drone, 5);
    expect(maxDronesBundled(table(COSTS.aerospaceTech), 'us')).toBe(0);
  });

  it('a laser network unlocks Aerospace Tech too, and only when a city takes it', () => {
    const s = table(200);
    expect(canBuyLaserBundled(s, 'us')).toBe(true);
    const city = s.nations.us.cities[0].id;

    const next = buyLaserBundled(s, city, 'us');
    expect(next.nations.us.hasAerospaceTech).toBe(true);
    expect(next.nations.us.cities[0].hasLaser).toBe(true);
    expect(next.nations.us.money).toBeCloseTo(200 - COSTS.aerospaceTech - COSTS.laser, 5);

    // A city that does not exist builds nothing, so the tech is not charged either
    expect(buyLaserBundled(s, 'nowhere', 'us')).toBe(s);
    expect(canBuyLaserBundled(table(COSTS.laser), 'us')).toBe(false);
  });
});

describe('low treasury', () => {
  it('is low only when even the cheapest thing left to buy is out of reach', () => {
    const rich = table(500);
    expect(isTreasuryLow(rich, 'us')).toBe(false);

    const cheapest = cheapestPurchase(rich, 'us');
    expect(cheapest).not.toBeNull();
    const min = cheapest as number;

    expect(isTreasuryLow(table(min - 0.01), 'us')).toBe(true);
    expect(isTreasuryLow(table(min), 'us')).toBe(false);
  });

  it('prices a first warhead with its tech, so it never counts as cheap', () => {
    const s = table(500);
    const cheapest = cheapestPurchase(s, 'us') as number;
    expect(cheapest).toBeLessThanOrEqual(COSTS.shield);
    // An untouched arsenal: warheads cost more than a bare shield
    expect(COSTS.bomb + COSTS.ballisticMissileTech).toBeGreaterThan(cheapest);
  });

  it('is not low when nothing is left to buy', () => {
    const s = table(0);
    const n = s.nations.us;
    const spent: GameState = {
      ...s,
      nations: {
        ...s.nations,
        us: {
          ...n,
          hasNuclearTech: true,
          nuclearTechUnlockedRound: 1,
          hasAerospaceTech: true,
          aerospaceTechUnlockedRound: 1,
          hasSpyNetwork: true,
          bombsBoughtThisRound: 99,
          dronesBoughtThisRound: 99,
          hydrogenBought: 99,
          magneticBought: 99,
          shieldsBoughtThisRound: 99,
          researchBoughtThisRound: 99,
          cities: n.cities.map((c, i) => ({
            ...c,
            hasLaser: true,
            isUnderground: i === 0,
          })),
        },
      },
    };
    expect(cheapestPurchase(spent, 'us')).toBeNull();
    expect(isTreasuryLow(spent, 'us')).toBe(false);
  });
});
