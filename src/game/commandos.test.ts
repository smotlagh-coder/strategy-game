import { describe, expect, it } from 'vitest';
import {
  COSTS,
  MAX_COMMANDOS_PER_ROUND,
  SCORE_CAPTURE,
  SCORE_CAPTURE_CLEAN,
  SCORE_KILL,
  SCORE_RESEARCH,
} from '../data/nations';
import {
  applyQueuedStrike,
  applyIncome,
  buyAerospaceTech,
  buyCommandos,
  canBuyCommandos,
  commandoStock,
  computeScore,
  createInitialState,
  finishStrikeResolution,
  maxCommandosPurchasable,
  nextRound,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  startGame,
} from './engine';
import { buyCommandosBundled, maxCommandosBundled } from './bundles';
import { mergeCommandoStock, mergeNationPlanning } from '../lib/onlineSync';
import type { City, GameState, NationId, NationState } from '../types';

type Patch = Partial<NationState>;

/** Us (squad, drones, warheads) against UK, two cities of each side in play. */
function table(us: Patch = {}, uk: Patch = {}): GameState {
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
        money: 300,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 0,
        hasNuclearTech: true,
        nuclearTechUnlockedRound: 0,
        commandos: 1,
        drones: 3,
        bombs: 2,
        hydrogenBombs: 1,
        hydrogenBought: 1,
        magneticBombs: 1,
        magneticBought: 1,
        hasSpyNetwork: true,
        ...us,
      },
      uk: { ...base.nations.uk, money: 300, ...uk },
    },
  });
}

function patchCity(state: GameState, nation: NationId, index: number, patch: Partial<City>): GameState {
  const n = state.nations[nation];
  return {
    ...state,
    nations: {
      ...state.nations,
      [nation]: {
        ...n,
        cities: n.cities.map((c, i) => (i === index ? { ...c, ...patch } : c)),
      },
    },
  };
}

function resolveAll(state: GameState): GameState {
  let s = state;
  for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
    s = applyQueuedStrike(s, strike);
  }
  return s;
}

const ukCity = (s: GameState, i = 0) => s.nations.uk.cities[i];

describe('Heliborne economy', () => {
  it('costs $45M, more than a nuke and less than the hydrogen bomb', () => {
    expect(COSTS.commando).toBe(45);
    expect(COSTS.commando).toBeGreaterThan(COSTS.bomb);
    expect(COSTS.commando).toBeLessThan(COSTS.bombHydrogen);
  });

  it('needs Aerospace Tech, like the helicopters it flies in', () => {
    let s = table({ hasAerospaceTech: false, aerospaceTechUnlockedRound: null, commandos: 0 });
    expect(canBuyCommandos(s, 'us')).toBe(false);
    expect(buyCommandos(s, 1, 'us').nations.us.commandos).toBe(0);
    s = buyAerospaceTech(s, 'us');
    expect(canBuyCommandos(s, 'us')).toBe(true);
    expect(buyCommandos(s, 1, 'us').nations.us.commandos).toBe(1);
  });

  it('bundles the tech into the first squad', () => {
    const s = table({ hasAerospaceTech: false, aerospaceTechUnlockedRound: null, commandos: 0, money: 100 });
    expect(maxCommandosBundled(s, 'us')).toBe(1);
    const bought = buyCommandosBundled(s, 1, 'us');
    expect(bought.nations.us.commandos).toBe(1);
    expect(bought.nations.us.money).toBe(100 - COSTS.aerospaceTech - COSTS.commando);
    expect(maxCommandosBundled({ ...s, nations: { ...s.nations, us: { ...s.nations.us, money: 60 } } }, 'us')).toBe(0);
  });

  it('allows one squad a round and resets with the round', () => {
    const s = table({ commandos: 0 });
    expect(maxCommandosPurchasable(s, 'us')).toBe(MAX_COMMANDOS_PER_ROUND);
    const bought = buyCommandos(s, 5, 'us');
    expect(bought.nations.us.commandos).toBe(MAX_COMMANDOS_PER_ROUND);
    expect(bought.nations.us.money).toBe(300 - COSTS.commando);
    expect(maxCommandosPurchasable(bought, 'us')).toBe(0);
    const next = nextRound({ ...bought, phase: 'roundSummary' });
    expect(commandoStock(next.nations.us)).toBe(1);
    expect(maxCommandosPurchasable(next, 'us')).toBe(1);
  });
});

