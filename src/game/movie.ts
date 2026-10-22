/**
 * The strike movie: what an attacker's volley looks like, shot by shot, and how
 * long each shot runs. Pure, so the engine can budget the same running time the
 * screen plays and every client in an online match waits for the same length.
 */
import { DRONE_DAMAGE } from '../data/nations';
import { ART } from '../data/art';
import type { NationId, PendingStrike, StrikeWeapon } from '../types';

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
  /** How the Heliborne squad fared: it took the city, turned back, or found nothing */
  raid?: 'captured' | 'repelled' | 'empty';
  /** What turned the squad back */
  raidCover?: 'laser' | 'shield' | 'bunker';
  /** A magnetic bomb had darkened this nation's lasers before the hit */
  laserDown?: boolean;
  /** Score the attacker banks here: the conquest bonus, or the kill points */
  points?: number;
  /** The takeover needed no warhead */
  clean?: boolean;
  /** The city is rubble when this volley's missiles arrive on screen */
  rubble?: boolean;
  /** Who razed this city in the round's true order, when this volley found nothing left */
  razedBy?: string;
  /** Who took this city over before a squad of this volley arrived */
  heldBy?: string;
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
      return 'Heliborne inbound';
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
    if (target.rubble && target.razedBy) return `${target.razedBy} razed it first`;
    if (target.rubble) return 'City in rubble';
    // The squad's own warhead levelled it a moment earlier
    if (target.leveled) return 'City in rubble';
    if (target.heldBy) return `${target.heldBy} took it first`;
    return 'City already gone';
  }
  if (target.rubble) {
    if (!impacted) return target.razedBy ? `${target.razedBy} razed it first` : 'Already in rubble';
    if (warhead) return 'Already rubble — the ruins take the hit';
    return target.razedBy ? `${target.razedBy} razed it first` : 'Already in rubble';
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
    return squads > 1 ? `HELIBORNE — ${squads} SQUADS` : 'HELIBORNE';
  }
  if (squads > 0) return 'HELIBORNE — COMBINED ARMS';
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
    squad ? raidAt + 4_900 : 0,
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
    if (t.raid === 'captured') return 'captured';
    if (t.raid === 'repelled') return 'repelled';
    // The squad's own warhead razed it first: the film shows that razing, then the ruins
    return t.leveled && !t.rubble ? 'razed' : 'empty';
  }
  if (t.rubble && !t.leveled) return 'empty';
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
      if (t.rubble) return `${t.cityName}: already rubble`;
      return t.heldBy ? `${t.cityName}: ${t.heldBy} took it first` : `${t.cityName}: already gone`;
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

/** Which launches the cinema films. */
export type CinemaScope = 'mine' | 'all';

/**
 * Cuts a round's volleys down to what concerns the viewer: every volley they
 * launched, and the strikes of anyone else that landed on their cities. A null
 * viewer list (spectators, or the "all battles" setting) keeps everything.
 */
export function filterVolleysForViewer<V extends { attackerId: NationId; strikes: PendingStrike[] }>(
  volleys: V[],
  viewers: readonly NationId[] | null,
): V[] {
  if (!viewers) return volleys;
  const mine = new Set(viewers);
  const out: V[] = [];
  for (const v of volleys) {
    if (mine.has(v.attackerId)) {
      out.push(v);
      continue;
    }
    const strikes = v.strikes.filter((s) => mine.has(s.targetNationId));
    if (strikes.length > 0) out.push({ ...v, strikes });
  }
  return out;
}

/**
 * Makes one volley's targets agree with what the film has already shown.
 * Volleys play in the round's own order, so a city can be razed in the true
 * resolution by a volley the film reaches later. The first volley on screen
 * with a warhead on that city plays the razing, and every later hit lands on
 * the rubble. A raid or swarm that arrives first sees the city as rubble with
 * the razer named, never a bare "nothing left" for a city the film has not razed.
 * `razed` carries the city ids already razed on screen from earlier volleys.
 */
export function reconcileWithFilm(targets: StrikeTarget[], razed: Set<string>): void {
  for (const t of targets) {
    const squad = t.weapons.includes('commando');
    if (razed.has(t.cityId)) {
      t.rubble = true;
      if (!squad) {
        t.leveled = false;
        t.absorbed = false;
      }
    } else if (t.razedBy && !t.leveled) {
      if (!squad && t.weapons.some(isBallisticWeapon)) {
        t.leveled = true;
        t.rubble = false;
      } else {
        t.rubble = true;
      }
    }
  }
  for (const t of targets) {
    if (t.weapons.includes('commando') || t.rubble || t.absorbed || t.lasered) continue;
    const escort = t.weapons.includes('drone') && t.weapons.some(isBallisticWeapon);
    if (t.weapons.includes('hydrogen') || (escort && (t.hadShield || t.laserDown))) t.leveled = true;
  }
  for (const t of targets) if (t.leveled) razed.add(t.cityId);
}
