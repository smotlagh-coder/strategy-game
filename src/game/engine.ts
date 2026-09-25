import {
  COSTS,
  INCOME_PER_CITY,
  DRONE_DAMAGE,
  MAX_BOMBS_PER_ROUND,
  MAX_HYDROGEN_PER_GAME,
  MAX_MAGNETIC_PER_GAME,
  MAX_DRONES_PER_ROUND,
  LASER_INTERCEPTS_PER_ROUND,
  MAX_SANCTIONS,
  MAX_RESEARCH_PER_ROUND,
  MAX_SHIELDS_PER_ROUND,
  MAX_OVERTIME_ROUNDS,
  MAX_ROUNDS,
  NATIONS,
  RESEARCH_INCOME,
  TABLE_SIZE,
  SANCTION_PENALTY,
  MAX_SANCTION_CUT,
  SCORE_BUNKER,
  SCORE_CITY,
  SCORE_RESEARCH,
  SCORE_SHIELD,
  SCORE_KILL,
  SCORE_ELIMINATION,
  SCORE_ANGEL,
  SCORE_EVIL,
  SURVIVAL_POINTS_PER_CITY,
  initialNation,
  nationDef,
} from '../data/nations';
import { displayNameOnly } from '../lib/session';
import {
  AFTERMATH_THINK_MS,
  RECAP_AUTO_MS,
  SELECTION_IDLE_MS,
  STRIKE_CINEMA_MS,
} from '../lib/onlineConstants';
import type {
  City,
  GameMode,
  GameState,
  IncomeLedgerEntry,
  LogEntry,
  NationId,
  NationState,
  PendingStrike,
  RoundScore,
  RoundWorldEvent,
  StrikeWeapon,
  WarheadKind,
} from '../types';

export type { StrikeWeapon, WarheadKind };

/** All ballistic warheads currently in stock. */
export function totalWarheads(n: Pick<NationState, 'bombs' | 'hydrogenBombs' | 'magneticBombs'>): number {
  return (
    (n.bombs ?? 0) + (n.hydrogenBombs ?? 0) + (n.magneticBombs ?? 0)
  );
}

export function warheadStock(n: NationState, kind: WarheadKind): number {
  if (kind === 'hydrogen') return n.hydrogenBombs ?? 0;
  if (kind === 'magnetic') return n.magneticBombs ?? 0;
  return n.bombs ?? 0;
}

export function warheadCost(kind: WarheadKind): number {
  if (kind === 'hydrogen') return COSTS.bombHydrogen;
  if (kind === 'magnetic') return COSTS.bombMagnetic;
  return COSTS.bomb;
}

export function isWarhead(weapon: StrikeWeapon | undefined): weapon is WarheadKind {
  return weapon !== 'drone';
}

let logSeq = 0;
function log(text: string, tone: LogEntry['tone'] = 'neutral'): LogEntry {
  return { id: `log-${++logSeq}`, text, tone };
}

let eventSeq = 0;
function worldEvent(
  partial: Omit<RoundWorldEvent, 'id'>,
): RoundWorldEvent {
  return { id: `evt-${++eventSeq}`, ...partial };
}

/**
 * Replacement cost of a city and everything bolted onto it — used when a
 * warhead writes the seat off so the aftermath can say what the round cost.
 */
export function cityAssetValue(
  city: Pick<City, 'hasShield' | 'hasResearch' | 'hasLaser' | 'isUnderground'>,
): number {
  return +(
    COSTS.rebuild +
    (city.hasShield ? COSTS.shield : 0) +
    (city.hasResearch ? COSTS.research : 0) +
    (city.hasLaser ? COSTS.laser : 0) +
    (city.isUnderground ? COSTS.underground : 0)
  ).toFixed(2);
}

/** Capital wiped this round for one nation (cities + shields lost). */
export function assetLossFor(
  events: RoundWorldEvent[],
  nationId: NationId,
): number {
  return +events
    .filter(
      (e) =>
        e.nationId === nationId &&
        (e.kind === 'cityDestroyed' || e.kind === 'shieldDestroyed'),
    )
    .reduce((sum, e) => {
      if (e.amount != null) return sum + e.amount;
      // Older events without a stamp: city ≈ rebuild, shield ≈ shield
      return sum + (e.kind === 'shieldDestroyed' ? COSTS.shield : COSTS.rebuild);
    }, 0)
    .toFixed(2);
}

/**
 * Seat one match. Every human country plays; the empty chairs are dealt from
 * the countries nobody picked, so the AI line-up varies between matches.
 * Chairs listed in `keep` are held on to first, so one player's pick does not
 * reshuffle a table the others have already seen.
 */
export function seatTable(
  humans: NationId[],
  opts?: { keep?: NationId[]; size?: number; rng?: () => number },
): NationId[] {
  const size = Math.max(opts?.size ?? TABLE_SIZE, humans.length);
  const seats: NationId[] = [];
  const take = (id: NationId) => {
    if (seats.length < size && !seats.includes(id)) seats.push(id);
  };
  for (const id of humans) take(id);
  for (const id of opts?.keep ?? []) take(id);

  const rng = opts?.rng ?? Math.random;
  const pool = NATIONS.map((n) => n.id).filter((id) => !seats.includes(id));
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  while (seats.length < size && pool.length > 0) seats.push(pool.shift()!);
  return seats;
}

export function createInitialState(): GameState {
  const nations = Object.fromEntries(
    NATIONS.map((n) => [n.id, initialNation(n.id)]),
  ) as GameState['nations'];

  return {
    mode: null,
    phase: 'session',
    round: 1,
    maxRounds: MAX_ROUNDS,
    nations,
    turnOrder: seatTable([]),
    currentTurnIndex: 0,
    selectingFor: 1,
    humanNations: [],
    playerNames: {},
    roundScores: [],
    scoreHistory: [],
    log: [],
    winner: null,
    pendingCountryPick: null,
    pendingStrikes: [],
    roundEvents: [],
    lastIncomeLedger: [],
    uidToNation: {},
    onlineGameId: null,
    onlineLobbyId: null,
    onlineHostUid: null,
    humanReady: {},
    humanPlanningStartedAt: null,
    humanLastActive: {},
    humanHeartbeat: {},
    planningComplete: false,
    aiPlanningComplete: false,
    aftermathEndsAt: null,
    previousRoundEvents: [],
    previousRoundNumber: null,
    angelNationId: null,
    evilNationId: null,
  };
}

export function aliveNations(state: GameState): NationId[] {
  return state.turnOrder.filter((id) => !state.nations[id].eliminated);
}

export function aliveHumanNations(state: GameState): NationId[] {
  return state.turnOrder.filter(
    (id) => state.nations[id].isHuman && !state.nations[id].eliminated,
  );
}

export function allAliveHumansReady(state: GameState): boolean {
  const humans = aliveHumanNations(state);
  if (humans.length === 0) return true;
  return humans.every((id) => Boolean(state.humanReady?.[id]));
}

/** True when a human stopped sending presence or sat idle through the selection window. */
export function isHumanDisconnected(
  state: GameState,
  nationId: NationId,
  now = Date.now(),
): boolean {
  const n = state.nations[nationId];
  if (!n?.isHuman || n.eliminated) return false;
  if (state.humanReady?.[nationId]) return false;
  const last = state.humanLastActive?.[nationId] ?? state.humanPlanningStartedAt ?? 0;
  return last > 0 && now - last >= SELECTION_IDLE_MS;
}

export function markHumanReady(state: GameState, nationId: NationId): GameState {
  return {
    ...state,
    humanReady: { ...state.humanReady, [nationId]: true },
  };
}

export function touchHumanActivity(state: GameState, nationId: NationId, at = Date.now()): GameState {
  return {
    ...state,
    humanLastActive: { ...state.humanLastActive, [nationId]: at },
    humanPlanningStartedAt: state.humanPlanningStartedAt ?? at,
  };
}

/** Start/reset the parallel human selection window for this round. */
export function beginHumanPlanning(state: GameState, at = Date.now()): GameState {
  const humanLastActive: Partial<Record<NationId, number>> = {};
  const humanHeartbeat: Partial<Record<NationId, number>> = {};
  for (const id of aliveHumanNations(state)) {
    humanLastActive[id] = at;
    humanHeartbeat[id] = at;
  }
  return {
    ...state,
    humanReady: {},
    humanPlanningStartedAt: at,
    humanLastActive,
    humanHeartbeat,
    planningComplete: false,
    aiPlanningComplete: false,
  };
}

/**
 * Player left / idle kick — burn every city, mark OUT, and strip human ownership
 * so they no longer block planning.
 */