describe('taking a city over', () => {
  it('moves an undefended city to the attacker, defences stripped', () => {
    let s = patchCity(table(), 'uk', 0, { hasResearch: true });
    s = { ...s, nations: { ...s.nations, uk: { ...s.nations.uk, researchCenters: 1 } } };
    const target = ukCity(s);
    const ukBefore = s.nations.uk.cities.length;
    const usBefore = s.nations.us.cities.length;
    s = queueStrike(s, 'uk', target.id, 'us', 'commando');
    expect(commandoStock(s.nations.us)).toBe(0);
    expect(s.pendingStrikes).toHaveLength(1);

    s = resolveAll(s);
    expect(s.nations.uk.cities).toHaveLength(ukBefore - 1);
    expect(s.nations.uk.cities.some((c) => c.id === target.id)).toBe(false);
    expect(s.nations.us.cities).toHaveLength(usBefore + 1);
    const taken = s.nations.us.cities.find((c) => c.id === target.id)!;
    expect(taken.destroyed).toBe(false);
    expect(taken.originId).toBe('uk');
    expect(taken.capturedRound).toBe(s.round);
    expect(taken.hasShield).toBe(false);
    // The lab comes with the city
    expect(taken.hasResearch).toBe(true);
    expect(s.nations.us.researchCenters).toBe(1);
    expect(s.nations.uk.researchCenters).toBe(0);
    const event = s.roundEvents.find((e) => e.kind === 'cityCaptured')!;
    expect(event).toMatchObject({ nationId: 'uk', attackerId: 'us', cityId: target.id });
  });

  it('counts the city for its new owner: income and score swing', () => {
    let s = table();
    const target = ukCity(s);
    const before = {
      us: computeScore(s, 'us').total,
      uk: computeScore(s, 'uk').total,
    };
    s = queueStrike(s, 'uk', target.id, 'us', 'commando');
    s = resolveAll(s);
    expect(computeScore(s, 'us').total).toBeGreaterThan(before.us);
    expect(computeScore(s, 'uk').total).toBeLessThan(before.uk);
    // Next round's income follows the cities
    const usCities = s.nations.us.cities.filter((c) => !c.destroyed).length;
    const ukCities = s.nations.uk.cities.filter((c) => !c.destroyed).length;
    const next = applyIncome({ ...s, round: s.round + 1 });
    const gain = (id: NationId, before: number) => next.nations[id].money - before;
    expect(gain('us', s.nations.us.money)).toBeGreaterThan(gain('uk', s.nations.uk.money));
    expect(usCities).toBeGreaterThan(ukCities);
  });

  it('is not a kill: no destroyed city, and the bonus is the conquest bonus', () => {
    let s = table();
    const pointsBefore = s.nations.us.attackPoints;
    s = queueStrike(s, 'uk', ukCity(s).id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.roundEvents.some((e) => e.kind === 'cityDestroyed')).toBe(false);
    const gained = s.nations.us.attackPoints - pointsBefore;
    expect(gained).toBe(SCORE_CAPTURE + SCORE_CAPTURE_CLEAN);
    expect(s.roundEvents.find((e) => e.kind === 'cityCaptured')).toMatchObject({
      points: gained,
      clean: true,
    });
  });

  it('pays more for a clean takeover of a research city than a razed one is worth', () => {
    let s = patchCity(table(), 'uk', 0, { hasResearch: true });
    const before = s.nations.us.attackPoints;
    s = queueStrike(s, 'uk', ukCity(s).id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.nations.us.attackPoints - before).toBe(
      SCORE_CAPTURE + SCORE_CAPTURE_CLEAN + SCORE_RESEARCH,
    );
    expect(SCORE_CAPTURE + SCORE_CAPTURE_CLEAN + SCORE_RESEARCH).toBeGreaterThan(SCORE_KILL);
  });

  it('pays the base bonus only when a warhead was part of the operation', () => {
    let s = patchCity(table(), 'uk', 0, { hasShield: true, hasResearch: true });
    const before = s.nations.us.attackPoints;
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'nuke');
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.roundEvents.find((e) => e.kind === 'cityCaptured')?.clean).toBeUndefined();
    expect(s.nations.us.attackPoints - before).toBe(SCORE_CAPTURE);
  });

  it('counts drones as clean: a swarm that opens a shield costs the bonus nothing', () => {
    let s = patchCity(table(), 'uk', 0, { hasShield: true });
    const before = s.nations.us.attackPoints;
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'drone');
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.nations.us.attackPoints - before).toBe(SCORE_CAPTURE + SCORE_CAPTURE_CLEAN);
  });

  it('pays a founder taking its own city home the base bonus only', () => {
    let s = table();
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    // UK answers with a squad of its own at the city it lost
    s = {
      ...s,
      nations: { ...s.nations, uk: { ...s.nations.uk, commandos: 1, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 } },
      pendingStrikes: [],
    };
    const before = s.nations.uk.attackPoints ?? 0;
    s = queueStrike(s, 'us', id, 'uk', 'commando');
    s = resolveAll(s);
    expect(s.nations.uk.cities.some((c) => c.id === id)).toBe(true);
    expect((s.nations.uk.attackPoints ?? 0) - before).toBe(SCORE_CAPTURE);
  });

  it('is resolved after every drone and warhead', () => {
    const order = orderStrikesForResolution([
      { attackerId: 'us', targetNationId: 'uk', cityId: 'a', weapon: 'commando' },
      { attackerId: 'us', targetNationId: 'uk', cityId: 'a', weapon: 'nuke' },
      { attackerId: 'us', targetNationId: 'uk', cityId: 'a', weapon: 'drone' },
    ]);
    expect(order.map((o) => o.weapon)).toEqual(['drone', 'nuke', 'commando']);
  });

  it('holds when the target is an ally', () => {
    let s = { ...table(), round: 2 };
    const target = ukCity(s);
    s = queueStrike(s, 'uk', target.id, 'us', 'commando');
    // A pact struck after the order was given still holds the squad
    s = {
      ...s,
      nations: {
        ...s.nations,
        us: { ...s.nations.us, alliance: { with: 'uk', proposalId: 1, declined: {}, version: 1 } },
        uk: { ...s.nations.uk, alliance: { with: 'us', proposalId: 1, declined: {}, version: 1 } },
      },
    };
    s = resolveAll(s);
    expect(s.nations.uk.cities.some((c) => c.id === target.id)).toBe(true);
  });

  it('cannot be queued without a squad in stock, or twice on one city', () => {
    const none = table({ commandos: 0 });
    expect(queueStrike(none, 'uk', ukCity(none).id, 'us', 'commando')).toBe(none);

    const two = table({ commandos: 2 });
    const once = queueStrike(two, 'uk', ukCity(two).id, 'us', 'commando');
    expect(once.pendingStrikes).toHaveLength(1);
    expect(queueStrike(once, 'uk', ukCity(two).id, 'us', 'commando')).toBe(once);
  });
});

