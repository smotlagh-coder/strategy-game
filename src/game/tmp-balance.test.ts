/* TEMPORARY balance-search harness. Delete after the analysis. */
import { describe, it } from 'vitest';
import {
  allScores,
  buyLaser,
  canBuyLaser,
  laserInterceptsLeft,
  applyQueuedStrike,
  buyAerospaceTech,
  buyBomb,
  buyDrone,
  buyNuclearTech,
  buyRebuild,
  buyResearch,
  buyShield,
  buyUnderground,
  canBuyBombs,
  canBuyDrones,
  createInitialState,
  finishStrikeResolution,
  nextRound,
  orderStrikesForResolution,
  queueStrike,
  seatTable,
  startGame,
  toggleSanction,
} from './engine';
import { runAiNationTurn } from './ai';
import { COSTS, MAX_BOMBS_PER_ROUND, MAX_DRONES_PER_ROUND } from '../data/nations';
import type { City, GameState, NationId } from '../types';

// ---------------------------------------------------------------- rule config

interface Rules {
  startMoney: number;
  baseIncome: number;
  researchIncome: number;
  survivalPerCity: number;
  cityPts: number;
  researchPts: number;
  shieldPts: number;
  droneDamage: number;
  nuclearTech: number;
  aerospaceTech: number;
  bomb: number;
  drone: number;
  shield: number;
  laser: number;
  research: number;
  rebuild: number;
  underground: number;
  /** points the attacker banks per city it levels */
  killPts: number;
  /** points the attacker banks per shield it burns through */
  shieldBreakPts: number;
  /** cap on shields a nation may install in one round (Infinity = today) */
  shieldsPerRound: number;
  /** cap on research centres per nation (Infinity = today) */
  researchCap: number;
  /** rounds between buying nuclear tech and being able to buy warheads */
  bombDelay: number;
  droneDelay: number;
}

const CURRENT: Rules = {
  startMoney: 14,
  baseIncome: 3,
  researchIncome: 1.5,
  survivalPerCity: 10,
  cityPts: 30,
  researchPts: 12,
  shieldPts: 8,
  droneDamage: 1.5,
  nuclearTech: 5,
  aerospaceTech: 2,
  bomb: 2.5,
  drone: 1,
  shield: 3,
  laser: 2.5,
  research: 2,
  rebuild: 6,
  underground: 6,
  killPts: 0,
  shieldBreakPts: 0,
  shieldsPerRound: Infinity,
  researchCap: Infinity,
  bombDelay: 1,
  droneDelay: 1,
};

/** Only the laser price is swept here; everything else is the shipped rule. */
function applyRules(r: Rules) {
  (COSTS as unknown as Record<string, number>).laser = r.laser;
}

// ------------------------------------------------------------------ policies

type Policy = (s: GameState, id: NationId, r: Rules) => GameState;

/** Per-match randomness: without it every seating replays the same match. */
let RNG: () => number = Math.random;
const shuffled = <T,>(xs: T[]): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(RNG() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const someCity = (cs: City[]) => shuffled(cs)[0];

const mine = (s: GameState, id: NationId) => s.nations[id];
const alive = (s: GameState) => s.turnOrder.filter((n) => !s.nations[n].eliminated);
const living = (s: GameState, id: NationId) => mine(s, id).cities.filter((c) => !c.destroyed);
const cash = (s: GameState, id: NationId) => mine(s, id).money;

/** Rivals ranked by the score they are on track to win with. */
function rivalsByScore(s: GameState, id: NationId): NationId[] {
  const scores = new Map(allScores(s).map((sc) => [sc.nationId, sc.total]));
  const ranked = shuffled(alive(s).filter((n) => n !== id)).sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
  );
  // A human would not always pick the exact leader, so sometimes take the #2
  if (ranked.length > 1 && RNG() < 0.25) [ranked[0], ranked[1]] = [ranked[1], ranked[0]];
  return ranked;
}