export function forfeitNation(state: GameState, nationId: NationId): GameState {
  const n = state.nations[nationId];
  if (!n || n.eliminated) return state;

  const ownerUid = n.ownerUid;
  const cities = n.cities.map((c) => ({
    ...c,
    destroyed: true,
    hasShield: false,
    hasResearch: false,
    hasLaser: false,
  }));

  const forfeited = {
    ...n,
    cities,
    researchCenters: 0,
    // Empty the treasury too, or the emergency rebuild would resurrect a leaver
    money: 0,
    bombs: 0,
    hydrogenBombs: 0,
    magneticBombs: 0,
    drones: 0,
    isHuman: false,
  };
  delete forfeited.playerSlot;
  delete forfeited.ownerUid;

  const uidToNation = { ...(state.uidToNation ?? {}) };
  if (ownerUid) delete uidToNation[ownerUid];
  for (const [uid, nid] of Object.entries(uidToNation)) {
    if (nid === nationId) delete uidToNation[uid];
  }

  const humanReady = { ...state.humanReady };
  delete humanReady[nationId];
  const humanLastActive = { ...state.humanLastActive };
  delete humanLastActive[nationId];
  const humanHeartbeat = { ...state.humanHeartbeat };
  delete humanHeartbeat[nationId];

  let next: GameState = {
    ...state,
    nations: { ...state.nations, [nationId]: forfeited },
    humanNations: state.humanNations.filter((id) => id !== nationId),
    uidToNation,
    humanReady,
    humanLastActive,
    humanHeartbeat,
    // Drop queued attacks from the leaver — they're out of the war
    pendingStrikes: state.pendingStrikes.filter((s) => s.attackerId !== nationId),
    log: [
      ...state.log,
      log(
        `${nationDef(nationId).name} left the game — all cities destroyed.`,
        'attack',
      ),
    ],
  };

  next = checkEliminations(next);
  next = checkWinner(next);
  return next;
}

/** After all humans finish planning: run AI turns, or resolve strikes if no AI left. */
export function startAiPhaseAfterHumans(state: GameState): GameState {
  const aiIdx = state.turnOrder.findIndex(
    (id) => !state.nations[id].isHuman && !state.nations[id].eliminated,
  );
  if (aiIdx === -1) return concludeRoundTurns(state);
  return { ...state, currentTurnIndex: aiIdx, phase: 'buy' };
}

/** Round complete after the last nation acts — resolve queued strikes or score. */
export function concludeRoundTurns(state: GameState): GameState {
  let next = checkEliminations(state);
  next = rememberScores(next, allScores(next));
  next = checkWinner(next);
  if (next.phase === 'gameOver') return next;

  if (next.pendingStrikes.length > 0) {
    return {
      ...next,
      phase: 'resolveStrikes',
      currentTurnIndex: Math.max(0, next.turnOrder.length - 1),
      log: [
        ...next.log,
        log('All targeting locked. Simultaneous strikes inbound…', 'attack'),
      ],
    };
  }
  next = awardRoundSurvival(next);
  next = awardRoundReputation(next);
  const scores = allScores(next);
  next = rememberScores(next, scores);
  return {
    ...next,
    phase: 'roundSummary',
    roundScores: scores,
    scoreHistory: [...next.scoreHistory, scores],
    // Timer starts when the aftermath UI is actually shown (see armAftermathTimer)
    aftermathEndsAt: null,
    previousRoundEvents: [...next.roundEvents],
    previousRoundNumber: next.round,
    log: [...next.log, log(`Round ${next.round} complete. Standing scores updated.`, 'neutral')],
  };
}

export function currentNationId(state: GameState): NationId {
  const idx = Math.min(
    Math.max(0, state.currentTurnIndex),
    Math.max(0, state.turnOrder.length - 1),
  );
  return state.turnOrder[idx];
}

export function citiesLeft(state: GameState, id: NationId): number {
  return state.nations[id].cities.filter((c) => !c.destroyed).length;
}

export function shieldsLeft(state: GameState, id: NationId): number {
  return state.nations[id].cities.filter((c) => !c.destroyed && c.hasShield).length;
}

export function bunkersLeft(state: GameState, id: NationId): number {
  return state.nations[id].cities.filter((c) => !c.destroyed && c.isUnderground).length;
}

export function researchCount(state: GameState, id: NationId): number {
  return state.nations[id].cities.filter((c) => !c.destroyed && c.hasResearch).length;
}

export function computeScore(state: GameState, id: NationId): RoundScore {
  const n = state.nations[id];
  const standing = n.cities.filter((c) => !c.destroyed);
  const cities = standing.length;
  const pristine = standing.filter((c) => c.rebuiltRound == null).length;
  const rebuilt = cities - pristine;
  const shields = shieldsLeft(state, id);
  const bunkers = bunkersLeft(state, id);
  const research = researchCount(state, id);
  // City survival is scored each round (cities standing × points), then banked.
  // Rebuilt rubble is half a city — phoenix turtling cannot bank full value forever.
  // Kill points reward the side that actually ends rival cities.
  // Angel prestige / evil infamy are the international-reputation ledger.
  const survivalPoints = n.citySurvivalPoints;
  const attackPoints = n.attackPoints ?? 0;
  const angelPoints = n.angelPoints ?? 0;
  const infamyPoints = n.infamyPoints ?? 0;
  const liveTotal = Math.max(
    0,
    pristine * SCORE_CITY +
      rebuilt * Math.round(SCORE_CITY / 2) +
      research * SCORE_RESEARCH +
      shields * SCORE_SHIELD +
      bunkers * SCORE_BUNKER +
      survivalPoints +
      attackPoints +
      angelPoints -
      infamyPoints,
  );
  // Eliminated nations keep their frozen score from when they fell
  const total =
    n.eliminated && n.lockedScore != null ? Math.max(0, n.lockedScore) : liveTotal;
  return {
    nationId: id,
    citiesLeft: cities,
    researchCenters: research,
    shields,
    bunkers,
    roundsSurvived: n.roundsSurvived,
    citySurvivalPoints: n.citySurvivalPoints,
    attackPoints,
    angelPoints,
    infamyPoints,
    total: Math.round(total),
    eliminated: n.eliminated,
  };
}

export function allScores(state: GameState): RoundScore[] {
  return state.turnOrder
    .map((id) => computeScore(state, id))
    .sort((a, b) => {
      // Living nations always rank above eliminated — OUT cannot lead / win
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      return b.total - a.total;
    });
}

/** Remember each nation's best live score so wipeout can freeze it later */
function rememberScores(state: GameState, scores: RoundScore[]): GameState {
  const nations = { ...state.nations };
  for (const row of scores) {
    const n = nations[row.nationId];
    if (n.eliminated) continue;
    nations[row.nationId] = {
      ...n,
      lockedScore: Math.max(n.lockedScore ?? 0, row.total),
    };
  }
  return { ...state, nations };
}

/** Grant survival credit based on cities still standing at round end */
function awardRoundSurvival(state: GameState): GameState {
  const nations = { ...state.nations };
  const logEntries = [...state.log];
  for (const id of state.turnOrder) {
    const n = nations[id];
    if (n.eliminated) continue;
    const standing = n.cities.filter((c) => !c.destroyed);
    // Rebuilt cities bank half the survival chip — reconstruction is survival,
    // not a free copy of an untouched capital.
    const gained = standing.reduce(
      (sum, c) =>
        sum +
        (c.rebuiltRound != null
          ? Math.ceil(SURVIVAL_POINTS_PER_CITY / 2)
          : SURVIVAL_POINTS_PER_CITY),
      0,
    );
    nations[id] = {
      ...n,
      roundsSurvived: n.roundsSurvived + 1,
      citySurvivalPoints: n.citySurvivalPoints + gained,
    };
    logEntries.push(
      log(
        `${nationDef(id).name} survived round ${state.round} with ${standing.length} cit${standing.length === 1 ? 'y' : 'ies'} (+${gained} pts).`,
        'money',
      ),
    );
  }
  return { ...state, nations, log: logEntries };
}

/**
 * How aggressive a seat was this resolution — used to crown one angel and
 * one evil for prestige / international reputation.
 */
export function roundOffenseScore(state: GameState, id: NationId): number {
  const strikes = state.resolvedStrikes ?? state.pendingStrikes;
  let score = 0;
  for (const s of strikes) {
    if (s.attackerId !== id) continue;
    score += s.weapon === 'drone' ? 1 : 10;
  }
  for (const e of state.roundEvents) {
    if (e.attackerId !== id) continue;
    if (e.kind === 'cityDestroyed') score += 100;
    else if (e.kind === 'shieldDestroyed') score += 20;
    else if (e.kind === 'droneDamage') score += 2;
    else if (e.kind === 'nationEliminated') score += 50;
  }
  return score;
}

