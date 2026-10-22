/**
 * The strike movie: what an attacker's volley looks like, shot by shot, and how
 * long each shot runs. Pure, so the engine can budget the same running time the
 * screen plays and every client in an online match waits for the same length.
 */
import { DRONE_DAMAGE } from '../data/nations';
import { ART } from '../data/art';
import type { NationId, PendingStrike, RoundWorldEvent, StrikeWeapon } from '../types';

/** The photoreal sprite of a weapon, upright (missiles point up, helicopters face right). */
export function movieCraft(weapon: StrikeWeapon): string {
  if (weapon === 'commando') return ART.mv.heli;
  if (weapon === 'drone') return ART.mv.drone;
  return ART.mv.missile[weapon === 'hydrogen' ? 'hydrogen' : weapon === 'magnetic' ? 'magnetic' : 'nuke'];
}

export function craftArt(weapon: StrikeWeapon): string {
  if (weapon === 'commando') return ART.heli;
  if (weapon === 'drone') return ART.drone;
  if (weapon === 'hydrogen') return ART.missileHydrogen;
  if (weapon === 'magnetic') return ART.missileMagnetic;
  return ART.missile;
}

export interface StrikeTarget {
  to: NationId;
  cityId: string;
  cityName: string;
  /** A city can catch a warhead and a drone swarm in the same volley */
  weapons: StrikeWeapon[];
  /** Repair bill per drone pack — halved when the city has a shield or bunker */
  droneBill?: number;
  /** The city's lasers downed the swarm, so it never reaches the skyline */
  lasered?: boolean;
  /** The warhead broke against the bunker: the ground shakes, nothing burns */
  absorbed?: boolean;
  /** A shield was up when this volley left the pad */
  hadShield?: boolean;
  /** The city was dug in when this volley left the pad */
  hadBunker?: boolean;
  /** This attacker's warhead leveled the city */
  leveled?: boolean;
  /** How the Invisible Force squad fared: it took the city, turned back, or found nothing */
  raid?: 'captured' | 'repelled' | 'empty';
  /** What turned the squad back */
  raidCover?: 'laser' | 'shield' | 'bunker';
  /** A magnetic bomb had darkened this nation's lasers before the hit */
  laserDown?: boolean;
  /** Score the attacker banks here: the conquest bonus, or the kill points */
  points?: number;
  /** The takeover needed no warhead */
  clean?: boolean;
}

/** One attacker's whole volley — every missile flies in the same panel. */
export interface StrikeShow {
  from: NationId;
  targets: StrikeTarget[];
}


export function isBallisticWeapon(weapon: StrikeWeapon | undefined): boolean {
  return weapon !== 'drone' && weapon !== 'commando';
}


export function cinemaCaption(target: StrikeTarget, impacted: boolean): string | null {
  const warhead = target.weapons.some(isBallisticWeapon);
  const swarm = target.weapons.includes('drone');
  const escorted = swarm && warhead;
  if (target.weapons.includes('commando')) {
    const opened = swarm || warhead;
    if (!impacted) {
      if (target.hadBunker && target.weapons.includes('hydrogen')) return 'Hydrogen opens the bunker — squad inbound';
      if (target.hadBunker) return 'Underground bunker';
      if (target.hadShield && opened) return 'Shielded — squad follows the opening';
      if (target.hadShield) return 'City shield';
      return 'Invisible Force inbound';
    }
    if (target.raid === 'captured') {
      if (target.hadBunker) return 'Bunker breached — city taken over';
      if (target.hadShield && swarm) return 'Shield tied up — city taken over';
      if (target.hadShield) return 'Shield stripped — city taken over';
      if (target.laserDown) return 'Lasers dark — city taken over';
      return 'City taken over';
    }
    if (target.raid === 'repelled') {
      if (target.raidCover === 'laser') return 'Lasers shot the helicopters down';
      if (target.raidCover === 'bunker') return 'Bunker sealed — squad turned back';
      return 'Shield held — squad turned back';
    }
    return 'Nothing left to take';
  }
  if (!impacted) {
    if (target.hadBunker) return 'Underground bunker';
    if (target.hadShield && escorted && target.laserDown) {
      return 'Shield and laser — magnetic bomb inbound';
    }
    if (target.hadShield && escorted) return 'Shielded — swarm and warhead inbound';
    if (target.hadShield) return 'City shield';
    if (target.weapons.includes('hydrogen')) return 'Hydrogen warhead';
    if (target.weapons.includes('magnetic')) return 'Magnetic EMP';
    if (target.lasered) return 'Lasers tracking the swarm';
    if (swarm) return 'Drone swarm';
    return null;
  }
  if (target.absorbed) return 'Bunker held — no damage';
  if (target.leveled && target.hadBunker) return 'Bunker cracked — city in rubble';
  if (target.leveled && escorted && target.laserDown) {
    return 'Laser down, swarm through — city in rubble';
  }
  if (target.leveled && escorted) return 'Swarm tied up the shield — city in rubble';
  if (target.leveled && target.hadShield) return 'Shield failed — city in rubble';
  if (target.hadShield && !target.leveled && warhead) return 'Shield shattered';
  if (target.leveled) return 'City in rubble';
  if (target.lasered) return 'Lasers shot the swarm down';
  if (swarm) {
    return warhead ? 'Shield swarmed' : `−$${target.droneBill ?? DRONE_DAMAGE}M damages`;
  }
  return null;
}


