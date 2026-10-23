import { describe, expect, it } from 'vitest';
import {
  COSTS,
  CLUSTER_DAMAGE_OPEN,
  LAB_ROUNDS_PER_INVENTION,
  RESEARCH_UPKEEP,
  SCORE_LAB_HIT,
} from '../data/nations';
import {
  applyQueuedStrike,
  buyResearch,
  canBuyBombs,
  canBuyDrones,
  defenseDroneStock,
  canBuyResearch,
  createInitialState,
  nextRound,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  startGame,
  totalWarheads,
  warheadStock,
} from './engine';
import { runAiNationTurn } from './ai';
import { aerospaceBundleCost, ballisticBundleCost } from './bundles';
import {
  INVENTION_KINDS,
  PROTOTYPE_KINDS,
  TECH_KINDS,
  inventionTotal,
  isTechKind,
  inventionOfRound,
  inventionStock,
  labCanFinish,
  pickInvention,
  researchProgress,
} from './inventions';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { City, GameState, InventionKind, NationId, NationState } from '../types';

const SEATS: NationId[] = ['us', 'uk', 'russia', 'china', 'france'];

function table(tweaks: Partial<Record<NationId, Partial<NationState>>> = {}, seed = 7): GameState {
  const base = createInitialState();
  const order = seatTable(SEATS, { size: SEATS.length });
  const nations = { ...base.nations };
  for (const id of order) {
    nations[id] = { ...nations[id], isHuman: id === 'us', money: 300, ...(tweaks[id] ?? {}) };
  }
  return startGame({
    ...base,
    matchSeed: seed,
    mode: 'single',
    turnOrder: order,
    humanNations: ['us'],
    nations,
  });
}

/** Resolve every queued strike in the round's own order. */
function resolveAll(state: GameState): GameState {
  let s = state;
  for (const strike of orderStrikesForResolution(state.pendingStrikes)) {
    s = applyQueuedStrike(s, strike);
  }
  return s;
}

const withCity = (s: GameState, id: NationId, index: number, patch: Partial<City>): GameState => ({
  ...s,
  nations: {
    ...s.nations,
    [id]: {
      ...s.nations[id],
      cities: s.nations[id].cities.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    },
  },
});

const arm = (s: GameState, id: NationId, kinds: InventionKind[]): GameState => ({
  ...s,
  nations: { ...s.nations, [id]: { ...s.nations[id], inventions: kinds } },
});

describe('what the labs invent', () => {
  it('delivers a bomb after two rounds of lab work, and says so on that round', () => {
    expect(LAB_ROUNDS_PER_INVENTION).toBe(2);
    let s = table();
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    expect(researchProgress(s.nations.us)).toEqual({ done: 0, of: 2 });

    s = nextRound(s); // round 2: first round of work
    expect(s.nations.us.inventions ?? []).toHaveLength(0);
    expect(researchProgress(s.nations.us).done).toBe(1);

    s = nextRound(s); // round 3: second round of work
    expect(s.round).toBe(3);
    expect(s.nations.us.inventions).toHaveLength(1);
    expect(inventionOfRound(s.nations.us, 3)).toBe(s.nations.us.inventions![0]);
    expect(s.log.some((l) => /scientists invented/.test(l.text))).toBe(true);
    // The announcement belongs to that round only
    expect(inventionOfRound(s.nations.us, 4)).toBeNull();

    // and a lab bought in round 1 delivers again in round 5
    s = nextRound(s);
    s = nextRound(s);
    expect(s.round).toBe(5);
    expect(s.nations.us.inventions).toHaveLength(2);
  });

  it('only sells a lab while there is time for it to deliver', () => {
    const base = table();
    const at = (round: number) => ({ ...base, round, phase: 'buy' as const });
    expect(canBuyResearch(at(1), 'us')).toBe(true);
    expect(canBuyResearch(at(4), 'us')).toBe(true);
    expect(canBuyResearch(at(5), 'us')).toBe(false);
    expect(canBuyResearch(at(6), 'us')).toBe(false);
    expect(buyResearch(at(5), base.nations.us.cities[0].id, 'us').nations.us.money).toBe(
      base.nations.us.money,
    );
    expect(labCanFinish(4, 6)).toBe(true);
    expect(labCanFinish(5, 6)).toBe(false);
  });

  it('does nothing for a nation with no lab', () => {
    let s = table();
    for (let i = 0; i < 4; i += 1) s = nextRound(s);
    expect(s.nations.us.inventions ?? []).toHaveLength(0);
    expect(s.nations.us.labRounds ?? 0).toBe(0);
  });

  it('pauses while the lab is in ruins instead of wiping the progress', () => {
    let s = table();
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    s = nextRound(s);
    expect(s.nations.us.labRounds).toBe(1);
    s = withCity(s, 'us', 0, { hasResearch: false });
    s = nextRound(s);
    s = nextRound(s);
    expect(s.nations.us.labRounds).toBe(1);
    expect(s.nations.us.inventions ?? []).toHaveLength(0);
  });

  it('draws the same bomb on every client, and a different one in a different match', () => {
    expect(pickInvention(7, 'us', [])).toBe(pickInvention(7, 'us', []));
    const seen = new Set<InventionKind>();
    for (let seed = 0; seed < 80; seed += 1) seen.add(pickInvention(seed, 'us', []));
    // Every kind is on the table
    expect([...seen].sort()).toEqual([...INVENTION_KINDS].sort());
  });

  it('never repeats the bomb it just made', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      const first = pickInvention(seed, 'us', []);
      expect(pickInvention(seed, 'us', [first])).not.toBe(first);
    }
  });
});