describe('what stops the squad, and what clears the way', () => {
  it('is turned back by a shield flying alone', () => {
    let s = patchCity(table(), 'uk', 0, { hasShield: true });
    s = queueStrike(s, 'uk', ukCity(s).id, 'us', 'commando');
    s = resolveAll(s);
    expect(ukCity(s).hasShield).toBe(true);
    expect(s.nations.us.cities.some((c) => c.originId)).toBe(false);
    expect(s.roundEvents.find((e) => e.kind === 'raidRepelled')?.cover).toBe('shield');
    // The squad was spent either way
    expect(commandoStock(s.nations.us)).toBe(0);
  });

  it('gets through a shield a drone swarm is tying up', () => {
    let s = patchCity(table(), 'uk', 0, { hasShield: true });
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'drone');
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.nations.us.cities.find((c) => c.id === id)).toBeDefined();
    expect(s.roundEvents.some((e) => e.kind === 'cityCaptured')).toBe(true);
  });

  it('gets through a shield a nuclear warhead stripped, and the city is spared', () => {
    let s = patchCity(table(), 'uk', 0, { hasShield: true });
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'nuke');
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    const taken = s.nations.us.cities.find((c) => c.id === id)!;
    expect(taken).toBeDefined();
    expect(taken.destroyed).toBe(false);
    expect(s.roundEvents.map((e) => e.kind)).toEqual(['shieldDestroyed', 'cityCaptured']);
  });

  it('wastes the squad on a city a nuke already levelled', () => {
    let s = table();
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'nuke');
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.nations.uk.cities.find((c) => c.id === id)!.destroyed).toBe(true);
    expect(s.nations.us.cities.some((c) => c.id === id)).toBe(false);
  });

  it('is sealed out by a bunker, which the whole table then sees', () => {
    let s = patchCity(table(), 'uk', 0, { isUnderground: true });
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    expect(ukCity(s).isUnderground).toBe(true);
    expect(s.roundEvents.find((e) => e.kind === 'raidRepelled')?.cover).toBe('bunker');
  });

  it('takes a bunker city after a hydrogen bomb opens it — without destroying it', () => {
    let s = patchCity(table(), 'uk', 0, { isUnderground: true, hasShield: false });
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'hydrogen');
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    const taken = s.nations.us.cities.find((c) => c.id === id)!;
    expect(taken).toBeDefined();
    expect(taken.destroyed).toBe(false);
    expect(taken.isUnderground).toBe(false);
    expect(s.roundEvents.some((e) => e.kind === 'cityDestroyed')).toBe(false);
  });

  it('still levels the city when the hydrogen bomb flies without a squad', () => {
    let s = patchCity(table(), 'uk', 0, { isUnderground: true });
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'hydrogen');
    s = resolveAll(s);
    expect(s.nations.uk.cities.find((c) => c.id === id)!.destroyed).toBe(true);
  });

  it('is shot down by the laser network', () => {
    let s = patchCity(table(), 'uk', 0, { hasLaser: true });
    s = queueStrike(s, 'uk', ukCity(s, 1).id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.roundEvents.find((e) => e.kind === 'raidRepelled')?.cover).toBe('laser');
    expect(s.nations.uk.cities).toHaveLength(createInitialState().nations.uk.cities.length);
    expect(s.nations.uk.dronesInterceptedThisRound).toBe(1);
  });

  it('slips past lasers once decoy swarms have used up their shots', () => {
    let s = patchCity(table(), 'uk', 0, { hasLaser: true });
    const [a, b, c] = s.nations.uk.cities;
    s = queueStrike(s, 'uk', a.id, 'us', 'drone');
    s = queueStrike(s, 'uk', b.id, 'us', 'drone');
    s = queueStrike(s, 'uk', c.id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.roundEvents.filter((e) => e.kind === 'dronesIntercepted')).toHaveLength(2);
    expect(s.nations.us.cities.some((x) => x.id === c.id)).toBe(true);
  });

  it('flies under a laser network a magnetic bomb darkened', () => {
    let s = patchCity(table(), 'uk', 0, { hasLaser: true });
    const [a, , c] = s.nations.uk.cities;
    // The magnetic warhead hits one city; the whole network goes dark
    s = queueStrike(s, 'uk', a.id, 'us', 'magnetic');
    s = queueStrike(s, 'uk', c.id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.roundEvents.some((e) => e.kind === 'raidRepelled')).toBe(false);
    expect(s.nations.us.cities.some((x) => x.id === c.id)).toBe(true);
  });
});