export function strikeTitle(flightPlan: { weapon: StrikeWeapon }[], targetCount: number): string {
  const nukes = flightPlan.filter((f) => f.weapon === 'nuke' || !f.weapon).length;
  const hydro = flightPlan.filter((f) => f.weapon === 'hydrogen').length;
  const mag = flightPlan.filter((f) => f.weapon === 'magnetic').length;
  const drones = flightPlan.filter((f) => f.weapon === 'drone').length;
  const squads = flightPlan.filter((f) => f.weapon === 'commando').length;
  const warheads = nukes + hydro + mag;
  if (squads > 0 && warheads === 0 && drones === 0) {
    return squads > 1 ? `INVISIBLE FORCE — ${squads} SQUADS` : 'INVISIBLE FORCE';
  }
  if (squads > 0) return 'INVISIBLE FORCE — COMBINED ARMS';
  if (warheads === 0) {
    return drones > 1 ? `DRONE SWARMS — ${drones} PACKS` : 'DRONE SWARM';
  }
  const kinds: string[] = [];
  if (hydro) kinds.push(hydro > 1 ? `${hydro} HYDROGEN` : 'HYDROGEN');
  if (mag) kinds.push(mag > 1 ? `${mag} MAGNETIC` : 'MAGNETIC');
  if (nukes) kinds.push(nukes > 1 ? `${nukes} NUCLEAR` : 'NUCLEAR');
  const head =
    kinds.length === 1
      ? `${kinds[0].replace(/^\d+\s/, '')} LAUNCH`
      : `MIXED WARHEADS — ${kinds.join(' · ')}`;
  if (drones > 0) return `${head} — DRONES ESCORT`;
  if (targetCount > 1 && kinds.length === 1) return `${head} — ${targetCount} MISSILES`;
  return head;
}

/**
 * Every beat below is written at "storyboard speed" and played this many times
 * slower, so a shot has room to land. The screen slows its animations by the
 * same factor.
 */
export const MOVIE_PACE = 1.6;

/** Fixed shots of every volley */
export const MOVIE_TITLE_MS = Math.round(1_400 * MOVIE_PACE);
export const MOVIE_LAUNCH_MS = Math.round(1_900 * MOVIE_PACE);

/** The globe shot: long enough to follow every route from the pad to its city. */
export function trackShotMs(count: number): number {
  return Math.round(6_000 + 700 * Math.min(4, Math.max(0, count - 1)));
}
export const MOVIE_TOLL_MS = Math.round(1_800 * MOVIE_PACE);

/** When things happen inside one city's shot, in ms from the cut to that city. */
export interface TargetTimeline {
  droneAt: number;
  warheadAt: number;
  raidAt: number;
  /** The shortest the shot can run and still show every beat */
  needs: number;
}