describe('what can be invented', () => {
  it('is what the shops do not sell: three bombs, the defence drones and two technologies', () => {
    expect([...INVENTION_KINDS].sort()).toEqual([
      'aerospaceTech',
      'ballisticTech',
      'biological',
      'chemical',
      'cluster',
      'defenseDrones',
    ]);
    expect([...TECH_KINDS].sort()).toEqual(['aerospaceTech', 'ballisticTech']);
    expect([...PROTOTYPE_KINDS].sort()).toEqual(['biological', 'chemical', 'cluster']);
    // Nuclear, hydrogen and magnetic bombs are bought, never invented
    for (const bought of ['nuke', 'hydrogen', 'magnetic']) {
      expect(INVENTION_KINDS as string[]).not.toContain(bought);
    }
  });

  it('keeps the defence drones out of the warhead count', () => {
    const s = arm(table(), 'us', ['defenseDrones', 'cluster']);
    expect(defenseDroneStock(s.nations.us)).toBe(1);
    expect(totalWarheads(s.nations.us)).toBe(1);
    // ...and they are no weapon: there is nothing to fire
    expect(queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'nuke')).toBe(s);
  });
});

describe('technology from the labs', () => {
  const seedFor = (kind: InventionKind): number => {
    for (let seed = 0; seed < 500; seed += 1) {
      if (pickInvention(seed, 'us', [], []) === kind) return seed;
    }
    throw new Error(`no seed draws ${kind}`);
  };
  const labTwoRounds = (s: GameState): GameState => {
    let next = buyResearch(s, s.nations.us.cities[0].id, 'us');
    next = nextRound(next);
    return nextRound(next);
  };

  it('can come out of the lab: Ballistic Missile Tech unlocks warheads outright', () => {
    let s = table({}, seedFor('ballisticTech'));
    expect(canBuyBombs(s, 'us')).toBe(false);
    expect(ballisticBundleCost(s, 'us')).toBe(COSTS.ballisticMissileTech);
    s = labTwoRounds(s);
    expect(s.nations.us.inventions).toEqual(['ballisticTech']);
    expect(s.nations.us.hasNuclearTech).toBe(true);
    expect(s.nations.us.nuclearTechUnlockedRound).toBe(3);
    // Usable the round it is announced, and the first warhead carries no tech fee
    expect(canBuyBombs(s, 'us')).toBe(true);
    expect(ballisticBundleCost(s, 'us')).toBe(0);
    expect(s.nations.us.hasAerospaceTech).toBe(false);
    expect(inventionOfRound(s.nations.us, 3)).toBe('ballisticTech');
  });

  it('can come out of the lab: Aerospace Tech unlocks drones and lasers outright', () => {
    let s = table({}, seedFor('aerospaceTech'));
    expect(aerospaceBundleCost(s, 'us')).toBe(COSTS.aerospaceTech);
    s = labTwoRounds(s);
    expect(s.nations.us.inventions).toEqual(['aerospaceTech']);
    expect(s.nations.us.hasAerospaceTech).toBe(true);
    expect(s.nations.us.aerospaceTechUnlockedRound).toBe(3);
    expect(canBuyDrones(s, 'us')).toBe(true);
    expect(aerospaceBundleCost(s, 'us')).toBe(0);
    expect(s.nations.us.hasNuclearTech).toBe(false);
  });

  it('is knowledge, not hardware: nothing lands in the arsenal', () => {
    const s = labTwoRounds(table({}, seedFor('ballisticTech')));
    expect(inventionTotal(s.nations.us)).toBe(0);
    expect(totalWarheads(s.nations.us)).toBe(0);
    expect(inventionStock(s.nations.us, 'ballisticTech')).toBe(1); // recorded, but not a stock to spend
    expect(isTechKind('ballisticTech')).toBe(true);
  });

  it('is never invented for a nation that already holds it', () => {
    const none: InventionKind[] = [];
    for (let seed = 0; seed < 300; seed += 1) {
      expect(pickInvention(seed, 'us', none, ['ballisticTech'])).not.toBe('ballisticTech');
      expect(pickInvention(seed, 'us', none, ['aerospaceTech'])).not.toBe('aerospaceTech');
      expect(isTechKind(pickInvention(seed, 'us', none, ['ballisticTech', 'aerospaceTech']))).toBe(false);
    }
  });

  it('skips the tech a nation bought, however the dice fall', () => {
    for (const [kind, owned] of [
      ['ballisticTech', { hasNuclearTech: true, nuclearTechUnlockedRound: 1 }],
      ['aerospaceTech', { hasAerospaceTech: true, aerospaceTechUnlockedRound: 1 }],
    ] as const) {
      const s = labTwoRounds(table({ us: owned }, seedFor(kind)));
      expect(s.nations.us.inventions).toHaveLength(1);
      expect(s.nations.us.inventions).not.toContain(kind);
    }
  });

  it('never repeats a tech: the second draw is something else', () => {
    let s = table({}, seedFor('ballisticTech'));
    s = labTwoRounds(s);
    s = nextRound(nextRound(s)); // round 5
    expect(s.nations.us.inventions).toHaveLength(2);
    expect(s.nations.us.inventions!.filter((k) => k === 'ballisticTech')).toHaveLength(1);
  });

  it('does not break the used-stock count when techs are in the list', () => {
    const s = arm(table(), 'us', ['ballisticTech', 'cluster']);
    expect(inventionTotal(s.nations.us)).toBe(1);
  });
});

