/**
 * What a research lab costs against what it is worth. The lab is a gamble — two
 * random bombs for a build price and a running cost — so it has to be priced so
 * that taking it is sensible but not obviously right, and so that having one
 * neither wins nor loses a match on its own. The harness takes labs away from
 * seats to measure exactly that, on the same seeded matches.
 *
 * The report prints with `npx vitest run src/game/lab-economics.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { applyBalanceProfile, CURRENT_PROFILE } from '../data/balance';
import {
  COSTS,
  LAB_ROUNDS_PER_INVENTION,
  MAX_ROUNDS,
  RESEARCH_UPKEEP,
  SCORE_CITY,
  SCORE_KILL,
  SCORE_LAB_HIT,
  TABLE_SIZE,
} from '../data/nations';
import { playMatch, setLabPolicy, type Archetype, type LabPolicy, type LabRecord } from './balanceSim';

const MATCHES = 2000;
const SEED = 5000;

type World = {
  winRate: Record<string, number>;
  avgScore: Record<string, number>;
  labs: LabRecord[];
  /** Pace of the war: how fast cities fall and how often the table is emptied */
  cities: number;
  eliminated: number;
  wipeoutShare: number;
  peakRoundKills: number;
  earlyKills: number;
};

function playWorld(policy: LabPolicy): World {
  applyBalanceProfile(CURRENT_PROFILE);
  setLabPolicy(policy);
  const seats: Record<string, { n: number; wins: number; score: number }> = {};
  const labs: LabRecord[] = [];
  let cities = 0;
  let eliminated = 0;
  let wipeouts = 0;
  const kills: number[] = Array.from({ length: 12 }, () => 0);
  for (let i = 0; i < MATCHES; i += 1) {
    const match = playMatch(SEED + i * 7919);
    cities += match.citiesDestroyed;
    eliminated += match.eliminated;
    if (match.eliminated >= TABLE_SIZE - 1) wipeouts += 1;
    match.killsByRound.forEach((k, r) => {
      kills[r] = (kills[r] ?? 0) + (k ?? 0);
    });
    for (const lab of match.labs) {
      const row = (seats[lab.archetype] ??= { n: 0, wins: 0, score: 0 });
      row.n += 1;
      row.wins += lab.won ? 1 : 0;
      row.score += lab.score;
      labs.push(lab);
    }
  }
  const entries = Object.entries(seats);
  return {
    winRate: Object.fromEntries(entries.map(([k, v]) => [k, (v.wins / v.n) * 100])),
    avgScore: Object.fromEntries(entries.map(([k, v]) => [k, v.score / v.n])),
    labs,
    cities: cities / MATCHES,
    eliminated: eliminated / MATCHES,
    wipeoutShare: wipeouts / MATCHES,
    peakRoundKills: Math.max(...kills) / MATCHES,
    earlyKills: kills[0] / MATCHES,
  };
}

