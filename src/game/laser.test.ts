import { describe, expect, it } from 'vitest';
import { COSTS, DRONE_DAMAGE } from '../data/nations';
import {
  applyQueuedStrike,
  buyLaser,
  buyRebuild,
  buyShield,
  canBuyLaser,
  createInitialState,
  droneDamageFor,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  startGame,
} from './engine';
import { pickDroneTarget, runAiBuyPhase } from './ai';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState, NationId, NationState } from '../types';

/** Two-nation table: 'us' holds the swarm, 'uk' is the one being swarmed. */
function table(overrides: Partial<Record<NationId, Partial<NationState>>> = {}): GameState {
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
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        drones: 2,
        hasNuclearTech: true,
        nuclearTechUnlockedRound: 0,
        bombs: 1,
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

/** Resolve every queued strike in the real order (drones first, then warheads). */
function resolveAll(state: GameState): GameState {
  let s = state;
  for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
    s = applyQueuedStrike(s, strike);
  }
  return s;
}

describe('laser defence', () => {
  it('costs $2.5M per city and needs Aerospace Tech first', () => {
    expect(COSTS.laser).toBe(2.5);

    const noTech = table({ uk: { hasAerospaceTech: false, aerospaceTechUnlockedRound: null } });
    expect(canBuyLaser(noTech, 'uk')).toBe(false);
    const city = noTech.nations.uk.cities[0];
    expect(buyLaser(noTech, city.id, 'uk').nations.uk.cities[0].hasLaser).toBeFalsy();

    const s = buyLaser(table(), city.id, 'uk');
    expect(s.nations.uk.cities[0].hasLaser).toBe(true);
    expect(s.nations.uk.money).toBe(20 - COSTS.laser);
  });

  it('does not sell a second battery for the same city', () => {
    const city = table().nations.uk.cities[0];
    const s = buyLaser(table(), city.id, 'uk');
    expect(buyLaser(s, city.id, 'uk').nations.uk.money).toBe(s.nations.uk.money);
  });

  it('shoots the swarm down instead of billing repairs', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyLaser(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = resolveAll(s);

    expect(s.nations.uk.pendingDroneDamage ?? 0).toBe(0);
    expect(droneDamageFor(s.nations.uk.cities[0])).toBe(0);
    const event = s.roundEvents.find((e) => e.kind === 'dronesIntercepted');
    expect(event?.cityId).toBe(city.id);
    expect(event?.attackerId).toBe('us');
  });

  it('bills the usual repairs on a city without a battery', () => {
    let s = table();
    const [lasered, open] = s.nations.uk.cities;
    s = buyLaser(s, lasered.id, 'uk');
    s = queueStrike(s, 'uk', open.id, 'us', 'drone');
    s = resolveAll(s);
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE);
  });

  it('keeps the shield up, so a nuke sent with the swarm only breaks the shield', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyShield(s, city.id, 'uk');
    s = buyLaser(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us');
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = resolveAll(s);

    const after = s.nations.uk.cities[0];
    expect(after.destroyed).toBe(false);
    expect(after.hasShield).toBe(false);
    expect(after.hasLaser).toBe(true);
  });

  it('without the battery the same volley levels the city', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyShield(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us');
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = resolveAll(s);
    expect(s.nations.uk.cities[0].destroyed).toBe(true);
  });

  it('burns with the city and does not come back with the rebuild', () => {
    let s = table({ us: { bombs: 2 } });
    const city = s.nations.uk.cities[0];
    s = buyLaser(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us');
    s = resolveAll(s);
    expect(s.nations.uk.cities[0].destroyed).toBe(true);
    expect(s.nations.uk.cities[0].hasLaser).toBe(false);

    s = buyRebuild({ ...s, pendingStrikes: [] }, city.id, 'uk');
    expect(s.nations.uk.cities[0].destroyed).toBe(false);
    expect(s.nations.uk.cities[0].hasLaser).toBe(false);
  });

  it('survives online reconciliation from either side', () => {
    const local = table();
    const remote = buyLaser(local, local.nations.uk.cities[0].id, 'uk');
    const forward = mergeNationPlanning(remote.nations.uk, local.nations.uk);
    const backward = mergeNationPlanning(local.nations.uk, remote.nations.uk);
    expect(forward.cities[0].hasLaser).toBe(true);
    expect(backward.cities[0].hasLaser).toBe(true);
  });
});

describe('AI and laser defence', () => {
  it('never sends a swarm at a city that will shoot it down', () => {
    let s = table();
    for (const city of s.nations.uk.cities.slice(0, 2)) {
      s = buyLaser(s, city.id, 'uk');
    }
    const target = pickDroneTarget(s, 'us');
    expect(target?.cityId).toBe(s.nations.uk.cities[2].id);

    let allCovered = s;
    allCovered = buyLaser(allCovered, s.nations.uk.cities[2].id, 'uk');
    expect(pickDroneTarget(allCovered, 'us')).toBeNull();
  });

  it('installs a battery once a rival is holding drones', () => {
    const base = table({ uk: { isHuman: false, money: 20 } });
    const s = { ...base, currentTurnIndex: base.turnOrder.indexOf('uk') };
    expect(runAiBuyPhase(s).nations.uk.cities.some((c) => c.hasLaser)).toBe(true);
  });

  it('leaves the batteries alone while nobody can field a swarm', () => {
    const base = table({ us: { drones: 0 }, uk: { isHuman: false, money: 20 } });
    const s = { ...base, currentTurnIndex: base.turnOrder.indexOf('uk') };
    expect(runAiBuyPhase(s).nations.uk.cities.some((c) => c.hasLaser)).toBe(false);
  });
});
