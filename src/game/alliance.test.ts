import { describe, expect, it } from 'vitest';
import { COSTS, MAX_SANCTIONS } from '../data/nations';
import {
  acceptAlliance,
  allianceDeskOpen,
  allianceWindowOpen,
  allyOf,
  areAllies,
  declineAlliance,
  effectiveSanctions,
  hasAerospaceAccess,
  hasBallisticTech,
  hasSpyService,
  allianceTalks,
  incomingInvites,
  inviteBlockedReason,
  pactPayment,
  PACT_INCOME_SHARE,
  pactTerms,
  talksDone,
  TALK_MAX_MS,
  TALK_MIN_MS,
  tributeFrom,
  leaveAlliance,
  outgoingInvite,
  proposeAlliance,
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
import {
  allianceAppeal,
  answerAiInvites,
  proposeAllianceWithReply,
  runAiAlliances,
  runAllAiAlliances,
} from './allianceAi';
import { allScores } from './engine';
import { rankedRivals, runAiNationTurn } from './ai';
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

  it('welcomes AI nations as partners', () => {
    const s = proposeAlliance(table(), 'russia', 'us');
    expect(outgoingInvite(s, 'us')?.to).toBe('russia');
    expect(inviteBlockedReason(table(), 'us', 'russia')).toBeNull();
    expect(incomingInvites(s, 'russia')).toEqual(['us']);
  });

  it('holds at most two players: you cannot invite while allied yourself', () => {
    const base = table();
    const three = {
      ...base,
      nations: { ...base.nations, france: { ...base.nations.france, isHuman: true } },
    };
    const s = allied(three);
    expect(inviteBlockedReason(s, 'france', 'us')).toBeNull();
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
    const dropped = { ...s, nations: { ...s.nations, uk: { ...s.nations.uk, eliminated: true } } };
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

  it('passes to the ally the moment the pact is made, with nothing to switch on', () => {
    const s = allied(rich());
    expect(hasBallisticTech(s, 'uk')).toBe(true);
    expect(hasAerospaceAccess(s, 'uk')).toBe(true);
    expect(ballisticBundleCost(s, 'uk')).toBe(0);
  });

  it('is not shared with someone who is only invited', () => {
    const s = proposeAlliance(rich(), 'uk', 'us');
    expect(hasBallisticTech(s, 'uk')).toBe(false);
    expect(hasAerospaceAccess(s, 'uk')).toBe(false);
    expect(ballisticBundleCost(s, 'uk')).toBe(COSTS.ballisticMissileTech);
  });

  it('lets the ally build and fire warheads without buying the tech', () => {
    const s = allied(rich());
    expect(hasBallisticTech(s, 'uk')).toBe(true);
    expect(canBuyBombs(s, 'uk')).toBe(true);
    expect(ballisticBundleCost(s, 'uk')).toBe(0);

    const bought = buyBombsBundled(s, 1, 'uk');
    expect(bought.nations.uk.bombs).toBe(1);
    expect(bought.nations.uk.money).toBe(s.nations.uk.money - COSTS.bomb);
    expect(bought.nations.uk.hasNuclearTech).toBe(false);

    const fired = queueStrike(bought, 'russia', bought.nations.russia.cities[0].id, 'uk', 'nuke');
    expect(fired).not.toBe(bought);
  });

  it('flows both ways and ends with the pact', () => {
    const both = allied(
      table({
        us: { hasNuclearTech: true, nuclearTechUnlockedRound: 1 },
        uk: { hasAerospaceTech: true, aerospaceTechUnlockedRound: 1 },
      }),
    );
    expect(hasBallisticTech(both, 'uk')).toBe(true);
    expect(hasAerospaceAccess(both, 'us')).toBe(true);
    const left = leaveAlliance(both, 'uk');
    expect(hasBallisticTech(left, 'uk')).toBe(false);
    expect(hasAerospaceAccess(left, 'us')).toBe(false);
  });

  it('only lends tech the owner has unlocked', () => {
    const s = allied();
    expect(hasBallisticTech(s, 'uk')).toBe(false);
    const locked = allied(table({ us: { hasNuclearTech: true, nuclearTechUnlockedRound: 4 } }));
    expect(hasBallisticTech(locked, 'uk')).toBe(false);
  });

  it('brings the spy service the same way', () => {
    const s = allied(table({ us: { hasSpyNetwork: true } }));
    expect(hasSpyService(s, 'uk')).toBe(true);
    expect(hasSpyService(leaveAlliance(s, 'uk'), 'uk')).toBe(false);
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

describe('pact money', () => {
  const withTerms = (tribute: number, over: Partial<Record<NationId, Partial<NationState>>> = {}) =>
    acceptAlliance(proposeAlliance(table(over), 'uk', 'us', tribute), 'us', 'uk');

  it('records who proposed and what they offered', () => {
    const s = withTerms(10);
    expect(pactTerms(s, 'us', 'uk')?.tribute).toBe(10);
    expect(tributeFrom(s, 'uk')).toBe(0 + (pactTerms(s, 'us', 'uk')?.proposer === 'us' ? -10 : 10));
  });

  it('moves $10M a round from the payer to the payee', () => {
    // us proposed offering to pay
    const s = acceptAlliance(proposeAlliance(table(), 'uk', 'us', 10), 'us', 'uk');
    expect(tributeFrom(s, 'us')).toBe(10);
    expect(tributeFrom(s, 'uk')).toBe(-10);
    const plain = applyIncome({ ...s, round: 3, nations: { ...s.nations, us: { ...s.nations.us, alliance: undefined } } });
    const paid = applyIncome({ ...s, round: 3 });
    expect(paid.nations.us.money).toBeCloseTo(plain.nations.us.money - 10, 5);
    const ledger = paid.lastIncomeLedger.find((e) => e.nationId === 'us');
    expect(ledger?.pactTransfer).toBe(-10);
    expect(paid.lastIncomeLedger.find((e) => e.nationId === 'uk')?.pactTransfer).toBe(10);
  });

  it('asking works the other way round', () => {
    const s = acceptAlliance(proposeAlliance(table(), 'uk', 'us', -10), 'us', 'uk');
    expect(tributeFrom(s, 'us')).toBe(-10);
    expect(tributeFrom(s, 'uk')).toBe(10);
  });

  it('is paid once per round, and only from what the payer holds', () => {
    const s = acceptAlliance(proposeAlliance(table({ us: { money: 0 } }), 'uk', 'us', 10), 'us', 'uk');
    const once = applyIncome({ ...s, round: 3 });
    const twice = applyIncome(once);
    expect(twice.nations.us.money).toBe(once.nations.us.money);
    expect(twice.nations.uk.money).toBe(once.nations.uk.money);
    expect(once.nations.us.money).toBeGreaterThanOrEqual(0);
  });

  it('never moves money when only one side of the pair is being paid in this pass', () => {
    const s = acceptAlliance(proposeAlliance(table(), 'uk', 'us', 10), 'us', 'uk');
    // us was already paid for round 3 (say, by another client); uk is not
    const half = { ...s, round: 3, nations: { ...s.nations, us: { ...s.nations.us, incomeRound: 3 } } };
    const paid = applyIncome(half);
    expect(paid.lastIncomeLedger.every((e) => !e.pactTransfer)).toBe(true);
    expect(paid.nations.us.money).toBe(half.nations.us.money);
  });

  it('stops when the pact is left', () => {
    const s = acceptAlliance(proposeAlliance(table(), 'uk', 'us', 10), 'us', 'uk');
    const left = leaveAlliance(s, 'uk');
    expect(tributeFrom(left, 'us')).toBe(0);
    expect(applyIncome({ ...left, round: 3 }).lastIncomeLedger.every((e) => !e.pactTransfer)).toBe(true);
  });
});

describe('pact payments stay in proportion', () => {
  it('never take more than the income share of the payer’s round', () => {
    expect(PACT_INCOME_SHARE).toBe(0.2);
    expect(pactPayment(10, 100)).toBe(10);
    expect(pactPayment(10, 50)).toBe(10);
    expect(pactPayment(10, 36)).toBe(7);
    expect(pactPayment(10, 18)).toBe(3);
    expect(pactPayment(10, 0)).toBe(0);
    expect(pactPayment(-10, 36)).toBe(7);
  });

  it('shrinks a payment from a nation that has lost its cities', () => {
    const pact = acceptAlliance(proposeAlliance(table(), 'uk', 'us', 10), 'us', 'uk');
    const cities = pact.nations.us.cities.map((c, i) => ({ ...c, destroyed: i > 0 }));
    const small = { ...pact, round: 3, nations: { ...pact.nations, us: { ...pact.nations.us, cities } } };
    const paid = applyIncome(small);
    const us = paid.lastIncomeLedger.find((e) => e.nationId === 'us')!;
    const uk = paid.lastIncomeLedger.find((e) => e.nationId === 'uk')!;
    expect(us.revenue).toBe(18);
    expect(us.pactTransfer).toBe(-3);
    expect(uk.pactTransfer).toBe(3);
  });

  it('is the full amount for a healthy nation', () => {
    const pact = acceptAlliance(proposeAlliance(table(), 'uk', 'us', 10), 'us', 'uk');
    const paid = applyIncome({ ...pact, round: 3 });
    expect(paid.lastIncomeLedger.find((e) => e.nationId === 'us')?.pactTransfer).toBe(-10);
  });
});

describe('AI alliance fairness', () => {
  const rich = { hasSpyNetwork: true, hasAerospaceTech: true, hasNuclearTech: true };
  /** Leaves `keep` cities standing, so a nation slides down the table. */
  const shrink = (state: GameState, id: NationId, keep: number): GameState => ({
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...state.nations[id],
        cities: state.nations[id].cities.map((c, i) => ({ ...c, destroyed: i >= keep })),
      },
    },
  });
  const order = (s: GameState) => allScores(s).map((r) => r.nationId);

  it('does not let the two front-runners lock the table', () => {
    // france and russia lead; us and uk are far behind
    let s = table({ france: rich, russia: { hasSpyNetwork: true, hasNuclearTech: true } });
    s = shrink(shrink(s, 'us', 1), 'uk', 2);
    expect(order(s).slice(0, 2).sort()).toEqual(['france', 'russia']);
    const after = runAiAlliances(s, 'russia');
    expect(allyOf(after, 'russia')).toBeNull();
    expect(outgoingInvite(after, 'russia')?.to).not.toBe('france');
    // and an invitation between them is turned down
    const asked = proposeAllianceWithReply(s, 'france', 'russia', 0);
    expect(allyOf(asked, 'russia')).toBeNull();
  });

  it('still pairs a front-runner with someone further back', () => {
    let s = table({ uk: rich });
    s = shrink(shrink(shrink(s, 'us', 1), 'russia', 3), 'uk', 1);
    const asked = runAiAlliances(s, 'france');
    // france goes for a partner outside the front pair; a human answers for themselves
    const to = outgoingInvite(asked, 'france')?.to ?? allyOf(asked, 'france');
    expect(to).toBeTruthy();
    expect(order(s).slice(0, 2)).toContain('france');
    expect(order(s).slice(0, 2)).not.toContain(to);
  });

  it('offers even terms to a neighbour in the standings', () => {
    const base = table({ france: rich });
    // france leads and russia is one place back
    const mid = shrink(shrink(shrink(base, 'us', 1), 'uk', 1), 'russia', 3);
    expect(order(mid)[1]).toBe('russia');
    const sent = runAiAlliances(mid, 'france').nations.france.alliance;
    expect(sent?.tribute ?? 0).toBe(0);
  });

  it('asks for money from a nation well behind it', () => {
    const base = table({ uk: rich });
    // france leads and uk is at the back, still worth asking
    const s = shrink(shrink(shrink(base, 'us', 1), 'russia', 3), 'uk', 1);
    expect(order(s)[0]).toBe('france');
    const sent = runAiAlliances(s, 'france').nations.france.alliance;
    expect(sent?.with).toBe('uk');
    expect(sent?.tribute).toBe(-10);
  });
});

describe('the alliance desk after the briefing', () => {
  it('opens in rounds 2 to 5 of a six-round game, and only then', () => {
    expect(allianceDeskOpen(table({}, 1), 'us')).toBe(false);
    for (const round of [2, 3, 4, 5]) expect(allianceDeskOpen(table({}, round), 'us'), `round ${round}`).toBe(true);
    expect(allianceDeskOpen(table({}, 6), 'us')).toBe(false);
  });

  it('stays shut for a fallen nation or when nobody is left to talk to', () => {
    expect(allianceDeskOpen(table({ us: { eliminated: true } }), 'us')).toBe(false);
    const alone = table({ uk: { eliminated: true }, russia: { eliminated: true }, france: { eliminated: true } });
    expect(allianceDeskOpen(alone, 'us')).toBe(false);
  });

  it('is open to an allied nation too, so a pact can be ended or swapped', () => {
    expect(allianceDeskOpen(allied(), 'us')).toBe(true);
  });

  it('seats every AI nation at the desk before the player orders', () => {
    const rich = { hasSpyNetwork: true, hasAerospaceTech: true, hasNuclearTech: true };
    // two well-stocked humans and two bare AI nations: the AI have something to ask for
    const s = table({ uk: rich, us: rich });
    const after = runAllAiAlliances(s);
    // each AI either has an ally or has reached out to someone
    for (const id of ['russia', 'france'] as NationId[]) {
      expect(allyOf(after, id) ?? outgoingInvite(after, id)?.to ?? null, id).not.toBeNull();
    }
    // running the desk again changes nothing it already settled
    const again = runAllAiAlliances(after);
    for (const id of ['russia', 'france'] as NationId[]) expect(allyOf(again, id)).toBe(allyOf(after, id));
  });
});

describe('AI bands together against the leader', () => {
  const rich = { hasSpyNetwork: true, hasAerospaceTech: true, hasNuclearTech: true };
  const shrink = (state: GameState, id: NationId, keep: number): GameState => ({
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...state.nations[id],
        cities: state.nations[id].cities.map((c, i) => ({ ...c, destroyed: i >= keep })),
      },
    },
  });
  /** Everyone level, or us out in front with the rest on two cities. */
  const tied = () => table({ us: rich, uk: rich });
  const runaway = () => shrink(shrink(shrink(tied(), 'uk', 2), 'russia', 2), 'france', 2);

  it('makes two nations behind a runaway leader want each other more', () => {
    expect(allianceAppeal(runaway(), 'russia', 'uk')).toBeGreaterThan(allianceAppeal(tied(), 'russia', 'uk'));
  });

  it('cools towards the leader itself', () => {
    const s = runaway();
    // same kit, but one of them is the runaway: the chaser prefers the other
    expect(allianceAppeal(s, 'russia', 'us')).toBeLessThan(allianceAppeal(s, 'russia', 'uk'));
    // and the cold shoulder only appears once the lead is real
    expect(allianceAppeal(tied(), 'russia', 'us')).toBeGreaterThanOrEqual(allianceAppeal(tied(), 'russia', 'uk') - 0.5);
  });

  it('points an allied pair at the front-runner outside the pact', () => {
    // uk is armed, so alone france would shoot uk first; us leads the table by a little
    const base = table({ uk: { hasNuclearTech: true, bombs: 1 } });
    const lead = {
      ...base,
      nations: {
        ...base.nations,
        us: {
          ...base.nations.us,
          cities: base.nations.us.cities.map((c, i) => (i === 0 ? { ...c, hasResearch: true } : c)),
        },
      },
    };
    expect(rankedRivals(lead, 'france')[0]).toBe('uk');
    const pact = acceptAlliance(proposeAlliance(lead, 'russia', 'france'), 'france', 'russia');
    expect(rankedRivals(pact, 'france')[0]).toBe('us');
    expect(rankedRivals(pact, 'france')).not.toContain('russia');
  });
});

describe('AI in alliances', () => {
  /** A strong, well-equipped France and a weak, bare Russia. */
  const aiTable = () =>
    table({
      france: { hasSpyNetwork: true, hasAerospaceTech: true, hasNuclearTech: true },
      russia: { hasSpyNetwork: false },
    });

  it('answers a human invitation at once', () => {
    const s = proposeAllianceWithReply(aiTable(), 'france', 'us', 0);
    const replied = allyOf(s, 'us') === 'france' || outgoingInvite(s, 'us')?.declined === true;
    expect(replied).toBe(true);
  });

  it('does the same thing every time it is asked', () => {
    const a = proposeAllianceWithReply(aiTable(), 'france', 'us', 10);
    const b = proposeAllianceWithReply(aiTable(), 'france', 'us', 10);
    expect(allyOf(a, 'us')).toBe(allyOf(b, 'us'));
  });

  it('pays attention to the money terms', () => {
    // a payment can tip an AI that would otherwise hesitate, and a demand can cost the pact
    const outcomes = [-10, 0, 10].map((t) => allyOf(proposeAllianceWithReply(aiTable(), 'france', 'us', t), 'us'));
    const yes = outcomes.map((o) => o === 'france');
    // being paid is never worse than paying
    expect(Number(yes[2])).toBeGreaterThanOrEqual(Number(yes[1]));
    expect(Number(yes[1])).toBeGreaterThanOrEqual(Number(yes[0]));
  });

  it('declines everyone but the best of several invitations', () => {
    let s = aiTable();
    s = proposeAlliance(s, 'france', 'us', 10);
    s = proposeAlliance(s, 'france', 'uk', 10);
    s = answerAiInvites(s, 'france');
    expect(incomingInvites(s, 'france')).toEqual([]);
    const allies = ['us', 'uk'].filter((id) => allyOf(s, id as NationId) === 'france');
    expect(allies.length).toBeLessThanOrEqual(1);
  });

  it('goes and asks the partner that completes it — a human included', () => {
    const rich = table({
      uk: { hasSpyNetwork: true, hasAerospaceTech: true, hasNuclearTech: true },
    });
    const s = runAiAlliances(rich, 'russia');
    const out = outgoingInvite(s, 'russia');
    expect(allyOf(s, 'russia') ?? out?.to).toBe('uk');
    // a human has to answer for themselves
    expect(allyOf(s, 'russia')).toBeNull();
    expect(incomingInvites(s, 'uk')).toEqual(['russia']);
  });

  it('may pair up two AI nations', () => {
    const rich = table({ france: { hasSpyNetwork: true, hasAerospaceTech: true, hasNuclearTech: true } });
    // russia sits near the bottom, so the pairing is not two front-runners
    const low = {
      ...rich,
      nations: {
        ...rich.nations,
        russia: {
          ...rich.nations.russia,
          cities: rich.nations.russia.cities.map((c, i) => ({ ...c, destroyed: i > 0 })),
        },
      },
    };
    const s = runAiAlliances(low, 'russia');
    expect(allyOf(s, 'russia') ?? outgoingInvite(s, 'russia')?.to).toBe('france');
  });

  it('never runs outside the window or for humans', () => {
    const early = { ...aiTable(), round: 1 };
    expect(runAiAlliances(early, 'france')).toBe(early);
    const s = aiTable();
    expect(runAiAlliances(s, 'us')).toBe(s);
  });

  it('never attacks its ally', () => {
    let s = aiTable();
    s = proposeAlliance(s, 'france', 'russia', 0);
    s = answerAiInvites(s, 'france');
    // force the pact in case the AI declined
    s = allyOf(s, 'france') ? s : acceptAlliance(proposeAlliance(s, 'russia', 'france', 0), 'russia', 'france');
    s = { ...s, nations: { ...s.nations, france: { ...s.nations.france, money: 900 } } };
    const after = runAiNationTurn(s, 'france');
    const hitAlly = after.pendingStrikes.filter((x) => x.attackerId === 'france' && x.targetNationId === 'russia');
    expect(hitAlly).toEqual([]);
  });
});

describe('alliance talks window', () => {
  it('lists an invitation as pending, then allied or declined', () => {
    const sent = proposeAlliance(table(), 'uk', 'us');
    expect(allianceTalks(sent).map((t) => [t.from, t.to, t.status])).toEqual([['us', 'uk', 'pending']]);
    expect(allianceTalks(acceptAlliance(sent, 'us', 'uk'))[0].status).toBe('allied');
    expect(allianceTalks(declineAlliance(sent, 'us', 'uk'))[0].status).toBe('declined');
  });

  it('gives each proposal its own key', () => {
    const first = allianceTalks(proposeAlliance(table(), 'uk', 'us'))[0].key;
    const again = allianceTalks(proposeAlliance(leaveAlliance(proposeAlliance(table(), 'uk', 'us'), 'us'), 'uk', 'us'))[0].key;
    expect(again).not.toBe(first);
  });

  it('is empty outside the alliance window', () => {
    expect(allianceTalks(proposeAlliance(table({}, 1), 'uk', 'us'))).toEqual([]);
  });

  it('closes at ten seconds, or early once settled — but never before three', () => {
    expect(TALK_MAX_MS).toBe(10_000);
    expect(TALK_MIN_MS).toBe(3_000);
    expect(talksDone(2_000, 0, 10_000, false)).toBe(false); // settled, minimum not shown yet
    expect(talksDone(3_000, 0, 10_000, false)).toBe(true); // settled early
    expect(talksDone(9_000, 0, 10_000, true)).toBe(false); // still waiting on someone
    expect(talksDone(10_000, 0, 10_000, true)).toBe(true); // clock ran out
  });
});

describe('switching and ending alliances', () => {
  const threeHumans = (over: Partial<Record<NationId, Partial<NationState>>> = {}) =>
    table({ france: { isHuman: true }, ...over });

  it('lets a nation that is already allied be invited, and accepting ends the old pact', () => {
    let s = allied(threeHumans());
    expect(inviteBlockedReason(s, 'france', 'us')).toBeNull();
    s = proposeAlliance(s, 'us', 'france');
    expect(incomingInvites(s, 'us')).toEqual(['france']);
    // still allied until they answer
    expect(allyOf(s, 'us')).toBe('uk');
    s = acceptAlliance(s, 'france', 'us');
    expect(allyOf(s, 'us')).toBe('france');
    expect(allyOf(s, 'uk')).toBeNull();
    // uk is left free, with no dangling invitation to us in either direction
    expect(outgoingInvite(s, 'uk')).toBeNull();
    expect(incomingInvites(s, 'us')).toEqual([]);
    expect(incomingInvites(s, 'uk')).toEqual([]);
  });

  it('answers the other offers on the table when one is accepted', () => {
    let s = table({ france: { isHuman: true }, russia: { isHuman: true } });
    s = proposeAlliance(s, 'us', 'france');
    s = proposeAlliance(s, 'us', 'russia');
    expect(incomingInvites(s, 'us').sort()).toEqual(['france', 'russia']);
    s = acceptAlliance(s, 'france', 'us');
    expect(incomingInvites(s, 'us')).toEqual([]);
    expect(allianceTalks(s).find((t) => t.from === 'russia')?.status).toBe('declined');
  });

  it('stops the per-round payments when the old pact is replaced', () => {
    let s = acceptAlliance(proposeAlliance(threeHumans(), 'uk', 'us', 10), 'us', 'uk');
    expect(tributeFrom(s, 'us')).toBe(10);
    s = acceptAlliance(proposeAlliance(s, 'us', 'france', 0), 'france', 'us');
    expect(tributeFrom(s, 'us')).toBe(0);
    expect(tributeFrom(s, 'uk')).toBe(0);
    const paid = applyIncome({ ...s, round: 3 });
    expect(paid.lastIncomeLedger.every((e) => !e.pactTransfer)).toBe(true);
  });

  it('ends the pact for both sides when one leaves, so the partner is not left hanging', () => {
    const pact = acceptAlliance(proposeAlliance(table(), 'uk', 'us', 10), 'us', 'uk');
    const left = leaveAlliance(pact, 'us');
    expect(allyOf(left, 'us')).toBeNull();
    expect(allyOf(left, 'uk')).toBeNull();
    expect(left.nations.uk.alliance?.with).toBeNull();
    // no leftover invitation either way
    expect(incomingInvites(left, 'us')).toEqual([]);
    expect(incomingInvites(left, 'uk')).toEqual([]);
    expect(outgoingInvite(left, 'uk')).toBeNull();
    // and the money stops
    expect(tributeFrom(left, 'us')).toBe(0);
    expect(applyIncome({ ...left, round: 3 }).lastIncomeLedger.every((e) => !e.pactTransfer)).toBe(true);
  });

  it('keeps an AI loyal to its ally unless the newcomer is clearly better', () => {
    // france (AI) allied with russia (AI); us (human) bids with nothing to offer
    let s = table({ russia: { hasSpyNetwork: true, hasAerospaceTech: true, hasNuclearTech: true } });
    s = acceptAlliance(proposeAlliance(s, 'france', 'russia'), 'russia', 'france');
    expect(allyOf(s, 'france')).toBe('russia');
    const weak = proposeAllianceWithReply(s, 'france', 'us', 0);
    expect(allyOf(weak, 'france')).toBe('russia');
    expect(outgoingInvite(weak, 'us')?.declined).toBe(true);
  });
});
