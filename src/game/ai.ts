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
  buySpyNetwork,
  buyShield,
  buyRebuild,
  buyUnderground,
  canBuyLaser,
  canBuyResearch,
  canBuyRebuild,
  canBuySpyNetwork,
  canBuyShield,
  canBuyUnderground,
  cityAsSeenBy,
  laserShotsKnownTo,
  citiesLeft,
  computeScore,
  concludeRoundTurns,
  currentNationId,
  endTurn,
  finishBuyPhase,
  maxBombsPurchasable,
  maxDronesPurchasable,
  queueStrike,
  seesCity,
  researchCount,
  sanctionsLeft,
  toggleSanction,
} from './engine';
import type { City, GameState, NationId } from '../types';

/** Extra threat weight carried by a rival that is sanctioning us. */
const GRUDGE = 30;
/** How far a rival must overtake a sanctioned one before the AI switches. */
const SWAP_MARGIN = 20;

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

/**
 * A rival's cities as this nation sees them. Without a spy service every
 * enemy city reads as bare ground, so the AI plans the same way a blind human
 * does: it picks targets on position alone and finds the shields the hard way.
 */
function seenCities(state: GameState, viewerId: NationId, targetId: NationId): City[] {
  return state.nations[targetId].cities.map((c) => cityAsSeenBy(state, viewerId, targetId, c));
}

/** Drones already committed this round cannot escort another warhead. */
function freeDrones(state: GameState, attackerId: NationId): number {
  const queued = state.pendingStrikes.filter(
    (s) => s.attackerId === attackerId && s.weapon === 'drone',
  ).length;
  return Math.max(0, state.nations[attackerId].drones - queued);
}

/** Rivals worth shooting at with the case against each, most dangerous first. */
function weighRivals(
  state: GameState,
  attackerId: NationId,
): { id: NationId; weight: number }[] {
  return aliveNations(state)
    .filter((id) => id !== attackerId && citiesLeft(state, id) > 0)
    .map((id) => {
      // Taking a rival's last city puts them out of the running entirely,
      // unless their treasury can pay for the automatic rebuild.
      const finishable =
        citiesLeft(state, id) === 1 && state.nations[id].money < COSTS.rebuild ? 120 : 0;
      // Sanctions are a declaration: a rival squeezing our income has already
      // picked a fight, and answering it is cheaper than bleeding all match.
      const grudge = state.nations[id].sanctions.includes(attackerId) ? GRUDGE : 0;
      return { id, weight: threatScore(state, id) + finishable + grudge };
    })
    .sort((a, b) => b.weight - a.weight);
}