/**
 * A swarm opens the way, then the warhead lands, then the squad arrives:
 * the same order the engine resolves them in.
 */
export function targetTimeline(weapons: readonly string[]): TargetTimeline {
  const swarm = weapons.includes('drone');
  const squad = weapons.includes('commando');
  const warhead = weapons.some((w) => w !== 'drone' && w !== 'commando');
  const lead = swarm && (warhead || squad) ? 700 : 0;
  const warheadAt = lead + 750;
  const raidAt = lead + (warhead ? 800 : 0);
  const needs = Math.max(
    swarm ? 2_100 : 0,
    warhead ? warheadAt + 1_700 : 0,
    squad ? raidAt + 3_800 : 0,
  );
  return { droneAt: 0, warheadAt, raidAt, needs };
}

/**
 * How long one city's shot runs. The target shots share roughly five seconds,
 * so one city gets room to breathe and a long list stays brisk, but never less
 * than the beats of its own weapons need.
 */
export function targetShotMs(weapons: readonly string[], count: number): number {
  const share = Math.max(1_700, Math.min(2_800, Math.round(5_200 / Math.max(1, count))));
  return Math.round(Math.max(share, targetTimeline(weapons).needs) * targetPace(count));
}

/** A long target list plays a touch quicker so one attacker never takes over the table. */
export function targetPace(count: number): number {
  return count >= 3 ? 1.2 : MOVIE_PACE;
}

/** Running time of one attacker's movie, from the title card to the toll card. */
export function volleyMovieMs(targets: readonly { weapons: readonly string[] }[]): number {
  const n = targets.length;
  const shots = targets.reduce((sum, t) => sum + targetShotMs(t.weapons, n), 0);
  return MOVIE_TITLE_MS + MOVIE_LAUNCH_MS + trackShotMs(n) + shots + MOVIE_TOLL_MS;
}

export type TargetOutcome =
  | 'captured'
  | 'repelled'
  | 'razed'
  | 'shield'
  | 'bunker'
  | 'swarmed'
  | 'swarmShot'
  | 'empty';

/** What happened to one city, in the one word the shot and the toll card both use. */
export function targetOutcome(t: StrikeTarget): TargetOutcome {
  if (t.weapons.includes('commando')) {
    return t.raid === 'captured' ? 'captured' : t.raid === 'repelled' ? 'repelled' : 'empty';
  }
  if (t.absorbed) return 'bunker';
  if (t.leveled) return 'razed';
  if (t.lasered && !t.weapons.some(isBallisticWeapon)) return 'swarmShot';
  if (t.hadShield && t.weapons.some(isBallisticWeapon)) return 'shield';
  if (t.weapons.includes('drone')) return t.lasered ? 'swarmShot' : 'swarmed';
  return 'empty';
}

/** One line of the toll card for a city. */
export function outcomeLine(t: StrikeTarget): string {
  switch (targetOutcome(t)) {
    case 'captured':
      return `${t.cityName} taken over`;
    case 'repelled':
      return `${t.cityName}: raid turned back`;
    case 'razed':
      return `${t.cityName} in rubble`;
    case 'shield':
      return `${t.cityName}: shield destroyed`;
    case 'bunker':
      return `${t.cityName}: bunker held`;
    case 'swarmed':
      return `${t.cityName}: swarm damage`;
    case 'swarmShot':
      return `${t.cityName}: swarm shot down`;
    default:
      return `${t.cityName}: nothing left to take`;
  }
}

export type MovieShot =
  | { kind: 'title'; ms: number; pace: number }
  | { kind: 'launch'; ms: number; pace: number }
  | { kind: 'track'; ms: number; pace: number }
  | { kind: 'target'; ms: number; pace: number; index: number }
  | { kind: 'toll'; ms: number; pace: number };

