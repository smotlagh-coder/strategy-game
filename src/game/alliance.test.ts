import { describe, expect, it } from 'vitest';
import { COSTS, MAX_SANCTIONS } from '../data/nations';
import {
  acceptAlliance,
  allianceWindowOpen,
  allyOf,
  areAllies,
  declineAlliance,
  effectiveSanctions,
  hasAerospaceAccess,
  hasBallisticTech,
  hasSpyService,
  incomingInvites,
  inviteBlockedReason,
  leaveAlliance,
  outgoingInvite,
  proposeAlliance,
  setTechSharing,
} from './alliance';
import {
  applyIncome,
  applyQueuedStrike,
  buyLaser,
  canBuyBombs,
  canBuySpyNetwork,
  createInitialState,
  laserCoverFor,
  laserShotsKnownTo,
  orderStrikesForResolution,
  queueStrike,
  sanctionsLeft,
  seatTable,
  seesCity,
  startGame,
  toggleSanction,
  whoIsSanctioning,
} from './engine';
import { ballisticBundleCost, buyBombsBundled } from './bundles';
import { mergeNationPlanning } from '../lib/onlineSync';
import type { GameState, NationId, NationState } from '../types';

/** us + uk are the two human players, ru + fr are rivals. Round 2 of a six-round game. */
function table(
  overrides: Partial<Record<NationId, Partial<NationState>>> = {},
  round = 2,
): GameState {
  const base = createInitialState();
  const ids: NationId[] = ['us', 'uk', 'russia', 'france'];
  const nations = { ...base.nations };
  for (const id of ids) {
    nations[id] = {
      ...base.nations[id],
      isHuman: id === 'us' || id === 'uk',
      money: 300,
      ...(overrides[id] ?? {}),
    };
  }
  const started = startGame({
    ...base,
    mode: 'two',
    turnOrder: seatTable(ids, { size: 4 }),
    humanNations: ['us', 'uk'],
    nations,
  });
  return { ...started, round, maxRounds: 6 };
}

const allied = (s = table()): GameState => acceptAlliance(proposeAlliance(s, 'uk', 'us'), 'us', 'uk');

function resolveAll(state: GameState): GameState {
  let s = state;
  for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
    s = applyQueuedStrike(s, strike);
  }
  return s;
}

describe('alliance window', () => {
  it('opens after round 1 and closes for the final round', () => {
    expect(allianceWindowOpen(table({}, 1))).toBe(false);
    expect(allianceWindowOpen(table({}, 2))).toBe(true);
    expect(allianceWindowOpen(table({}, 5))).toBe(true);
    expect(allianceWindowOpen(table({}, 6))).toBe(false);
    expect(inviteBlockedReason(table({}, 1), 'us', 'uk')).toMatch(/round 1/);
  });

  it('ends the pact when the last round arrives', () => {
    const s = allied(table({}, 5));
    expect(allyOf(s, 'us')).toBe('uk');
    expect(allyOf({ ...s, round: 6 }, 'us')).toBeNull();
  });

  it('cannot be proposed in round 1', () => {
    const s = proposeAlliance(table({}, 1), 'uk', 'us');
    expect(outgoingInvite(s, 'us')).toBeNull();
    expect(s.nations.us.alliance).toBeUndefined();
  });
});

