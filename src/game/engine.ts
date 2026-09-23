import {
  BASE_INCOME,
  COSTS,
  DRONE_DAMAGE,
  ENV_BOMB_HIT,
  ENV_IMPROVE,
  MAX_BOMBS_PER_ROUND,
  MAX_DRONES_PER_ROUND,
  LASER_INTERCEPTS_PER_ROUND,
  MAX_SANCTIONS,
  MAX_SHIELDS_PER_ROUND,
  MAX_ROUNDS,
  NATIONS,
  RESEARCH_INCOME,
  TABLE_SIZE,
  SANCTION_PENALTY,
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
} from '../types';

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
    environment: 100,
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

export function researchCount(state: GameState, id: NationId): number {
  return state.nations[id].cities.filter((c) => !c.destroyed && c.hasResearch).length;
}

export function computeScore(state: GameState, id: NationId): RoundScore {
  const n = state.nations[id];
  const cities = citiesLeft(state, id);
  const shields = shieldsLeft(state, id);
  const research = researchCount(state, id);
  // World environment above 70% unlocks positive eco points; otherwise 0 (never negative)
  const envPoints =
    state.environment > 70 ? Math.max(0, n.environmentScore) * 2 : 0;
  // City survival is scored each round (cities standing × points), then banked
  const survivalPoints = n.citySurvivalPoints;
  const liveTotal = Math.max(
    0,
    cities * 30 + research * 12 + shields * 8 + envPoints + survivalPoints,
  );
  // Eliminated nations keep their frozen score from when they fell
  const total =
    n.eliminated && n.lockedScore != null ? Math.max(0, n.lockedScore) : liveTotal;
  return {
    nationId: id,
    citiesLeft: cities,
    researchCenters: research,
    shields,
    environmentScore: state.environment > 70 ? Math.max(0, n.environmentScore) : 0,
    roundsSurvived: n.roundsSurvived,
    citySurvivalPoints: n.citySurvivalPoints,
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
    const cities = n.cities.filter((c) => !c.destroyed).length;
    const gained = cities * SURVIVAL_POINTS_PER_CITY;
    nations[id] = {
      ...n,
      roundsSurvived: n.roundsSurvived + 1,
      citySurvivalPoints: n.citySurvivalPoints + gained,
    };
    logEntries.push(
      log(
        `${nationDef(id).name} survived round ${state.round} with ${cities} cit${cities === 1 ? 'y' : 'ies'} (+${gained} pts).`,
        'money',
      ),
    );
  }
  return { ...state, nations, log: logEntries };
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
    // Last city gone but the treasury can cover a rebuild: stay in the game
    if (!n.eliminated && n.cities.every((c) => c.destroyed) && n.money >= COSTS.rebuild) {
      const lost = lastCityLost({ ...state, roundEvents }, n);
      if (lost) {
        nations[id] = raiseFromRubble(n, lost.id, state.round);
        logEntries.push(
          log(
            `${nationDef(id).name} spent $${COSTS.rebuild}M rebuilding ${lost.name} — the nation survives.`,
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
    }
  }
  return { ...state, nations, log: logEntries, roundEvents };
}

function pickLivingSuperpower(state: GameState): NationId | 'draw' {
  const scores = allScores(state);
  const contenders = scores.filter((s) => !s.eliminated);
  if (contenders.length === 0) {
    // No living nations — fall back to highest locked score, never mutual destruction
    return scores[0]?.nationId ?? 'draw';
  }
  const top = contenders[0].total;
  const tied = contenders.filter((s) => s.total === top);
  if (tied.length === 1) return tied[0].nationId;
  // Break ties: more cities, then higher survival points, then nation id
  tied.sort((a, b) => {
    if (b.citiesLeft !== a.citiesLeft) return b.citiesLeft - a.citiesLeft;
    if (b.citySurvivalPoints !== a.citySurvivalPoints) {
      return b.citySurvivalPoints - a.citySurvivalPoints;
    }
    return a.nationId.localeCompare(b.nationId);
  });
  return tied[0].nationId;
}

function checkWinner(state: GameState): GameState {
  // Mutual destruction only when the environment has collapsed
  if (state.environment <= 0) {
    return {
      ...state,
      phase: 'gameOver',
      winner: 'draw',
      roundScores: allScores(state),
    };
  }

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
    return {
      ...state,
      nations,
      turnOrder: seatTable([id], { keep: state.turnOrder }),
      humanNations: [id],
      phase: 'leaders',
      pendingCountryPick: id,
    };
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
  return {
    ...state,
    nations,
    turnOrder: seatTable(humanNations, { keep: state.turnOrder }),
    humanNations,
    phase: 'leaders',
    pendingCountryPick: id,
  };
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
        'Round 1 begins. Spend your starting funds — $3M income starts in round 2.',
        'neutral',
      ),
    ],
  };
  return beginHumanPlanning(base);
}

