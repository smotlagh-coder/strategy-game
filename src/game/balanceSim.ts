/**
 * Monte Carlo balance harness. Swaps CURRENT vs PROPOSED profiles, plays full
 * matches through the real engine, and prints whether the proposed pack is
 * more eventful without crowning one archetype.
 *
 * Run: npx vitest run src/game/balance-sim.test.ts
 */
import {
  applyBalanceProfile,
  CURRENT_PROFILE,
  LEGACY_PROFILE,
  type BalanceProfile,
} from '../data/balance';
import { COSTS, MAX_SANCTIONS, NATIONS, TABLE_SIZE } from '../data/nations';
import {
  applyQueuedStrike,
  buyAerospaceTech,
  buyBomb,
  buyDrone,
  buyNuclearTech,
  buyRebuild,
  buyResearch,
  buyShield,
  buySpyNetwork,
  buyUnderground,
  canBuyRebuild,
  canBuyResearch,
  canBuyShield,
  canBuySpyNetwork,
  canBuyUnderground,
  computeScore,
  createInitialState,
  endTurn,
  finishStrikeResolution,
  nextRound,
  orderStrikesForResolution,
  queueStrike,
  researchCount,
  seatTable,
  startGame,
  toggleSanction,
} from './engine';
import { runAiNationTurn } from './ai';
import type { GameState, NationId, NationState } from '../types';

export type Archetype =
  | 'economy'
  | 'turtle'
  | 'rusher'
  | 'swarmer'
  | 'balanced'
  | 'shipped';

const ARCHETYPES: Archetype[] = [
  'economy',
  'turtle',
  'rusher',
  'swarmer',
  'balanced',
  'shipped',
];