describe('invitations', () => {
  it('needs the other side to accept', () => {
    const s = proposeAlliance(table(), 'uk', 'us');
    expect(allyOf(s, 'us')).toBeNull();
    expect(incomingInvites(s, 'uk')).toEqual(['us']);
    expect(outgoingInvite(s, 'us')).toEqual({ to: 'uk', declined: false });

    const done = acceptAlliance(s, 'us', 'uk');
    expect(allyOf(done, 'us')).toBe('uk');
    expect(allyOf(done, 'uk')).toBe('us');
    expect(incomingInvites(done, 'uk')).toEqual([]);
  });

  it('can be declined, and offered again', () => {
    let s = proposeAlliance(table(), 'uk', 'us');
    s = declineAlliance(s, 'us', 'uk');
    expect(incomingInvites(s, 'uk')).toEqual([]);
    expect(outgoingInvite(s, 'us')).toEqual({ to: 'uk', declined: true });
    expect(allyOf(s, 'us')).toBeNull();

    s = proposeAlliance(s, 'uk', 'us');
    expect(incomingInvites(s, 'uk')).toEqual(['us']);
    expect(outgoingInvite(s, 'us')?.declined).toBe(false);
  });

  it('never involves AI nations', () => {
    const s = proposeAlliance(table(), 'russia', 'us');
    expect(outgoingInvite(s, 'us')).toBeNull();
    expect(inviteBlockedReason(table(), 'russia', 'us')).not.toBeNull();
  });

  it('holds at most two players: a taken nation cannot be invited', () => {
    const base = table();
    const three = {
      ...base,
      nations: { ...base.nations, france: { ...base.nations.france, isHuman: true } },
    };
    const s = allied(three);
    expect(inviteBlockedReason(s, 'france', 'us')).toBe('Already allied');
    expect(inviteBlockedReason(s, 'us', 'france')).toBe('You already have an ally');
  });

  it('treats inviting someone who invited you as a yes', () => {
    const s = proposeAlliance(proposeAlliance(table(), 'uk', 'us'), 'us', 'uk');
    expect(allyOf(s, 'us')).toBe('uk');
  });

  it('lets either side leave in any round', () => {
    const s = allied();
    const left = leaveAlliance(s, 'uk');
    expect(allyOf(left, 'us')).toBeNull();
    expect(allyOf(left, 'uk')).toBeNull();
    // and a fresh pact is possible later
    expect(allyOf(acceptAlliance(proposeAlliance(left, 'us', 'uk'), 'uk', 'us'), 'us')).toBe('uk');
  });

  it('dissolves when a partner drops out of the game', () => {
    const s = allied();
    const dropped = { ...s, nations: { ...s.nations, uk: { ...s.nations.uk, isHuman: false } } };
    expect(allyOf(dropped, 'us')).toBeNull();
  });
});

describe('no friendly fire', () => {
  it('refuses strikes between allies, drones and bombs alike', () => {
    const s = table({
      us: { drones: 2, bombs: 2, hasNuclearTech: true, nuclearTechUnlockedRound: 0, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 },
    });
    const pact = allied(s);
    const city = pact.nations.uk.cities[0].id;
    expect(queueStrike(pact, 'uk', city, 'us', 'drone')).toBe(pact);
    expect(queueStrike(pact, 'uk', city, 'us', 'nuke')).toBe(pact);
    // outsiders are still fair game
    const rival = pact.nations.russia.cities[0].id;
    expect(queueStrike(pact, 'russia', rival, 'us', 'nuke')).not.toBe(pact);
  });

  it('holds fire on an order given before the pact was struck', () => {
    const s = table({
      us: { bombs: 1, hasNuclearTech: true, nuclearTechUnlockedRound: 0 },
    });
    const queued = queueStrike(s, 'uk', s.nations.uk.cities[0].id, 'us', 'nuke');
    const pact = allied(queued);
    const after = resolveAll(pact);
    expect(after.nations.uk.cities[0].destroyed).toBeFalsy();
  });
});

describe('laser cover', () => {
  const lasered = (): GameState => {
    const s = table({
      us: { hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 },
      russia: { drones: 5, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 },
    });
    return buyLaser(s, s.nations.us.cities[0].id, 'us');
  };

  it('lets a laser network defend the ally too', () => {
    const s = allied(lasered());
    expect(laserCoverFor(s, 'uk')).toBe('us');
    let strike = queueStrike(s, 'uk', s.nations.uk.cities[0].id, 'russia', 'drone');
    strike = resolveAll(strike);
    expect(strike.nations.uk.pendingDroneDamage ?? 0).toBe(0);
    expect(strike.nations.us.dronesInterceptedThisRound).toBe(1);
    const event = strike.roundEvents.find((e) => e.kind === 'dronesIntercepted');
    expect(event?.nationId).toBe('uk');
    expect(event?.coveredBy).toBe('us');
  });

  it('gives no cover without a pact', () => {
    const s = lasered();
    expect(laserCoverFor(s, 'uk')).toBeNull();
    const hit = resolveAll(queueStrike(s, 'uk', s.nations.uk.cities[0].id, 'russia', 'drone'));
    expect(hit.nations.uk.pendingDroneDamage ?? 0).toBeGreaterThan(0);
  });

  it('uses the nation’s own network first, then the ally’s', () => {
    let s = allied(lasered());
    s = buyLaser(
      { ...s, nations: { ...s.nations, uk: { ...s.nations.uk, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 } } },
      s.nations.uk.cities[0].id,
      'uk',
    );
    expect(laserCoverFor(s, 'uk')).toBe('uk');
    s = { ...s, nations: { ...s.nations, uk: { ...s.nations.uk, dronesInterceptedThisRound: 2 } } };
    expect(laserCoverFor(s, 'uk')).toBe('us');
  });

  it('counts the ally’s shots in what an attacker can plan on', () => {
    const s = allied({ ...lasered() });
    const spied = { ...s, nations: { ...s.nations, russia: { ...s.nations.russia, hasSpyNetwork: true } } };
    expect(laserShotsKnownTo(spied, 'russia', 'uk')).toBeGreaterThan(0);
    expect(laserShotsKnownTo(spied, 'russia', 'france')).toBe(0);
  });
});