describe('firing a lab bomb', () => {
  it('needs no ballistic tech and uses up the invented stock', () => {
    let s = arm(table(), 'us', ['cluster']);
    expect(s.nations.us.hasNuclearTech).toBe(false);
    expect(totalWarheads(s.nations.us)).toBe(1);
    expect(warheadStock(s.nations.us, 'cluster')).toBe(1);

    const target = s.nations.russia.cities[0];
    s = queueStrike(s, 'russia', target.id, 'us', 'cluster');
    expect(s.pendingStrikes).toHaveLength(1);
    expect(s.pendingStrikes[0].weapon).toBe('cluster');
    expect(inventionStock(s.nations.us, 'cluster')).toBe(0);
    expect(s.nations.us.inventionsUsed?.cluster).toBe(1);
    expect(totalWarheads(s.nations.us)).toBe(0);

    // Nothing left to fire
    const again = queueStrike(s, 'russia', s.nations.russia.cities[1].id, 'us', 'cluster');
    expect(again).toBe(s);
  });

  it('a bomb nobody invented cannot be fired', () => {
    const s = table();
    for (const kind of ['cluster', 'biological', 'chemical'] as const) {
      expect(queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', kind)).toBe(s);
    }
  });
});

describe('cluster bomb', () => {
  /** Russia: a shielded city, a bunker city and an open one, the open one marked. */
  const setup = () => {
    let s = arm(table(), 'us', ['cluster']);
    s = withCity(s, 'russia', 0, { hasShield: true });
    s = withCity(s, 'russia', 1, { isUnderground: true });
    return queueStrike(s, 'russia', s.nations.russia.cities[2].id, 'us', 'cluster');
  };
  const kindsOf = (s: GameState, kind: string) => s.roundEvents.filter((e) => e.kind === kind);

  it('splits into a bomblet for every city: shields down, open cities damaged, bunkers hold', () => {
    expect(CLUSTER_DAMAGE_OPEN).toBe(20);
    const done = resolveAll(setup());
    const cities = done.nations.russia.cities;
    // The shield is gone; the open city is billed; the bunker city is untouched
    expect(cities[0].hasShield).toBe(false);
    expect(cities[1].isUnderground).toBe(true);
    expect(done.nations.russia.pendingDroneDamage).toBe(CLUSTER_DAMAGE_OPEN);
    const events = done.roundEvents.filter((e) => e.weapon === 'cluster');
    expect(events.map((e) => [e.cityId, e.kind])).toEqual([
      [cities[0].id, 'shieldDestroyed'],
      [cities[1].id, 'strikeAbsorbed'],
      [cities[2].id, 'droneDamage'],
    ]);
  });

  it('destroys every shield of the nation, wherever the canister was aimed', () => {
    let s = arm(table(), 'us', ['cluster']);
    for (const i of [0, 1, 2]) s = withCity(s, 'russia', i, { hasShield: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[1].id, 'us', 'cluster');
    const done = resolveAll(s);
    expect(done.nations.russia.cities.every((c) => !c.hasShield && !c.destroyed)).toBe(true);
    expect(kindsOf(done, 'shieldDestroyed')).toHaveLength(3);
    // A shield took the bomblet, so there is no repair bill
    expect(done.nations.russia.pendingDroneDamage ?? 0).toBe(0);
  });

  it('damages every open city and levels nothing', () => {
    let s = arm(table(), 'us', ['cluster']);
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'cluster');
    const done = resolveAll(s);
    const n = done.nations.russia.cities.length;
    expect(done.nations.russia.pendingDroneDamage).toBe(n * CLUSTER_DAMAGE_OPEN);
    expect(done.nations.russia.cities.every((c) => !c.destroyed)).toBe(true);
    expect(kindsOf(done, 'droneDamage')).toHaveLength(n);
  });

  it('does not care about a laser battery: the bomblets are too many to shoot down', () => {
    let s = arm(table(), 'us', ['cluster']);
    s = withCity(s, 'russia', 0, { hasLaser: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[1].id, 'us', 'cluster');
    const done = resolveAll(s);
    expect(done.nations.russia.pendingDroneDamage).toBe(s.nations.russia.cities.length * CLUSTER_DAMAGE_OPEN);
  });

  it('goes in ahead of the warheads, so a nuke behind it finds the shield already gone', () => {
    let s = setup();
    s = { ...s, nations: { ...s.nations, uk: { ...s.nations.uk, bombs: 1, hasNuclearTech: true, nuclearTechUnlockedRound: 0 } } };
    // The nuke is queued after the canister, but would be first without the ordering rule
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'uk', 'nuke');
    const order = orderStrikesForResolution([...s.pendingStrikes].reverse());
    expect(order[0].weapon).toBe('cluster');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(true);
  });

  it('banks points for each shield torn down and each city damaged, not for a bunker that held', () => {
    const start = setup();
    const before = start.nations.us.attackPoints ?? 0;
    const done = resolveAll(start);
    expect((done.nations.us.attackPoints ?? 0) - before).toBe(2 * SCORE_LAB_HIT);
  });

  it('opens over the nation even when the marked city is already rubble', () => {
    let s = setup();
    s = withCity(s, 'russia', 2, { destroyed: true });
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].hasShield).toBe(false);
    expect(kindsOf(done, 'shieldDestroyed')).toHaveLength(1);
  });

  it('can be aimed through any city, including one in a bunker', () => {
    let s = arm(table(), 'us', ['cluster']);
    s = withCity(s, 'russia', 1, { isUnderground: true });
    const aimed = queueStrike(s, 'russia', s.nations.russia.cities[1].id, 'us', 'cluster');
    expect(aimed.pendingStrikes).toHaveLength(1);
  });
});