/** Living seats crowned most peaceful / most offensive for this round. */
export function pickRoundStance(state: GameState): {
  angel: NationId | null;
  evil: NationId | null;
} {
  const living = state.turnOrder.filter((id) => !state.nations[id]?.eliminated);
  if (living.length < 2) return { angel: null, evil: null };

  const ranked = [...living].sort((a, b) => {
    const diff = roundOffenseScore(state, b) - roundOffenseScore(state, a);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
  const evil = ranked[0];
  const angel = ranked[ranked.length - 1];
  if (evil === angel) return { angel: null, evil: null };
  // Quiet table / identical aggression — no prestige or infamy this round
  if (roundOffenseScore(state, evil) === roundOffenseScore(state, angel)) {
    return { angel: null, evil: null };
  }
  return { angel, evil };
}

/** Bank angel prestige / evil infamy and remember who wears those portraits. */
function awardRoundReputation(state: GameState): GameState {
  if (SCORE_ANGEL <= 0 && SCORE_EVIL <= 0) {
    return { ...state, angelNationId: null, evilNationId: null };
  }
  const { angel, evil } = pickRoundStance(state);
  if (!angel && !evil) {
    return { ...state, angelNationId: null, evilNationId: null };
  }

  const nations = { ...state.nations };
  const logEntries = [...state.log];

  if (angel && SCORE_ANGEL > 0) {
    const n = nations[angel];
    nations[angel] = {
      ...n,
      angelPoints: (n.angelPoints ?? 0) + SCORE_ANGEL,
    };
    logEntries.push(
      log(
        `${nationDef(angel).name} is this round's angel of peace (+${SCORE_ANGEL} prestige).`,
        'money',
      ),
    );
  }
  if (evil && SCORE_EVIL > 0) {
    const n = nations[evil];
    nations[evil] = {
      ...n,
      infamyPoints: (n.infamyPoints ?? 0) + SCORE_EVIL,
    };
    logEntries.push(
      log(
        `${nationDef(evil).name} is this round's aggressor (−${SCORE_EVIL} international reputation).`,
        'attack',
      ),
    );
  }

  return {
    ...state,
    nations,
    log: logEntries,
    angelNationId: angel,
    evilNationId: evil,
  };
}

/** The city that just fell, so an emergency rebuild raises the one they lost last. */
function lastCityLost(state: GameState, n: NationState): City | null {
  for (let i = state.roundEvents.length - 1; i >= 0; i -= 1) {
    const e = state.roundEvents[i];
    if (e.kind !== 'cityDestroyed' || e.nationId !== n.id) continue;
    const city = n.cities.find((c) => c.id === e.cityId && c.destroyed);
    if (city) return city;
  }
  return n.cities.find((c) => c.destroyed) ?? null;
}

function checkEliminations(state: GameState): GameState {
  const nations = { ...state.nations };
  const logEntries = [...state.log];
  const roundEvents = [...state.roundEvents];
  for (const id of state.turnOrder) {
    const n = nations[id];
    // Last city gone: one automatic rebuild per match if the treasury covers it
    const canEmergency =
      (n.emergencyRebuildsUsed ?? 0) < 1 && n.money >= COSTS.rebuild;
    if (!n.eliminated && n.cities.every((c) => c.destroyed) && canEmergency) {
      const lost = lastCityLost({ ...state, roundEvents }, n);
      if (lost) {
        nations[id] = {
          ...raiseFromRubble(n, lost.id, state.round),
          emergencyRebuildsUsed: (n.emergencyRebuildsUsed ?? 0) + 1,
        };
        logEntries.push(
          log(
            `${nationDef(id).name} spent $${COSTS.rebuild}M rebuilding ${lost.name} — the nation survives (last automatic rebuild).`,
            'money',
          ),
        );
        roundEvents.push(
          worldEvent({
            kind: 'cityRebuilt',
            nationId: id,
            cityId: lost.id,
            cityName: lost.name,
            amount: COSTS.rebuild,
            automatic: true,
          }),
        );
        continue;
      }
    }
    if (!n.eliminated && n.cities.every((c) => c.destroyed)) {
      const priorTotals = state.scoreHistory
        .map((round) => round.find((r) => r.nationId === id)?.total ?? 0)
        .concat(
          state.roundScores.find((r) => r.nationId === id)?.total ?? 0,
        );
      const bestPrior = priorTotals.length ? Math.max(0, ...priorTotals) : 0;
      // Freeze best known score so a wipeout doesn't erase standings
      const lockedScore = Math.max(bestPrior, n.lockedScore ?? 0);
      nations[id] = { ...n, eliminated: true, bombs: 0, drones: 0, lockedScore };
      logEntries.push(log(`${nationDef(id).name} has been eliminated!`, 'attack'));
      roundEvents.push(
        worldEvent({ kind: 'nationEliminated', nationId: id }),
      );
      // Credit the attacker who landed the finishing city for ending the nation
      if (SCORE_ELIMINATION > 0) {
        let finisher: NationId | null = null;
        for (let i = roundEvents.length - 1; i >= 0; i -= 1) {
          const e = roundEvents[i];
          if (e.kind === 'cityDestroyed' && e.nationId === id && e.attackerId) {
            finisher = e.attackerId;
            break;
          }
        }
        if (finisher && nations[finisher] && !nations[finisher].eliminated) {
          nations[finisher] = {
            ...nations[finisher],
            attackPoints: (nations[finisher].attackPoints ?? 0) + SCORE_ELIMINATION,
          };
          logEntries.push(
            log(
              `${nationDef(finisher).name} scored +${SCORE_ELIMINATION} for eliminating ${nationDef(id).name}.`,
              'attack',
            ),
          );
        }
      }
    }
  }
  return { ...state, nations, log: logEntries, roundEvents };
}

/**
 * The living nations sharing the top score, or an empty list when one nation
 * leads on its own. A shared lead is not a title.
 */
export function tiedForTheLead(state: GameState): NationId[] {
  const contenders = allScores(state).filter((s) => !s.eliminated);
  if (contenders.length < 2) return [];
  const top = contenders[0].total;
  const tied = contenders.filter((s) => s.total === top);
  return tied.length > 1 ? tied.map((s) => s.nationId) : [];
}

/**
 * Whether the last round settled nothing and the war should run one more. The
 * overtime is capped: the extra rounds already granted are the distance
 * `maxRounds` has been pushed beyond the scheduled match length.
 */
export function needsOvertime(state: GameState): boolean {
  if (state.maxRounds - MAX_ROUNDS >= MAX_OVERTIME_ROUNDS) return false;
  return tiedForTheLead(state).length > 1;
}

function pickLivingSuperpower(state: GameState): NationId | null {
  const scores = allScores(state);
  const contenders = scores.filter((s) => !s.eliminated);
  if (contenders.length === 0) {
    // No living nations — the highest locked score still takes the title
    return scores[0]?.nationId ?? null;
  }
  const top = contenders[0].total;
  const tied = contenders.filter((s) => s.total === top);
  if (tied.length === 1) return tied[0].nationId;
  // Break ties: more cities, then attack points, then survival, then id
  tied.sort((a, b) => {
    if (b.citiesLeft !== a.citiesLeft) return b.citiesLeft - a.citiesLeft;
    if (b.attackPoints !== a.attackPoints) return b.attackPoints - a.attackPoints;
    if (b.citySurvivalPoints !== a.citySurvivalPoints) {
      return b.citySurvivalPoints - a.citySurvivalPoints;
    }
    return a.nationId.localeCompare(b.nationId);
  });
  return tied[0].nationId;
}

function checkWinner(state: GameState): GameState {
  const alive = aliveNations(state);
  if (alive.length <= 1) {
    return {
      ...state,
      phase: 'gameOver',
      winner: alive[0] ?? pickLivingSuperpower(state),
      roundScores: allScores(state),
    };
  }
  if (state.round > state.maxRounds) {
    return {
      ...state,
      phase: 'gameOver',
      winner: pickLivingSuperpower(state),
      roundScores: allScores(state),
    };
  }
  return state;
}

export function setMode(state: GameState, mode: GameMode): GameState {
  return {
    ...state,
    mode,
    phase: mode === 'two' ? 'names' : mode === 'online' ? 'lobby' : 'country',
    selectingFor: 1,
    humanNations: [],
    playerNames: {},
    pendingCountryPick: null,
  };
}

export function setPlayerNames(state: GameState, name1: string, name2: string): GameState {
  const p1 = name1.trim() || 'Player 1';
  const p2 = name2.trim() || 'Player 2';
  return {
    ...state,
    playerNames: { 1: p1, 2: p2 },
    phase: 'country',
    selectingFor: 1,
  };
}

export function playerDisplayName(state: GameState, nationId: NationId): string {
  const n = state.nations[nationId];
  if (!n.isHuman) return 'AI';
  const slot = n.playerSlot;
  if (slot && state.playerNames[slot]) return displayNameOnly(state.playerNames[slot]!);
  return slot ? `Player ${slot}` : 'Player';
}

export function pickCountry(state: GameState, id: NationId): GameState {
  if (state.humanNations.includes(id)) return state;

  if (state.mode === 'single') {
    const nations = { ...state.nations };
    for (const n of NATIONS) {
      nations[n.id] = {
        ...nations[n.id],
        isHuman: n.id === id,
        playerSlot: n.id === id ? 1 : undefined,
      };
    }
    // Straight into round 1 — there is no briefing to sit through
    return startGame({
      ...state,
      nations,
      turnOrder: seatTable([id], { keep: state.turnOrder }),
      humanNations: [id],
      pendingCountryPick: id,
    });
  }

  // Two player
  if (state.selectingFor === 1) {
    const nations = { ...state.nations };
    nations[id] = { ...nations[id], isHuman: true, playerSlot: 1 };
    return {
      ...state,
      nations,
      turnOrder: seatTable([id], { keep: state.turnOrder }),
      humanNations: [id],
      selectingFor: 2,
      pendingCountryPick: id,
    };
  }

  const nations = { ...state.nations };
  nations[id] = { ...nations[id], isHuman: true, playerSlot: 2 };
  const humanNations = [...state.humanNations, id];
  return startGame({
    ...state,
    nations,
    turnOrder: seatTable(humanNations, { keep: state.turnOrder }),
    humanNations,
    pendingCountryPick: id,
  });
}

export function startGame(state: GameState): GameState {
  // Humans act first, then AI in fixed nation order
  const humans = state.turnOrder.filter((id) => state.nations[id].isHuman);
  const ai = state.turnOrder.filter((id) => !state.nations[id].isHuman);
  const turnOrder = [...humans, ...ai];
  // Round 1: starting treasury only — base/research income begins in round 2
  const base: GameState = {
    ...state,
    turnOrder,
    currentTurnIndex: 0,
    phase: 'buy',
    round: 1,
    log: [
      log(
        'Round 1 begins. Spend your starting funds — city income starts in round 2 ($1.75M per standing city).',
        'neutral',
      ),
    ],
  };
  return beginHumanPlanning(base);
}

/** Apply city + research income (sanctions cut total revenue 10% each) at round start.
 *  Income begins in round 2 (not round 1). Safe to call more than once per round. */
export function applyIncome(state: GameState): GameState {
  if (state.round < 2) return { ...state, lastIncomeLedger: [] };

  const unpaid = state.turnOrder.filter((id) => {
    const n = state.nations[id];
    return !n.eliminated && n.incomeRound !== state.round;
  });
  if (unpaid.length === 0) return state;

  const nations = { ...state.nations };
  const logEntries = [...state.log];
  const ledger: IncomeLedgerEntry[] = [];

  for (const id of state.turnOrder) {
    const n = nations[id];
    if (n.eliminated) continue;

    const standing = n.cities.filter((c) => !c.destroyed).length;
    const cityIncome = standing * INCOME_PER_CITY;
    const researchIncome =
      n.cities.filter((c) => !c.destroyed && c.hasResearch).length * RESEARCH_INCOME;
    const gross = cityIncome + researchIncome;
    const sanctioners = state.turnOrder.filter(
      (other) => other !== id && !nations[other].eliminated && nations[other].sanctions.includes(id),
    );
    const sanctionPenalty = Math.min(MAX_SANCTION_CUT, sanctioners.length * SANCTION_PENALTY);
    const revenue = +(gross * (1 - sanctionPenalty)).toFixed(2);

    if (n.incomeRound === state.round) {
      const prevEntry = state.lastIncomeLedger.find((e) => e.nationId === id);
      ledger.push(
        prevEntry ?? {
          nationId: id,
          previousBalance: +(n.money - revenue).toFixed(2),
          revenue,
          balanceAfterIncome: n.money,
          sanctionPenalty,
          sanctioners,
        },
      );
      continue;
    }

    const previousBalance = n.money;
    // Last round's drone swarms come due now, capped at what the treasury holds
    const droneDamage = Math.min(
      +(n.pendingDroneDamage ?? 0).toFixed(2),
      +(previousBalance + revenue).toFixed(2),
    );
    const balanceAfterIncome = +(previousBalance + revenue - droneDamage).toFixed(2);

    nations[id] = {
      ...n,
      money: balanceAfterIncome,
      researchCenters: n.cities.filter((c) => !c.destroyed && c.hasResearch).length,
      incomeRound: state.round,
      pendingDroneDamage: 0,
    };
    ledger.push({
      nationId: id,
      previousBalance,
      revenue,
      balanceAfterIncome,
      sanctionPenalty,
      sanctioners,
      droneDamage,
    });
    const sanctionNote =
      sanctioners.length > 0 ? `, −${Math.round(sanctionPenalty * 100)}% sanctions` : '';
    const droneNote = droneDamage > 0 ? `, −$${droneDamage}M drone damage` : '';
    logEntries.push(
      log(
        `${nationDef(id).name} receives $${revenue}M (${standing} cit${standing === 1 ? 'y' : 'ies'} $${cityIncome}M + research $${researchIncome}M${sanctionNote}${droneNote}).`,
        'money',
      ),
    );
  }

  return { ...state, nations, log: logEntries, lastIncomeLedger: ledger };
}

/** Ensure round income has been applied (online sync safety net). */
export function ensureIncome(state: GameState): GameState {
  if (state.phase !== 'buy' && state.phase !== 'action' && state.phase !== 'income') {
    return state;
  }
  if (state.round < 2) return state;
  const needsPay = state.turnOrder.some((id) => {
    const n = state.nations[id];
    return !n.eliminated && n.incomeRound !== state.round;
  });
  return needsPay ? applyIncome(state) : state;
}

/** Nations currently sanctioning `targetId`. */
export function whoIsSanctioning(state: GameState, targetId: NationId): NationId[] {
  return state.turnOrder.filter(
    (id) =>
      id !== targetId &&
      !state.nations[id].eliminated &&
      state.nations[id].sanctions.includes(targetId),
  );
}

export function canBuyBombs(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return (
    !n.eliminated &&
    n.hasNuclearTech &&
    n.nuclearTechUnlockedRound != null &&
    n.nuclearTechUnlockedRound <= state.round
  );
}

/** Nuclear warheads left to buy this round (shared 3/round cap). */
export function maxBombsPurchasable(state: GameState, nationId?: NationId): number {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyBombs(state, id)) return 0;
  const byMoney = Math.floor(n.money / COSTS.bomb);
  const byCap = MAX_BOMBS_PER_ROUND - n.bombsBoughtThisRound;
  return Math.max(0, Math.min(MAX_BOMBS_PER_ROUND, byMoney, byCap));
}

export function maxHydrogenPurchasable(state: GameState, nationId?: NationId): number {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyBombs(state, id)) return 0;
  const left = MAX_HYDROGEN_PER_GAME - (n.hydrogenBought ?? 0);
  if (left <= 0 || n.money < COSTS.bombHydrogen) return 0;
  return 1;
}

