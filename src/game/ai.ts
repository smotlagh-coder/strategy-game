import { COSTS } from '../data/nations';
import {
  aliveNations,
  allAliveHumansReady,
  buyAerospaceTech,
  buyBomb,
  buyDrone,
  buyEnvironment,
  buyNuclearTech,
  buyResearch,
  buyShield,
  buyRebuild,
  buyUnderground,
  canBuyRebuild,
  canBuyUnderground,
  citiesLeft,
  computeScore,
  concludeRoundTurns,
  currentNationId,
  endTurn,
  finishBuyPhase,
  maxBombsPurchasable,
  maxDronesPurchasable,
  queueStrike,
  researchCount,
  toggleSanction,
} from './engine';
import type { City, GameState, NationId } from '../types';

export function pickBombTarget(
  state: GameState,
  attackerId: NationId,
): { nationId: NationId; cityId: string } | null {
  const rivals = aliveNations(state).filter((id) => id !== attackerId);
  if (rivals.length === 0) return null;
  const alreadyHit = new Set(state.nations[attackerId].citiesStruckThisRound);

  const ranked = rivals
    .map((id) => ({ id, score: computeScore(state, id).total, cities: citiesLeft(state, id) }))
    .filter((r) => r.cities > 0)
    .sort((a, b) => b.score - a.score);

  const eligible = (c: { id: string; destroyed: boolean; isUnderground?: boolean }) =>
    !c.destroyed && !c.isUnderground && !alreadyHit.has(c.id);

  for (const rival of ranked) {
    const cities = state.nations[rival.id].cities.filter(eligible);
    const researchOpen = cities.find((c) => c.hasResearch && !c.hasShield);
    if (researchOpen) return { nationId: rival.id, cityId: researchOpen.id };
  }
  for (const rival of ranked) {
    const cities = state.nations[rival.id].cities.filter(eligible);
    const unshielded = cities.find((c) => !c.hasShield);
    if (unshielded) return { nationId: rival.id, cityId: unshielded.id };
  }
  for (const rival of ranked) {
    const shielded = state.nations[rival.id].cities.find((c) => eligible(c) && c.hasShield);
    if (shielded) return { nationId: rival.id, cityId: shielded.id };
  }
  return null;
}

/** Drones cannot level a city, so send them where the repair bill bites hardest. */
export function pickDroneTarget(
  state: GameState,
  attackerId: NationId,
): { nationId: NationId; cityId: string } | null {
  const swarmed = new Set(state.nations[attackerId].citiesDronedThisRound);
  const rivals = aliveNations(state)
    .filter((id) => id !== attackerId && citiesLeft(state, id) > 0)
    .map((id) => ({ id, score: computeScore(state, id).total }))
    .sort((a, b) => b.score - a.score);

  // A shield or bunker halves the bill, so undefended cities are worth more —
  // unless a warhead is already inbound, where the swarm ties up the shield.
  const nuking = new Set(
    state.pendingStrikes
      .filter((s) => s.attackerId === attackerId && s.weapon !== 'drone')
      .map((s) => `${s.targetNationId}:${s.cityId}`),
  );
  const value = (rivalId: NationId, city: City) => {
    if (nuking.has(`${rivalId}:${city.id}`)) return 3;
    if (!city.hasShield && !city.isUnderground) return 2;
    return 1;
  };

  for (const rival of rivals) {
    const cities = state.nations[rival.id].cities.filter(
      (c) => !c.destroyed && !swarmed.has(c.id),
    );
    const best = [...cities].sort(
      (a, b) =>
        value(rival.id, b) - value(rival.id, a) ||
        Number(b.hasResearch) - Number(a.hasResearch) ||
        cities.indexOf(a) - cities.indexOf(b),
    )[0];
    if (best) return { nationId: rival.id, cityId: best.id };
  }
  return null;
}

/** AI purchases only — leaves phase on 'action' */
export function runAiBuyPhase(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated || s.nations[id].isHuman) return s;

  s = { ...s, phase: 'buy' };

  if (!s.nations[id].hasNuclearTech && s.nations[id].money >= COSTS.nuclearTech) {
    if (s.round <= 3 || s.nations[id].money >= 8) {
      s = buyNuclearTech(s);
    }
  }

  while (
    s.nations[id].money >= COSTS.research + 2 &&
    researchCount(s, id) < 3 &&
    (s.round <= 2 || researchCount(s, id) < 2)
  ) {
    const spot = s.nations[id].cities.find((c) => !c.destroyed && !c.hasResearch);
    if (!spot) break;
    s = buyResearch(s, spot.id);
  }

  if (
    !s.nations[id].hasAerospaceTech &&
    s.round <= 3 &&
    s.nations[id].money >= COSTS.aerospaceTech + 1
  ) {
    s = buyAerospaceTech(s);
  }

  // Rubble scores nothing, so raise a city again once the war chest can spare it
  if (canBuyRebuild(s, id) && s.nations[id].money >= COSTS.rebuild + 2) {
    const rubble = s.nations[id].cities.find((c) => c.destroyed);
    if (rubble) s = buyRebuild(s, rubble.id, id);
  }

  // One city in the rock is a guaranteed seat at the final scores
  if (canBuyUnderground(s, id) && s.nations[id].money >= COSTS.underground + 1) {
    const keep =
      s.nations[id].cities.find((c) => !c.destroyed && c.hasResearch) ??
      s.nations[id].cities.find((c) => !c.destroyed);
    if (keep) s = buyUnderground(s, keep.id, id);
  }

  for (const city of s.nations[id].cities) {
    if (
      !city.destroyed &&
      !city.hasShield &&
      !city.isUnderground &&
      s.nations[id].money >= COSTS.shield + 2
    ) {
      s = buyShield(s, city.id);
    }
  }

  const escort = s.nations[id].hasAerospaceTech ? COSTS.drone : 0;
  const wantBombs = Math.min(3, maxBombsPurchasable(s, id));
  for (let i = 0; i < wantBombs; i += 1) {
    if (s.nations[id].money < COSTS.bomb + escort + 1 && s.environment < 40) break;
    s = buyBomb(s);
  }

  // Drones are cheap, so buy a pack per warhead to strip shields, plus one raider
  const wantDrones = Math.min(
    maxDronesPurchasable(s, id),
    Math.max(1, s.nations[id].bombs),
  );
  for (let i = 0; i < wantDrones; i += 1) {
    if (s.nations[id].money < COSTS.drone) break;
    s = buyDrone(s);
  }

  if (
    !s.nations[id].envBoughtThisRound &&
    s.environment < 50 &&
    s.nations[id].money >= COSTS.environment + 2
  ) {
    s = buyEnvironment(s);
  }

  return finishBuyPhase(s);
}