const SEAT_POOL: NationId[] = NATIONS.map((n) => n.id);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSeats(rng: () => number, n: number): NationId[] {
  const pool = [...SEAT_POOL];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

function pickArchetypes(rng: () => number): Archetype[] {
  const out: Archetype[] = [];
  for (let i = 0; i < TABLE_SIZE; i += 1) {
    out.push(ARCHETYPES[Math.floor(rng() * ARCHETYPES.length)]);
  }
  return out;
}

function exposedCity(s: GameState, id: NationId) {
  return s.nations[id].cities.find((c) => !c.destroyed && !c.hasShield && !c.isUnderground);
}

function anyCity(s: GameState, id: NationId) {
  return s.nations[id].cities.find((c) => !c.destroyed);
}

function rivalTarget(s: GameState, id: NationId) {
  for (const nid of s.turnOrder) {
    if (nid === id || s.nations[nid].eliminated) continue;
    const city = s.nations[nid].cities.find((c) => !c.destroyed && !c.isUnderground);
    if (city) return { nationId: nid, cityId: city.id, hasShield: city.hasShield };
  }
  return null;
}

function sanctionLeader(s: GameState, id: NationId): GameState {
  const me = s.nations[id];
  if (me.eliminated) return s;
  const ranked = s.turnOrder
    .filter((nid) => nid !== id && !s.nations[nid].eliminated)
    .map((nid) => ({ nid, score: computeScore(s, nid).total }))
    .sort((a, b) => b.score - a.score);
  let next = s;
  for (const row of ranked) {
    if (next.nations[id].sanctions.length >= MAX_SANCTIONS) break;
    if (next.nations[id].sanctions.includes(row.nid)) continue;
    next = toggleSanction(next, row.nid, id);
  }
  return next;
}

/** Scripted strategies — shipped uses the real AI. */
function planArchetype(s: GameState, id: NationId, kind: Archetype): GameState {
  if (s.nations[id].eliminated) return s;
  if (kind === 'shipped') return runAiNationTurn(s, id);

  let next: GameState = { ...s, currentTurnIndex: s.turnOrder.indexOf(id), phase: 'buy' };
  const money = () => next.nations[id].money;

  if (canBuyRebuild(next, id) && money() >= COSTS.rebuild) {
    const rubble = next.nations[id].cities.find((c) => c.destroyed);
    if (rubble) next = buyRebuild(next, rubble.id, id);
  }

  if (kind === 'economy') {
    if (researchCount(next, id) < 2 && canBuyResearch(next, id)) {
      const spot = next.nations[id].cities.find((c) => !c.destroyed && !c.hasResearch);
      if (spot) next = buyResearch(next, spot.id, id);
    }
    if (canBuyShield(next, id)) {
      const spot = exposedCity(next, id);
      if (spot) next = buyShield(next, spot.id, id);
    }
    return sanctionLeader(next, id);
  }

  if (kind === 'turtle') {
    if (researchCount(next, id) < 1 && canBuyResearch(next, id)) {
      const spot = next.nations[id].cities.find((c) => !c.destroyed && !c.hasResearch);
      if (spot) next = buyResearch(next, spot.id, id);
    }
    if (canBuyUnderground(next, id)) {
      const spot = anyCity(next, id);
      if (spot) next = buyUnderground(next, spot.id, id);
    }
    if (canBuyShield(next, id)) {
      const spot = exposedCity(next, id);
      if (spot) next = buyShield(next, spot.id, id);
    }
    return sanctionLeader(next, id);
  }

  if (kind === 'rusher') {
    if (!next.nations[id].hasNuclearTech && money() >= COSTS.ballisticMissileTech + COSTS.bomb) {
      next = buyNuclearTech(next, id);
    }
    while (
      next.nations[id].hasNuclearTech &&
      money() >= COSTS.bomb &&
      next.nations[id].bombsBoughtThisRound < 3
    ) {
      next = buyBomb(next, id);
    }
    while (next.nations[id].bombs > 0) {
      const t = rivalTarget(next, id);
      if (!t) break;
      const before = next;
      next = queueStrike(next, t.nationId, t.cityId, id);
      if (next === before) break;
    }
    return sanctionLeader(next, id);
  }

  if (kind === 'swarmer') {
    if (!next.nations[id].hasAerospaceTech && money() >= COSTS.aerospaceTech + COSTS.drone) {
      next = buyAerospaceTech(next, id);
    }
    while (
      next.nations[id].hasAerospaceTech &&
      money() >= COSTS.drone &&
      next.nations[id].dronesBoughtThisRound < 3
    ) {
      next = buyDrone(next, id);
    }
    while (next.nations[id].drones > 0) {
      const t = rivalTarget(next, id);
      if (!t) break;
      const before = next;
      next = queueStrike(next, t.nationId, t.cityId, id, 'drone');
      if (next === before) break;
    }
    return sanctionLeader(next, id);
  }

  // balanced: research once, shield, then arm like a mild rusher
  if (researchCount(next, id) < 1 && canBuyResearch(next, id)) {
    const spot = next.nations[id].cities.find((c) => !c.destroyed && !c.hasResearch);
    if (spot) next = buyResearch(next, spot.id, id);
  }
  if (canBuyShield(next, id)) {
    const spot = exposedCity(next, id);
    if (spot) next = buyShield(next, spot.id, id);
  }
  if (canBuySpyNetwork(next, id) && next.round >= 2 && money() >= COSTS.spy + COSTS.bomb) {
    next = buySpyNetwork(next, id);
  }
  if (!next.nations[id].hasNuclearTech && next.round >= 2 && money() >= COSTS.ballisticMissileTech + COSTS.bomb) {
    next = buyNuclearTech(next, id);
  }
  if (next.nations[id].hasNuclearTech && money() >= COSTS.bomb) {
    next = buyBomb(next, id);
  }
  while (next.nations[id].bombs > 0) {
    const t = rivalTarget(next, id);
    if (!t) break;
    const before = next;
    next = queueStrike(next, t.nationId, t.cityId, id);
    if (next === before) break;
  }
  return sanctionLeader(next, id);
}

export type MatchStats = {
  winnerArchetype: Archetype | null;
  seatArchetypes: Archetype[];
  citiesDestroyed: number;
  quietRounds: number;
  roundsPlayed: number;
  killsByRound: number[];
  finalScores: number[];
  eliminated: number;
  /** Spread between 1st and 2nd living score at game end */
  scoreSpread: number;
  angelAwards: number;
  evilAwards: number;
  totalAttackPoints: number;
  totalAngelPoints: number;
  totalInfamyPoints: number;
  winnerAttackShare: number;
  winnerSurvivalShare: number;
};

function playMatch(seed: number): MatchStats {
  const rng = mulberry32(seed);
  const seats = pickSeats(rng, TABLE_SIZE);
  const kinds = pickArchetypes(rng);
  const byNation = Object.fromEntries(seats.map((id, i) => [id, kinds[i]])) as Record<
    NationId,
    Archetype
  >;

  const base = createInitialState();
  const nations = { ...base.nations } as Record<NationId, NationState>;
  for (const id of seats) {
    nations[id] = { ...nations[id], isHuman: false };
  }
  let s = startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable(seats, { size: TABLE_SIZE }),
    humanNations: [],
    nations,
  });

  const killsByRound: number[] = [];
  let citiesDestroyed = 0;
  let quietRounds = 0;
  let angelAwards = 0;
  let evilAwards = 0;
  let guard = 0;

  while (s.phase !== 'gameOver' && guard++ < 60) {
    if (s.phase === 'buy' || s.phase === 'action') {
      let turnGuard = 0;
      while ((s.phase === 'buy' || s.phase === 'action') && turnGuard++ < 20) {
        const id = s.turnOrder[s.currentTurnIndex];
        if (!id || s.nations[id].eliminated) {
          s = endTurn(s);
          continue;
        }
        s = planArchetype(s, id, byNation[id]);
        s = endTurn(s);
      }
      continue;
    }

    if (s.phase === 'resolveStrikes') {
      const pending = [...s.pendingStrikes];
      for (const strike of orderStrikesForResolution(pending)) {
        s = applyQueuedStrike(s, strike);
      }
      s = finishStrikeResolution(s);
      continue;
    }

    if (s.phase === 'roundSummary') {
      const destroyed = (s.previousRoundEvents ?? []).filter((e) => e.kind === 'cityDestroyed')
        .length;
      killsByRound[s.round - 1] = (killsByRound[s.round - 1] ?? 0) + destroyed;
      citiesDestroyed += destroyed;
      if (destroyed === 0) quietRounds += 1;
      if (s.angelNationId) angelAwards += 1;
      if (s.evilNationId) evilAwards += 1;
      s = nextRound(s);
      continue;
    }

    break;
  }

  const winner = s.winner;
  const scored = s.turnOrder.map((id) => computeScore(s, id));
  const living = scored.filter((r) => !r.eliminated).sort((a, b) => b.total - a.total);
  const scoreSpread =
    living.length >= 2 ? living[0].total - living[1].total : living[0]?.total ?? 0;
  const scores = scored.map((r) => r.total);
  const totalAttackPoints = scored.reduce((sum, r) => sum + (r.attackPoints ?? 0), 0);
  const totalAngelPoints = scored.reduce((sum, r) => sum + (r.angelPoints ?? 0), 0);
  const totalInfamyPoints = scored.reduce((sum, r) => sum + (r.infamyPoints ?? 0), 0);
  const winRow = winner ? scored.find((r) => r.nationId === winner) : null;
  const winTotal = Math.max(1, winRow?.total ?? 1);

  return {
    winnerArchetype: winner ? byNation[winner] : null,
    seatArchetypes: kinds,
    citiesDestroyed,
    quietRounds,
    roundsPlayed: s.round,
    killsByRound,
    finalScores: scores,
    eliminated: s.turnOrder.filter((id) => s.nations[id].eliminated).length,
    scoreSpread,
    angelAwards,
    evilAwards,
    totalAttackPoints,
    totalAngelPoints,
    totalInfamyPoints,
    winnerAttackShare: (winRow?.attackPoints ?? 0) / winTotal,
    winnerSurvivalShare: (winRow?.citySurvivalPoints ?? 0) / winTotal,
  };
}