export function maxMagneticPurchasable(state: GameState, nationId?: NationId): number {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyBombs(state, id)) return 0;
  const left = MAX_MAGNETIC_PER_GAME - (n.magneticBought ?? 0);
  if (left <= 0) return 0;
  return Math.min(left, Math.floor(n.money / COSTS.bombMagnetic));
}

/** True when the arsenal modal still has something the nation can afford. */
export function canBuyAnyWarhead(state: GameState, nationId?: NationId): boolean {
  return (
    maxBombsPurchasable(state, nationId) > 0 ||
    maxHydrogenPurchasable(state, nationId) > 0 ||
    maxMagneticPurchasable(state, nationId) > 0
  );
}

export function buyNuclearTech(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (n.hasNuclearTech || n.money < COSTS.ballisticMissileTech || n.eliminated) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.ballisticMissileTech).toFixed(2),
        hasNuclearTech: true,
        nuclearTechUnlockedRound: state.round,
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} unlocked Ballistic Missile Tech — warheads can be built and fired this round.`,
        'money',
      ),
    ],
  };
}

export function canBuyDrones(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return (
    !n.eliminated &&
    n.hasAerospaceTech &&
    n.aerospaceTechUnlockedRound != null &&
    n.aerospaceTechUnlockedRound <= state.round
  );
}

export function maxDronesPurchasable(state: GameState, nationId?: NationId): number {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyDrones(state, id)) return 0;
  const byMoney = Math.floor(n.money / COSTS.drone);
  const byCap = MAX_DRONES_PER_ROUND - n.dronesBoughtThisRound;
  return Math.max(0, Math.min(byMoney, byCap));
}

export function canBuySpyNetwork(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return !n.eliminated && !n.hasSpyNetwork && n.money >= COSTS.spy;
}

export function buySpyNetwork(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuySpyNetwork(state, id)) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: { ...n, money: +(n.money - COSTS.spy).toFixed(2), hasSpyNetwork: true },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} opened a spy service — enemy city defences are on the table.`,
        'money',
      ),
    ],
  };
}

