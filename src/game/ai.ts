import { COSTS } from '../data/nations';
import {
  aliveNations,
  allAliveHumansReady,
  buyBomb,
  buyEnvironment,
  buyNuclearTech,
  buyResearch,
  buyShield,
  citiesLeft,
  computeScore,
  concludeRoundTurns,
  currentNationId,
  endTurn,
  finishBuyPhase,
  maxBombsPurchasable,
  queueStrike,
  researchCount,
  toggleSanction,
} from './engine';
import type { GameState, NationId } from '../types';

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

  const eligible = (c: { id: string; destroyed: boolean }) =>
    !c.destroyed && !alreadyHit.has(c.id);

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

  for (const city of s.nations[id].cities) {
    if (!city.destroyed && !city.hasShield && s.nations[id].money >= COSTS.shield + 2) {
      s = buyShield(s, city.id);
    }
  }

  const wantBombs = Math.min(3, maxBombsPurchasable(s, id));
  for (let i = 0; i < wantBombs; i += 1) {
    if (s.nations[id].money < COSTS.bomb + 1 && s.environment < 40) break;
    s = buyBomb(s);
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