export type SuiteResult = {
  profile: BalanceProfile['name'];
  matches: number;
  avgCitiesDestroyed: number;
  avgQuietRoundShare: number;
  avgRounds: number;
  avgEliminated: number;
  killsByRound: number[];
  winRate: Record<Archetype, number>;
  winGap: number;
  pointlessShare: number;
  avgScoreSpread: number;
  avgAngelAwards: number;
  avgEvilAwards: number;
  avgAttackPoints: number;
  avgAngelPoints: number;
  avgInfamyPoints: number;
  avgWinnerAttackShare: number;
  avgWinnerSurvivalShare: number;
  /** Share of matches where at least 2 cities fell */
  eventfulShare: number;
  /** Share of matches decided by ≤20 points */
  closeFinishShare: number;
};

export function runSuite(profile: BalanceProfile, matches: number, seed0: number): SuiteResult {
  applyBalanceProfile(profile);
  const wins: Record<Archetype, number> = {
    economy: 0,
    turtle: 0,
    rusher: 0,
    swarmer: 0,
    balanced: 0,
    shipped: 0,
  };
  let cities = 0;
  let quiet = 0;
  let rounds = 0;
  let eliminated = 0;
  let pointless = 0;
  let eventful = 0;
  let closeFinish = 0;
  let scoreSpread = 0;
  let angelAwards = 0;
  let evilAwards = 0;
  let attackPoints = 0;
  let angelPoints = 0;
  let infamyPoints = 0;
  let winnerAttack = 0;
  let winnerSurvival = 0;
  const killsByRound = [0, 0, 0, 0, 0, 0, 0, 0];
  const appearances: Record<Archetype, number> = {
    economy: 0,
    turtle: 0,
    rusher: 0,
    swarmer: 0,
    balanced: 0,
    shipped: 0,
  };

  for (let i = 0; i < matches; i += 1) {
    const m = playMatch(seed0 + i * 9973);
    cities += m.citiesDestroyed;
    quiet += m.quietRounds;
    rounds += m.roundsPlayed;
    eliminated += m.eliminated;
    scoreSpread += m.scoreSpread;
    angelAwards += m.angelAwards;
    evilAwards += m.evilAwards;
    attackPoints += m.totalAttackPoints;
    angelPoints += m.totalAngelPoints;
    infamyPoints += m.totalInfamyPoints;
    winnerAttack += m.winnerAttackShare;
    winnerSurvival += m.winnerSurvivalShare;
    for (let r = 0; r < m.killsByRound.length; r += 1) {
      killsByRound[r] = (killsByRound[r] ?? 0) + m.killsByRound[r];
    }
    if (m.citiesDestroyed === 0) pointless += 1;
    if (m.citiesDestroyed >= 2) eventful += 1;
    if (m.scoreSpread <= 20) closeFinish += 1;
    if (m.winnerArchetype) wins[m.winnerArchetype] += 1;
    for (const a of m.seatArchetypes) appearances[a] += 1;
  }

  const winRate = Object.fromEntries(
    ARCHETYPES.map((a) => [a, (wins[a] / Math.max(1, appearances[a])) * 100]),
  ) as Record<Archetype, number>;
  const rates = Object.values(winRate);
  const winGap = Math.max(...rates) - Math.min(...rates);

  return {
    profile: profile.name,
    matches,
    avgCitiesDestroyed: cities / matches,
    avgQuietRoundShare: quiet / Math.max(1, rounds),
    avgRounds: rounds / matches,
    avgEliminated: eliminated / matches,
    killsByRound: killsByRound.map((k) => k / matches),
    winRate,
    winGap,
    pointlessShare: pointless / matches,
    avgScoreSpread: scoreSpread / matches,
    avgAngelAwards: angelAwards / matches,
    avgEvilAwards: evilAwards / matches,
    avgAttackPoints: attackPoints / matches,
    avgAngelPoints: angelPoints / matches,
    avgInfamyPoints: infamyPoints / matches,
    avgWinnerAttackShare: winnerAttack / matches,
    avgWinnerSurvivalShare: winnerSurvival / matches,
    eventfulShare: eventful / matches,
    closeFinishShare: closeFinish / matches,
  };
}

export function compareSuites(
  matches = 800,
  seed0 = 42,
): { legacy: SuiteResult; current: SuiteResult } {
  const legacy = runSuite(LEGACY_PROFILE, matches, seed0);
  const current = runSuite(CURRENT_PROFILE, matches, seed0);
  applyBalanceProfile(CURRENT_PROFILE);
  return { legacy, current };
}