export function buildShots(strike: StrikeShow): MovieShot[] {
  const n = strike.targets.length;
  return [
    { kind: 'title', ms: MOVIE_TITLE_MS, pace: MOVIE_PACE },
    { kind: 'launch', ms: MOVIE_LAUNCH_MS, pace: MOVIE_PACE },
    { kind: 'track', ms: trackShotMs(n), pace: MOVIE_PACE },
    ...strike.targets.map((t, index) => ({
      kind: 'target' as const,
      ms: targetShotMs(t.weapons, n),
      pace: targetPace(n),
      index,
    })),
    { kind: 'toll', ms: MOVIE_TOLL_MS, pace: MOVIE_PACE },
  ];
}

export function movieTitle(strike: StrikeShow): string {
  const plan = strike.targets.flatMap((t) => t.weapons.map((weapon) => ({ weapon })));
  return strikeTitle(plan, strike.targets.length);
}

/** Every distinct weapon of the volley with how many were sent. */
export function arsenalOf(strike: StrikeShow): { weapon: StrikeWeapon; count: number }[] {
  const counts = new Map<StrikeWeapon, number>();
  for (const t of strike.targets) {
    for (const w of t.weapons) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const order: StrikeWeapon[] = ['hydrogen', 'magnetic', 'nuke', 'drone', 'commando'];
  return order.filter((w) => counts.has(w)).map((weapon) => ({ weapon, count: counts.get(weapon)! }));
}

/** The weapons that reach each city of one attacker's volley, in the order the cinema visits them. */
export function volleyWeapons(
  strikes: readonly Pick<PendingStrike, 'targetNationId' | 'cityId' | 'weapon'>[],
): StrikeWeapon[][] {
  const stops: { key: string; weapons: StrikeWeapon[] }[] = [];
  for (const strike of strikes) {
    const key = `${strike.targetNationId}:${strike.cityId}`;
    const weapon: StrikeWeapon = (strike.weapon as StrikeWeapon | undefined) ?? 'nuke';
    const open = stops.find((s) => s.key === key);
    if (open) open.weapons.push(weapon);
    else stops.push({ key, weapons: [weapon] });
  }
  return stops.map((s) => s.weapons);
}

/**
 * The order the volleys play in. Quiet strikes go first and the round's big
 * moments last, but the film never contradicts the round's own order of events:
 * warheads resolve before squads, so a squad that "found nothing left to take"
 * only makes sense after the volley that turned that city to rubble. Showing the
 * squad flying home first and the rubble after reads as the wrong cause.
 */
export function orderVolleysForFilm<V extends { attackerId: NationId; strikes: PendingStrike[] }>(
  volleys: V[],
  events: RoundWorldEvent[],
): V[] {
  const rank = (v: V) => {
    let score = 0;
    for (const strike of v.strikes) {
      const mine = events.filter((e) => e.attackerId === v.attackerId && e.cityId === strike.cityId);
      if (mine.some((e) => e.kind === 'cityDestroyed' || e.kind === 'cityCaptured')) {
        score = Math.max(score, 2);
      } else if (mine.some((e) => e.kind === 'shieldDestroyed' || e.kind === 'strikeAbsorbed')) {
        score = Math.max(score, 1);
      }
    }
    return score;
  };
  const base = volleys.slice().sort((a, b) => rank(a) - rank(b));

  // Who must already have played: whoever razed a city this volley's squad found empty
  const mustFollow = (v: V): NationId[] => {
    const after = new Set<NationId>();
    for (const strike of v.strikes) {
      if (strike.weapon !== 'commando') continue;
      const own = events.some(
        (e) =>
          e.attackerId === v.attackerId &&
          e.cityId === strike.cityId &&
          (e.kind === 'cityCaptured' || e.kind === 'raidRepelled'),
      );
      if (own) continue;
      for (const e of events) {
        if (e.kind === 'cityDestroyed' && e.cityId === strike.cityId && e.attackerId && e.attackerId !== v.attackerId) {
          after.add(e.attackerId);
        }
      }
    }
    return [...after];
  };

  const ordered: V[] = [];
  const left = base.slice();
  while (left.length > 0) {
    const waiting = new Set(left.map((v) => v.attackerId));
    const next =
      left.find((v) => mustFollow(v).every((id) => !waiting.has(id) || id === v.attackerId)) ?? left[0];
    ordered.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return ordered;
}
