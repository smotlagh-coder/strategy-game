import { COSTS } from '../data/nations';
import {
  buyAerospaceTech,
  buyBombs,
  buyDrones,
  buyHydrogenBomb,
  buyLaser,
  buyMagneticBombs,
  buyNuclearTech,
  canBuyLaser,
  canBuyRebuild,
  canBuyResearch,
  canBuyShield,
  canBuySpyNetwork,
  canBuyUnderground,
  currentNationId,
  maxBombsPurchasable,
  maxDronesPurchasable,
  maxHydrogenPurchasable,
  maxMagneticPurchasable,
} from './engine';
import { hasAerospaceAccess, hasBallisticTech } from './alliance';
import type { GameState, NationId } from '../types';

/**
 * Tech is never bought on its own. Ballistic Missile Tech rides along with a
 * nation's first warhead (of any kind) and Aerospace Tech with its first drone
 * pack or laser network: one purchase, one tap, and the tech cost is simply
 * part of that first price.
 */

const idOf = (state: GameState, nationId?: NationId) => nationId ?? currentNationId(state);

/** What the first warhead also costs: Ballistic Missile Tech, until owned. */
export function ballisticBundleCost(state: GameState, nationId?: NationId): number {
  const id = idOf(state, nationId);
  // Tech an ally lends is as good as one's own
  return hasBallisticTech(state, id) ? 0 : COSTS.ballisticMissileTech;
}

/** What the first drone pack or laser also costs: Aerospace Tech, until owned. */
export function aerospaceBundleCost(state: GameState, nationId?: NationId): number {
  const id = idOf(state, nationId);
  return hasAerospaceAccess(state, id) ? 0 : COSTS.aerospaceTech;
}

/** The state with Ballistic Missile Tech unlocked, or null when it cannot be paid for. */
function withBallistic(state: GameState, id: NationId): GameState | null {
  const n = state.nations[id];
  if (n.eliminated) return null;
  if (hasBallisticTech(state, id)) return state;
  return n.money >= COSTS.ballisticMissileTech ? buyNuclearTech(state, id) : null;
}

function withAerospace(state: GameState, id: NationId): GameState | null {
  const n = state.nations[id];
  if (n.eliminated) return null;
  if (hasAerospaceAccess(state, id)) return state;
  return n.money >= COSTS.aerospaceTech ? buyAerospaceTech(state, id) : null;
}

export function maxBombsBundled(state: GameState, nationId?: NationId): number {
  const id = idOf(state, nationId);
  const s = withBallistic(state, id);
  return s ? maxBombsPurchasable(s, id) : 0;
}

export function maxMagneticBundled(state: GameState, nationId?: NationId): number {
  const id = idOf(state, nationId);
  const s = withBallistic(state, id);
  return s ? maxMagneticPurchasable(s, id) : 0;
}

export function maxHydrogenBundled(state: GameState, nationId?: NationId): number {
  const id = idOf(state, nationId);
  const s = withBallistic(state, id);
  return s ? maxHydrogenPurchasable(s, id) : 0;
}

export function maxDronesBundled(state: GameState, nationId?: NationId): number {
  const id = idOf(state, nationId);
  const s = withAerospace(state, id);
  return s ? maxDronesPurchasable(s, id) : 0;
}

export function canBuyLaserBundled(state: GameState, nationId?: NationId): boolean {
  const id = idOf(state, nationId);
  const s = withAerospace(state, id);
  return s ? canBuyLaser(s, id) : false;
}

/** Nuclear warheads; the first one also unlocks Ballistic Missile Tech. */
export function buyBombsBundled(state: GameState, count: number, nationId?: NationId): GameState {
  const id = idOf(state, nationId);
  const s = withBallistic(state, id);
  if (!s) return state;
  const k = Math.min(count, maxBombsPurchasable(s, id));
  return k < 1 ? state : buyBombs(s, k, id);
}

export function buyMagneticBundled(state: GameState, count: number, nationId?: NationId): GameState {
  const id = idOf(state, nationId);
  const s = withBallistic(state, id);
  if (!s) return state;
  const k = Math.min(count, maxMagneticPurchasable(s, id));
  return k < 1 ? state : buyMagneticBombs(s, k, id);
}

export function buyHydrogenBundled(state: GameState, nationId?: NationId): GameState {
  const id = idOf(state, nationId);
  const s = withBallistic(state, id);
  if (!s || maxHydrogenPurchasable(s, id) < 1) return state;
  return buyHydrogenBomb(s, id);
}

/** Drone packs; the first one also unlocks Aerospace Tech. */
export function buyDronesBundled(state: GameState, count: number, nationId?: NationId): GameState {
  const id = idOf(state, nationId);
  const s = withAerospace(state, id);
  if (!s) return state;
  const k = Math.min(count, maxDronesPurchasable(s, id));
  return k < 1 ? state : buyDrones(s, k, id);
}

/** A laser network; if Aerospace Tech is missing it is unlocked in the same purchase. */
export function buyLaserBundled(state: GameState, cityId: string, nationId?: NationId): GameState {
  const id = idOf(state, nationId);
  const s = withAerospace(state, id);
  if (!s) return state;
  const next = buyLaser(s, cityId, id);
  // Nothing was built (bad city): keep the tech money too
  return next === s ? state : next;
}

/**
 * The smallest amount that still buys something this nation could buy, or
 * null when nothing is left to buy (everything owned or capped). Availability
 * ignores the treasury; the price includes any tech that would be bundled.
 */
export function cheapestPurchase(state: GameState, nationId?: NationId): number | null {
  const id = idOf(state, nationId);
  const n = state.nations[id];
  if (!n || n.eliminated) return null;
  // Judge what is possible as if the treasury were full
  const rich: GameState = {
    ...state,
    nations: { ...state.nations, [id]: { ...n, money: 1_000_000 } },
  };
  const options: number[] = [];
  const ballistic = ballisticBundleCost(state, id);
  const aerospace = aerospaceBundleCost(state, id);
  if (maxBombsBundled(rich, id) > 0) options.push(COSTS.bomb + ballistic);
  if (maxMagneticBundled(rich, id) > 0) options.push(COSTS.bombMagnetic + ballistic);
  if (maxHydrogenBundled(rich, id) > 0) options.push(COSTS.bombHydrogen + ballistic);
  if (maxDronesBundled(rich, id) > 0) options.push(COSTS.drone + aerospace);
  if (canBuyLaserBundled(rich, id)) options.push(COSTS.laser + aerospace);
  if (canBuyShield(rich, id)) options.push(COSTS.shield);
  if (canBuyUnderground(rich, id)) options.push(COSTS.underground);
  if (canBuyRebuild(rich, id)) options.push(COSTS.rebuild);
  if (canBuyResearch(rich, id)) options.push(COSTS.research);
  if (canBuySpyNetwork(rich, id)) options.push(COSTS.spy);
  return options.length > 0 ? Math.min(...options) : null;
}

/** True when the treasury no longer covers even the cheapest thing left to buy. */
export function isTreasuryLow(state: GameState, nationId?: NationId): boolean {
  const id = idOf(state, nationId);
  const cheapest = cheapestPurchase(state, id);
  return cheapest != null && state.nations[id].money < cheapest;
}
