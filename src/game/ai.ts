import { COSTS } from '../data/nations';
import {
  aliveNations,
  buyBomb,
  buyEnvironment,
  buyNuclearTech,
  buyResearch,
  buyShield,
  citiesLeft,
  computeScore,
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

/** Queue AI strikes for fair end-of-round resolution, then end turn */
export function runAiTurn(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated || s.nations[id].isHuman) {
    return endTurn(s);
  }

  s = runAiBuyPhase(s);
  s = runAiDiplomacy(s);

  while (s.nations[id].bombs > 0) {
    const target = pickBombTarget(s, id);
    if (!target) break;
    s = queueStrike(s, target.nationId, target.cityId, id);
  }

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

export function describeAiMood(state: GameState, id: NationId): string {
  const me = computeScore(state, id);
  const top = aliveNations(state)
    .map((nid) => computeScore(state, nid))
    .sort((a, b) => b.total - a.total)[0];
  if (top && top.nationId === id) return 'Leading — projecting strength.';
  if (me.total < (top?.total ?? 0) - 40) return 'Behind — seeking leverage.';
  return 'Holding position.';
}