describe('chemical bomb', () => {
  it('destroys a city that is not underground', () => {
    let s = arm(table(), 'us', ['chemical']);
    s = withCity(s, 'russia', 0, { hasResearch: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'chemical');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(true);
    expect(done.roundEvents.map((e) => e.kind)).toContain('cityDestroyed');
    expect(done.nations.us.attackPoints ?? 0).toBeGreaterThan(0);
  });

  it('is held out by a bunker', () => {
    let s = arm(table(), 'us', ['chemical']);
    s = withCity(s, 'russia', 0, { isUnderground: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'chemical');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.roundEvents.map((e) => e.kind)).toContain('strikeAbsorbed');
  });

  it('is absorbed by a shield, which it destroys', () => {
    let s = arm(table(), 'us', ['chemical']);
    s = withCity(s, 'russia', 0, { hasShield: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'chemical');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.nations.russia.cities[0].hasShield).toBe(false);
    expect(done.roundEvents.map((e) => e.kind)).toContain('shieldDestroyed');
  });

  it('is shot down by a laser network', () => {
    let s = arm(table(), 'us', ['chemical']);
    s = withCity(s, 'russia', 1, { hasLaser: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'chemical');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.nations.russia.dronesInterceptedThisRound).toBe(1);
    const shot = done.roundEvents.find((e) => e.kind === 'warheadIntercepted');
    expect(shot?.weapon).toBe('chemical');
    expect(shot?.cityId).toBe(s.nations.russia.cities[0].id);
  });

  it('gets through a shield a drone swarm has tied up', () => {
    let s = arm(
      table({ us: { drones: 1, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 } }),
      'us',
      ['chemical'],
    );
    s = withCity(s, 'russia', 0, { hasShield: true });
    const id = s.nations.russia.cities[0].id;
    s = queueStrike(s, 'russia', id, 'us', 'drone');
    s = queueStrike(s, 'russia', id, 'us', 'chemical');
    expect(resolveAll(s).nations.russia.cities[0].destroyed).toBe(true);
  });
});

describe('biological bomb', () => {
  it('destroys a city even underground', () => {
    let s = arm(table(), 'us', ['biological']);
    s = withCity(s, 'russia', 0, { isUnderground: true });
    // Even a blind attacker may fire it at a bunker, and a seeing one too
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'biological');
    expect(s.pendingStrikes).toHaveLength(1);
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(true);
    expect(done.roundEvents.map((e) => e.kind)).toContain('cityDestroyed');
  });

  it('is destroyed by a shield, which it takes down with it', () => {
    let s = arm(table(), 'us', ['biological']);
    s = withCity(s, 'russia', 0, { hasShield: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'biological');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.nations.russia.cities[0].hasShield).toBe(false);
    expect(done.roundEvents.map((e) => e.kind)).toContain('shieldDestroyed');
  });

  it('is shot down by a laser network', () => {
    let s = arm(table(), 'us', ['biological']);
    s = withCity(s, 'russia', 0, { hasLaser: true, isUnderground: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'biological');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.roundEvents.map((e) => e.kind)).toContain('warheadIntercepted');
  });

  it('gets through a shield and a laser only with a magnetic bomb and a drone swarm', () => {
    const attacker = {
      hasNuclearTech: true,
      nuclearTechUnlockedRound: 0,
      magneticBombs: 1,
      hasAerospaceTech: true,
      aerospaceTechUnlockedRound: 0,
      drones: 1,
    };
    let s = arm(table({ us: attacker }), 'us', ['biological']);
    s = withCity(s, 'russia', 0, { hasShield: true, hasLaser: true });
    s = withCity(s, 'russia', 1, { isUnderground: true });
    const id = s.nations.russia.cities[0].id;

    // Alone it dies in the shield
    const alone = resolveAll(queueStrike(s, 'russia', id, 'us', 'biological'));
    expect(alone.nations.russia.cities[0].destroyed).toBe(false);

    // The magnetic bomb blacks out the laser, the swarm ties up the shield
    let full = queueStrike(s, 'russia', s.nations.russia.cities[1].id, 'us', 'magnetic');
    full = queueStrike(full, 'russia', id, 'us', 'drone');
    full = queueStrike(full, 'russia', id, 'us', 'biological');
    const done = resolveAll(full);
    expect(done.nations.russia.cities[0].destroyed).toBe(true);
    expect(done.roundEvents.map((e) => e.kind)).not.toContain('warheadIntercepted');
  });
});