/**
 * Whether `viewerId` can read the defences of `targetId`'s cities. Your own
 * cities are always open to you; everyone else's take a spy service.
 */
export function seesDefences(state: GameState, viewerId: NationId, targetId: NationId): boolean {
  if (viewerId === targetId) return true;
  return Boolean(state.nations[viewerId]?.hasSpyNetwork);
}

/**
 * Whether `viewerId` can read one particular city. A spy service opens every
 * city at once; a drone swarm that gets through opens the city it flew over,
 * and that knowledge keeps for the rest of the war.
 */
export function seesCity(
  state: GameState,
  viewerId: NationId,
  targetId: NationId,
  cityId: string,
): boolean {
  if (seesDefences(state, viewerId, targetId)) return true;
  return Boolean(state.nations[viewerId]?.scoutedCities?.includes(cityId));
}

/**
 * Put one city on every nation's map. A warhead breaking against rock is not a
 * secret anyone can keep: the whole table watched it bounce, so from then on
 * that city is read as the bunker it is, by everybody.
 */
export function revealCityToEveryone(state: GameState, cityId: string): GameState {
  return state.turnOrder.reduce((seen, id) => scoutCity(seen, id, cityId), state);
}

/** Record what a swarm saw on its way in — permanent intel on that one city. */
export function scoutCity(state: GameState, viewerId: NationId, cityId: string): GameState {
  const viewer = state.nations[viewerId];
  if (!viewer || viewer.scoutedCities.includes(cityId)) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [viewerId]: { ...viewer, scoutedCities: [...viewer.scoutedCities, cityId] },
    },
  };
}

/**
 * A city as `viewerId` sees it. Rubble and rebuilds are visible from orbit;
 * shields, research, bunkers and laser networks are not, so an unspied enemy
 * city looks like bare ground and has to be attacked on guesswork.
 */
export function cityAsSeenBy(
  state: GameState,
  viewerId: NationId,
  targetId: NationId,
  city: City,
): City {
  if (seesCity(state, viewerId, targetId, city.id)) return city;
  return {
    ...city,
    hasShield: false,
    hasResearch: false,
    isUnderground: false,
    hasLaser: false,
  };
}

export function buyAerospaceTech(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (n.hasAerospaceTech || n.money < COSTS.aerospaceTech || n.eliminated) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.aerospaceTech).toFixed(2),
        hasAerospaceTech: true,
        aerospaceTechUnlockedRound: state.round,
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} unlocked Aerospace Tech — drone packs can fly this round.`,
        'money',
      ),
    ],
  };
}

export function buyDrone(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (
    !canBuyDrones(state, id) ||
    n.money < COSTS.drone ||
    n.eliminated ||
    n.dronesBoughtThisRound >= MAX_DRONES_PER_ROUND
  ) {
    return state;
  }
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.drone).toFixed(2),
        drones: n.drones + 1,
        dronesBoughtThisRound: n.dronesBoughtThisRound + 1,
      },
    },
    log: [...state.log, log(`${nationDef(id).name} assembled a drone pack.`, 'attack')],
  };
}

export function buyDrones(state: GameState, count: number, nationId?: NationId): GameState {
  let s = state;
  const id = nationId ?? currentNationId(s);
  const n = Math.max(0, Math.min(count, maxDronesPurchasable(s, id)));
  for (let i = 0; i < n; i += 1) s = buyDrone(s, id);
  return s;
}

export function buyBomb(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (
    !canBuyBombs(state, id) ||
    n.money < COSTS.bomb ||
    n.eliminated ||
    n.bombsBoughtThisRound >= MAX_BOMBS_PER_ROUND
  ) {
    return state;
  }
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.bomb).toFixed(2),
        bombs: n.bombs + 1,
        bombsBoughtThisRound: n.bombsBoughtThisRound + 1,
      },
    },
    log: [...state.log, log(`${nationDef(id).name} stockpiled a nuclear bomb.`, 'attack')],
  };
}

export function buyBombs(state: GameState, count: number, nationId?: NationId): GameState {
  let s = state;
  const id = nationId ?? currentNationId(s);
  const n = Math.max(0, Math.min(count, maxBombsPurchasable(s, id)));
  for (let i = 0; i < n; i += 1) s = buyBomb(s, id);
  return s;
}

export function buyHydrogenBomb(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (maxHydrogenPurchasable(state, id) < 1) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.bombHydrogen).toFixed(2),
        hydrogenBombs: (n.hydrogenBombs ?? 0) + 1,
        hydrogenBought: (n.hydrogenBought ?? 0) + 1,
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} armed a hydrogen bomb — bunkers will not stop it.`,
        'attack',
      ),
    ],
  };
}

export function buyMagneticBomb(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (maxMagneticPurchasable(state, id) < 1) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.bombMagnetic).toFixed(2),
        magneticBombs: (n.magneticBombs ?? 0) + 1,
        magneticBought: (n.magneticBought ?? 0) + 1,
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} stockpiled a magnetic bomb — it kills laser cover for the round.`,
        'attack',
      ),
    ],
  };
}

/** One site at a time: a nation cannot break ground on two centres in a round. */
export function canBuyResearch(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return (
    !n.eliminated &&
    n.money >= COSTS.research &&
    n.researchBoughtThisRound < MAX_RESEARCH_PER_ROUND &&
    n.cities.some((c) => !c.destroyed && !c.hasResearch)
  );
}

export function buyResearch(state: GameState, cityId?: string, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyResearch(state, id)) return state;

  const target =
    (cityId && n.cities.find((c) => c.id === cityId && !c.destroyed && !c.hasResearch)) ||
    n.cities.find((c) => !c.destroyed && !c.hasResearch);
  if (!target) return state;

  const cities = n.cities.map((c) =>
    c.id === target.id ? { ...c, hasResearch: true } : c,
  );
  const researchCenters = cities.filter((c) => !c.destroyed && c.hasResearch).length;

  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.research).toFixed(2),
        cities,
        researchCenters,
        researchBoughtThisRound: n.researchBoughtThisRound + 1,
      },
    },
    log: [
      ...state.log,
      log(`${nationDef(id).name} built a Research Center in ${target.name}.`, 'money'),
    ],
  };
}

/** Rubble comes back as a bare city: the shield, the lab and the bunker are gone for good. */
function raiseFromRubble(n: NationState, cityId: string, round: number): NationState {
  const cities = n.cities.map((c) =>
    c.id === cityId
      ? {
          ...c,
          destroyed: false,
          hasShield: false,
          hasResearch: false,
          hasLaser: false,
          isUnderground: false,
          rebuiltRound: round,
        }
      : c,
  );
  return {
    ...n,
    money: +(n.money - COSTS.rebuild).toFixed(2),
    cities,
    researchCenters: cities.filter((c) => !c.destroyed && c.hasResearch).length,
  };
}

export function canBuyRebuild(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return !n.eliminated && n.money >= COSTS.rebuild && n.cities.some((c) => c.destroyed);
}

export function buyRebuild(state: GameState, cityId: string, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyRebuild(state, id)) return state;

  const target = n.cities.find((c) => c.id === cityId && c.destroyed);
  if (!target) return state;

  return {
    ...state,
    nations: { ...state.nations, [id]: raiseFromRubble(n, cityId, state.round) },
    log: [
      ...state.log,
      log(`${nationDef(id).name} rebuilt ${target.name} from the rubble.`, 'money'),
    ],
    roundEvents: [
      ...state.roundEvents,
      worldEvent({
        kind: 'cityRebuilt',
        nationId: id,
        cityId: target.id,
        cityName: target.name,
        amount: COSTS.rebuild,
      }),
    ],
  };
}

/** A nation may bunker one city per match. */
export function undergroundCity(state: GameState, nationId: NationId): City | null {
  return state.nations[nationId].cities.find((c) => c.isUnderground) ?? null;
}

export function canBuyUnderground(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return (
    !n.eliminated &&
    n.money >= COSTS.underground &&
    !undergroundCity(state, id) &&
    n.cities.some((c) => !c.destroyed)
  );
}

export function buyUnderground(
  state: GameState,
  cityId: string,
  nationId?: NationId,
): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyUnderground(state, id)) return state;

  const target = n.cities.find((c) => c.id === cityId && !c.destroyed && !c.isUnderground);
  if (!target) return state;

  // A bunker replaces surface cover — stacking a shield under rock is wasted
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.underground).toFixed(2),
        cities: n.cities.map((c) =>
          c.id === cityId ? { ...c, isUnderground: true, hasShield: false } : c,
        ),
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} moved ${target.name} underground — only a hydrogen bomb can crack it${
          target.hasShield ? ' (the surface shield was scrapped)' : ''
        }.`,
        'money',
      ),
    ],
  };
}