describe('taking a city back', () => {
  /** UK lost city 0 to the US; now the UK has a squad of its own. */
  function occupied(ukSquad = 1) {
    let s = table({}, { commandos: ukSquad, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 });
    const id = ukCity(s).id;
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    s = nextRound({ ...finishStrikeResolution(s) });
    return { s, id };
  }

  it('returns the city to its founder and clears the held mark', () => {
    let { s, id } = occupied();
    s = queueStrike(s, 'us', id, 'uk', 'commando');
    expect(s.pendingStrikes).toHaveLength(1);
    s = resolveAll(s);
    const home = s.nations.uk.cities.find((c) => c.id === id)!;
    expect(home).toBeDefined();
    expect(home.originId).toBeUndefined();
    expect(s.nations.us.cities.some((c) => c.id === id)).toBe(false);
  });

  it('can be fortified by its new owner to hold it', () => {
    let { s, id } = occupied();
    s = patchCity(s, 'us', s.nations.us.cities.findIndex((c) => c.id === id), { hasShield: true });
    s = queueStrike(s, 'us', id, 'uk', 'commando');
    s = resolveAll(s);
    expect(s.nations.us.cities.some((c) => c.id === id)).toBe(true);
  });

  it('keeps the founder when a third nation takes the city', () => {
    const base = createInitialState();
    let s = startGame({
      ...base,
      mode: 'two',
      turnOrder: seatTable(['us', 'uk', 'france']),
      humanNations: ['us'],
      nations: {
        ...base.nations,
        us: { ...base.nations.us, isHuman: true, money: 300, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0, commandos: 1 },
        uk: { ...base.nations.uk, money: 300 },
        france: { ...base.nations.france, money: 300, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0, commandos: 1 },
      },
    });
    const id = s.nations.uk.cities[0].id;
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    s = queueStrike(s, 'us', id, 'france', 'commando');
    s = resolveAll(s);
    const held = s.nations.france.cities.find((c) => c.id === id)!;
    expect(held.originId).toBe('uk');
    expect(s.nations.us.cities.some((c) => c.id === id)).toBe(false);
  });

  it('lets the second squad find nothing when the first already took the city', () => {
    const base = createInitialState();
    let s = startGame({
      ...base,
      mode: 'two',
      turnOrder: seatTable(['us', 'uk', 'france']),
      humanNations: ['us'],
      nations: {
        ...base.nations,
        us: { ...base.nations.us, isHuman: true, money: 300, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0, commandos: 1 },
        uk: { ...base.nations.uk, money: 300 },
        france: { ...base.nations.france, money: 300, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0, commandos: 1 },
      },
    });
    const id = s.nations.uk.cities[0].id;
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = queueStrike(s, 'uk', id, 'france', 'commando');
    s = resolveAll(s);
    expect(s.nations.us.cities.some((c) => c.id === id)).toBe(true);
    expect(s.nations.france.cities.some((c) => c.id === id)).toBe(false);
    expect(s.roundEvents.filter((e) => e.kind === 'cityCaptured')).toHaveLength(1);
  });
});