describe('defence drones', () => {
  const bomber = { bombs: 1, hasNuclearTech: true, nuclearTechUnlockedRound: 0 };
  const guarded = (extra: Partial<Record<NationId, Partial<NationState>>> = {}) =>
    arm(table({ us: bomber, uk: bomber, ...extra }), 'russia', ['defenseDrones']);

  it('shoot the attack down in the sky, so the city is untouched', () => {
    let s = guarded();
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'nuke');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    const event = done.roundEvents.find((e) => e.kind === 'strikeNeutralized');
    expect(event?.cityId).toBe(s.nations.russia.cities[0].id);
    expect(event?.attackerId).toBe('us');
    expect(event?.weapon).toBe('nuke');
    expect(done.log.some((l) => /defence drones met/.test(l.text))).toBe(true);
    // The pack is spent: the next attack lands
    expect(defenseDroneStock(done.nations.russia)).toBe(0);
  });

  it('stand by through a quiet round and are used up only when a city is attacked', () => {
    let s = guarded();
    s = nextRound(nextRound(s));
    expect(defenseDroneStock(s.nations.russia)).toBe(1);
    expect(s.nations.russia.inventionsUsed?.defenseDrones ?? 0).toBe(0);
    // Round 3: the first attack finally comes
    s = {
      ...s,
      nations: { ...s.nations, us: { ...s.nations.us, ...bomber } },
    };
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'nuke');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(defenseDroneStock(done.nations.russia)).toBe(0);
  });

  it('guard one city: the first one attacked, however many strike it', () => {
    let s = guarded();
    const [first, second] = s.nations.russia.cities;
    s = queueStrike(s, 'russia', first.id, 'us', 'nuke');
    s = queueStrike(s, 'russia', first.id, 'uk', 'nuke');
    let done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.roundEvents.filter((e) => e.kind === 'strikeNeutralized')).toHaveLength(2);
    // Two attacks, one pack
    expect(done.nations.russia.inventionsUsed?.defenseDrones).toBe(1);

    // A second city attacked the same round is not covered
    s = guarded();
    s = queueStrike(s, 'russia', first.id, 'us', 'nuke');
    s = queueStrike(s, 'russia', second.id, 'uk', 'nuke');
    done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.nations.russia.cities[1].destroyed).toBe(true);
  });

  it('do nothing for a nation that has none', () => {
    let s = table({ us: bomber });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'nuke');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(true);
    expect(done.roundEvents.map((e) => e.kind)).not.toContain('strikeNeutralized');
  });

  it('meet a bomb meant for a bunker and a shielded city alike', () => {
    let s = guarded();
    s = withCity(s, 'russia', 0, { hasShield: true });
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'nuke');
    const done = resolveAll(s);
    // The shield was never touched: the drones met the missile first
    expect(done.nations.russia.cities[0].hasShield).toBe(true);
    expect(done.roundEvents.map((e) => e.kind)).not.toContain('shieldDestroyed');
  });

  it('shoot down a lab bomb, even a plague', () => {
    let s = arm(guarded(), 'us', ['biological']);
    s = queueStrike(s, 'russia', s.nations.russia.cities[0].id, 'us', 'biological');
    const done = resolveAll(s);
    expect(done.nations.russia.cities[0].destroyed).toBe(false);
    expect(done.roundEvents.find((e) => e.kind === 'strikeNeutralized')?.weapon).toBe('biological');
  });

  it('shoot down a drone swarm and turn a Heliborne squad back', () => {
    const air = { hasAerospaceTech: true, aerospaceTechUnlockedRound: 0, drones: 1, commandos: 1 };
    let s = guarded({ us: air });
    const id = s.nations.russia.cities[0].id;
    s = queueStrike(s, 'russia', id, 'us', 'drone');
    s = queueStrike(s, 'russia', id, 'us', 'commando');
    const done = resolveAll(s);
    expect(done.nations.russia.cities.some((c) => c.id === id)).toBe(true);
    expect(done.nations.russia.pendingDroneDamage ?? 0).toBe(0);
    expect(done.roundEvents.filter((e) => e.kind === 'strikeNeutralized')).toHaveLength(2);
  });

  it('save only the marked city from a cluster bomb: the rest of the nation is still billed', () => {
    let s = arm(guarded(), 'us', ['cluster']);
    const [mark] = s.nations.russia.cities;
    s = queueStrike(s, 'russia', mark.id, 'us', 'cluster');
    const done = resolveAll(s);
    const rest = done.nations.russia.cities.length - 1;
    // Every other city is still hit: here the open ones are billed
    expect(done.nations.russia.pendingDroneDamage ?? 0).toBeGreaterThan(0);
    expect(done.nations.russia.pendingDroneDamage ?? 0).toBeLessThanOrEqual(rest * CLUSTER_DAMAGE_OPEN);
    expect(done.roundEvents.some((e) => e.kind === 'droneDamage' && e.cityId === mark.id)).toBe(false);
    expect(done.roundEvents.some((e) => e.kind === 'strikeNeutralized' && e.cityId === mark.id)).toBe(true);
  });
});

