import {
  BASE_INCOME,
  COSTS,
  ENV_BOMB_HIT,
  ENV_IMPROVE,
  MAX_BOMBS_PER_ROUND,
  MAX_ROUNDS,
  NATIONS,
  RESEARCH_INCOME,
  SANCTION_PENALTY,
  SURVIVAL_POINTS_PER_CITY,
  initialNation,
  nationDef,
} from '../data/nations';
import type {
  GameMode,
  GameState,
  LogEntry,
  NationId,
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

export function createInitialState(): GameState {
  const nations = Object.fromEntries(
    NATIONS.map((n) => [n.id, initialNation(n.id)]),
  ) as GameState['nations'];

  return {
    mode: null,
    phase: 'mode',
    round: 1,
    maxRounds: MAX_ROUNDS,
    environment: 100,
    nations,
    turnOrder: NATIONS.map((n) => n.id),
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
  };
}

export function aliveNations(state: GameState): NationId[] {
  return state.turnOrder.filter((id) => !state.nations[id].eliminated);
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

function checkEliminations(state: GameState): GameState {
  const nations = { ...state.nations };
  const logEntries = [...state.log];
  const roundEvents = [...state.roundEvents];
  for (const id of state.turnOrder) {
    const n = nations[id];
    if (!n.eliminated && n.cities.every((c) => c.destroyed)) {
      const priorTotals = state.scoreHistory
        .map((round) => round.find((r) => r.nationId === id)?.total ?? 0)
        .concat(
          state.roundScores.find((r) => r.nationId === id)?.total ?? 0,
        );
      const bestPrior = priorTotals.length ? Math.max(0, ...priorTotals) : 0;
      // Freeze best known score so a wipeout doesn't erase standings
      const lockedScore = Math.max(bestPrior, n.lockedScore ?? 0);
      nations[id] = { ...n, eliminated: true, bombs: 0, lockedScore };
      logEntries.push(log(`${nationDef(id).name} has been eliminated!`, 'attack'));
      roundEvents.push(
        worldEvent({ kind: 'nationEliminated', nationId: id }),
      );
    }
  }
  return { ...state, nations, log: logEntries, roundEvents };
}

function checkWinner(state: GameState): GameState {
  const alive = aliveNations(state);
  if (alive.length <= 1) {
    return {
      ...state,
      phase: 'gameOver',
      winner: alive[0] ?? 'draw',
      roundScores: allScores(state),
    };
  }
  if (state.round > state.maxRounds) {
    const scores = allScores(state);
    // Eliminated nations keep standings points but can never become superpower
    const contenders = scores.filter((s) => !s.eliminated);
    const top = contenders[0]?.total;
    const tied =
      top == null ? [] : contenders.filter((s) => s.total === top);
    return {
      ...state,
      phase: 'gameOver',
      winner: tied.length === 1 ? tied[0].nationId : 'draw',
      roundScores: scores,
    };
  }
  return state;
}

export function setMode(state: GameState, mode: GameMode): GameState {
  return {
    ...state,
    mode,
    phase: mode === 'two' ? 'names' : 'country',
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
  if (slot && state.playerNames[slot]) return state.playerNames[slot]!;
  return slot ? `Player ${slot}` : 'Player';
}

export function pickCountry(state: GameState, id: NationId): GameState {
  if (state.humanNations.includes(id)) return state;

  if (state.mode === 'single') {
    const nations = { ...state.nations };
    for (const nid of state.turnOrder) {
      nations[nid] = {
        ...nations[nid],
        isHuman: nid === id,
        playerSlot: nid === id ? 1 : undefined,
      };
    }
    return {
      ...state,
      nations,
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
      humanNations: [id],
      selectingFor: 2,
      pendingCountryPick: id,
    };
  }

  const nations = { ...state.nations };
  nations[id] = { ...nations[id], isHuman: true, playerSlot: 2 };
  return {
    ...state,
    nations,
    humanNations: [...state.humanNations, id],
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
  return {
    ...state,
    turnOrder,
    currentTurnIndex: 0,
    phase: 'buy',
    round: 1,
    log: [
      log(
        'Round 1 begins. Spend your starting funds — $3.5M income starts in round 2.',
        'neutral',
      ),
    ],
  };
}

/** Apply base + research income (sanctions cut total revenue 20% each) at round start.
 *  Income begins in round 2 (not round 1). */
export function applyIncome(state: GameState): GameState {
  if (state.round < 2) return state;

  const nations = { ...state.nations };
  const logEntries = [...state.log];

  for (const id of state.turnOrder) {
    const n = nations[id];
    if (n.eliminated) continue;

    const researchIncome =
      n.cities.filter((c) => !c.destroyed && c.hasResearch).length * RESEARCH_INCOME;
    const gross = BASE_INCOME + researchIncome;
    // How many others are sanctioning this nation?
    const sanctionCount = state.turnOrder.filter(
      (other) => other !== id && !nations[other].eliminated && nations[other].sanctions.includes(id),
    ).length;
    const penalty = Math.min(0.8, sanctionCount * SANCTION_PENALTY);
    const income = +(gross * (1 - penalty)).toFixed(2);

    nations[id] = {
      ...n,
      money: +(n.money + income).toFixed(2),
      researchCenters: n.cities.filter((c) => !c.destroyed && c.hasResearch).length,
    };
    const note =
      sanctionCount > 0
        ? `${nationDef(id).name} receives $${income}M (base $${BASE_INCOME}M + research $${researchIncome}M, −${Math.round(penalty * 100)}% sanctions).`
        : `${nationDef(id).name} receives $${income}M (base $${BASE_INCOME}M + research $${researchIncome}M).`;
    logEntries.push(log(note, 'money'));
  }

  return { ...state, nations, log: logEntries };
}

export function canBuyBombs(state: GameState, nationId?: NationId): boolean {
  const id = nationId ?? currentNationId(state);
  const n = state.nations[id];
  return (
    !n.eliminated &&
    n.hasNuclearTech &&
    n.nuclearTechUnlockedRound != null &&
    n.nuclearTechUnlockedRound < state.round
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

export function buyNuclearTech(state: GameState): GameState {
  const id = currentNationId(state);
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
        `${nationDef(id).name} unlocked Nuclear Tech — bombs available next round.`,
        'money',
      ),
    ],
  };
}

export function buyBomb(state: GameState): GameState {
  const id = currentNationId(state);
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

export function buyBombs(state: GameState, count: number): GameState {
  let s = state;
  const n = Math.max(0, Math.min(count, maxBombsPurchasable(s)));
  for (let i = 0; i < n; i += 1) s = buyBomb(s);
  return s;
}

export function buyResearch(state: GameState, cityId?: string): GameState {
  const id = currentNationId(state);
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

export function buyEnvironment(state: GameState): GameState {
  const id = currentNationId(state);
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

export function buyShield(state: GameState, cityId: string): GameState {
  const id = currentNationId(state);
  const n = state.nations[id];
  const city = n.cities.find((c) => c.id === cityId);
  if (!city || city.destroyed || city.hasShield || n.money < COSTS.shield || n.eliminated) {
    return state;
  }
  return {
    ...state,
    nations: {
      ...state.nations,
      [id]: {
        ...n,
        money: +(n.money - COSTS.shield).toFixed(2),
        cities: n.cities.map((c) => (c.id === cityId ? { ...c, hasShield: true } : c)),
      },
    },
    log: [...state.log, log(`${nationDef(id).name} shielded ${city.name}.`, 'money')],
  };
}

export function finishBuyPhase(state: GameState): GameState {
  return { ...state, phase: 'action' };
}

/** Queue a strike for end-of-round resolution (spends the bomb now). */
export function queueStrike(
  state: GameState,
  targetNation: NationId,
  cityId: string,
  attackerId = currentNationId(state),
): GameState {
  const attacker = state.nations[attackerId];
  const defender = state.nations[targetNation];

  if (
    attacker.eliminated ||
    defender.eliminated ||
    attackerId === targetNation ||
    attacker.bombs < 1 ||
    !attacker.hasNuclearTech ||
    attacker.citiesStruckThisRound.includes(cityId)
  ) {
    return state;
  }

  const city = defender.cities.find((c) => c.id === cityId);
  if (!city || city.destroyed) return state;

  const strike: PendingStrike = {
    attackerId,
    targetNationId: targetNation,
    cityId,
  };

  return {
    ...state,
    pendingStrikes: [...state.pendingStrikes, strike],
    nations: {
      ...state.nations,
      [attackerId]: {
        ...attacker,
        bombs: attacker.bombs - 1,
        bombsUsed: attacker.bombsUsed + 1,
        citiesStruckThisRound: [...attacker.citiesStruckThisRound, cityId],
      },
    },
    log: [
      ...state.log,
      log(
        `${nationDef(attackerId).name} locked targeting on ${city.name} (${nationDef(targetNation).name}).`,
        'attack',
      ),
    ],
  };
}

export function queueStrikes(
  state: GameState,
  targets: { nationId: NationId; cityId: string }[],
  attackerId = currentNationId(state),
): GameState {
  let s = state;
  for (const t of targets) {
    s = queueStrike(s, t.nationId, t.cityId, attackerId);
  }
  return s;
}

/** Apply damage for a previously queued strike (bomb already spent). */
export function applyQueuedStrike(state: GameState, strike: PendingStrike): GameState {
  const attacker = state.nations[strike.attackerId];
  const defender = state.nations[strike.targetNationId];
  if (attacker.eliminated || defender.eliminated) return state;

  const city = defender.cities.find((c) => c.id === strike.cityId);
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
  if (city.hasShield) {
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
        ? { ...c, destroyed: true, hasShield: false, hasResearch: false }
        : c,
    );
    message = `${nationDef(strike.attackerId).name} destroyed ${city.name} (${nationDef(strike.targetNationId).name})!`;
    hitEvent = worldEvent({
      kind: 'cityDestroyed',
      nationId: strike.targetNationId,
      cityId: city.id,
      cityName: city.name,
      attackerId: strike.attackerId,
    });
  }

  const researchCenters = cities.filter((c) => !c.destroyed && c.hasResearch).length;

  let next: GameState = {
    ...state,
    environment: Math.max(0, state.environment - ENV_BOMB_HIT),
    nations: {
      ...state.nations,
      [strike.targetNationId]: { ...defender, cities, researchCenters },
    },
    log: [...state.log, log(message, 'attack')],
    roundEvents: [...state.roundEvents, hitEvent],
  };

  return checkEliminations(next);
}

export function finishStrikeResolution(state: GameState): GameState {
  let next: GameState = { ...state, pendingStrikes: [] };
  next = checkEliminations(next);
  next = awardRoundSurvival(next);
  const scores = allScores(next);
  next = rememberScores(next, scores);
  next = checkWinner({
    ...next,
    phase: 'roundSummary',
    roundScores: scores,
    scoreHistory: [...next.scoreHistory, scores],
    log: [...next.log, log(`Round ${next.round} complete. Standing scores updated.`, 'neutral')],
  });
  return next;
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

export function toggleSanction(state: GameState, target: NationId): GameState {
  const id = currentNationId(state);
  const n = state.nations[id];
  if (n.eliminated || target === id || state.nations[target].eliminated) return state;

  const has = n.sanctions.includes(target);
  const sanctions = has ? n.sanctions.filter((s) => s !== target) : [...n.sanctions, target];
  return {
    ...state,
    nations: { ...state.nations, [id]: { ...n, sanctions } },
    log: [
      ...state.log,
      log(
        has
          ? `${nationDef(id).name} lifted sanctions on ${nationDef(target).name}.`
          : `${nationDef(id).name} sanctioned ${nationDef(target).name} (−20% research income).`,
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
    // Round complete — resolve queued strikes together, then score
    if (next.pendingStrikes.length > 0) {
      return {
        ...next,
        phase: 'resolveStrikes',
        // Keep a valid index while cinema resolves (no active nation turn)
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
      log: [...next.log, log(`Round ${next.round} complete. Standing scores updated.`, 'neutral')],
    };
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
      envBoughtThisRound: false,
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
    log: [...state.log, log(`Round ${nextRoundNum} begins.`, 'neutral')],
  };
  next = applyIncome(next);
  next = checkWinner(next);
  return next;
}

export function formatMoney(m: number): string {
  if (Number.isInteger(m)) return `${m}M`;
  return `${m.toFixed(1)}M`;
}