function nukeTarget(s: GameState, id: NationId): { nationId: NationId; city: City } | null {
  for (const rival of rivalsByScore(s, id)) {
    const suppressible = s.nations[id].drones > laserInterceptsLeft(s, rival);
    const cities = shuffled(s.nations[rival].cities).filter(
      (c) =>
        !c.destroyed &&
        !c.isUnderground &&
        !s.nations[id].citiesStruckThisRound.includes(c.id) &&
        (!c.hasShield || suppressible),
    );
    const open = cities.filter((c) => !c.hasShield);
    const pick = open.sort((a, b) => Number(b.hasResearch) - Number(a.hasResearch))[0] ?? cities[0];
    if (pick) return { nationId: rival, city: pick };
  }
  return null;
}

function droneTarget(s: GameState, id: NationId): { nationId: NationId; city: City } | null {
  const swarms = s.nations[id].drones;
  for (const rival of rivalsByScore(s, id)) {
    // A laser network burns swarms for nothing unless there are enough in
    // hand to outlast its shots
    const shots = laserInterceptsLeft(s, rival);
    if (shots > 0 && swarms <= shots) continue;
    const cities = shuffled(s.nations[rival].cities).filter(
      (c) => !c.destroyed && !s.nations[id].citiesDronedThisRound.includes(c.id),
    );
    const pick = cities.sort((a, b) => Number(b.hasResearch) - Number(a.hasResearch))[0];
    if (pick) return { nationId: rival, city: pick };
  }
  return null;
}

/** Squeeze the two rivals in front — the slots are limited now. */
function sanctionAll(s: GameState, id: NationId): GameState {
  let out = s;
  for (const rival of rivalsByScore(out, id).slice(0, 2)) {
    if (!out.nations[id].sanctions.includes(rival)) out = toggleSanction(out, rival, id);
  }
  return out;
}

/** Install the national laser network if swarms are in the air. */
function buyNetwork(s: GameState, id: NationId, budget: () => number): GameState {
  if (!canBuyLaser(s, id) || budget() < COSTS.laser) return s;
  const cities = s.nations[id].cities.filter((c) => !c.destroyed && !c.hasLaser);
  const pick = cities.find((c) => c.isUnderground) ?? cities.find((c) => c.hasShield) ?? cities[0];
  return pick ? buyLaser(s, pick.id, id) : s;
}

function buyShields(s: GameState, id: NationId, r: Rules, budget: () => number): GameState {
  let out = s;
  let installed = 0;
  while (installed < r.shieldsPerRound && installed < 4) {
    const spot = someCity(living(out, id).filter((c) => !c.hasShield));
    if (!spot || budget() < COSTS.shield) break;
    const next = buyShield(out, spot.id, id);
    if (next === out) break;
    out = next;
    installed += 1;
  }
  return out;
}

