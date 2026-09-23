import { describe, expect, it } from 'vitest';
import { COSTS } from '../data/nations';
import {
  applyQueuedStrike,
  buyLaser,
  buyShield,
  buySpyNetwork,
  buyUnderground,
  canBuySpyNetwork,
  cityAsSeenBy,
  createInitialState,
  laserShotsKnownTo,
  queueStrike,
  seatTable,
  seesDefences,
  startGame,
} from './engine';
import { pickBombTarget, runAiBuyPhase } from './ai';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState, NationState } from '../types';

function table(overrides: { us?: Partial<NationState>; uk?: Partial<NationState> } = {}): GameState {
  const base = createInitialState();
  return startGame({
    ...base,
    mode: 'two',
    turnOrder: seatTable(['us', 'uk'], { size: 2 }),
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
        ...(overrides.us ?? {}),
      },
      uk: {
        ...base.nations.uk,
        money: 20,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        ...(overrides.uk ?? {}),
      },
    },
  });
}

describe('buying a spy service', () => {
  it(`costs $${COSTS.spy}M once and sticks for the rest of the war`, () => {
    const s = table();
    expect(canBuySpyNetwork(s, 'us')).toBe(true);

    const after = buySpyNetwork(s, 'us');
    expect(after.nations.us.hasSpyNetwork).toBe(true);
    expect(after.nations.us.money).toBe(20 - COSTS.spy);

    // No second service to buy
    expect(canBuySpyNetwork(after, 'us')).toBe(false);
    expect(buySpyNetwork(after, 'us')).toBe(after);
  });

  it('is out of reach on an empty treasury', () => {
    const s = table({ us: { money: COSTS.spy - 0.5 } });
    expect(canBuySpyNetwork(s, 'us')).toBe(false);
    expect(buySpyNetwork(s, 'us')).toBe(s);
  });

  it('survives online reconciliation from either side', () => {
    const s = table();
    const spied = buySpyNetwork(s, 'us');
    expect(mergeNationPlanning(spied.nations.us, s.nations.us).hasSpyNetwork).toBe(true);
    expect(mergeNationPlanning(s.nations.us, spied.nations.us).hasSpyNetwork).toBe(true);
  });
});

describe('what a nation can see', () => {
  it('always reads its own cities', () => {
    const s = table();
    expect(seesDefences(s, 'us', 'us')).toBe(true);
    expect(seesDefences(s, 'us', 'uk')).toBe(false);
    expect(seesDefences(buySpyNetwork(s, 'us'), 'us', 'uk')).toBe(true);
  });

  it('strips the defences off an enemy city until the service is open', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyShield(s, city.id, 'uk');
    s = buyLaser(s, city.id, 'uk');

    const blind = cityAsSeenBy(s, 'us', 'uk', s.nations.uk.cities[0]);
    expect(blind.hasShield).toBe(false);
    expect(blind.hasLaser).toBe(false);
    expect(blind.destroyed).toBe(false);
    expect(blind.name).toBe(city.name);

    const spied = buySpyNetwork(s, 'us');
    expect(cityAsSeenBy(spied, 'us', 'uk', spied.nations.uk.cities[0]).hasShield).toBe(true);
  });

  it('counts no interceptions it cannot see', () => {
    let s = table();
    s = buyLaser(s, s.nations.uk.cities[0].id, 'uk');
    expect(laserShotsKnownTo(s, 'us', 'uk')).toBe(0);
    expect(laserShotsKnownTo(buySpyNetwork(s, 'us'), 'us', 'uk')).toBeGreaterThan(0);
  });
});

describe('attacking blind', () => {
  it('lets a warhead fly at a bunker and break against the rock', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us');
    expect(s.pendingStrikes).toHaveLength(1);

    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(s.nations.uk.cities[0].destroyed).toBe(false);
  });

  it('refuses the same shot once the bunker is on the table', () => {
    let s = buySpyNetwork(table(), 'us');
    const city = s.nations.uk.cities[0];
    s = buyUnderground(s, city.id, 'uk');
    const after = queueStrike(s, 'uk', city.id, 'us');
    expect(after.pendingStrikes).toHaveLength(0);
    expect(after.nations.us.bombs).toBe(s.nations.us.bombs);
  });

  it('aims at a shielded city it cannot see is shielded', () => {
    let s = table({ us: { drones: 0 } });
    const [shielded, open] = s.nations.uk.cities;
    s = buyShield(s, shielded.id, 'uk');

    // Blind, the first city looks as good as any other
    expect(pickBombTarget(s, 'us')?.cityId).toBe(shielded.id);
    // With eyes on it, the warhead goes where it will actually land
    expect(pickBombTarget(buySpyNetwork(s, 'us'), 'us')?.cityId).toBe(open.id);
  });
});

describe('AI and intel', () => {
  /** An AI nation with money to spend and a rival that has put a shield up. */
  function aiTable(rivalShields: number): GameState {
    const base = table({
      us: { isHuman: false, money: 20, hasSpyNetwork: false },
      uk: { money: 20 },
    });
    let s: GameState = { ...base, round: 2, currentTurnIndex: base.turnOrder.indexOf('us') };
    for (const city of s.nations.uk.cities.slice(0, rivalShields)) {
      s = buyShield({ ...s, nations: { ...s.nations, uk: { ...s.nations.uk, shieldsBoughtThisRound: 0 } } }, city.id, 'uk');
    }
    return s;
  }

  it('pays for eyes once a rival has defences worth finding', () => {
    expect(runAiBuyPhase(aiTable(1)).nations.us.hasSpyNetwork).toBe(true);
  });

  it('spends nothing on intel while the board is still bare', () => {
    expect(runAiBuyPhase(aiTable(0)).nations.us.hasSpyNetwork).toBe(false);
  });
});