describe('lab economics', () => {
  afterAll(() => {
    applyBalanceProfile(CURRENT_PROFILE);
    setLabPolicy({ shipped: true, archetypes: true });
  });

  it('prices a lab bomb between a bought nuke and a bought magnetic bomb', () => {
    // Bought in round 1 it pays upkeep in rounds 2 to 6 and delivers in rounds 3 and 5
    const bombs = Math.floor((MAX_ROUNDS - 1) / LAB_ROUNDS_PER_INVENTION);
    const total = COSTS.research + RESEARCH_UPKEEP * (MAX_ROUNDS - 1);
    const perBomb = total / bombs;
    expect(bombs).toBe(2);
    // dearer than the plain warhead it can turn out to be, cheaper than the rarest one
    expect(perBomb).toBeGreaterThanOrEqual(COSTS.bomb);
    expect(perBomb).toBeLessThan(COSTS.bombMagnetic);
  });

  it('keeps a damage-only bomb from out-earning the kill it stands in for', () => {
    // A cluster canister over a three-city rival banks at most three hits
    expect(SCORE_LAB_HIT * 3).toBeLessThanOrEqual(SCORE_KILL * 1.5);
    expect(SCORE_LAB_HIT).toBeLessThan(SCORE_CITY / 3);
  });

  it('makes a lab a fair buy: it neither wins nor loses the match by itself', () => {
    const none = playWorld({ shipped: false, archetypes: false });
    const shippedOnly = playWorld({ shipped: true, archetypes: false });
    const everyone = playWorld({ shipped: true, archetypes: true });

    const adopters = shippedOnly.labs.filter((l) => l.archetype === 'shipped' && l.boughtRound > 0);
    const made = adopters.reduce((sum, l) => sum + l.made.length, 0) / Math.max(1, adopters.length);
    const used = adopters.reduce((sum, l) => sum + l.used, 0) / Math.max(1, adopters.length);
    const kinds: Record<string, number> = {};
    for (const l of adopters) for (const k of l.made) kinds[k] = (kinds[k] ?? 0) + 1;

    const shipped = (w: World) => w.winRate.shipped;
    const delta = shipped(shippedOnly) - shipped(none);
    const scoreDelta = shippedOnly.avgScore.shipped - none.avgScore.shipped;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          labPrice: COSTS.research,
          upkeepPerRound: RESEARCH_UPKEEP,
          scoreLabHit: SCORE_LAB_HIT,
          matches: MATCHES,
          shippedWinRate: {
            noLabsAnywhere: +shipped(none).toFixed(1),
            onlyShippedHasLabs: +shipped(shippedOnly).toFixed(1),
            everyoneHasLabs: +shipped(everyone).toFixed(1),
            winRateDelta: +delta.toFixed(1),
            avgScoreDelta: +scoreDelta.toFixed(1),
          },
          labsPerAdopter: { bombsMade: +made.toFixed(2), bombsFired: +used.toFixed(2) },
          drawMix: kinds,
          pace: {
            citiesFallenPerMatch: {
              noLabs: +none.cities.toFixed(2),
              everyoneHasLabs: +everyone.cities.toFixed(2),
              outOf: TABLE_SIZE * 3,
            },
            nationsEliminatedPerMatch: { noLabs: +none.eliminated.toFixed(2), everyoneHasLabs: +everyone.eliminated.toFixed(2) },
            busiestRoundKills: { noLabs: +none.peakRoundKills.toFixed(2), everyoneHasLabs: +everyone.peakRoundKills.toFixed(2) },
            wipeoutShare: +everyone.wipeoutShare.toFixed(3),
          },
          everyoneHasLabsWinRates: Object.fromEntries(
            Object.entries(everyone.winRate).map(([k, v]) => [k, +v.toFixed(1)]),
          ),
          noLabsWinRates: Object.fromEntries(Object.entries(none.winRate).map(([k, v]) => [k, +v.toFixed(1)])),
        },
        null,
        2,
      ),
    );

    // A lab bought in round 1 delivers both its bombs, and they get fired
    expect(adopters.length).toBeGreaterThan(MATCHES * 0.1);
    expect(made).toBeGreaterThan(1.5);
    expect(made).toBeLessThanOrEqual(2);
    expect(used).toBeGreaterThan(made * 0.8);

    // Worth building, not worth building at any price: the AI's win rate moves a point or two at most
    expect(delta).toBeGreaterThan(-2);
    expect(delta).toBeLessThan(3);

    // With labs everywhere no strategy takes over the table
    for (const [name, rate] of Object.entries(everyone.winRate)) {
      expect(rate, name).toBeLessThan(name === 'shipped' ? 55 : 45);
    }
    // The live AI stays a real opponent for someone who does take a lab
    const rivals = (Object.keys(everyone.winRate) as Archetype[]).filter((a) => a !== 'shipped');
    const bestRival = Math.max(...rivals.map((a) => everyone.winRate[a]));
    expect(shipped(everyone)).toBeGreaterThan(35);
    expect(shipped(everyone)).toBeGreaterThan(bestRival - 5);

    // Labs add to the war without ending it early: the table is never emptied
    // and the first round stays quiet, so every nation has a game to play
    const cityCount = TABLE_SIZE * 3;
    expect(everyone.cities).toBeLessThan(cityCount * 0.5);
    expect(everyone.cities).toBeLessThan(none.cities * 1.25);
    expect(everyone.eliminated).toBeLessThan(1.2);
    expect(everyone.wipeoutShare).toBeLessThan(0.02);
    expect(everyone.peakRoundKills).toBeLessThan(2.2);
    expect(everyone.earlyKills).toBeLessThan(0.7);
  }, 120_000);
});