function buyResearchUpTo(
  s: GameState,
  id: NationId,
  cap: number,
  budget: () => number,
): GameState {
  let out = s;
  for (let i = 0; i < 4; i += 1) {
    if (living(out, id).filter((c) => c.hasResearch).length >= cap) break;
    if (budget() < COSTS.research) break;
    const spot = someCity(living(out, id).filter((c) => !c.hasResearch));
    if (!spot) break;
    const next = buyResearch(out, spot.id, id);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Per-round caps make repeat buys silent no-ops, so every loop is counted. */
function stockBombs(
  s: GameState,
  id: NationId,
  want: number,
  budget: () => number,
  reserve: number,
): GameState {
  let out = s;
  for (let i = 0; i < want; i += 1) {
    if (!canBuyBombs(out, id) || budget() < COSTS.bomb + reserve) break;
    const next = buyBomb(out, id);
    if (next === out) break;
    out = next;
  }
  return out;
}

function stockDrones(
  s: GameState,
  id: NationId,
  want: number,
  budget: () => number,
  reserve: number,
): GameState {
  let out = s;
  for (let i = 0; i < want; i += 1) {
    if (!canBuyDrones(out, id) || budget() < COSTS.drone + reserve) break;
    const next = buyDrone(out, id);
    if (next === out) break;
    out = next;
  }
  return out;
}

function fireEverything(s: GameState, id: NationId): GameState {
  let out = s;
  let guard = 0;
  while (out.nations[id].bombs > 0 && guard++ < 12) {
    const t = nukeTarget(out, id);
    if (!t) break;
    out = queueStrike(out, t.nationId, t.city.id, id);
    if (t.city.hasShield && !t.city.hasLaser && out.nations[id].drones > 0) {
      out = queueStrike(out, t.nationId, t.city.id, id, 'drone');
    }
  }
  guard = 0;
  while (out.nations[id].drones > 0 && guard++ < 12) {
    const t = droneTarget(out, id);
    if (!t) break;
    out = queueStrike(out, t.nationId, t.city.id, id, 'drone');
  }
  return out;
}

/** Rebuild whenever it is affordable and a city is missing. */
function rebuildIfCheap(s: GameState, id: NationId, budget: () => number): GameState {
  const gone = mine(s, id).cities.find((c) => c.destroyed);
  if (gone && budget() >= COSTS.rebuild && s.round < s.maxRounds) {
    return buyRebuild(s, gone.id, id);
  }
  return s;
}

/** Economy first: research, then shields. No offence ever. */
const econ: Policy = (s, id, r) => {
  let out: GameState = { ...s, currentTurnIndex: s.turnOrder.indexOf(id), phase: 'buy' };
  const budget = () => cash(out, id);
  out = buyResearchUpTo(out, id, Math.min(r.researchCap, 3), budget);
  out = buyShields(out, id, r, budget);
  out = rebuildIfCheap(out, id, budget);
  return sanctionAll(out, id);
};

/** Pure defence: shields, then bunkers, then research. */
const turtle: Policy = (s, id, r) => {
  let out: GameState = { ...s, currentTurnIndex: s.turnOrder.indexOf(id), phase: 'buy' };
  const budget = () => cash(out, id);
  out = buyShields(out, id, r, budget);
  const bunker = living(out, id).find((c) => !c.isUnderground);
  if (bunker && budget() >= COSTS.underground && !out.nations[id].cities.some((c) => c.isUnderground)) {
    out = buyUnderground(out, bunker.id, id);
  }
  out = buyResearchUpTo(out, id, Math.min(r.researchCap, 3), budget);
  out = buyNetwork(out, id, budget);
  out = rebuildIfCheap(out, id, budget);
  return sanctionAll(out, id);
};

/** Warheads as early and as often as possible, defence only with spare change. */
const rush: Policy = (s, id, r) => {
  let out: GameState = { ...s, currentTurnIndex: s.turnOrder.indexOf(id), phase: 'buy' };
  const budget = () => cash(out, id);
  if (!mine(out, id).hasNuclearTech && budget() >= COSTS.nuclearTech) {
    out = buyNuclearTech(out, id);
  }
  if (!mine(out, id).hasAerospaceTech && budget() >= COSTS.aerospaceTech + COSTS.bomb) {
    out = buyAerospaceTech(out, id);
  }
  out = stockBombs(out, id, MAX_BOMBS_PER_ROUND, budget, 0);
  out = stockDrones(out, id, MAX_DRONES_PER_ROUND, budget, COSTS.shield);
  out = buyShields(out, id, r, budget);
  out = rebuildIfCheap(out, id, budget);
  out = sanctionAll(out, id);
  return fireEverything(out, id);
};

/** Cheap economic warfare: aerospace, swarms every round, one shield. */
const swarm: Policy = (s, id, r) => {
  let out: GameState = { ...s, currentTurnIndex: s.turnOrder.indexOf(id), phase: 'buy' };
  const budget = () => cash(out, id);
  if (!mine(out, id).hasAerospaceTech && budget() >= COSTS.aerospaceTech) {
    out = buyAerospaceTech(out, id);
  }
  out = buyResearchUpTo(out, id, Math.min(r.researchCap, 1), budget);
  out = stockDrones(out, id, MAX_DRONES_PER_ROUND, budget, 0);
  out = buyShields(out, id, r, budget);
  out = rebuildIfCheap(out, id, budget);
  out = sanctionAll(out, id);
  return fireEverything(out, id);
};

/** One research centre, then alternate shield and warhead. */
const balanced: Policy = (s, id, r) => {
  let out: GameState = { ...s, currentTurnIndex: s.turnOrder.indexOf(id), phase: 'buy' };
  const budget = () => cash(out, id);
  out = buyResearchUpTo(out, id, Math.min(r.researchCap, 1), budget);
  if (!mine(out, id).hasNuclearTech && budget() >= COSTS.nuclearTech + COSTS.shield) {
    out = buyNuclearTech(out, id);
  }
  if (r.shieldsPerRound >= 1 && budget() >= COSTS.shield) {
    const spot = someCity(living(out, id).filter((c) => !c.hasShield));
    if (spot) out = buyShield(out, spot.id, id);
  }
  if (!mine(out, id).hasAerospaceTech && budget() >= COSTS.aerospaceTech + COSTS.bomb) {
    out = buyAerospaceTech(out, id);
  }
  out = buyNetwork(out, id, budget);
  out = stockBombs(out, id, MAX_BOMBS_PER_ROUND, budget, 0);
  out = stockDrones(out, id, MAX_DRONES_PER_ROUND, budget, 0);
  out = buyShields(out, id, r, budget);
  out = rebuildIfCheap(out, id, budget);
  out = sanctionAll(out, id);
  return fireEverything(out, id);
};

/** Air defence as a strategy: aerospace, the network, shields, research. */
const aegis: Policy = (s, id, r) => {
  let out: GameState = { ...s, currentTurnIndex: s.turnOrder.indexOf(id), phase: 'buy' };
  const budget = () => cash(out, id);
  if (!mine(out, id).hasAerospaceTech && budget() >= COSTS.aerospaceTech + COSTS.laser) {
    out = buyAerospaceTech(out, id);
  }
  out = buyNetwork(out, id, budget);
  out = buyShields(out, id, r, budget);
  out = buyResearchUpTo(out, id, Math.min(r.researchCap, 2), budget);
  out = stockDrones(out, id, MAX_DRONES_PER_ROUND, budget, 0);
  out = rebuildIfCheap(out, id, budget);
  out = sanctionAll(out, id);
  return fireEverything(out, id);
};

/** The AI that actually ships. */
const shipped: Policy = (s, id) => runAiNationTurn(s, id);

const POLICIES: { name: string; run: Policy }[] = [
  { name: 'econ', run: econ },
  { name: 'turtle', run: turtle },
  { name: 'rush', run: rush },
  { name: 'swarm', run: swarm },
  { name: 'balanced', run: balanced },
  { name: 'aegis', run: aegis },
  { name: 'shipped', run: shipped },
];

// -------------------------------------------------------------- match runner

interface MatchResult {
  winner: string;
  /** cities levelled in each round, index 0 = round 1 */
  killsByRound: number[];
  /** table-wide $M spent per round on offence / defence / economy */
  offenceByRound: number[];
  defenceByRound: number[];
  economyByRound: number[];
  bombs: number;
  drones: number;
  shields: number;
  research: number;
  /** laser batteries standing at the end, and swarms they shot down */
  batteries: number;
  intercepts: number;
  droneBills: number;
  /** how often the points leader changed hands after round 1 */
  leadChanges: number;
  /** winning margin over the runner-up, in points */
  margin: number;
  /** nations wiped off the board, and cities still standing at the end */
  eliminated: number;
  standing: number;
  earlyWipe: boolean;
  scoreMix: { cities: number; research: number; shields: number; survival: number; kills: number };
}

/** Snapshot of everything a nation could have paid for, for round-by-round spend. */
function assets(s: GameState) {
  let shields = 0;
  let lasers = 0;
  let research = 0;
  let bunkers = 0;
  let tech = 0;
  let bombs = 0;
  let drones = 0;
  let rebuilds = 0;
  for (const id of s.turnOrder) {
    const n = s.nations[id];
    shields += n.cities.filter((c) => c.hasShield).length;
    lasers += n.cities.filter((c) => c.hasLaser).length;
    research += n.cities.filter((c) => c.hasResearch).length;
    bunkers += n.cities.filter((c) => c.isUnderground).length;
    tech += Number(n.hasNuclearTech) + Number(n.hasAerospaceTech);
    bombs += n.bombsUsed + n.bombs;
    drones += n.dronesUsed + n.drones;
    rebuilds += n.cities.filter((c) => c.rebuiltRound != null).length;
  }
  return { shields, lasers, research, bunkers, tech, bombs, drones, rebuilds };
}

function playMatch(seed: number, seats: { name: string; run: Policy }[], r: Rules): MatchResult {
  let rngState = seed * 2654435761;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };
  applyRules(r);
  RNG = rng;
  const base = createInitialState();
  let s = startGame({
    ...base,
    mode: 'single',
    turnOrder: seatTable([], { rng }),
    humanNations: [],
  });

  const byNation = new Map<NationId, { name: string; run: Policy }>();
  s.turnOrder.forEach((id, i) => byNation.set(id, seats[i % seats.length]));
  const kills = new Map<string, number>();
  const shieldBreaks = new Map<string, number>();
  const killsByRound: number[] = [];
  let intercepts = 0;
  let droneBills = 0;
  const offenceByRound: number[] = [];
  const defenceByRound: number[] = [];
  const economyByRound: number[] = [];
  let leadChanges = 0;
  let lastLeader = '';
  let eliminatedByRound3 = false;

  for (let guard = 0; guard < 40; guard += 1) {
    if (s.phase === 'gameOver') break;
    const before = assets(s);
    for (const id of alive(s)) {
      s = byNation.get(id)!.run(s, id, r);
    }
    const after = assets(s);
    offenceByRound.push(
      +(
        (after.bombs - before.bombs) * r.bomb +
        (after.drones - before.drones) * r.drone +
        (after.tech - before.tech) * ((r.nuclearTech + r.aerospaceTech) / 2)
      ).toFixed(2),
    );
    defenceByRound.push(
      +(
        (after.shields - before.shields) * r.shield +
        (after.lasers - before.lasers) * r.laser +
        (after.bunkers - before.bunkers) * r.underground +
        (after.rebuilds - before.rebuilds) * r.rebuild
      ).toFixed(2),
    );
    economyByRound.push(+((after.research - before.research) * r.research).toFixed(2));
    s = { ...s, phase: s.pendingStrikes.length > 0 ? 'resolveStrikes' : 'roundSummary' };
    let levelled = 0;
    if (s.phase === 'resolveStrikes') {
      // The UI applies strikes during the cinema, then closes the round
      for (const strike of orderStrikesForResolution(s.pendingStrikes)) {
        s = applyQueuedStrike(s, strike);
      }
      for (const e of s.roundEvents) {
        if (e.kind === 'dronesIntercepted') intercepts += 1;
        if (e.kind === 'droneDamage') droneBills += e.amount ?? 0;
        const who = e.attackerId ? byNation.get(e.attackerId)?.name : undefined;
        if (!who) continue;
        if (e.kind === 'cityDestroyed') {
          kills.set(who, (kills.get(who) ?? 0) + 1);
          levelled += 1;
        }
        if (e.kind === 'shieldDestroyed' || e.kind === 'strikeAbsorbed') {
          shieldBreaks.set(who, (shieldBreaks.get(who) ?? 0) + 1);
        }
      }
      s = finishStrikeResolution(s);
    }
    killsByRound.push(levelled);
    if (s.round <= 3 && s.turnOrder.some((id) => s.nations[id].eliminated)) eliminatedByRound3 = true;
    const leader = allScores(s).reduce((best, sc) => (sc.total > best.total ? sc : best));
    const leaderName = byNation.get(leader.nationId)!.name;
    if (lastLeader && leaderName !== lastLeader) leadChanges += 1;
    lastLeader = leaderName;
    if (s.round >= s.maxRounds) break;
    s = nextRound(s);
  }

  let best = { name: '—', total: -1 };
  let runnerUp = -1;
  const mix = { cities: 0, research: 0, shields: 0, survival: 0, kills: 0 };
  for (const sc of allScores(s)) {
    const name = byNation.get(sc.nationId)!.name;
    const bonus =
      (kills.get(name) ?? 0) * r.killPts + (shieldBreaks.get(name) ?? 0) * r.shieldBreakPts;
    const total = sc.total + bonus;
    if (total > best.total) {
      runnerUp = best.total;
      best = { name, total };
      const n = s.nations[sc.nationId];
      const live = n.cities.filter((c) => !c.destroyed);
      mix.cities = live.length * r.cityPts;
      mix.research = live.filter((c) => c.hasResearch).length * r.researchPts;
      mix.shields = live.filter((c) => c.hasShield).length * r.shieldPts;
      mix.survival = n.citySurvivalPoints;
      mix.kills = bonus;
    } else if (total > runnerUp) {
      runnerUp = total;
    }
  }

  let bombs = 0;
  let drones = 0;
  let shields = 0;
  let research = 0;
  let batteries = s.log.filter((l) => l.text.includes('laser defence network')).length;
  for (const id of s.turnOrder) {
    const n = s.nations[id];
    bombs += n.bombsUsed;
    drones += n.dronesUsed;
    shields += n.cities.filter((c) => c.hasShield && !c.destroyed).length;
    research += n.cities.filter((c) => c.hasResearch && !c.destroyed).length;
  }
  const eliminated = s.turnOrder.filter((id) => s.nations[id].eliminated).length;
  const standing = s.turnOrder.reduce(
    (t, id) => t + s.nations[id].cities.filter((c) => !c.destroyed).length,
    0,
  );
  return {
    winner: best.name,
    eliminated,
    standing,
    earlyWipe: eliminatedByRound3,
    killsByRound,
    offenceByRound,
    defenceByRound,
    economyByRound,
    bombs,
    drones,
    shields,
    research,
    batteries,
    intercepts,
    droneBills: +droneBills.toFixed(2),
    leadChanges,
    margin: +Math.max(0, best.total - Math.max(0, runnerUp)).toFixed(0),
    scoreMix: mix,
  };
}

interface Report {
  label: string;
  winRate: Record<string, number>;
  spread: number;
  killsPerGame: number;
  killsByRound: number[];
  offenceByRound: number[];
  defenceByRound: number[];
  economyByRound: number[];
  bombs: number;
  drones: number;
  shields: number;
  research: number;
  batteries: number;
  intercepts: number;
  droneBills: number;
  leadChanges: number;
  margin: number;
  /** share of all destruction that lands in the last two rounds, % */
  lateShare: number;
  /** share of played rounds where nothing at all was destroyed, % */
  silentRounds: number;
  eliminated: number;
  standing: number;
  earlyWipe: number;
  winnerMix: Record<string, number>;
}

/** Round-robin: every game seats 5 of the 6 policies, rotating who sits out. */
function evaluate(label: string, r: Rules, games = 120): Report {
  const wins = new Map<string, number>();
  const played = new Map<string, number>();
  const killsByRound = [0, 0, 0, 0, 0];
  const offenceByRound = [0, 0, 0, 0, 0];
  const defenceByRound = [0, 0, 0, 0, 0];
  const economyByRound = [0, 0, 0, 0, 0];
  let leadChanges = 0;
  let margin = 0;
  let kills = 0;
  let silent = 0;
  let roundsPlayed = 0;
  let eliminated = 0;
  let standing = 0;
  let earlyWipe = 0;
  let bombs = 0;
  let drones = 0;
  let shields = 0;
  let research = 0;
  let batteries = 0;
  let intercepts = 0;
  let droneBills = 0;
  const mix = { cities: 0, research: 0, shields: 0, survival: 0, kills: 0 };

  for (let g = 0; g < games; g += 1) {
    // Random 5 of the 6 policies in random seats, so no policy owns a seat
    let seatRng = (g + 1) * 747796405;
    const draw = () => {
      seatRng = (seatRng * 1103515245 + 12345) & 0x7fffffff;
      return seatRng / 0x7fffffff;
    };
    const pool = [...POLICIES];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(draw() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const seats = pool.slice(0, 5);
    for (const p of seats) played.set(p.name, (played.get(p.name) ?? 0) + 1);
    const res = playMatch(g + 1, seats, r);
    wins.set(res.winner, (wins.get(res.winner) ?? 0) + 1);
    res.killsByRound.forEach((k, i) => {
      if (i < 5) killsByRound[i] += k;
      kills += k;
      roundsPlayed += 1;
      if (k === 0) silent += 1;
    });
    res.offenceByRound.forEach((v, i) => {
      if (i < 5) offenceByRound[i] += v;
    });
    res.defenceByRound.forEach((v, i) => {
      if (i < 5) defenceByRound[i] += v;
    });
    res.economyByRound.forEach((v, i) => {
      if (i < 5) economyByRound[i] += v;
    });
    leadChanges += res.leadChanges;
    eliminated += res.eliminated;
    standing += res.standing;
    earlyWipe += res.earlyWipe ? 1 : 0;
    margin += res.margin;
    bombs += res.bombs;
    drones += res.drones;
    shields += res.shields;
    research += res.research;
    batteries += res.batteries;
    intercepts += res.intercepts;
    droneBills += res.droneBills;
    for (const k of Object.keys(mix) as (keyof typeof mix)[]) mix[k] += res.scoreMix[k];
  }

  const winRate: Record<string, number> = {};
  for (const p of POLICIES) {
    winRate[p.name] = +(((wins.get(p.name) ?? 0) / (played.get(p.name) || 1)) * 100).toFixed(1);
  }
  const rates = Object.values(winRate);
  const mixTotal = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  return {
    label,
    winRate,
    spread: +(Math.max(...rates) - Math.min(...rates)).toFixed(1),
    killsPerGame: +(kills / games).toFixed(2),
    killsByRound: killsByRound.map((k) => +(k / games).toFixed(2)),
    offenceByRound: offenceByRound.map((k) => +(k / games).toFixed(1)),
    defenceByRound: defenceByRound.map((k) => +(k / games).toFixed(1)),
    economyByRound: economyByRound.map((k) => +(k / games).toFixed(1)),
    leadChanges: +(leadChanges / games).toFixed(2),
    lateShare: +(((killsByRound[3] + killsByRound[4]) / (kills || 1)) * 100).toFixed(0),
    silentRounds: +((silent / (roundsPlayed || 1)) * 100).toFixed(0),
    eliminated: +(eliminated / games).toFixed(2),
    standing: +(standing / games).toFixed(1),
    earlyWipe: +((earlyWipe / games) * 100).toFixed(0),
    margin: +(margin / games).toFixed(0),
    bombs: +(bombs / games).toFixed(2),
    drones: +(drones / games).toFixed(2),
    shields: +(shields / games).toFixed(2),
    research: +(research / games).toFixed(2),
    batteries: +(batteries / games).toFixed(2),
    intercepts: +(intercepts / games).toFixed(2),
    droneBills: +(droneBills / games).toFixed(2),
    winnerMix: Object.fromEntries(
      Object.entries(mix).map(([k, v]) => [k, +((v / mixTotal) * 100).toFixed(0)]),
    ),
  };
}

const tweak = (label: string, patch: Partial<Rules>) => ({
  label,
  rules: { ...CURRENT, ...patch },
});

const D: Partial<Rules> = { droneDelay: 0, bombDelay: 0, baseIncome: 5, startMoney: 12 };
const F: Partial<Rules> = { droneDelay: 0, bombDelay: 0, baseIncome: 6, startMoney: 10 };

const SAME: Partial<Rules> = { droneDelay: 0, bombDelay: 0 };
const CORE: Partial<Rules> = {
  ...SAME,
  startMoney: 14,
  shieldsPerRound: 1,
  nuclearTech: 4,
};

const CANDIDATES: { label: string; rules: Rules }[] = [
  { label: 'no lasers (price 99)', rules: { ...CURRENT, laser: 99 } },
  { label: 'laser $2.0M', rules: { ...CURRENT, laser: 2 } },
  { label: 'laser $2.5M (shipped)', rules: { ...CURRENT, laser: 2.5 } },
  { label: 'laser $3.5M', rules: { ...CURRENT, laser: 3.5 } },
  { label: 'laser $5M', rules: { ...CURRENT, laser: 5 } },
];

describe('balance search', () => {
  it('measures dominance and pacing', () => {
    const rows = CANDIDATES.map((c) => {
      const rep = evaluate(c.label, c.rules, 2000);
      return [
        rep.label,
        rep.spread,
        Object.values(rep.winRate).join('/'),
        rep.killsPerGame,
        `batteries ${rep.batteries}`,
        `intercepts ${rep.intercepts}`,
        `droneBills $${rep.droneBills}M`,
        `dronesFlown ${rep.drones}`,
        rep.killsByRound.join('|'),
        rep.lateShare,
        rep.silentRounds,
        rep.eliminated,
        rep.standing,
        rep.earlyWipe,
        rep.offenceByRound.join('|'),
        rep.defenceByRound.join('|'),
        rep.leadChanges,
        rep.margin,
        Object.values(rep.winnerMix).join('/'),
      ].join('  ');
    });
    throw new Error(
      [
        'label | spread | win% econ/turtle/rush/swarm/balanced/aegis/shipped | kills | kills r1-5 | late% | silent% | elim | standing | earlyWipe% | offence$ r1-5 | defence$ r1-5 | leadChg | margin | winner mix cities/res/shield/surv/kill',
        ...rows,
      ].join('\n'),
    );
  });
});