/** Apply base + research income (sanctions cut total revenue 10% each) at round start.
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

    const researchIncome =
      n.cities.filter((c) => !c.destroyed && c.hasResearch).length * RESEARCH_INCOME;
    const gross = BASE_INCOME + researchIncome;
    const sanctioners = state.turnOrder.filter(
      (other) => other !== id && !nations[other].eliminated && nations[other].sanctions.includes(id),
    );
    const sanctionPenalty = Math.min(0.9, sanctioners.length * SANCTION_PENALTY);
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
        `${nationDef(id).name} receives $${revenue}M (base $${BASE_INCOME}M + research $${researchIncome}M${sanctionNote}${droneNote}).`,
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

export function maxBombsPurchasable(state: GameState, nationId?: NationId): number {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (!canBuyBombs(state, id)) return 0;
  const byMoney = Math.floor(n.money / COSTS.bomb);
  const byCap = MAX_BOMBS_PER_ROUND - n.bombsBoughtThisRound;
  return Math.max(0, Math.min(3, byMoney, byCap));
}

export function buyNuclearTech(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (n.hasNuclearTech || n.money < COSTS.nuclearTech || n.eliminated) return state;
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.nuclearTech).toFixed(2),
        hasNuclearTech: true,
        nuclearTechUnlockedRound: state.round,
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} unlocked Nuclear Tech — warheads can be built and fired this round.`,
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
  if (seesDefences(state, viewerId, targetId)) return city;
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

export function buyResearch(state: GameState, cityId?: string, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (n.money < COSTS.research || n.eliminated) return state;

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
      },
    },
    log: [
      ...state.log,
      log(`${nationDef(id).name} built a Research Center in ${target.name}.`, 'money'),
    ],
  };
}

export function buyEnvironment(state: GameState, nationId?: NationId): GameState {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  if (
    n.money < COSTS.environment ||
    n.eliminated ||
    n.envBoughtThisRound ||
    state.environment >= 100
  ) {
    return state;
  }
  return {
    ...state,
    environment: Math.min(100, state.environment + ENV_IMPROVE),
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.environment).toFixed(2),
        environmentScore: n.environmentScore + 10,
        environmentBuys: n.environmentBuys + 1,
        envBoughtThisRound: true,
      },
    },
    log: [
      ...state.log,
      log(`${nationDef(id).name} invested in the environment (+${ENV_IMPROVE}%).`, 'env'),
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

  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.underground).toFixed(2),
        cities: n.cities.map((c) => (c.id === cityId ? { ...c, isUnderground: true } : c)),
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(id).name} moved ${target.name} underground — the city can no longer be destroyed.`,
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
  weapon: 'nuke' | 'drone' = 'nuke',
): GameState {
  const attacker = state.nations[attackerId];
  const defender = state.nations[targetNation];
  const drone = weapon === 'drone';

  if (
    attacker.eliminated ||
    defender.eliminated ||
    attackerId === targetNation ||
    (drone
      ? attacker.drones < 1 ||
        !attacker.hasAerospaceTech ||
        attacker.citiesDronedThisRound.includes(cityId)
      : attacker.bombs < 1 ||
        !attacker.hasNuclearTech ||
        attacker.citiesStruckThisRound.includes(cityId))
  ) {
    return state;
  }

  const city = defender.cities.find((c) => c.id === cityId);
  if (!city || city.destroyed) return state;
  // Warheads cannot crack a bunker city; drones still run up a repair bill.
  // An attacker with no eyes on the target does not know that, so the warhead
  // flies anyway and breaks against the rock at resolution.
  if (city.isUnderground && !drone && seesDefences(state, attackerId, targetNation)) return state;

  const strike: PendingStrike = {
    attackerId,
    targetNationId: targetNation,
    cityId,
    weapon,
  };

  const spend = drone
    ? {
        drones: attacker.drones - 1,
        dronesUsed: attacker.dronesUsed + 1,
        citiesDronedThisRound: [...attacker.citiesDronedThisRound, cityId],
      }
    : {
        bombs: attacker.bombs - 1,
        bombsUsed: attacker.bombsUsed + 1,
        citiesStruckThisRound: [...attacker.citiesStruckThisRound, cityId],
      };

  return {
    ...state,
    pendingStrikes: [...state.pendingStrikes, strike],
    nations: {
      ...state.nations,
      [attackerId]: { ...attacker, ...spend },
    },
    log: [
      ...state.log,
      log(
        drone
          ? `${nationDef(attackerId).name} launched a drone swarm.`
          : `${nationDef(attackerId).name} locked in strike orders.`,
        'attack',
      ),
    ],
  };
}

export function queueStrikes(
  state: GameState,
  targets: { nationId: NationId; cityId: string }[],
  attackerId = currentNationId(state),
  weapon: 'nuke' | 'drone' = 'nuke',
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
  if (!seesDefences(state, viewerId, targetId)) return 0;
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
    return {
      ...state,
      nations: {
        ...state.nations,
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
  return {
    ...state,
    nations: {
      ...state.nations,
      [strike.targetNationId]: {
        ...defender,
        pendingDroneDamage: +((defender.pendingDroneDamage ?? 0) + damage).toFixed(2),
      },
    },
    log: [
      ...state.log,
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

  const city = defender.cities.find((c) => c.id === strike.cityId);
  if (city && !city.destroyed && strike.weapon === 'drone') {
    return applyDroneStrike(state, strike, city);
  }
  // A player can bunker a city in the same round a warhead was aimed at it
  if (city && !city.destroyed && city.isUnderground) {
    return {
      ...state,
      environment: Math.max(0, state.environment - ENV_BOMB_HIT),
      log: [
        ...state.log,
        log(
          `${nationDef(strike.attackerId).name}'s warhead broke against the bunkers under ${city.name} (${nationDef(strike.targetNationId).name}).`,
          'attack',
        ),
      ],
      roundEvents: [
        ...state.roundEvents,
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
  // Drones swarming this city keep its shield occupied, so the warhead lands
  const shielded =
    city.hasShield &&
    !shieldIsBusy(state, strike.targetNationId, strike.cityId);
  if (shielded) {
    cities = cities.map((c) =>
      c.id === strike.cityId ? { ...c, hasShield: false } : c,
    );
    message = `${nationDef(strike.attackerId).name} nuked ${city.name} (${nationDef(strike.targetNationId).name}) — shield destroyed!`;
    hitEvent = worldEvent({
      kind: 'shieldDestroyed',
      nationId: strike.targetNationId,
      cityId: city.id,
      cityName: city.name,
      attackerId: strike.attackerId,
    });
  } else {
    cities = cities.map((c) =>
      c.id === strike.cityId
        ? { ...c, destroyed: true, hasShield: false, hasResearch: false, hasLaser: false }
        : c,
    );
    message = city.hasShield
      ? `${nationDef(strike.attackerId).name} destroyed ${city.name} (${nationDef(strike.targetNationId).name}) — drones kept the shield busy!`
      : `${nationDef(strike.attackerId).name} destroyed ${city.name} (${nationDef(strike.targetNationId).name})!`;
    hitEvent = worldEvent({
      kind: 'cityDestroyed',
      nationId: strike.targetNationId,
      cityId: city.id,
      cityName: city.name,
      attackerId: strike.attackerId,
    });
  }

  const researchCenters = cities.filter((c) => !c.destroyed && c.hasResearch).length;

  // Nobody repairs rubble: when the warhead levels the city, the swarm's bill
  // for that same city is written off. Getting it back costs a $6M rebuild.
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

  let next: GameState = {
    ...state,
    environment: Math.max(0, state.environment - ENV_BOMB_HIT),
    nations: {
      ...state.nations,
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
    nations: { ...state.nations, [id]: { ...n, sanctions } },
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
  const nextRoundNum = state.round + 1;
  if (nextRoundNum > state.maxRounds) {
    return checkWinner({ ...state, round: nextRoundNum });
  }

  // Reset to first alive in turn order
  let idx = 0;
  while (idx < state.turnOrder.length && state.nations[state.turnOrder[idx]].eliminated) {
    idx += 1;
  }

  const clearedNations = { ...state.nations };
  for (const id of state.turnOrder) {
    clearedNations[id] = {
      ...clearedNations[id],
      citiesStruckThisRound: [],
      bombsBoughtThisRound: 0,
      citiesDronedThisRound: [],
      dronesBoughtThisRound: 0,
      shieldsBoughtThisRound: 0,
      dronesInterceptedThisRound: 0,
      envBoughtThisRound: false,
      promptsDoneThisRound: [],
    };
  }

  let next: GameState = {
    ...state,
    round: nextRoundNum,
    currentTurnIndex: idx,
    phase: 'buy',
    nations: clearedNations,
    pendingStrikes: [],
    roundEvents: [],
    aftermathEndsAt: null,
    log: [...state.log, log(`Round ${nextRoundNum} begins.`, 'neutral')],
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
