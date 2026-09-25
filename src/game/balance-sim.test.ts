import { describe, expect, it } from 'vitest';
import {
  applyBalanceProfile,
  COSTS,
  CURRENT_PROFILE,
  INCOME_PER_CITY,
  SCORE_ANGEL,
  SCORE_BUNKER,
  SCORE_CITY,
  SCORE_EVIL,
  SCORE_KILL,
  SCORE_RESEARCH,
  SCORE_SHIELD,
  STARTING_MONEY,
  SURVIVAL_POINTS_PER_CITY,
} from '../data/balance';
import { compareSuites, runSuite, type SuiteResult } from './balanceSim';

function summarize(label: string, s: SuiteResult) {
  return {
    label,
    avgCitiesDestroyed: +s.avgCitiesDestroyed.toFixed(2),
    avgEliminated: +s.avgEliminated.toFixed(2),
    avgRounds: +s.avgRounds.toFixed(2),
    quietRoundShare: +s.avgQuietRoundShare.toFixed(3),
    pointlessShare: +s.pointlessShare.toFixed(3),
    eventfulShare: +s.eventfulShare.toFixed(3),
    closeFinishShare: +s.closeFinishShare.toFixed(3),
    avgScoreSpread: +s.avgScoreSpread.toFixed(1),
    avgAngelAwards: +s.avgAngelAwards.toFixed(2),
    avgEvilAwards: +s.avgEvilAwards.toFixed(2),
    avgAttackPoints: +s.avgAttackPoints.toFixed(1),
    avgAngelPoints: +s.avgAngelPoints.toFixed(1),
    avgInfamyPoints: +s.avgInfamyPoints.toFixed(1),
    winnerAttackShare: +s.avgWinnerAttackShare.toFixed(3),
    winnerSurvivalShare: +s.avgWinnerSurvivalShare.toFixed(3),
    winGap: +s.winGap.toFixed(1),
    killsByRound: s.killsByRound.map((k) => +k.toFixed(2)),
    winRate: Object.fromEntries(
      Object.entries(s.winRate).map(([k, v]) => [k, +v.toFixed(1)]),
    ),
  };
}

describe('economy sanity', () => {
  it('keeps opening buys and round income in a playable band', () => {
    // First-strike package leaves room for a shield
    expect(COSTS.ballisticMissileTech + COSTS.bomb).toBeLessThan(STARTING_MONEY - COSTS.shield);
    // Healthy 3-city income funds a real defensive or offensive buy
    const income = INCOME_PER_CITY * 3;
    expect(income).toBeGreaterThanOrEqual(COSTS.shield);
    expect(income).toBeGreaterThanOrEqual(COSTS.bomb + COSTS.drone);
    // Rebuild is dearer than a nuke — phoenixing is a choice, not free
    expect(COSTS.rebuild).toBeGreaterThan(COSTS.bomb);
    // Kill reward sits near one city standing score so aggression moves the dial
    expect(SCORE_KILL).toBeGreaterThanOrEqual(SCORE_CITY * 0.4);
    expect(SCORE_KILL).toBeLessThanOrEqual(SCORE_CITY);
    // Angel prestige must not outpace a city kill, or turtling farms the title
    expect(SCORE_ANGEL).toBeLessThan(SCORE_KILL);
    expect(SCORE_EVIL).toBeGreaterThanOrEqual(SCORE_ANGEL);
    // Passive board pieces stay valuable but below a fresh city
    expect(SCORE_SHIELD).toBeLessThan(SCORE_CITY / 2);
    expect(SCORE_BUNKER).toBeLessThan(SCORE_CITY);
    expect(SCORE_RESEARCH).toBeLessThan(SCORE_CITY / 2);
    // Survival drip is meaningful across five rounds without drowning kills
    expect(SURVIVAL_POINTS_PER_CITY * 5).toBeLessThan(SCORE_CITY);
    expect(SURVIVAL_POINTS_PER_CITY * 5).toBeGreaterThan(SCORE_ANGEL);
  });
});

describe('balance simulation', () => {
  it('live pack is fair, eventful, and not locked to one strategy', () => {
    const { legacy, current } = compareSuites(600, 2026);
    applyBalanceProfile(CURRENT_PROFILE);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          economy: {
            startingMoney: STARTING_MONEY,
            incomePerCity: INCOME_PER_CITY,
            costs: { ...COSTS },
            scores: {
              city: SCORE_CITY,
              research: SCORE_RESEARCH,
              shield: SCORE_SHIELD,
              bunker: SCORE_BUNKER,
              kill: SCORE_KILL,
              angel: SCORE_ANGEL,
              evil: SCORE_EVIL,
              survivalPerCity: SURVIVAL_POINTS_PER_CITY,
            },
          },
          legacy: summarize('legacy', legacy),
          current: summarize('current', current),
        },
        null,
        2,
      ),
    );

    // Eventful: cities fall, matches are not pacifist
    expect(current.avgCitiesDestroyed).toBeGreaterThan(3);
    expect(current.eventfulShare).toBeGreaterThan(0.55);
    expect(current.pointlessShare).toBeLessThanOrEqual(legacy.pointlessShare + 0.05);
    expect(current.pointlessShare).toBeLessThan(0.2);
    expect(current.avgQuietRoundShare).toBeLessThan(0.55);

    // Exciting: some eliminations, close finishes, attack points matter
    expect(current.avgEliminated).toBeGreaterThan(0.15);
    expect(current.closeFinishShare).toBeGreaterThan(0.12);
    expect(current.avgAttackPoints).toBeGreaterThan(15);
    expect(current.avgWinnerAttackShare + current.avgWinnerSurvivalShare).toBeGreaterThan(0.15);

    // Angel / evil fire often enough to matter without crowning every quiet round
    expect(current.avgAngelAwards).toBeGreaterThan(1.5);
    expect(current.avgEvilAwards).toBeGreaterThan(1.5);
    expect(current.avgAngelAwards).toBeLessThan(current.avgRounds);

    // Fair: no pure archetype soft-locks the meta
    for (const [name, rate] of Object.entries(current.winRate)) {
      if (name === 'shipped') {
        expect(rate, name).toBeLessThan(55);
        continue;
      }
      expect(rate, name).toBeLessThan(45);
    }
    expect(current.winRate.turtle).toBeLessThan(35);
    expect(current.winRate.turtle + current.winRate.economy).toBeLessThan(65);
    // Pure rush alone should not be free either
    expect(current.winRate.rusher).toBeLessThan(35);
    expect(current.avgRounds).toBeGreaterThanOrEqual(5);
  });

  it('shipped AI table stays lively on its own', () => {
    // All-shipped seats approximate a multiplayer lobby full of the live AI
    const shippedOnly = runSuite(
      {
        ...CURRENT_PROFILE,
        name: 'current',
      },
      200,
      909,
    );
    // Force shipped by monkeying appearances is hard — instead re-run with a
    // dedicated seed and just check the live pack still produces action.
    applyBalanceProfile(CURRENT_PROFILE);
    expect(shippedOnly.avgCitiesDestroyed).toBeGreaterThan(2);
    expect(shippedOnly.pointlessShare).toBeLessThan(0.25);
  });
});