/** Laser batteries need the aerospace program behind them — no tech, no tracking. */
export function canBuyLaser(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return (
    !n.eliminated &&
    n.hasAerospaceTech &&
    n.money >= COSTS.laser &&
    // One network is enough: a second battery defends cities the first
    // already covers
    !laserNetwork(state, id) &&
    n.cities.some((c) => !c.destroyed && !c.hasLaser)
  );
}

export function buyLaser(state: GameState, cityId: string, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyLaser(state, id)) return state;

  const city = n.cities.find((c) => c.id === cityId && !c.destroyed && !c.hasLaser);
  if (!city) return state;

  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.laser).toFixed(2),
        cities: n.cities.map((c) => (c.id === cityId ? { ...c, hasLaser: true } : c)),
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} installed a laser defence network on ${city.name} — it shoots down ${LASER_INTERCEPTS_PER_ROUND} drone swarms a round, anywhere in the nation.`,
        'money',
      ),
    ],
  };
}

/** One shield per round, so a nation cannot wall off every city in one turn. */
export function canBuyShield(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return (
    !n.eliminated &&
    n.money >= COSTS.shield &&
    n.shieldsBoughtThisRound < MAX_SHIELDS_PER_ROUND &&
    n.cities.some((c) => !c.destroyed && !c.hasShield && !c.isUnderground)
  );
}

export function buyShield(state: GameState, cityId: string, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  const city = n.cities.find((c) => c.id === cityId);
  if (
    !city ||
    city.destroyed ||
    city.hasShield ||
    city.isUnderground ||
    !canBuyShield(state, id)
  ) {
    return state;
  }
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.shield).toFixed(2),
        shieldsBoughtThisRound: n.shieldsBoughtThisRound + 1,
        cities: n.cities.map((c) => (c.id === cityId ? { ...c, hasShield: true } : c)),
      },
    },
    log: [...state.log, log(`${nationDef(id).name} shielded ${city.name}.`, 'money')],
  };
}

export function finishBuyPhase(state: GameState): GameState {
  return { ...state, phase: 'action' };
}

/** Queue a strike for end-of-round resolution (spends the bomb or drone pack now). */
export function queueStrike(
  state: GameState,
  targetNation: NationId,
  cityId: string,
  attackerId = currentNationId(state),
  weapon: StrikeWeapon = 'nuke',
): GameState {
  const attacker = state.nations[attackerId];
  const defender = state.nations[targetNation];
  const drone = weapon === 'drone';
  const warhead: WarheadKind | null = drone ? null : weapon === 'hydrogen' || weapon === 'magnetic' ? weapon : 'nuke';

  if (
    attacker.eliminated ||
    defender.eliminated ||
    attackerId === targetNation ||
    (drone
      ? attacker.drones < 1 ||
        !attacker.hasAerospaceTech ||
        attacker.citiesDronedThisRound.includes(cityId)
      : warheadStock(attacker, warhead!) < 1 ||
        !attacker.hasNuclearTech ||
        attacker.citiesStruckThisRound.includes(cityId))
  ) {
    return state;
  }

  const city = defender.cities.find((c) => c.id === cityId);
  if (!city || city.destroyed) return state;
  // Nuclear and magnetic warheads cannot crack a bunker; hydrogen can.
  // Blind attackers still fire and learn at resolution.
  if (
    city.isUnderground &&
    warhead &&
    warhead !== 'hydrogen' &&
    seesCity(state, attackerId, targetNation, city.id)
  ) {
    return state;
  }

  const strike: PendingStrike = {
    attackerId,
    targetNationId: targetNation,
    cityId,
    weapon: drone ? 'drone' : warhead!,
  };

  let spend: Partial<NationState>;
  let defenderPatch: Partial<NationState> = {};
  if (drone) {
    spend = {
      drones: attacker.drones - 1,
      dronesUsed: attacker.dronesUsed + 1,
      citiesDronedThisRound: [...attacker.citiesDronedThisRound, cityId],
    };
  } else if (warhead === 'hydrogen') {
    spend = {
      hydrogenBombs: (attacker.hydrogenBombs ?? 0) - 1,
      hydrogenUsed: (attacker.hydrogenUsed ?? 0) + 1,
      citiesStruckThisRound: [...attacker.citiesStruckThisRound, cityId],
    };
  } else if (warhead === 'magnetic') {
    // Laser dies the moment the magnetic warhead is locked — drones queued
    // this round already fly under a dark sky.
    spend = {
      magneticBombs: (attacker.magneticBombs ?? 0) - 1,
      magneticUsed: (attacker.magneticUsed ?? 0) + 1,
      citiesStruckThisRound: [...attacker.citiesStruckThisRound, cityId],
    };
    defenderPatch = { laserOfflineThisRound: true };
  } else {
    spend = {
      bombs: attacker.bombs - 1,
      bombsUsed: attacker.bombsUsed + 1,
      citiesStruckThisRound: [...attacker.citiesStruckThisRound, cityId],
    };
  }

  const warheadLabel =
    warhead === 'hydrogen'
      ? 'hydrogen bomb'
      : warhead === 'magnetic'
        ? 'magnetic bomb'
        : 'warhead';

  return {
    ...state,
    pendingStrikes: [...state.pendingStrikes, strike],
    nations: {
      ...state.nations,
      [attackerId]: { ...attacker, ...spend },
      [targetNation]: { ...defender, ...defenderPatch },
    },
    log: [
      ...state.log,
      log(
        drone
          ? `${nationDef(attackerId).name} launched a drone swarm.`
          : warhead === 'magnetic'
            ? `${nationDef(attackerId).name} locked a magnetic bomb on ${nationDef(targetNation).name} — their laser network is dark for the round.`
            : `${nationDef(attackerId).name} locked in ${warheadLabel} strike orders.`,
        'attack',
      ),
    ],
  };
}

export function queueStrikes(
  state: GameState,
  targets: { nationId: NationId; cityId: string }[],
  attackerId = currentNationId(state),
  weapon: StrikeWeapon = 'nuke',
): GameState {
  let s = state;
  for (const t of targets) {
    s = queueStrike(s, t.nationId, t.cityId, attackerId, weapon);
  }
  return s;
}

/**
 * One battery defends every city the nation owns, and it can shoot down a
 * fixed number of swarms a round — a swarming rival has to overwhelm the
 * network, not tip-toe around one city.
 */
export function laserNetwork(state: GameState, nationId: NationId): boolean {
  return state.nations[nationId].cities.some((c) => !c.destroyed && c.hasLaser);
}

export function laserInterceptsLeft(state: GameState, nationId: NationId): number {
  if (!laserNetwork(state, nationId)) return 0;
  if (state.nations[nationId].laserOfflineThisRound) return 0;
  const fired = state.nations[nationId].dronesInterceptedThisRound;
  return Math.max(0, LASER_INTERCEPTS_PER_ROUND - fired);
}

/**
 * True when a swarm actually got through to this city this round, tying up its
 * shield. Drones resolve before warheads, so by the time a warhead lands the
 * round's events already say whether the network burnt the swarm out of the sky.
 */
/**
 * Interceptions `viewerId` can count on the defender having left. Without a
 * spy service the network is invisible, so an attacker plans as if there were
 * none and loses swarms finding out.
 */
export function laserShotsKnownTo(
  state: GameState,
  viewerId: NationId,
  targetId: NationId,
): number {
  const battery = state.nations[targetId]?.cities.find((c) => !c.destroyed && c.hasLaser);
  // A beam gives away the city that fired it, so a swarm shot down counts as
  // having found the network the hard way.
  if (!battery || !seesCity(state, viewerId, targetId, battery.id)) return 0;
  return laserInterceptsLeft(state, targetId);
}

export function shieldIsBusy(
  state: GameState,
  targetNationId: NationId,
  cityId: string,
): boolean {
  return state.roundEvents.some(
    (e) => e.kind === 'droneDamage' && e.nationId === targetNationId && e.cityId === cityId,
  );
}

/** Drone swarms cannot level a city — they run up a repair bill instead. */
/**
 * A laser battery downs the swarm outright; a shield or a bunker only blunts it,
 * so it runs up half the repair bill. Shields still count even when the swarm is
 * tying one up for a warhead.
 */
/** Repair bill for a swarm the laser network did not catch. */
export function droneDamageFor(city: Pick<City, 'hasShield' | 'isUnderground'>): number {
  return city.hasShield || city.isUnderground ? +(DRONE_DAMAGE / 2).toFixed(2) : DRONE_DAMAGE;
}

function applyDroneStrike(
  state: GameState,
  strike: PendingStrike,
  city: City,
): GameState {
  const defender = state.nations[strike.targetNationId];
  if (laserInterceptsLeft(state, strike.targetNationId) > 0) {
    const fired = defender.dronesInterceptedThisRound + 1;
    const left = LASER_INTERCEPTS_PER_ROUND - fired;
    // The swarm dies, but the beam shows the attacker where the battery sits
    const battery = defender.cities.find((c) => !c.destroyed && c.hasLaser);
    const seen = battery ? scoutCity(state, strike.attackerId, battery.id) : state;
    return {
      ...seen,
      nations: {
        ...seen.nations,
        [strike.targetNationId]: { ...defender, dronesInterceptedThisRound: fired },
      },
      log: [
        ...state.log,
        log(
          `${nationDef(strike.targetNationId).name}'s laser network shot down ${nationDef(strike.attackerId).name}'s drone swarm over ${city.name} — no damage${
            left > 0 ? '' : ' (the network is out of shots this round)'
          }.`,
          'attack',
        ),
      ],
      roundEvents: [
        ...state.roundEvents,
        worldEvent({
          kind: 'dronesIntercepted',
          nationId: strike.targetNationId,
          cityId: city.id,
          cityName: city.name,
          attackerId: strike.attackerId,
        }),
      ],
    };
  }

  const damage = droneDamageFor(city);
  const defended = damage < DRONE_DAMAGE;
  // The swarm got over the city, so the attacker has now seen what defends it
  const seen = scoutCity(state, strike.attackerId, city.id);
  return {
    ...seen,
    nations: {
      ...seen.nations,
      [strike.targetNationId]: {
        ...defender,
        pendingDroneDamage: +((defender.pendingDroneDamage ?? 0) + damage).toFixed(2),
      },
    },
    log: [
      ...seen.log,
      log(
        `${nationDef(strike.attackerId).name}'s drones hit ${city.name} (${nationDef(strike.targetNationId).name}) — $${damage}M in damages${defended ? ' (defences took the brunt)' : ''}.`,
        'attack',
      ),
    ],
    roundEvents: [
      ...state.roundEvents,
      worldEvent({
        kind: 'droneDamage',
        nationId: strike.targetNationId,
        cityId: city.id,
        cityName: city.name,
        attackerId: strike.attackerId,
        amount: damage,
      }),
    ],
  };
}