describe('shared spy service', () => {
  it('gives the ally the network for free', () => {
    const s = allied(table({ us: { hasSpyNetwork: true } }));
    expect(hasSpyService(s, 'uk')).toBe(true);
    expect(canBuySpyNetwork(s, 'uk')).toBe(false);
    expect(seesCity(s, 'uk', 'russia', s.nations.russia.cities[0].id)).toBe(true);
  });

  it('is gone with the pact', () => {
    const s = leaveAlliance(allied(table({ us: { hasSpyNetwork: true } })), 'us');
    expect(hasSpyService(s, 'uk')).toBe(false);
    expect(canBuySpyNetwork(s, 'uk')).toBe(true);
  });

  it('shares what swarms uncovered', () => {
    const s = allied(table({ us: { scoutedCities: ['london'] } }));
    expect(seesCity(s, 'uk', 'russia', 'london')).toBe(true);
  });
});

describe('shared tech', () => {
  const rich = (): GameState =>
    table({
      us: {
        hasNuclearTech: true,
        nuclearTechUnlockedRound: 1,
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: 1,
      },
    });

  it('stays private until the owner offers it', () => {
    const s = allied(rich());
    expect(hasBallisticTech(s, 'uk')).toBe(false);
    expect(ballisticBundleCost(s, 'uk')).toBe(COSTS.ballisticMissileTech);
  });

  it('lets the ally build and fire warheads without buying the tech', () => {
    const s = setTechSharing(allied(rich()), 'us', 'ballistic', true);
    expect(hasBallisticTech(s, 'uk')).toBe(true);
    expect(hasAerospaceAccess(s, 'uk')).toBe(false);
    expect(canBuyBombs(s, 'uk')).toBe(true);
    expect(ballisticBundleCost(s, 'uk')).toBe(0);

    const bought = buyBombsBundled(s, 1, 'uk');
    expect(bought.nations.uk.bombs).toBe(1);
    expect(bought.nations.uk.money).toBe(s.nations.uk.money - COSTS.bomb);
    expect(bought.nations.uk.hasNuclearTech).toBe(false);

    const fired = queueStrike(bought, 'russia', bought.nations.russia.cities[0].id, 'uk', 'nuke');
    expect(fired).not.toBe(bought);
  });

  it('can be taken back, and ends with the pact', () => {
    let s = setTechSharing(allied(rich()), 'us', 'aerospace', true);
    expect(hasAerospaceAccess(s, 'uk')).toBe(true);
    s = setTechSharing(s, 'us', 'aerospace', false);
    expect(hasAerospaceAccess(s, 'uk')).toBe(false);
    s = setTechSharing(s, 'us', 'aerospace', true);
    expect(hasAerospaceAccess(leaveAlliance(s, 'uk'), 'uk')).toBe(false);
  });

  it('only lends tech the owner has', () => {
    const s = setTechSharing(allied(), 'us', 'ballistic', true);
    expect(s.nations.us.alliance?.shareBallistic).toBe(false);
  });
});

