/**
 * Research labs invent things the shops do not sell. A nation that keeps a lab
 * standing for LAB_ROUNDS_PER_INVENTION rounds is handed one prototype, drawn from
 * a fixed seed so every client in an online match gets the same one. Prototypes
 * are free, need no Ballistic Missile Tech, and sit in their own stock next to the
 * bought warheads: three bombs nobody can buy (cluster, chemical, biological) and
 * the defence drones that guard a city. A lab can also come up with knowledge instead
 * of hardware: Ballistic Missile Tech or Aerospace Tech, handed over outright, which
 * is never drawn for a nation that already holds it.
 *
 * Pure and engine-free (the engine imports this, never the reverse).
 */
import {
  CLUSTER_DAMAGE_OPEN,
  CLUSTER_DAMAGE_PROTECTED,
  LAB_ROUNDS_PER_INVENTION,
} from '../data/nations';
import type { InventionKind, NationId, NationState, WarheadKind } from '../types';

export interface InventionInfo {
  name: string;
  /** What the scientists announce */
  headline: string;
  /** What it does, in a line the strike dock can show */
  effect: string;
  /** Odds in the lab's draw (relative) */
  weight: number;
}

/** Odds of a tech breakthrough, against 3 for a common bomb. */
const TECH_WEIGHT = 2;

export const INVENTION_INFO: Record<InventionKind, InventionInfo> = {
  cluster: {
    name: 'Cluster bomb',
    headline: 'A canister that scatters bomblets over an entire nation',
    effect: `Hits every city of one rival at once: $${CLUSTER_DAMAGE_OPEN}M of damage on each open city, $${CLUSTER_DAMAGE_PROTECTED}M on each protected one (shield, bunker or laser). Nothing is levelled.`,
    weight: 3,
  },
  chemical: {
    name: 'Chemical bomb',
    headline: 'A gas that empties a city of everything but its bunker',
    effect:
      'Destroys any city that is not underground. A laser battery shoots it down and a shield absorbs it, so strip those first. A bunker holds it out.',
    weight: 3,
  },
  biological: {
    name: 'Biological bomb',
    headline: 'A plague that seeps even into the bunkers',
    effect:
      'Destroys a city even underground, but a shield or a laser battery destroys the bomb first. Fire it with a magnetic bomb to black out the lasers and drones to tie up the shield.',
    weight: 2,
  },
  defenseDrones: {
    name: 'Defence drones',
    headline: 'An autonomous screen that meets incoming attacks in the sky',
    effect:
      'Guards the first city of yours that is attacked: the drones hit every attack on it in the sky and neutralise it for the round. They wait on standby, and are only used up on a round in which one of your cities is attacked.',
    weight: 3,
  },
  ballisticTech: {
    name: 'Ballistic Missile Tech',
    headline: 'A breakthrough in rocketry that puts long-range warheads within reach',
    effect: 'Unlocks Ballistic Missile Tech outright: nuclear, hydrogen and magnetic warheads can be bought and fired from now on, with no tech fee on your first one.',
    weight: TECH_WEIGHT,
  },
  aerospaceTech: {
    name: 'Aerospace Tech',
    headline: 'A breakthrough in flight that brings drones and lasers within reach',
    effect: 'Unlocks Aerospace Tech outright: drone packs, heliborne squads and laser batteries can be bought from now on, with no tech fee on your first one.',
    weight: TECH_WEIGHT,
  },
};

/** Everything a lab can come up with, in a fixed order */
export const INVENTION_KINDS = Object.keys(INVENTION_INFO) as InventionKind[];

/** Inventions that are knowledge, not hardware: they never sit in the arsenal. */
export const TECH_KINDS: readonly InventionKind[] = ['ballisticTech', 'aerospaceTech'];

export function isTechKind(kind: InventionKind | string): kind is 'ballisticTech' | 'aerospaceTech' {
  return (TECH_KINDS as readonly string[]).includes(kind);
}

/** Inventions that arrive as stock: the bombs and the defence drones. */
export const STOCK_KINDS: readonly InventionKind[] = INVENTION_KINDS.filter((k) => !isTechKind(k));

/** The bombs that exist only as inventions (they cannot be bought) */
export type PrototypeKind = Extract<WarheadKind, InventionKind>;
export const PROTOTYPE_KINDS: readonly PrototypeKind[] = ['cluster', 'biological', 'chemical'];

export function isPrototypeKind(kind: WarheadKind | string): kind is PrototypeKind {
  return (PROTOTYPE_KINDS as readonly string[]).includes(kind);
}

/** Invented bombs of this kind still waiting in the arsenal. */
export function inventionStock(
  n: Pick<NationState, 'inventions' | 'inventionsUsed'>,
  kind: InventionKind,
): number {
  const made = (n.inventions ?? []).filter((k) => k === kind).length;
  return Math.max(0, made - (n.inventionsUsed?.[kind] ?? 0));
}

/** Every invented bomb still in stock, of any kind. */
export function inventionTotal(n: Pick<NationState, 'inventions' | 'inventionsUsed'>): number {
  return STOCK_KINDS.reduce((sum, kind) => sum + inventionStock(n, kind), 0);
}

/**
 * A lab bought in `round` delivers its first bomb LAB_ROUNDS_PER_INVENTION rounds
 * later, and a bomb that arrives after the last round is worth nothing. So in the
 * closing rounds a lab is all cost and no result, and cannot be bought.
 */
export function labCanFinish(round: number, maxRounds: number): boolean {
  return round + LAB_ROUNDS_PER_INVENTION <= maxRounds;
}

/** How far along the next invention is: rounds of lab work done and rounds needed. */
export function researchProgress(n: Pick<NationState, 'labRounds'>): { done: number; of: number } {
  return { done: (n.labRounds ?? 0) % LAB_ROUNDS_PER_INVENTION, of: LAB_ROUNDS_PER_INVENTION };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * What the lab invents next. Seeded by the match, the nation and how many
 * inventions it already has, so a client that recomputes gets the same answer.
 * The same kind never comes twice in a row: a second draw should feel new, and a
 * technology the nation already holds is never drawn.
 */
export function pickInvention(
  seed: number,
  nationId: NationId,
  made: readonly InventionKind[],
  /** Inventions the nation has no use for (technology it already holds, own or lent) */
  owned: readonly InventionKind[] = [],
): InventionKind {
  const last = made[made.length - 1];
  const pool = INVENTION_KINDS.filter((k) => k !== last && !owned.includes(k));
  if (pool.length === 0) return INVENTION_KINDS.find((k) => !isTechKind(k) && k !== last) ?? 'cluster';
  const total = pool.reduce((sum, k) => sum + INVENTION_INFO[k].weight, 0);
  let roll = hash(`${seed}:${nationId}:${made.length}`) % total;
  for (const kind of pool) {
    roll -= INVENTION_INFO[kind].weight;
    if (roll < 0) return kind;
  }
  return pool[0];
}

/** The invention announced at the start of `round`, if this nation's lab made one. */
export function inventionOfRound(
  n: Pick<NationState, 'inventions' | 'inventionRound' | 'eliminated'>,
  round: number,
): InventionKind | null {
  if (n.eliminated || n.inventionRound !== round) return null;
  const list = n.inventions ?? [];
  return list.length > 0 ? list[list.length - 1] : null;
}