describe('a nation that lost every city to the squad', () => {
  /** UK owns a single standing city; everything else is rubble. */
  function lastCity(ukPatch: Patch = {}): GameState {
    let s = table({}, ukPatch);
    s = {
      ...s,
      nations: {
        ...s.nations,
        uk: {
          ...s.nations.uk,
          cities: s.nations.uk.cities.map((c, i) => (i === 0 ? c : { ...c, destroyed: true })),
        },
      },
    };
    return s;
  }

  it('is out when it cannot send a squad of its own', () => {
    let s = lastCity({ money: 0 });
    s = queueStrike(s, 'uk', s.nations.uk.cities[0].id, 'us', 'commando');
    s = finishStrikeResolution(resolveAll(s));
    expect(s.nations.uk.eliminated).toBe(true);
    expect(s.roundEvents.some((e) => e.kind === 'nationEliminated')).toBe(true);
  });

  it('stays in the fight while its squad can win a city back', () => {
    let s = lastCity({ commandos: 1, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 });
    s = queueStrike(s, 'uk', s.nations.uk.cities[0].id, 'us', 'commando');
    s = finishStrikeResolution(resolveAll(s));
    expect(s.nations.uk.eliminated).toBe(false);
    expect(s.nations.uk.cities.filter((c) => !c.destroyed)).toHaveLength(0);
    // It does not burn its last cash on an automatic rebuild either
    expect(s.nations.uk.emergencyRebuildsUsed ?? 0).toBe(0);
  });

  it('retakes a city in the same round and is whole again', () => {
    // UK's order was given before the loss: it targets the city the US just took
    const base = lastCity({ commandos: 1, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 });
    const id = base.nations.uk.cities[0].id;
    let s = queueStrike(base, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    expect(s.nations.us.cities.some((c) => c.id === id)).toBe(true);
    // Next round the UK sends the squad it kept
    s = nextRound(finishStrikeResolution(s));
    expect(s.nations.uk.eliminated).toBe(false);
    s = queueStrike(s, 'us', id, 'uk', 'commando');
    s = finishStrikeResolution(resolveAll(s));
    expect(s.nations.uk.cities.find((c) => c.id === id)?.destroyed).toBe(false);
    expect(s.nations.uk.eliminated).toBe(false);
  });

  it('is out once the squad is spent and the city is not won back', () => {
    // The one automatic rebuild is already spent, so nothing else can save the nation
    let s = lastCity({
      commandos: 1,
      hasAerospaceTech: true,
      aerospaceTechUnlockedRound: 0,
      emergencyRebuildsUsed: 1,
    });
    const id = s.nations.uk.cities[0].id;
    s = queueStrike(s, 'uk', id, 'us', 'commando');
    s = resolveAll(s);
    s = nextRound(finishStrikeResolution(s));
    // The occupier digs in, the squad is turned back, and the nation is out
    s = patchCity(s, 'us', s.nations.us.cities.findIndex((c) => c.id === id), { hasShield: true });
    s = queueStrike(s, 'us', id, 'uk', 'commando');
    s = finishStrikeResolution(resolveAll(s));
    expect(s.nations.uk.eliminated).toBe(true);
  });
});

describe('online merge', () => {
  it('rebuilds the squad stock from the monotonic counters', () => {
    const base = createInitialState().nations.us;
    const bought: NationState = { ...base, commandos: 1, commandosBoughtThisRound: 1, commandosUsed: 0 };
    const fired: NationState = { ...base, commandos: 0, commandosBoughtThisRound: 1, commandosUsed: 1 };
    expect(mergeCommandoStock(bought, fired)).toBe(0);
    expect(mergeCommandoStock(fired, bought)).toBe(0);
    expect(mergeCommandoStock(bought, bought)).toBe(1);
  });

  it('keeps a nation with no cities alive while it holds a squad', () => {
    const base = createInitialState().nations.uk;
    const landless: NationState = { ...base, cities: [], commandos: 1 };
    expect(mergeNationPlanning(landless, landless).eliminated).toBe(false);
    const dead: NationState = { ...base, cities: [], commandos: 0 };
    expect(mergeNationPlanning(dead, dead).eliminated).toBe(true);
  });

  it('takes the city list from the further snapshot, so a capture is not undone by a stale one', () => {
    const base = createInitialState();
    const before: GameState = table();
    const after = resolveAll(queueStrike(before, 'uk', ukCity(before).id, 'us', 'commando'));
    const merged = mergeNationPlanning(after.nations.us, before.nations.us);
    expect(merged.cities.some((c) => c.id === ukCity(before).id && c.originId === 'uk')).toBe(true);
    const owner = mergeNationPlanning(after.nations.uk, before.nations.uk);
    expect(owner.cities.some((c) => c.id === ukCity(before).id)).toBe(false);
    expect(base).toBeDefined();
  });
});
