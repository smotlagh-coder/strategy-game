import { COSTS, MAX_BOMBS_PER_ROUND, SURVIVAL_POINTS_PER_CITY } from '../data/nations';
import {
  aliveNations,
  allAliveHumansReady,
  buyAerospaceTech,
  buyBomb,
  buyDrone,
  buyEnvironment,
  buyLaser,
  buyNuclearTech,
  buyResearch,
  buyShield,
  buyRebuild,
  buyUnderground,
  canBuyLaser,
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

/**
 * How dangerous a rival looks at the *end* of the match, not today: the score
 * they already hold, the survival points their cities will keep banking, the
 * research paying for it, and the arsenal pointed back at us.
 */
export function threatScore(state: GameState, id: NationId): number {
  const n = state.nations[id];
  if (n.eliminated) return -1;
  const cities = citiesLeft(state, id);
  const roundsLeft = Math.max(0, state.maxRounds - state.round);
  const arsenal = (n.hasNuclearTech ? 8 : 0) + n.bombs * 12 + n.drones * 3;
  return (
    computeScore(state, id).total +
    cities * SURVIVAL_POINTS_PER_CITY * roundsLeft +
    researchCount(state, id) * 8 +
    arsenal
  );
}

/** Drones already committed this round cannot escort another warhead. */
function freeDrones(state: GameState, attackerId: NationId): number {
  const queued = state.pendingStrikes.filter(
    (s) => s.attackerId === attackerId && s.weapon === 'drone',
  ).length;
  return Math.max(0, state.nations[attackerId].drones - queued);
}

/** Rivals worth shooting at, most dangerous first. */
function rankedRivals(state: GameState, attackerId: NationId): NationId[] {
  return aliveNations(state)
    .filter((id) => id !== attackerId && citiesLeft(state, id) > 0)
    .map((id) => {
      // Taking a rival's last city puts them out of the running entirely,
      // unless their treasury can pay for the automatic rebuild.
      const finishable =
        citiesLeft(state, id) === 1 && state.nations[id].money < COSTS.rebuild ? 120 : 0;
      return { id, weight: threatScore(state, id) + finishable };
    })
    .sort((a, b) => b.weight - a.weight)
    .map((r) => r.id);
}

export function pickBombTarget(
  state: GameState,
  attackerId: NationId,
): { nationId: NationId; cityId: string } | null {
  const alreadyHit = new Set(state.nations[attackerId].citiesStruckThisRound);
  const escorts = freeDrones(state, attackerId);
  const rivals = rankedRivals(state, attackerId);

  const eligible = (c: City) => !c.destroyed && !c.isUnderground && !alreadyHit.has(c.id);
  // A research city is worth 12 pts and $1.5M a round on top of the city itself
  const worth = (c: City) => (c.hasResearch ? 2 : 0) + (c.hasShield ? 0 : 1);

  // A warhead only pays for itself if the city actually falls: unshielded, or
  // shielded with a drone swarm free to tie the shield up this round — which
  // lasers rule out, since they burn the escort before it reaches the shield.
  for (const rival of rivals) {
    const killable = state.nations[rival].cities
      .filter((c) => eligible(c) && (!c.hasShield || (escorts > 0 && !c.hasLaser)))
      .sort((a, b) => worth(b) - worth(a));
    if (killable.length > 0) return { nationId: rival, cityId: killable[0].id };
  }
  // Nothing dies this round — strip the leader's shield so it dies next round
  for (const rival of rivals) {
    const shielded = state.nations[rival].cities.find((c) => eligible(c) && c.hasShield);
    if (shielded) return { nationId: rival, cityId: shielded.id };
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
    // Lasers shoot swarms down for nothing, so never send one there
    const cities = state.nations[rival.id].cities.filter(
      (c) => !c.destroyed && !c.hasLaser && !swarmed.has(c.id),
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

/** Enemy cities a warhead could actually take off the board this round. */
function openTargets(state: GameState, id: NationId): City[] {
  return aliveNations(state)
    .filter((nid) => nid !== id)
    .flatMap((nid) =>
      state.nations[nid].cities.filter(
        (c) => !c.destroyed && !c.isUnderground && !(c.hasShield && c.hasLaser),
      ),
    );
}

/**
 * AI purchases only — leaves phase on 'action'.
 *
 * Shape of the plan, in the order that won the strategy simulation: two
 * research centres for the income, shields on everything (a shield saves a
 * 30-pt city for 3M), then only as many warheads as there are cities they can
 * actually level this round. Warheads bought with no killable target are the
 * single most expensive mistake available, so they are sized, not maximised.
 */
export function runAiBuyPhase(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated || s.nations[id].isHuman) return s;

  s = { ...s, phase: 'buy' };

  const me = () => s.nations[id];
  const finalRound = s.round >= s.maxRounds;
  const roundsAfterThis = Math.max(0, s.maxRounds - s.round);

  // Down to the last city, $6M in the bank is an automatic rebuild — that
  // insurance outscores anything else the money could buy.
  const rescue =
    citiesLeft(s, id) <= 1 && me().money >= COSTS.rebuild && !finalRound ? COSTS.rebuild : 0;
  const spare = () => Math.max(0, me().money - rescue);

  if (!me().hasNuclearTech && !finalRound && spare() >= COSTS.nuclearTech) {
    s = buyNuclearTech(s, id);
  }

  // Two centres is the sweet spot: the third costs a shield's worth of cash and
  // paints the city as the juiciest target on the board.
  while (researchCount(s, id) < 2 && spare() >= COSTS.research) {
    const spot = me().cities.find((c) => !c.destroyed && !c.hasResearch);
    if (!spot) break;
    s = buyResearch(s, spot.id, id);
  }

  // Drones only arrive the round after they are unlocked
  if (!me().hasAerospaceTech && roundsAfterThis >= 1 && spare() >= COSTS.aerospaceTech) {
    s = buyAerospaceTech(s, id);
  }

  for (const city of me().cities) {
    if (city.destroyed || city.hasShield || city.isUnderground) continue;
    if (spare() < COSTS.shield) break;
    s = buyShield(s, city.id, id);
  }

  // Lasers matter against a rival who actually flies drones — a swarm in hand,
  // or one they have already sent. A battery on a shielded city is worth far
  // more than the repair bill it saves: with no swarm left to tie the shield
  // up, that city stops being killable at all. One keystone city only: an AI
  // that lasers everything stops buying warheads and the match freezes.
  const swarmThreat = aliveNations(s).some(
    (nid) => nid !== id && (s.nations[nid].drones > 0 || s.nations[nid].dronesUsed > 0),
  );
  const hasBattery = me().cities.some((c) => !c.destroyed && c.hasLaser);
  if (swarmThreat && !hasBattery && canBuyLaser(s, id) && spare() >= COSTS.laser + COSTS.drone) {
    const exposed = me().cities.filter((c) => !c.destroyed && !c.hasLaser);
    const pick =
      exposed.find((c) => c.hasShield && c.hasResearch) ??
      exposed.find((c) => c.hasShield) ??
      exposed.find((c) => c.hasResearch) ??
      exposed[0];
    if (pick) s = buyLaser(s, pick.id, id);
  }

  // Size the arsenal to what it can kill: open cities, plus shielded ones we
  // can suppress with a swarm in the same volley.
  const targets = openTargets(s, id);
  const undefended = targets.filter((c) => !c.hasShield).length;
  const shielded = targets.length - undefended;
  const escortable = me().hasAerospaceTech || me().drones > 0 ? shielded : 0;
  let warheads = Math.min(MAX_BOMBS_PER_ROUND, undefended + escortable);
  while (warheads > 0 && maxBombsPurchasable(s, id) > 0) {
    const needsEscort = me().bombs + 1 > undefended;
    const escort = needsEscort && me().hasAerospaceTech ? COSTS.drone : 0;
    if (spare() < COSTS.bomb + escort) break;
    s = buyBomb(s, id);
    warheads -= 1;
  }
  const wantDrones = Math.min(
    maxDronesPurchasable(s, id),
    Math.max(0, Math.min(me().bombs, shielded)),
  );
  for (let i = 0; i < wantDrones; i += 1) {
    if (spare() < COSTS.drone) break;
    s = buyDrone(s, id);
  }

  // Rubble scores nothing: a rebuilt city is 30 pts back plus survival points
  if (canBuyRebuild(s, id) && spare() >= COSTS.rebuild) {
    const rubble = me().cities.find((c) => c.destroyed);
    if (rubble) s = buyRebuild(s, rubble.id, id);
  }

  // One city in the rock is a guaranteed seat at the final scores
  if (canBuyUnderground(s, id) && spare() >= COSTS.underground) {
    const keep =
      me().cities.find((c) => !c.destroyed && c.hasResearch) ??
      me().cities.find((c) => !c.destroyed);
    if (keep) s = buyUnderground(s, keep.id, id);
  }

  if (!me().envBoughtThisRound && s.environment < 50 && spare() >= COSTS.environment + 2) {
    s = buyEnvironment(s, id);
  }

  return finishBuyPhase(s);
}

export function runAiDiplomacy(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated) return s;

  // Sanctions cost nothing and stack, so every rival gets one: a rival we let
  // off the hook is a rival funding the warhead pointed at us.
  for (const nid of aliveNations(s).filter((rival) => rival !== id)) {
    if (!s.nations[id].sanctions.includes(nid)) s = toggleSanction(s, nid, id);
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
    if (city?.hasShield && !city.hasLaser && s.nations[nationId].drones > 0) {
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