export function runAiDiplomacy(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated) return s;

  const rivals = aliveNations(s).filter((nid) => nid !== id);
  const scores = rivals
    .map((nid) => computeScore(s, nid))
    .sort((a, b) => b.total - a.total);
  const topRival = scores[0]?.nationId;

  if (topRival && !s.nations[id].sanctions.includes(topRival)) {
    s = toggleSanction(s, topRival);
  }
  for (const sid of [...s.nations[id].sanctions]) {
    if (sid !== topRival) s = toggleSanction(s, sid);
  }
  return s;
}

/** Run buy / diplomacy / strike queue for one AI nation. */
export function runAiNationTurn(state: GameState, nationId: NationId): GameState {
  const n = state.nations[nationId];
  if (!n || n.eliminated || n.isHuman) return state;

  const idx = state.turnOrder.indexOf(nationId);
  if (idx < 0) return state;

  let s: GameState = { ...state, currentTurnIndex: idx, phase: 'buy' };
  s = runAiBuyPhase(s);
  s = runAiDiplomacy(s);

  while (s.nations[nationId].bombs > 0) {
    const target = pickBombTarget(s, nationId);
    if (!target) break;
    s = queueStrike(s, target.nationId, target.cityId, nationId);
    // A shielded target only falls if drones tie the shield up first
    const city = s.nations[target.nationId].cities.find((c) => c.id === target.cityId);
    if (city?.hasShield && s.nations[nationId].drones > 0) {
      s = queueStrike(s, target.nationId, target.cityId, nationId, 'drone');
    }
  }

  while (s.nations[nationId].drones > 0) {
    const target = pickDroneTarget(s, nationId);
    if (!target) break;
    s = queueStrike(s, target.nationId, target.cityId, nationId, 'drone');
  }
  return s;
}

/**
 * Online: AI selects at round start (same window as humans), so the board shows
 * their research/shields/tech while players are still choosing.
 */
export function runOnlineAiPlanning(state: GameState): GameState {
  if (state.mode !== 'online') return state;
  if (state.aiPlanningComplete) return state;
  if (state.phase !== 'buy' && state.phase !== 'action') return state;

  const savedIndex = state.currentTurnIndex;
  let s = state;
  for (const id of s.turnOrder) {
    s = runAiNationTurn(s, id);
  }

  return {
    ...s,
    phase: 'buy',
    currentTurnIndex: savedIndex,
    aiPlanningComplete: true,
  };
}

/** Queue AI strikes for fair end-of-round resolution, then end turn */
export function runAiTurn(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated || s.nations[id].isHuman) {
    return endTurn(s);
  }

  s = runAiNationTurn(s, id);
  return endTurn(s);
}

export function runAllAiUntilHumanOrSummary(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (
    guard++ < 20 &&
    (s.phase === 'buy' || s.phase === 'action') &&
    !s.nations[currentNationId(s)].isHuman &&
    !s.nations[currentNationId(s)].eliminated
  ) {
    s = runAiTurn(s);
  }
  while (
    guard++ < 30 &&
    (s.phase === 'buy' || s.phase === 'action') &&
    s.nations[currentNationId(s)].eliminated
  ) {
    s = endTurn(s);
  }
  return s;
}

/**
 * Online: after every human finished selections, ensure AI planned then
 * move to strike resolution / round summary.
 */
export function finishOnlineHumanPlanning(state: GameState): GameState {
  if (state.mode !== 'online') return state;
  if (!allAliveHumansReady(state)) return state;
  if (state.phase !== 'buy' && state.phase !== 'action') {
    return { ...state, planningComplete: true };
  }

  // Already advanced past planning — don't rewind
  if (state.planningComplete) return state;

  let s = runOnlineAiPlanning(state);
  s = concludeRoundTurns(s);
  return { ...s, planningComplete: true, aiPlanningComplete: true };
}

export function describeAiMood(state: GameState, id: NationId): string {
  const me = computeScore(state, id);
  const top = aliveNations(state)
    .map((nid) => computeScore(state, nid))
    .sort((a, b) => b.total - a.total)[0];
  if (top && top.nationId === id) return 'Leading — projecting strength.';
  if (me.total < (top?.total ?? 0) - 40) return 'Behind — seeking leverage.';
  return 'Holding position.';
}