/** Apply damage for a previously queued strike (bomb or drone pack already spent). */
export function applyQueuedStrike(state: GameState, strike: PendingStrike): GameState {
  const attacker = state.nations[strike.attackerId];
  const defender = state.nations[strike.targetNationId];
  if (attacker.eliminated || defender.eliminated) return state;

  // Normalize legacy / stripped payloads so specialty warheads cannot fall back
  // to a plain nuke (which would bounce off bunkers).
  const weapon: StrikeWeapon =
    strike.weapon === 'drone' ||
    strike.weapon === 'hydrogen' ||
    strike.weapon === 'magnetic'
      ? strike.weapon
      : 'nuke';
  const strikeNorm = weapon === strike.weapon ? strike : { ...strike, weapon };

  const city = defender.cities.find((c) => c.id === strikeNorm.cityId);
  if (city && !city.destroyed && weapon === 'drone') {
    return applyDroneStrike(state, strikeNorm, city);
  }

  const hydrogen = weapon === 'hydrogen';
  const magnetic = weapon === 'magnetic';
  const warheadName = hydrogen ? 'hydrogen bomb' : magnetic ? 'magnetic bomb' : 'warhead';

  // A player can bunker a city in the same round a warhead was aimed at it —
  // only a hydrogen bomb cracks the rock.
  if (city && !city.destroyed && city.isUnderground && !hydrogen) {
    // Everyone saw the warhead break, so nobody has to buy that intel again
    const seen = revealCityToEveryone(state, city.id);
    return {
      ...seen,
      log: [
        ...seen.log,
        log(
          `${nationDef(strike.attackerId).name}'s ${warheadName} broke against the bunkers under ${city.name} (${nationDef(strike.targetNationId).name}) — every capital can see the city is dug in now.`,
          'attack',
        ),
      ],
      roundEvents: [
        ...seen.roundEvents,
        worldEvent({
          kind: 'strikeAbsorbed',
          nationId: strike.targetNationId,
          cityId: city.id,
          cityName: city.name,
          attackerId: strike.attackerId,
        }),
      ],
    };
  }
  if (!city || city.destroyed) {
    return {
      ...state,
      log: [
        ...state.log,
        log(
          `${nationDef(strike.attackerId).name}'s strike on ${strike.cityId} found nothing left to hit.`,
          'attack',
        ),
      ],
    };
  }

  let cities = defender.cities;
  let message: string;
  let hitEvent: RoundWorldEvent;
  // Hydrogen punches through shields and bunkers alike — no escort required.
  // Other warheads need the shield busy (drone swarm) or they only strip it.
  const shielded =
    !hydrogen &&
    city.hasShield &&
    !shieldIsBusy(state, strike.targetNationId, strike.cityId);
  if (shielded) {
    cities = cities.map((c) =>
      c.id === strike.cityId ? { ...c, hasShield: false, isUnderground: false } : c,
    );
    message = `${nationDef(strike.attackerId).name}'s ${warheadName} hit ${city.name} (${nationDef(strike.targetNationId).name}) — shield destroyed!`;
    hitEvent = worldEvent({
      kind: 'shieldDestroyed',
      nationId: strike.targetNationId,
      cityId: city.id,
      cityName: city.name,
      attackerId: strike.attackerId,
      amount: COSTS.shield,
    });
  } else {
    cities = cities.map((c) =>
      c.id === strike.cityId
        ? {
            ...c,
            destroyed: true,
            hasShield: false,
            hasResearch: false,
            hasLaser: false,
            isUnderground: false,
          }
        : c,
    );
    message =
      city.isUnderground && hydrogen
        ? `${nationDef(strike.attackerId).name}'s hydrogen bomb cracked the bunker under ${city.name} (${nationDef(strike.targetNationId).name}) — the city is gone!`
        : city.hasShield && hydrogen
          ? `${nationDef(strike.attackerId).name}'s hydrogen bomb vaporized ${city.name} (${nationDef(strike.targetNationId).name}) — the shield did not matter!`
          : city.hasShield
            ? `${nationDef(strike.attackerId).name}'s ${warheadName} destroyed ${city.name} (${nationDef(strike.targetNationId).name}) — drones kept the shield busy!`
            : `${nationDef(strike.attackerId).name}'s ${warheadName} destroyed ${city.name} (${nationDef(strike.targetNationId).name})!`;
    hitEvent = worldEvent({
      kind: 'cityDestroyed',
      nationId: strike.targetNationId,
      cityId: city.id,
      cityName: city.name,
      attackerId: strike.attackerId,
      amount: cityAssetValue(city),
    });
  }

  const researchCenters = cities.filter((c) => !c.destroyed && c.hasResearch).length;

  // Nobody repairs rubble: when the warhead levels the city, the swarm's bill
  // for that same city is written off. Getting it back costs a rebuild.
  const swarmedThisCity = (e: RoundWorldEvent) =>
    e.kind === 'droneDamage' &&
    e.nationId === strike.targetNationId &&
    e.cityId === strike.cityId;
  const writtenOff = shielded
    ? 0
    : +state.roundEvents
        .filter(swarmedThisCity)
        .reduce((sum, e) => sum + (e.amount ?? 0), 0)
        .toFixed(2);
  const pendingDroneDamage = +Math.max(
    0,
    (defender.pendingDroneDamage ?? 0) - writtenOff,
  ).toFixed(2);
  const roundEvents = writtenOff > 0
    ? state.roundEvents.filter((e) => !swarmedThisCity(e))
    : state.roundEvents;

  const killCredit = !shielded && SCORE_KILL > 0 ? SCORE_KILL : 0;
  const attackerPatch =
    killCredit > 0
      ? {
          [strike.attackerId]: {
            ...attacker,
            attackPoints: (attacker.attackPoints ?? 0) + killCredit,
          },
        }
      : {};

  let next: GameState = {
    ...state,
    nations: {
      ...state.nations,
      ...attackerPatch,
      [strike.targetNationId]: {
        ...defender,
        cities,
        researchCenters,
        pendingDroneDamage,
      },
    },
    log: [
      ...state.log,
      log(message, 'attack'),
      ...(killCredit > 0
        ? [
            log(
              `${nationDef(strike.attackerId).name} scored +${killCredit} for destroying ${city.name}.`,
              'attack',
            ),
          ]
        : []),
      ...(writtenOff > 0
        ? [
            log(
              `The $${writtenOff}M repair bill for ${city.name} died with the city — rebuilding costs $${COSTS.rebuild}M.`,
              'money',
            ),
          ]
        : []),
    ],
    roundEvents: [...roundEvents, hitEvent],
  };

  return checkEliminations(next);
}

