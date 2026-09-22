import { describe, expect, it } from 'vitest';
import { COSTS } from '../data/nations';
import {
  applyQueuedStrike,
  buyRebuild,
  buyResearch,
  buyShield,
  canBuyRebuild,
  createInitialState,
  queueStrike,
  seatTable,
  startGame,
} from './engine';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState } from '../types';

/** A US armed with enough warheads to level the UK, which has cash to rebuild. */
function table(ukMoney = 20, usBombs = 3) {
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
        bombs: usBombs,
      },
      uk: { ...base.nations.uk, money: ukMoney },
    },
  });
}

/** Flatten every UK city, resolving each warhead as it lands. */
function levelTheUk(state: GameState): GameState {
  let s = state;
  for (const city of s.nations.uk.cities) {
    if (s.nations.uk.cities.find((c) => c.id === city.id)?.destroyed) continue;
    s = queueStrike(s, 'uk', city.id, 'us');
    const strike = s.pendingStrikes[s.pendingStrikes.length - 1];
    s = { ...s, nations: { ...s.nations, us: { ...s.nations.us, citiesStruckThisRound: [] } } };
    s = applyQueuedStrike(s, strike);
  }
  return s;
}

describe('rebuilding a burnt city', () => {
  it('costs $6M and puts the city back on the board', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(s.nations.uk.cities[0].destroyed).toBe(true);

    const before = s.nations.uk.money;
    s = buyRebuild(s, city.id, 'uk');
    expect(s.nations.uk.money).toBe(before - COSTS.rebuild);
    expect(s.nations.uk.cities[0].destroyed).toBe(false);
    expect(s.nations.uk.cities[0].rebuiltRound).toBe(s.round);
  });

  it('brings the city back bare — no shield, no research', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyShield(s, city.id, 'uk');
    s = buyResearch(s, city.id, 'uk');
    // First warhead only shatters the shield; the second levels the city
    for (let i = 0; i < 2; i += 1) {
      s = { ...s, nations: { ...s.nations, us: { ...s.nations.us, citiesStruckThisRound: [] } } };
      s = queueStrike(s, 'uk', city.id, 'us');
      s = applyQueuedStrike(s, s.pendingStrikes[s.pendingStrikes.length - 1]);
    }
    expect(s.nations.uk.cities[0].destroyed).toBe(true);
    s = buyRebuild(s, city.id, 'uk');

    const rebuilt = s.nations.uk.cities[0];
    expect(rebuilt.destroyed).toBe(false);
    expect(rebuilt.hasShield).toBe(false);
    expect(rebuilt.hasResearch).toBe(false);
    expect(s.nations.uk.researchCenters).toBe(0);
  });

  it('is not offered without the money or without rubble', () => {
    const intact = table();
    expect(canBuyRebuild(intact, 'uk')).toBe(false);

    let s = table(COSTS.rebuild - 0.5);
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    expect(canBuyRebuild(s, 'uk')).toBe(false);
    expect(buyRebuild(s, city.id, 'uk')).toBe(s);
  });

  it('logs a round event so the aftermath can report it', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    s = buyRebuild(s, city.id, 'uk');

    const event = s.roundEvents.find((e) => e.kind === 'cityRebuilt');
    expect(event?.cityId).toBe(city.id);
    expect(event?.automatic).toBeUndefined();
  });
});

describe('the emergency rebuild when the last city falls', () => {
  it('keeps a nation alive that can still pay for it', () => {
    const s = levelTheUk(table(20));

    expect(s.nations.uk.eliminated).toBe(false);
    expect(s.nations.uk.cities.filter((c) => !c.destroyed)).toHaveLength(1);
    expect(s.nations.uk.money).toBe(20 - COSTS.rebuild);

    const rescue = s.roundEvents.find((e) => e.kind === 'cityRebuilt');
    expect(rescue?.automatic).toBe(true);
    expect(s.roundEvents.some((e) => e.kind === 'nationEliminated')).toBe(false);
  });

  it('raises the city that fell last', () => {
    const s = levelTheUk(table(20));
    const standing = s.nations.uk.cities.find((c) => !c.destroyed);
    expect(standing?.id).toBe(s.nations.uk.cities[s.nations.uk.cities.length - 1].id);
  });

  it('still eliminates a nation that cannot afford it', () => {
    const s = levelTheUk(table(COSTS.rebuild - 0.5));

    expect(s.nations.uk.eliminated).toBe(true);
    expect(s.roundEvents.some((e) => e.kind === 'nationEliminated')).toBe(true);
  });
});

describe('online merge of a rebuilt city', () => {
  it('does not bury a city the other client has not seen rebuilt yet', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    const stale = s.nations.uk;
    const rebuilt = buyRebuild(s, city.id, 'uk').nations.uk;

    expect(mergeNationPlanning(stale, rebuilt).cities[0].destroyed).toBe(false);
    expect(mergeNationPlanning(rebuilt, stale).cities[0].destroyed).toBe(false);
  });

  it('keeps a city that was rebuilt and then hit again as rubble', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    s = buyRebuild(s, city.id, 'uk');
    const rebuilt = s.nations.uk;

    s = { ...s, nations: { ...s.nations, us: { ...s.nations.us, citiesStruckThisRound: [] } } };
    s = queueStrike(s, 'uk', city.id, 'us');
    s = applyQueuedStrike(s, s.pendingStrikes[0]);
    const hitAgain = s.nations.uk;

    expect(mergeNationPlanning(rebuilt, hitAgain).cities[0].destroyed).toBe(true);
    expect(mergeNationPlanning(hitAgain, rebuilt).cities[0].destroyed).toBe(true);
  });
});