/** Rivals worth shooting at, most dangerous first. */
export function rankedRivals(state: GameState, attackerId: NationId): NationId[] {
  return weighRivals(state, attackerId).map((r) => r.id);
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
  // shielded with a swarm free to tie the shield up. Against a laser network
  // the escort has to survive first, so we need more swarms in hand than the
  // network has shots left this round.
  for (const rival of rivals) {
    const suppressible = escorts > laserShotsKnownTo(state, attackerId, rival);
    const killable = seenCities(state, attackerId, rival)
      .filter((c) => eligible(c) && (!c.hasShield || suppressible))
      .sort((a, b) => worth(b) - worth(a));
    if (killable.length > 0) return { nationId: rival, cityId: killable[0].id };
  }
  // Nothing dies this round — strip the leader's shield so it dies next round
  for (const rival of rivals) {
    const shielded = seenCities(state, attackerId, rival).find(
      (c) => eligible(c) && c.hasShield,
    );
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
  const blind = !state.nations[attackerId].hasSpyNetwork;
  const value = (rivalId: NationId, city: City) => {
    if (nuking.has(`${rivalId}:${city.id}`)) return 3;
    // Blind, a swarm is also a scout: the city it flies over is readable for
    // the rest of the war, which is worth more than a marginal repair bill.
    if (blind && !seesCity(state, attackerId, rivalId, city.id)) return 2.5;
    if (!city.hasShield && !city.isUnderground) return 2;
    return 1;
  };

  const swarmsInHand = freeDrones(state, attackerId);
  for (const rival of rivals) {
    // A network with shots left burns swarms for nothing. Only send them at a
    // covered nation when there are enough to saturate it, or when a warhead
    // is already inbound and the escort has to get through.
    const shots = laserShotsKnownTo(state, attackerId, rival.id);
    const saturating = swarmsInHand > shots;
    if (shots > 0 && !saturating) continue;
    const cities = seenCities(state, attackerId, rival.id).filter(
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

/** Enemy cities a warhead could actually take off the board this round. */
function openTargets(state: GameState, id: NationId): City[] {
  const swarms = state.nations[id].drones;
  return aliveNations(state)
    .filter((nid) => nid !== id)
    .flatMap((nid) => {
      // A shield only falls to a swarm, and a swarm only lands if it can
      // outlast the defender's laser network
      const suppressible = swarms > laserShotsKnownTo(state, id, nid);
      return seenCities(state, id, nid).filter(
        (c) => !c.destroyed && !c.isUnderground && (!c.hasShield || suppressible),
      );
    });
}

/**
 * AI purchases only — leaves phase on 'action'.
 *
 * Shape of the plan, in the order that won the strategy simulation: rubble
 * back on the board first, then two research centres for the income, then a
 * shield on the most valuable exposed city (the rules allow one a round), then
 * as many warheads as there are cities they can actually level. From round 2
 * a strike package is reserved ahead of all of that, because a warhead bought
 * now lands now and a rival city left standing banks points every round.
 * Warheads bought with no killable target are the single most expensive
 * mistake available, so they are sized, not maximised.
 */
export function runAiBuyPhase(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated || s.nations[id].isHuman) return s;

  s = { ...s, phase: 'buy' };

  const me = () => s.nations[id];
  const finalRound = s.round >= s.maxRounds;

  // Down to the last city, a rebuild in the bank is an automatic comeback —
  // that insurance outscores anything else the money could buy.
  const rescue =
    citiesLeft(s, id) <= 1 && me().money >= COSTS.rebuild && !finalRound ? COSTS.rebuild : 0;
  const spare = () => Math.max(0, me().money - rescue);

  // From round 2 on, hold back enough for one strike while there is anything
  // worth hitting: a warhead bought now lands now, and a rival city left
  // standing banks survival points every round. The opening turn is the
  // exception — research and a shield bought in round 1 pay for the whole
  // match, and simulation says arming instead of building costs the AI wins.
  const strikeCost = () => (me().hasNuclearTech ? 0 : COSTS.nuclearTech) + COSTS.bomb;
  const worthArming = () => s.round > 1 && openTargets(s, id).length > 0;
  const budget = () => Math.max(0, spare() - (worthArming() ? strikeCost() : 0));

  // Rubble scores nothing: a rebuilt city is 30 pts back plus survival points
  if (canBuyRebuild(s, id) && spare() >= COSTS.rebuild) {
    const rubble = me().cities.find((c) => c.destroyed);
    if (rubble) s = buyRebuild(s, rubble.id, id);
  }

  if (!me().hasNuclearTech && spare() >= strikeCost() && worthArming()) {
    s = buyNuclearTech(s, id);
  }

  // Two centres is the sweet spot: the third costs a shield's worth of cash and
  // paints the city as the juiciest target on the board. Only one site a round,
  // so the second centre waits for next round's budget like everyone else's.
  if (researchCount(s, id) < 2 && canBuyResearch(s, id) && budget() >= COSTS.research) {
    const spot = me().cities.find((c) => !c.destroyed && !c.hasResearch);
    if (spot) s = buyResearch(s, spot.id, id);
  }

  // Eyes before warheads. The standings say how many shields a rival has put
  // up, but not which city carries them, and a blind package is spent finding
  // out: one bounced warhead costs more than the whole spy service.
  const rivalShields = () =>
    aliveNations(s)
      .filter((nid) => nid !== id)
      .reduce((total, nid) => total + computeScore(s, nid).shields, 0);
  // Only out of genuinely spare cash: intel that costs a warhead is a bad
  // trade, because a warhead aimed at a shield still burns the shield down.
  // Simulation puts the line at two warheads of headroom — above it the
  // service pays for itself, below it the money was better spent shooting.
  if (
    canBuySpyNetwork(s, id) &&
    worthArming() &&
    rivalShields() > 0 &&
    budget() >= COSTS.spy + 2 * COSTS.bomb
  ) {
    s = buySpyNetwork(s, id);
  }

  // Aerospace pays for itself the same round: swarms suppress shields for the
  // warheads already in the plan, and they bill the cities they cannot kill.
  if (!me().hasAerospaceTech && budget() >= COSTS.aerospaceTech + COSTS.drone) {
    s = buyAerospaceTech(s, id);
  }

  // One shield a round, so it goes on the city that would hurt most to lose
  if (canBuyShield(s, id) && budget() >= COSTS.shield) {
    const exposed = me().cities.filter((c) => !c.destroyed && !c.hasShield && !c.isUnderground);
    const pick = exposed.find((c) => c.hasResearch) ?? exposed[0];
    if (pick) s = buyShield(s, pick.id, id);
  }

  // One battery covers the whole nation, so it is worth buying as soon as any
  // rival can field swarms at all — the network both cancels repair bills and,
  // more importantly, keeps shields free to stop the warheads those swarms
  // were sent to escort. It goes on the city most likely to still be there
  // next round, because the network dies with its city.
  const swarmThreat = aliveNations(s).some(
    (nid) =>
      nid !== id &&
      (s.nations[nid].hasAerospaceTech || s.nations[nid].drones > 0 || s.nations[nid].dronesUsed > 0),
  );
  if (swarmThreat && canBuyLaser(s, id) && budget() >= COSTS.laser) {
    const exposed = me().cities.filter((c) => !c.destroyed && !c.hasLaser);
    const pick =
      exposed.find((c) => c.isUnderground) ??
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
  // Without a spy service the shielded city cannot be picked out, but the
  // count is public on the scoreboard: a nation that knows three shields are
  // up still buys the swarms to suppress them, it just cannot aim them.
  // Blind, the shielded city cannot be picked out, but the count is public on
  // the scoreboard. Escorts are only worth buying when the odds of hitting a
  // shield are real: simulation puts break-even at one shield per two standing
  // enemy cities, below which the money belongs in warheads.
  const rivals = aliveNations(s).filter((nid) => nid !== id);
  const knownShields = rivals.reduce((total, nid) => total + computeScore(s, nid).shields, 0);
  const rivalCities = rivals.reduce(
    (total, nid) => total + s.nations[nid].cities.filter((c) => !c.destroyed).length,
    0,
  );
  const worthEscorting = rivalCities > 0 && knownShields * 2 >= rivalCities;
  const shielded = me().hasSpyNetwork
    ? targets.length - undefended
    : worthEscorting
      ? Math.min(targets.length, knownShields)
      : 0;
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

  // A swarm is the cheap way to find out what a city is hiding: it flies for
  // the price of half a warhead and, if it gets through, the defences are on
  // the table for the rest of the war. Worth one pack out of spare cash while
  // there is still a round left to use what it brings back.
  const blindOnSomething = aliveNations(s)
    .filter((nid) => nid !== id)
    .some((nid) =>
      s.nations[nid].cities.some((c) => !c.destroyed && !seesCity(s, id, nid, c.id)),
    );
  if (
    blindOnSomething &&
    // Intel is only worth buying for a nation that can act on it
    me().hasNuclearTech &&
    s.round < s.maxRounds &&
    maxDronesPurchasable(s, id) > 0 &&
    spare() >= COSTS.drone + COSTS.bomb
  ) {
    s = buyDrone(s, id);
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

/**
 * Sanctions are limited and public, so an AI spends them on the rivals it
 * means to shoot at: read the sanction list and you know where its warheads
 * are pointed. A name is only swapped out when a clearly bigger threat turns
 * up, so the table is not watching sanctions flicker every round.
 */
export function runAiDiplomacy(state: GameState): GameState {
  let s = state;
  const id = currentNationId(s);
  if (!s.nations[id] || s.nations[id].eliminated) return s;

  const weights = new Map(weighRivals(s, id).map((r) => [r.id, r.weight]));
  const held = () => s.nations[id].sanctions.filter((nid) => !s.nations[nid].eliminated);
  const unsanctioned = () =>
    [...weights.keys()].filter((nid) => !s.nations[id].sanctions.includes(nid));

  // Free slots go to the biggest threats
  while (sanctionsLeft(s, id) > 0) {
    const next = unsanctioned()[0];
    if (next == null) break;
    s = toggleSanction(s, next, id);
  }

  // Full up: swap only for a rival that has clearly overtaken the weakest name
  const weakest = held().sort((a, b) => (weights.get(a) ?? 0) - (weights.get(b) ?? 0))[0];
  const challenger = unsanctioned()[0];
  if (weakest != null && challenger != null) {
    const beaten = (weights.get(challenger) ?? 0) > (weights.get(weakest) ?? 0) + SWAP_MARGIN;
    if (beaten) {
      s = toggleSanction(s, weakest, id);
      s = toggleSanction(s, challenger, id);
    }
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
    const before = s;
    s = queueStrike(s, target.nationId, target.cityId, nationId);
    // A refused strike would leave the warhead in hand and the plan unchanged
    if (s === before) break;
    // A shielded target only falls if drones tie the shield up first
    const city = seenCities(s, nationId, target.nationId).find((c) => c.id === target.cityId);
    const shots = laserShotsKnownTo(s, nationId, target.nationId);
    if (city?.hasShield && s.nations[nationId].drones > shots) {
      // The network fires in the order swarms arrive, and a city can only be
      // swarmed once, so decoys go to the neighbours first: they burn the
      // battery's shots and the escort behind them reaches the shield.
      let burnt = 0;
      for (const decoy of s.nations[target.nationId].cities) {
        if (burnt >= shots || s.nations[nationId].drones <= 1) break;
        if (decoy.destroyed || decoy.id === target.cityId) continue;
        if (s.nations[nationId].citiesDronedThisRound.includes(decoy.id)) continue;
        s = queueStrike(s, target.nationId, decoy.id, nationId, 'drone');
        burnt += 1;
      }
      if (burnt >= shots && s.nations[nationId].drones > 0) {
        s = queueStrike(s, target.nationId, target.cityId, nationId, 'drone');
      }
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