export function finishStrikeResolution(state: GameState): GameState {
  // Kept on the summary so a client that never saw the resolveStrikes phase
  // (slow phone, lagging listener) can still play the launch cinema.
  let next: GameState = {
    ...state,
    pendingStrikes: [],
    resolvedStrikes: [...state.pendingStrikes],
  };
  next = checkEliminations(next);
  next = awardRoundSurvival(next);
  next = awardRoundReputation(next);
  const scores = allScores(next);
  next = rememberScores(next, scores);
  next = checkWinner({
    ...next,
    phase: 'roundSummary',
    roundScores: scores,
    scoreHistory: [...next.scoreHistory, scores],
    // Timer starts when the aftermath UI is actually shown (see armAftermathTimer)
    aftermathEndsAt: null,
    previousRoundEvents: [...next.roundEvents],
    previousRoundNumber: next.round,
    log: [...next.log, log(`Round ${next.round} complete. Standing scores updated.`, 'neutral')],
  });
  return next;
}

/** Drones go in first; every client resolves the round in this same order. */
export function orderStrikesForResolution(strikes: PendingStrike[]): PendingStrike[] {
  return [
    ...strikes.filter((s) => s.weapon === 'drone'),
    ...strikes.filter((s) => s.weapon !== 'drone'),
  ];
}

/**
 * One cinema per attacker: a nation that hit several targets launches its whole
 * volley in a single panel, so a heavy round doesn't drag on.
 */
export function groupStrikesByAttacker(
  strikes: PendingStrike[],
): { attackerId: NationId; strikes: PendingStrike[] }[] {
  const volleys: { attackerId: NationId; strikes: PendingStrike[] }[] = [];
  for (const strike of strikes) {
    const open = volleys.find((v) => v.attackerId === strike.attackerId);
    if (open) open.strikes.push(strike);
    else volleys.push({ attackerId: strike.attackerId, strikes: [strike] });
  }
  return volleys;
}

/** How long the launch cinema plus aftermath recap runs on every client. */
export function cinemaDurationMs(state: GameState): number {
  const volleys = groupStrikesByAttacker(state.resolvedStrikes ?? []).length;
  if (volleys === 0) return state.previousRoundEvents?.length ? RECAP_AUTO_MS : 0;
  return volleys * STRIKE_CINEMA_MS + RECAP_AUTO_MS;
}

/**
 * Start the shared strategy countdown. Publishers include the cinema runtime so
 * the clock a peer adopts still leaves a full think window once its own
 * animation finishes; clients arming after the fact pass includeCinema: false.
 */
export function armAftermathTimer(
  state: GameState,
  at = Date.now(),
  { includeCinema = false }: { includeCinema?: boolean } = {},
): GameState {
  if (state.phase !== 'roundSummary') return state;
  const endsAt = at + (includeCinema ? cinemaDurationMs(state) : 0) + AFTERMATH_THINK_MS;
  if (state.aftermathEndsAt != null && state.aftermathEndsAt > endsAt) return state;
  return {
    ...state,
    aftermathEndsAt: endsAt,
  };
}

export function attackCity(state: GameState, targetNation: NationId, cityId: string): GameState {
  // Legacy immediate attack — prefer queueStrike + applyQueuedStrike for fair rounds
  const queued = queueStrike(state, targetNation, cityId);
  if (queued === state) return state;
  const strike = queued.pendingStrikes[queued.pendingStrikes.length - 1];
  const withoutPending: GameState = {
    ...queued,
    pendingStrikes: queued.pendingStrikes.slice(0, -1),
  };
  return applyQueuedStrike(withoutPending, strike);
}

/** Remember a buy-wizard prompt so a remount cannot ask it again this round. */
export function markPromptDone(
  state: GameState,
  nationId: NationId,
  prompt: string,
): GameState {
  const n = state.nations[nationId];
  if (!n || n.eliminated) return state;
  const done = n.promptsDoneThisRound ?? [];
  if (done.includes(prompt)) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [nationId]: { ...n, promptsDoneThisRound: [...done, prompt] },
    },
  };
}

/** Sanctions a nation may run at once — lifting one frees the slot again. */
export function sanctionsLeft(state: GameState, nationId?: NationId): number {
  const id = nationId ?? currentNationId(state);
  const live = state.nations[id].sanctions.filter((s) => !state.nations[s].eliminated);
  return Math.max(0, MAX_SANCTIONS - live.length);
}

export function toggleSanction(state: GameState, target: NationId, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (n.eliminated || target === id || state.nations[target].eliminated) return state;

  const has = n.sanctions.includes(target);
  // Only two rivals at a time, so a sanction is a choice about who to squeeze
  if (!has && sanctionsLeft(state, id) < 1) return state;
  const sanctions = has ? n.sanctions.filter((s) => s !== target) : [...n.sanctions, target];
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: { ...n, sanctions, sanctionsVersion: (n.sanctionsVersion ?? 0) + 1 },
    },
    log: [
      ...state.log,
      log(
        has
          ? `${nationDef(id).name} lifted sanctions on ${nationDef(target).name}.`
          : `${nationDef(id).name} sanctioned ${nationDef(target).name} (−10% income).`,
        'sanction',
      ),
    ],
  };
}

export function endTurn(state: GameState): GameState {
  let next = checkEliminations(state);
  // Snapshot scores while cities still stand (before later wipeouts)
  next = rememberScores(next, allScores(next));
  next = checkWinner(next);
  if (next.phase === 'gameOver') return next;

  // Advance to next alive nation
  let idx = next.currentTurnIndex + 1;
  while (idx < next.turnOrder.length && next.nations[next.turnOrder[idx]].eliminated) {
    idx += 1;
  }

  if (idx >= next.turnOrder.length) {
    return concludeRoundTurns(next);
  }

  return {
    ...next,
    currentTurnIndex: idx,
    phase: 'buy',
  };
}

export function nextRound(state: GameState): GameState {
  let base = state;
  const nextRoundNum = base.round + 1;
  if (nextRoundNum > base.maxRounds) {
    // Nobody takes the title on a shared score: the war runs an extra round
    // and the leaders settle it between them.
    if (!needsOvertime(base)) return checkWinner({ ...base, round: nextRoundNum });
    const tied = tiedForTheLead(base).map((id) => nationDef(id).name);
    base = {
      ...base,
      maxRounds: base.maxRounds + 1,
      log: [
        ...base.log,
        log(
          `${tied.join(' and ')} finish level — round ${nextRoundNum} decides the superpower.`,
          'neutral',
        ),
      ],
    };
  }

  // Reset to first alive in turn order
  let idx = 0;
  while (idx < base.turnOrder.length && base.nations[base.turnOrder[idx]].eliminated) {
    idx += 1;
  }

  const clearedNations = { ...base.nations };
  for (const id of base.turnOrder) {
    clearedNations[id] = {
      ...clearedNations[id],
      citiesStruckThisRound: [],
      bombsBoughtThisRound: 0,
      citiesDronedThisRound: [],
      dronesBoughtThisRound: 0,
      shieldsBoughtThisRound: 0,
      researchBoughtThisRound: 0,
      dronesInterceptedThisRound: 0,
      laserOfflineThisRound: false,
      promptsDoneThisRound: [],
    };
  }

  let next: GameState = {
    ...base,
    round: nextRoundNum,
    currentTurnIndex: idx,
    phase: 'buy',
    nations: clearedNations,
    pendingStrikes: [],
    roundEvents: [],
    aftermathEndsAt: null,
    log: [...base.log, log(`Round ${nextRoundNum} begins.`, 'neutral')],
  };
  next = beginHumanPlanning(next);
  next = applyIncome(next);
  next = checkWinner(next);
  return next;
}

export function formatMoney(m: number): string {
  if (Number.isInteger(m)) return `${m}M`;
  return `${m.toFixed(1)}M`;
}
