import { describe, expect, it } from 'vitest';
import { COSTS, DRONE_DAMAGE, LASER_INTERCEPTS_PER_ROUND } from '../data/nations';
import {
  applyQueuedStrike,
  buyLaser,
  buyRebuild,
  buyShield,
  canBuyLaser,
  createInitialState,
  droneDamageFor,
  laserInterceptsLeft,
  nextRound,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  startGame,
} from './engine';
import { pickDroneTarget, runAiBuyPhase, runAiNationTurn } from './ai';
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
        // Attack plans only account for a network the attacker can see
        hasSpyNetwork: true,
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
  it('costs $3M and needs Aerospace Tech first', () => {
    expect(COSTS.laser).toBe(3);

    const noTech = table({ uk: { hasAerospaceTech: false, aerospaceTechUnlockedRound: null } });
    expect(canBuyLaser(noTech, 'uk')).toBe(false);
    const city = noTech.nations.uk.cities[0];
    expect(buyLaser(noTech, city.id, 'uk').nations.uk.cities[0].hasLaser).toBeFalsy();

    const s = buyLaser(table(), city.id, 'uk');
    expect(s.nations.uk.cities[0].hasLaser).toBe(true);
    expect(s.nations.uk.money).toBe(20 - COSTS.laser);
  });

  it('sells one network per nation, not one battery per city', () => {
    const cities = table().nations.uk.cities;
    const s = buyLaser(table(), cities[0].id, 'uk');
    expect(canBuyLaser(s, 'uk')).toBe(false);
    expect(buyLaser(s, cities[1].id, 'uk')).toBe(s);
    expect(buyLaser(s, cities[0].id, 'uk')).toBe(s);
  });

  it('covers every city the nation owns, not just the one it sits on', () => {
    let s = table();
    const [host, elsewhere] = s.nations.uk.cities;
    s = buyLaser(s, host.id, 'uk');
    s = queueStrike(s, 'uk', elsewhere.id, 'us', 'drone');
    s = resolveAll(s);

    expect(s.nations.uk.pendingDroneDamage ?? 0).toBe(0);
    expect(s.roundEvents.some((e) => e.kind === 'dronesIntercepted')).toBe(true);
  });

  it('runs out of shots after its budget and lets the rest through', () => {
    let s = table({ us: { drones: 5 } });
    s = buyLaser(s, s.nations.uk.cities[0].id, 'uk');
    for (const city of s.nations.uk.cities) {
      s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    }
    s = resolveAll(s);

    const shot = s.roundEvents.filter((e) => e.kind === 'dronesIntercepted');
    const billed = s.roundEvents.filter((e) => e.kind === 'droneDamage');
    expect(shot).toHaveLength(LASER_INTERCEPTS_PER_ROUND);
    expect(billed).toHaveLength(3 - LASER_INTERCEPTS_PER_ROUND);
    expect(s.nations.uk.dronesInterceptedThisRound).toBe(LASER_INTERCEPTS_PER_ROUND);
  });

  it('reloads for the next round', () => {
    let s = table({ us: { drones: 5 } });
    s = buyLaser(s, s.nations.uk.cities[0].id, 'uk');
    s = queueStrike(s, 'uk', s.nations.uk.cities[0].id, 'us', 'drone');
    s = resolveAll(s);
    expect(laserInterceptsLeft(s, 'uk')).toBe(LASER_INTERCEPTS_PER_ROUND - 1);

    s = nextRound({ ...s, phase: 'roundSummary', pendingStrikes: [] });
    expect(laserInterceptsLeft(s, 'uk')).toBe(LASER_INTERCEPTS_PER_ROUND);
  });

  it('shoots the swarm down instead of billing repairs', () => {
    let s = table();
    const city = s.nations.uk.cities[0];
    s = buyLaser(s, city.id, 'uk');
    s = queueStrike(s, 'uk', city.id, 'us', 'drone');
    s = resolveAll(s);

    expect(s.nations.uk.pendingDroneDamage ?? 0).toBe(0);
    const event = s.roundEvents.find((e) => e.kind === 'dronesIntercepted');
    expect(event?.cityId).toBe(city.id);
    expect(event?.attackerId).toBe('us');
  });

  it('bills the usual repairs on a nation without a network', () => {
    let s = table();
    const open = s.nations.uk.cities[1];
    s = queueStrike(s, 'uk', open.id, 'us', 'drone');
    s = resolveAll(s);
    expect(s.nations.uk.pendingDroneDamage).toBe(DRONE_DAMAGE);
    expect(droneDamageFor(s.nations.uk.cities[1])).toBe(DRONE_DAMAGE);
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
  it('will not fly swarms it cannot push past the network', () => {
    let s = table({ us: { drones: LASER_INTERCEPTS_PER_ROUND } });
    s = buyLaser(s, s.nations.uk.cities[0].id, 'uk');
    // Exactly as many swarms as the network has shots — every one dies
    expect(pickDroneTarget(s, 'us')).toBeNull();
  });

  it('flies into a network it has no eyes on', () => {
    let s = table({
      us: { drones: LASER_INTERCEPTS_PER_ROUND, hasSpyNetwork: false },
    });
    s = buyLaser(s, s.nations.uk.cities[0].id, 'uk');
    // The network is invisible without a spy service, so the swarms go anyway
    expect(pickDroneTarget(s, 'us')?.nationId).toBe('uk');

    s = runAiNationTurn({ ...s, nations: { ...s.nations, us: { ...s.nations.us, isHuman: false } } }, 'us');
    s = resolveAll(s);
    expect(s.roundEvents.filter((e) => e.kind === 'dronesIntercepted')).toHaveLength(
      LASER_INTERCEPTS_PER_ROUND,
    );
    expect(s.nations.uk.pendingDroneDamage ?? 0).toBe(0);
  });

  it('saturates the network when it holds one swarm more than the shots', () => {
    let s = table({ us: { drones: LASER_INTERCEPTS_PER_ROUND + 1 } });
    s = buyLaser(s, s.nations.uk.cities[0].id, 'uk');
    expect(pickDroneTarget(s, 'us')?.nationId).toBe('uk');
  });

  it('spends decoys on the neighbours so the escort reaches a shielded city', () => {
    let s = table({ us: { drones: LASER_INTERCEPTS_PER_ROUND + 1, bombs: 1 } });
    const target = s.nations.uk.cities[0];
    s = buyShield(s, target.id, 'uk');
    s = buyLaser(s, s.nations.uk.cities[2].id, 'uk');

    s = runAiNationTurn({ ...s, nations: { ...s.nations, us: { ...s.nations.us, isHuman: false } } }, 'us');
    const swarms = s.pendingStrikes.filter((p) => p.weapon === 'drone');
    expect(swarms.length).toBe(LASER_INTERCEPTS_PER_ROUND + 1);
    expect(swarms.some((p) => p.cityId === target.id)).toBe(true);

    s = resolveAll(s);
    const shot = s.roundEvents.filter((e) => e.kind === 'dronesIntercepted').map((e) => e.cityId);
    expect(shot).toHaveLength(LASER_INTERCEPTS_PER_ROUND);
    expect(shot).not.toContain(target.id);
    expect(s.nations.uk.cities[0].hasShield).toBe(false);
  });

  /** An AI that already has its tech, so the budget reaches the defences. */
  function aiTable(usDrones: number): GameState {
    const base = table({
      us: { drones: usDrones },
      uk: { isHuman: false, money: 20, hasNuclearTech: true, nuclearTechUnlockedRound: 0 },
    });
    return { ...base, currentTurnIndex: base.turnOrder.indexOf('uk') };
  }

  it('installs a battery once a rival is holding drones', () => {
    const s = aiTable(2);
    expect(runAiBuyPhase(s).nations.uk.cities.some((c) => c.hasLaser)).toBe(true);
  });

  it('leaves the network alone while nobody can field a swarm', () => {
    const grounded = aiTable(0);
    const s = {
      ...grounded,
      nations: {
        ...grounded.nations,
        us: {
          ...grounded.nations.us,
          hasAerospaceTech: false,
          aerospaceTechUnlockedRound: null,
        },
      },
    };
    expect(runAiBuyPhase(s).nations.uk.cities.some((c) => c.hasLaser)).toBe(false);
  });
});