describe('shared sanctions', () => {
  it('allows one pick each and enforces both on both', () => {
    let s = allied();
    expect(sanctionsLeft(s, 'us')).toBe(1);
    s = toggleSanction(s, 'russia', 'us');
    expect(sanctionsLeft(s, 'us')).toBe(0);
    // a second pick is refused
    expect(toggleSanction(s, 'france', 'us')).toBe(s);

    s = toggleSanction(s, 'france', 'uk');
    expect(effectiveSanctions(s, 'us').sort()).toEqual(['france', 'russia']);
    expect(effectiveSanctions(s, 'uk').sort()).toEqual(['france', 'russia']);
    // both allies sanction both rivals: 2 sanctioners each
    expect(whoIsSanctioning(s, 'russia').sort()).toEqual(['uk', 'us']);
    expect(whoIsSanctioning(s, 'france').sort()).toEqual(['uk', 'us']);
  });

  it('cuts income by the pact’s sanctions', () => {
    let s = allied();
    s = toggleSanction(s, 'russia', 'us');
    const paid = applyIncome({ ...s, round: 3 });
    const entry = paid.lastIncomeLedger.find((e) => e.nationId === 'russia');
    expect(entry?.sanctioners.sort()).toEqual(['uk', 'us']);
    expect(entry?.sanctionPenalty).toBeCloseTo(0.2);
  });

  it('never targets the partner', () => {
    const s = allied();
    expect(toggleSanction(s, 'uk', 'us')).toBe(s);
  });

  it('trims stale extra picks when the pact forms, and restores two on leaving', () => {
    let s = table();
    s = toggleSanction(toggleSanction(s, 'russia', 'us'), 'france', 'us');
    expect(sanctionsLeft(s, 'us')).toBe(0);
    s = allied(s);
    expect(effectiveSanctions(s, 'us')).toEqual(['russia']);
    s = leaveAlliance(s, 'us');
    expect(effectiveSanctions(s, 'us')).toEqual(['russia', 'france']);
    expect(MAX_SANCTIONS).toBe(2);
  });

  it('drops a sanction on the new partner', () => {
    let s = toggleSanction(table(), 'uk', 'us');
    expect(effectiveSanctions(s, 'us')).toEqual(['uk']);
    s = allied(s);
    expect(effectiveSanctions(s, 'us')).toEqual([]);
    expect(whoIsSanctioning(s, 'uk')).toEqual([]);
  });
});

describe('paired drones and bombs', () => {
  it('share the reward for the city they take together', () => {
    const s = table({
      us: { drones: 1, hasAerospaceTech: true, aerospaceTechUnlockedRound: 0 },
      uk: { bombs: 1, hasNuclearTech: true, nuclearTechUnlockedRound: 0 },
    });
    const pact = allied(s);
    // France has a shield: the swarm ties it up, the bomb takes the city
    const city = pact.nations.france.cities[0];
    const shielded = {
      ...pact,
      nations: {
        ...pact.nations,
        france: {
          ...pact.nations.france,
          cities: pact.nations.france.cities.map((c) => (c.id === city.id ? { ...c, hasShield: true } : c)),
        },
      },
    };
    let play = queueStrike(shielded, 'france', city.id, 'us', 'drone');
    play = queueStrike(play, 'france', city.id, 'uk', 'nuke');
    const before = { us: play.nations.us.attackPoints, uk: play.nations.uk.attackPoints };
    const done = resolveAll(play);
    expect(done.nations.france.cities.find((c) => c.id === city.id)?.destroyed).toBe(true);
    const gained = {
      us: done.nations.us.attackPoints - before.us,
      uk: done.nations.uk.attackPoints - before.uk,
    };
    expect(gained.us).toBeGreaterThan(0);
    expect(gained.uk).toBeGreaterThan(0);
  });
});

describe('online merge', () => {
  it('keeps the owner’s newer pact pointer', () => {
    const s = proposeAlliance(table(), 'uk', 'us');
    const stale = table();
    const merged = mergeNationPlanning(s.nations.us, stale.nations.us);
    expect(merged.alliance?.with).toBe('uk');
    const reverse = mergeNationPlanning(stale.nations.us, s.nations.us);
    expect(reverse.alliance?.with).toBe('uk');
  });

  it('lets a leave beat the older pact', () => {
    const pact = allied();
    const left = leaveAlliance(pact, 'us');
    const merged = mergeNationPlanning(pact.nations.us, left.nations.us);
    expect(merged.alliance?.with).toBeNull();
    expect(areAllies(left, 'us', 'uk')).toBe(false);
  });
});