describe('lab upkeep', () => {
  it('bills every standing lab each round, so the bomb is not free', () => {
    let s = table({ us: { money: 100 } });
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    const before = s.nations.us.money;
    s = nextRound(s); // round 2
    const entry = s.lastIncomeLedger.find((e) => e.nationId === 'us');
    expect(entry?.researchUpkeep).toBe(RESEARCH_UPKEEP);
    expect(s.nations.us.money).toBe(before + (entry?.revenue ?? 0) - RESEARCH_UPKEEP);
    expect(RESEARCH_UPKEEP).toBe(5);
  });

  it('charges nothing without a lab', () => {
    const s = nextRound(table());
    expect(s.lastIncomeLedger.find((e) => e.nationId === 'us')?.researchUpkeep).toBe(0);
  });

  it('lets a razed lab stop costing money while its clock pauses', () => {
    let s = table();
    s = buyResearch(s, s.nations.us.cities[0].id, 'us');
    s = withCity(s, 'us', 0, { destroyed: true });
    s = nextRound(s);
    expect(s.lastIncomeLedger.find((e) => e.nationId === 'us')?.researchUpkeep).toBe(0);
    expect(s.nations.us.labRounds ?? 0).toBe(0);
  });
});

describe('online merge of the labs', () => {
  it('keeps the longer list of inventions and the larger used counts', () => {
    const base = table().nations.us;
    const a: NationState = { ...base, labRounds: 3, inventions: ['cluster'], inventionRound: 4 };
    const b: NationState = {
      ...base,
      labRounds: 3,
      inventions: ['cluster'],
      inventionsUsed: { cluster: 1 },
      inventionRound: 4,
    };
    const merged = mergeNationPlanning(a, b);
    expect(merged.inventions).toEqual(['cluster']);
    expect(merged.inventionsUsed?.cluster).toBe(1);
    expect(merged.labRounds).toBe(3);
    // A stale snapshot from before the invention cannot take it back
    const stale: NationState = { ...base, labRounds: 2 };
    const kept = mergeNationPlanning(stale, a);
    expect(kept.inventions).toEqual(['cluster']);
    expect(kept.labRounds).toBe(3);
    expect(inventionStock(kept, 'cluster')).toBe(1);
  });
});

describe('AI with a lab bomb', () => {
  it('puts it to use', () => {
    for (const kind of ['cluster', 'biological', 'chemical'] as const) {
      let s = table({ uk: { money: 0 } });
      s = arm(s, 'uk', [kind]);
      s = runAiNationTurn({ ...s, phase: 'buy' }, 'uk');
      expect(s.pendingStrikes.some((p) => p.attackerId === 'uk' && p.weapon === kind)).toBe(true);
    }
  });
});
