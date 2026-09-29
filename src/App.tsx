import './App.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ART, SFX } from './data/art';
import {
  NATIONS,
  nationDef,
  COSTS,
  DRONE_DAMAGE,
  LASER_INTERCEPTS_PER_ROUND,
} from './data/nations';
import {
  applyQueuedStrike,
  orderStrikesForResolution,
  aliveHumanNations,
  allAliveHumansReady,
  armAftermathTimer,
  isHumanDisconnected,
  seesCity,
  droneDamageFor,
  createInitialState,
  currentNationId,
  computeScore,
  rankNationIds,
  endTurn,
  finishBuyPhase,
  finishStrikeResolution,
  groupStrikesByAttacker,
  formatMoney,
  markHumanReady,
  totalWarheads,
  needsOvertime,
  nextRound,
  tiedForTheLead,
  pickCountry,
  queueStrike,
  queueStrikes,
  setMode,
  setPlayerNames,
  playerDisplayName,
  touchHumanActivity,
  citiesLeft,
  shieldsLeft,
  whoIsSanctioning,
} from './game/engine';
import { runAllAiUntilHumanOrSummary, runAiTurn, runOnlineAiPlanning } from './game/ai';
import { buildRoundBriefing, combatLedger } from './game/briefing';
import type {
  BriefingCityStatus,
  BriefingIntelAdvice,
  BriefingOrder,
  BriefingOrderIcon,
  RoundBriefing,
} from './game/briefing';
import type {
  City,
  GameMode,
  GameState,
  GameSyncEvent,
  NationId,
  PendingStrike,
  RoundWorldEvent,
  StrikeWeapon,
  WarheadKind,
} from './types';
import { isFirebaseConfigured } from './lib/firebase';
import {
  ensureAuthSession,
  formatPlayerLabel,
  getStoredDisplayName,
  loadOrCreatePlayer,
  resetPlayerIdentity,
  setPlayerStatus,
} from './lib/session';
import {
  advanceOnlineRound,
  fetchGame,
  finishOnlineGame,
  incrementSuperpowerWin,
  kickIdleHumanFromGame,
  leaveOnlineGame,
  listenGame,
  enqueueHumanPlanningPush,
  lockInHumanPlanning,
  markOnlineReady,
  publishPlanningComplete,
  publishSharedPhase,
  rematchOnlineGame,
  tryAcquireAiLock,
  publishStrikeResolution,
} from './lib/multiplayer';
import { applyRemoteGameSnapshot } from './lib/onlineSync';
import { applyPublishedGame } from './lib/gameSync';
import {
  AFTERMATH_THINK_MS,
  RECAP_AUTO_MS,
  REPORT_POLL_MS,
  REPORT_WAIT_MS,
  ROUND_BANNER_MS,
  ROUND_BRIEFING_MS,
  SELECTION_IDLE_MS,
  STRIKE_CINEMA_MS,
  TARGET_CONFIRM_MS,
  PURCHASE_WINDOW_MS,
} from './lib/onlineConstants';
import { aftermathMyCityIds, aftermathWorldIds } from './lib/lobbyInvite';
import { NameGate } from './screens/NameGate';
import { CommandDashboard } from './screens/CommandDashboard';
import { useFitToWindow } from './lib/useFitToWindow';
import { LobbyScreen } from './screens/Lobby';
import { LeaderboardScreen } from './screens/Leaderboard';

type FxKind = 'buy' | 'strike-label';
type WizardStep = 'command' | 'strike' | 'droneStrike';

/**
 * Angel / evil portraits follow the seats crowned at the last resolution.
 * Spy hoodies combine with those looks when both apply.
 */
function leaderArt(state: GameState, id: NationId): string {
  const spy = Boolean(state.nations[id]?.hasSpyNetwork);
  const angel = state.angelNationId === id;
  const evil = state.evilNationId === id;
  if (spy && angel) return ART.leadersSpyAngel[id];
  if (spy && evil) return ART.leadersSpyEvil[id];
  if (spy) return ART.leadersSpy[id];
  if (angel) return ART.leadersAngel[id];
  if (evil) return ART.leadersEvil[id];
  return ART.leaders[id];
}

/**
 * A city that has moved underground is redrawn inside its rock cavern, so the
 * board shows what it has become rather than labelling it.
 */
function cityArt(city: City): string {
  return city.isUnderground && !city.destroyed
    ? ART.citiesUnderground[city.id]
    : ART.cities[city.id];
}

interface FxEvent {
  id: string;
  kind: FxKind;
  label?: string;
}

function playSfx(src: string, volume = 0.85, rate = 1) {
  try {
    const audio = new Audio(src);
    audio.volume = volume;
    audio.playbackRate = rate;
    void audio.play().catch(() => {
      /* autoplay / missing file — ignore */
    });
  } catch {
    /* ignore */
  }
}

const MUSIC_PREF = 'nw-music';

function musicIsOn() {
  try {
    return localStorage.getItem(MUSIC_PREF) !== 'off';
  } catch {
    return true;
  }
}

function rememberMusic(on: boolean) {
  try {
    localStorage.setItem(MUSIC_PREF, on ? 'on' : 'off');
  } catch {
    /* private browsing */
  }
}

function useMusicToggle() {
  const [on, setOn] = useState(musicIsOn);
  useEffect(() => {
    const sync = () => setOn(musicIsOn());
    window.addEventListener('nw-music', sync);
    return () => window.removeEventListener('nw-music', sync);
  }, []);
  const toggle = () => {
    const next = !musicIsOn();
    rememberMusic(next);
    setOn(next);
    window.dispatchEvent(new Event('nw-music'));
  };
  return [on, toggle] as const;
}

/** Original heroic title cue. Plays on the opening screens until the match begins. */
function TitleTheme({ active }: { active: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [on, toggle] = useMusicToggle();

  useEffect(() => {
    const audio = audioRef.current ?? new Audio(SFX.theme);
    audio.loop = true;
    audio.volume = 0.78;
    audioRef.current = audio;
    if (!active || !on) {
      audio.pause();
      return;
    }
    const start = () => {
      void audio.play().catch(() => {
        /* browsers block sound until the first tap */
      });
    };
    start();
    window.addEventListener('pointerdown', start);
    return () => window.removeEventListener('pointerdown', start);
  }, [active, on]);

  if (!active) return null;
  return (
    <button
      type="button"
      className={`theme-toggle ${on ? 'is-on' : ''}`}
      onClick={toggle}
    >
      {on ? 'Music on' : 'Music off'}
    </button>
  );
}

/** Victory when this table's player is the superpower, defeat otherwise. */
function localPlayerIsSuperpower(state: GameState, sessionUid?: string | null) {
  if (!state.winner) return false;
  const winner = state.nations[state.winner];
  if (!winner?.isHuman) return false;
  if (state.mode !== 'online') return true;
  if (sessionUid && winner.ownerUid) return winner.ownerUid === sessionUid;
  return Boolean(sessionUid && state.uidToNation?.[sessionUid] === state.winner);
}

function OutcomeTheme({ victory }: { victory: boolean }) {
  const [on, toggle] = useMusicToggle();

  useEffect(() => {
    const audio = new Audio(victory ? SFX.victory : SFX.defeat);
    audio.loop = false;
    audio.volume = victory ? 0.8 : 0.7;
    if (!on) return;
    let played = false;
    let stopTimer = 0;
    const start = () => {
      if (played) return;
      played = true;
      void audio.play().then(() => {
        stopTimer = window.setTimeout(() => {
          audio.pause();
        }, 10000);
      }).catch(() => {
        played = false;
      });
    };
    start();
    window.addEventListener('pointerdown', start);
    return () => {
      window.clearTimeout(stopTimer);
      window.removeEventListener('pointerdown', start);
      audio.pause();
    };
  }, [on, victory]);

  return (
    <button
      type="button"
      className={`theme-toggle ${on ? 'is-on' : ''}`}
      onClick={toggle}
    >
      {on ? 'Music on' : 'Music off'}
    </button>
  );
}

interface StrikeTarget {
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
  /** A magnetic bomb had darkened this nation's lasers before the hit */
  laserDown?: boolean;
}

/** One attacker's whole volley — every missile flies in the same panel. */
interface StrikeShow {
  from: NationId;
  targets: StrikeTarget[];
}

const STRIKE_FLIGHT_MS = 1750;
const STRIKE_IMPACT_MS = 1600;
/** How far along its run a swarm gets before the lasers catch it */
const LASER_INTERCEPT_AT = 0.6;

function isBallisticWeapon(weapon: StrikeWeapon | undefined): boolean {
  return weapon !== 'drone';
}

function craftArt(weapon: StrikeWeapon): string {
  if (weapon === 'drone') return ART.drone;
  if (weapon === 'hydrogen') return ART.missileHydrogen;
  if (weapon === 'magnetic') return ART.missileMagnetic;
  return ART.missile;
}

function boomArt(weapon: StrikeWeapon): string {
  if (weapon === 'hydrogen') return ART.explosionHydrogen;
  if (weapon === 'magnetic') return ART.explosionMagnetic;
  return ART.explosion;
}

function cinemaCaption(target: StrikeTarget, impacted: boolean): string | null {
  const warhead = target.weapons.some(isBallisticWeapon);
  const swarm = target.weapons.includes('drone');
  const escorted = swarm && warhead;
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

function strikeTitle(flightPlan: { weapon: StrikeWeapon }[], targetCount: number): string {
  const nukes = flightPlan.filter((f) => f.weapon === 'nuke' || !f.weapon).length;
  const hydro = flightPlan.filter((f) => f.weapon === 'hydrogen').length;
  const mag = flightPlan.filter((f) => f.weapon === 'magnetic').length;
  const drones = flightPlan.filter((f) => f.weapon === 'drone').length;
  const warheads = nukes + hydro + mag;
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

function StrikeCinema({
  state,
  strike,
  onComplete,
}: {
  state: GameState;
  strike: StrikeShow;
  onComplete: () => void;
}) {
  const flightRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLImageElement>(null);
  const cityRefs = useRef<(HTMLImageElement | null)[]>([]);
  const missileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const [booms, setBooms] = useState<
    ({
      x: number;
      y: number;
      weapon: StrikeWeapon;
      absorbed?: boolean;
      shieldBreak?: boolean;
      leveled?: boolean;
    } | null)[]
  >([]);
  /** Where a laser caught a swarm, and the beam that did it */
  const [zaps, setZaps] = useState<
    { x: number; y: number; beamX: number; beamY: number; length: number; angle: number }[]
  >([]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const strikeRef = useRef(strike);
  strikeRef.current = strike;

  const volleyKey = `${strike.from}:${strike.targets
    .map((t) => `${t.cityId}/${t.weapons.join('+')}`)
    .join(',')}`;
  const count = strike.targets.length;
  const flightPlan = strike.targets.flatMap((target, targetIndex) =>
    target.weapons.map((weapon) => ({
      targetIndex,
      weapon,
      intercepted: weapon === 'drone' && Boolean(target.lasered),
      absorbed: isBallisticWeapon(weapon) && Boolean(target.absorbed),
      shieldBreak:
        isBallisticWeapon(weapon) &&
        Boolean(target.hadShield) &&
        !target.leveled &&
        !target.absorbed,
      leveled: isBallisticWeapon(weapon) && Boolean(target.leveled),
    })),
  );
  const title = strikeTitle(flightPlan, count);

  const planRef = useRef(flightPlan);
  planRef.current = flightPlan;

  useEffect(() => {
    const plan = planRef.current;
    setBooms([]);
    setZaps([]);
    playSfx(SFX.launch, 0.9);
    let raf = 0;
    let startTimer = 0;
    let fallbackTimer = 0;
    let frameTimer = 0;
    let impactTimer = 0;
    let safetyTimer = 0;
    let finished = false;
    // Mobile webviews routinely starve requestAnimationFrame, which used to
    // leave the missile parked at opacity 0. Fall back to a timer so the
    // strike always plays.
    let sawFrame = false;
    let usingTimer = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      onCompleteRef.current();
    };

    // Absolute failsafe so a turn can never hang forever
    safetyTimer = window.setTimeout(finish, STRIKE_FLIGHT_MS + STRIKE_IMPACT_MS + 800);

    const start = () => {
      const layer = flightRef.current;
      const launcher = launcherRef.current;
      // Every craft that actually rendered flies to the card of its own city
      const flights = plan
        .map((leg, i) => ({
          missile: missileRefs.current[i],
          city: cityRefs.current[leg.targetIndex],
          path: pathRefs.current[i],
          targetIndex: leg.targetIndex,
          weapon: leg.weapon,
          intercepted: leg.intercepted,
          absorbed: leg.absorbed,
          shieldBreak: leg.shieldBreak,
          leveled: leg.leveled,
        }))
        .filter((f) => f.missile && f.city);
      if (!layer || !launcher || flights.length === 0) {
        impactTimer = window.setTimeout(finish, STRIKE_FLIGHT_MS + STRIKE_IMPACT_MS);
        return;
      }

      // Fly between the real elements so each warhead lands on its city.
      // The panel is mid enter-pop, so undo its scale to get layout pixels.
      const layerBox = layer.getBoundingClientRect();
      const scale = layer.offsetWidth ? layerBox.width / layer.offsetWidth : 1;
      const center = (box: DOMRect) => ({
        x: (box.left + box.width / 2 - layerBox.left) / scale,
        y: (box.top + box.height / 2 - layerBox.top) / scale,
      });
      const p0 = center(launcher.getBoundingClientRect());

      const arcs = flights.map((flight, i) => {
        const p2 = center(flight.city!.getBoundingClientRect());
        const dx = p2.x - p0.x;
        const dy = p2.y - p0.y;
        // Fan the volley out so overlapping trails stay readable
        const spread = flights.length > 1 ? 0.3 + (i / (flights.length - 1)) * 0.34 : 0.42;
        const p1 =
          Math.abs(dx) >= Math.abs(dy)
            ? { x: (p0.x + p2.x) / 2, y: Math.min(p0.y, p2.y) - Math.abs(dx) * spread }
            : { x: Math.max(p0.x, p2.x) + Math.abs(dy) * spread, y: (p0.y + p2.y) / 2 };
        flight.path?.setAttribute('d', `M ${p0.x} ${p0.y} Q ${p1.x} ${p1.y} ${p2.x} ${p2.y}`);
        return { ...flight, p1, p2 };
      });

      const t0 = performance.now();
      const shotDown = new Set<number>();
      const tick = (now: number) => {
        if (finished) return;
        sawFrame = true;
        const u = Math.min(1, (now - t0) / STRIKE_FLIGHT_MS);
        for (let i = 0; i < arcs.length; i += 1) {
          const arc = arcs[i];
          const el = arc.missile!;
          // A swarm the lasers will catch stops short of the skyline
          const stop = arc.intercepted ? LASER_INTERCEPT_AT : 1;
          const capped = Math.min(u, stop);
          const t = capped * capped * (3 - 2 * capped);
          const omt = 1 - t;
          const x = omt * omt * p0.x + 2 * omt * t * arc.p1.x + t * t * arc.p2.x;
          const y = omt * omt * p0.y + 2 * omt * t * arc.p1.y + t * t * arc.p2.y;
          const vx = 2 * omt * (arc.p1.x - p0.x) + 2 * t * (arc.p2.x - arc.p1.x);
          const vy = 2 * omt * (arc.p1.y - p0.y) + 2 * t * (arc.p2.y - arc.p1.y);
          // A warhead noses over onto its target; a quadcopter stays level
          const angle = arc.weapon === 'drone' ? 0 : (Math.atan2(vy, vx) * 180) / Math.PI;
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          // Shrinks as it dives so it reads as falling onto the city
          el.style.transform = `translate(-50%, -50%) rotate(${angle}deg) scale(${1 - t * 0.35})`;
          el.style.opacity = u < 0.04 ? String(u / 0.04) : '1';

          if (arc.intercepted && u >= stop && !shotDown.has(i)) {
            shotDown.add(i);
            el.style.opacity = '0';
            // Beam runs from the defended city out to the doomed swarm
            const dx = x - arc.p2.x;
            const dy = y - arc.p2.y;
            playSfx(SFX.explosion, 0.28, 2.6);
            setZaps((prev) => [
              ...prev,
              {
                x,
                y,
                beamX: arc.p2.x,
                beamY: arc.p2.y,
                length: Math.hypot(dx, dy),
                angle: (Math.atan2(dy, dx) * 180) / Math.PI,
              },
            ]);
          }
        }

        if (u < 1) {
          if (!usingTimer) raf = requestAnimationFrame(tick);
        } else {
          window.clearInterval(frameTimer);
          // Whole volley lands together, so one panel covers every target
          const impacts: ({
            x: number;
            y: number;
            weapon: StrikeWeapon;
            absorbed?: boolean;
            shieldBreak?: boolean;
            leveled?: boolean;
          } | null)[] = strikeRef.current.targets.map(() => null);
          for (const arc of arcs) {
            // A swarm the lasers burnt never reaches the city, so nothing lands
            if (arc.intercepted) continue;
            const landed = impacts[arc.targetIndex];
            // A warhead outshines any swarm sharing the same city
            if (landed && isBallisticWeapon(landed.weapon)) continue;
            const doomed = Boolean(strikeRef.current.targets[arc.targetIndex]?.leveled);
            impacts[arc.targetIndex] = {
              ...arc.p2,
              weapon: arc.weapon,
              absorbed: arc.absorbed && !doomed,
              shieldBreak: arc.shieldBreak && !doomed,
              leveled: arc.leveled || doomed,
            };
          }
          // A warhead that broke on rock gets a low, smothered thud rather than
          // the airburst — the blast went into the ground, not the skyline.
          // A shield that stops the shot cracks instead of burning the skyline.
          const anyBlast = impacts.some(
            (i) => i && isBallisticWeapon(i.weapon) && !i.absorbed && !i.shieldBreak,
          );
          const anyShield = impacts.some((i) => i?.shieldBreak);
          const anyRock = impacts.some((i) => i && isBallisticWeapon(i.weapon) && i.absorbed);
          const anyMagnetic = impacts.some((i) => i?.weapon === 'magnetic' && !i.absorbed);
          const anyHydrogen = impacts.some((i) => i?.weapon === 'hydrogen' && !i.absorbed);
          if (anyHydrogen) playSfx(SFX.explosion, 1, 0.78);
          else if (anyMagnetic) playSfx(SFX.explosion, 0.85, 1.55);
          else if (anyBlast) playSfx(SFX.explosion, 0.95);
          else if (anyShield) playSfx(SFX.explosion, 0.65, 1.35);
          else if (anyRock) playSfx(SFX.explosion, 0.5, 0.6);
          else playSfx(SFX.explosion, 0.3, 2.1);
          setBooms(impacts);
          for (const arc of arcs) arc.missile!.style.opacity = '0';
          impactTimer = window.setTimeout(finish, STRIKE_IMPACT_MS);
        }
      };

      raf = requestAnimationFrame(tick);
      fallbackTimer = window.setTimeout(() => {
        if (finished || sawFrame) return;
        usingTimer = true;
        cancelAnimationFrame(raf);
        frameTimer = window.setInterval(() => tick(performance.now()), 33);
      }, 250);
    };

    // Timer, not rAF: the panel must start flying even in a frame-starved view
    startTimer = window.setTimeout(start, 32);

    return () => {
      finished = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(startTimer);
      window.clearTimeout(fallbackTimer);
      window.clearInterval(frameTimer);
      window.clearTimeout(impactTimer);
      window.clearTimeout(safetyTimer);
    };
  }, [volleyKey]);

  const from = nationDef(strike.from);

  return (
    <div className="strike-cinema" role="dialog" aria-modal="true" aria-label="Nuclear strike">
      <div className="strike-cinema__veil" />
      <div className="strike-cinema__panel enter-pop">
        <header className="strike-cinema__title">{title}</header>

        <div className={`strike-cinema__row${count > 2 ? ' strike-cinema__row--volley' : ''}`}>
          <div className="strike-cinema__side strike-cinema__side--from">
            <div className="strike-cinema__flag">DEPARTING</div>
            <img
              ref={launcherRef}
              className="strike-cinema__leader"
              src={leaderArt(state, strike.from)}
              alt=""
            />
            <strong>{from.name}</strong>
            <span>{from.leader}</span>
          </div>

          <div
            className={`strike-cinema__side strike-cinema__side--to${
              count > 1 ? ' strike-cinema__side--many' : ''
            }`}
          >
            <div className="strike-cinema__flag strike-cinema__flag--danger">
              {count > 1 ? 'TARGETS' : 'TARGET'}
            </div>
            <div className="strike-cinema__targets">
              {strike.targets.map((target, i) => {
                const to = nationDef(target.to);
                const impact = booms[i];
                const ballistic = Boolean(impact && isBallisticWeapon(impact.weapon));
                const showBunker = Boolean(target.hadBunker);
                const ruined = Boolean(impact && target.leveled);
                const shieldOnly = Boolean(impact && target.hadShield && impact.shieldBreak && !ruined);
                const shieldShattered = Boolean(impact && target.hadShield && (shieldOnly || ruined));
                const artClass = [
                  'strike-cinema__target-art',
                  showBunker ? 'is-bunker' : '',
                  shieldOnly ? 'is-shield-break' : '',
                  impact?.absorbed && !ruined ? 'is-absorbed' : '',
                  ruined ? 'is-rubble' : '',
                  ruined && (impact?.weapon === 'hydrogen' || target.weapons.includes('hydrogen'))
                    ? 'is-fusion'
                    : '',
                  ruined && impact?.weapon === 'magnetic' && !target.weapons.includes('hydrogen')
                    ? 'is-emp'
                    : '',
                  ruined &&
                  impact?.weapon !== 'hydrogen' &&
                  impact?.weapon !== 'magnetic' &&
                  !target.weapons.includes('hydrogen')
                    ? 'is-burning'
                    : '',
                  impact && !ballistic && !ruined ? 'is-rattled' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const caption = cinemaCaption(target, Boolean(impact));
                return (
                  <div className="strike-cinema__target" key={`${target.to}-${target.cityId}`}>
                    <div className={artClass}>
                      <img
                        ref={(el) => {
                          cityRefs.current[i] = el;
                        }}
                        className="strike-cinema__city"
                        src={
                          showBunker
                            ? ART.citiesUnderground[target.cityId]
                            : ART.cities[target.cityId]
                        }
                        alt=""
                      />
                      {showBunker && (
                        <span className="strike-cinema__bunker">Bunker</span>
                      )}
                      {target.hadShield && (
                        <span
                          className={`strike-cinema__dome${shieldShattered ? ' is-shattered' : ''}`}
                          aria-hidden
                        />
                      )}
                      {shieldShattered && (
                        <span className="strike-cinema__shards" aria-hidden>
                          {[0, 1, 2, 3, 4, 5].map((n) => (
                            <i key={n} />
                          ))}
                        </span>
                      )}
                      <img
                        className="strike-cinema__leader-sm"
                        src={leaderArt(state, target.to)}
                        alt=""
                      />
                      {ruined &&
                        (impact?.weapon === 'magnetic' && !target.weapons.includes('hydrogen') ? (
                          <span className="strike-cinema__emp" aria-hidden />
                        ) : (
                          <span className="strike-cinema__fire" aria-hidden />
                        ))}
                      {ruined && <span className="strike-cinema__ash" aria-hidden />}
                      {ruined && <span className="strike-cinema__ruin" aria-hidden />}
                      {ballistic && impact?.absorbed && (
                        <span className="strike-cinema__rubble" aria-hidden />
                      )}
                      {impact?.weapon === 'drone' && (
                        <span className="strike-cinema__dust" aria-hidden />
                      )}
                    </div>
                    <strong>{to.name}</strong>
                    <span>{target.cityName}</span>
                    {caption && <span className="strike-cinema__tag">{caption}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Spans the whole row so the flight paths can cross between the cards */}
          <div ref={flightRef} className="strike-cinema__flight" aria-hidden>
            <svg className="strike-cinema__path">
              {flightPlan.map((leg, i) => (
                <path
                  key={`leg-${i}-path`}
                  className={
                    leg.weapon === 'drone'
                      ? 'is-drone'
                      : leg.weapon === 'hydrogen'
                        ? 'is-hydrogen'
                        : leg.weapon === 'magnetic'
                          ? 'is-magnetic'
                          : undefined
                  }
                  ref={(el) => {
                    pathRefs.current[i] = el;
                  }}
                  d=""
                />
              ))}
            </svg>
            {flightPlan.map((leg, i) => (
              <div
                key={`leg-${i}-craft`}
                ref={(el) => {
                  missileRefs.current[i] = el;
                }}
                className={`strike-cinema__missile${
                  leg.weapon === 'drone'
                    ? ' strike-cinema__missile--drone'
                    : leg.weapon === 'hydrogen'
                      ? ' strike-cinema__missile--hydrogen'
                      : leg.weapon === 'magnetic'
                        ? ' strike-cinema__missile--magnetic'
                        : ''
                }`}
              >
                <img src={craftArt(leg.weapon)} alt="" draggable={false} />
                {isBallisticWeapon(leg.weapon) && (
                  <span
                    className={`strike-cinema__flame${
                      leg.weapon === 'hydrogen'
                        ? ' strike-cinema__flame--hydrogen'
                        : leg.weapon === 'magnetic'
                          ? ' strike-cinema__flame--magnetic'
                          : ''
                    }`}
                  />
                )}
              </div>
            ))}
            {zaps.map((zap, i) => (
              <span
                key={`beam-${i}`}
                className="strike-cinema__laser"
                style={{
                  left: zap.beamX,
                  top: zap.beamY,
                  width: zap.length,
                  transform: `rotate(${zap.angle}deg)`,
                }}
              >
                <i />
              </span>
            ))}
            {zaps.map((zap, i) => (
              <div
                key={`zap-${i}`}
                className="strike-cinema__boom strike-cinema__boom--drone"
                style={{ left: zap.x, top: zap.y }}
              >
                <span className="strike-cinema__pop" />
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <span key={n} className={`strike-cinema__spark spark-${n}`} />
                ))}
              </div>
            ))}
            {booms.map((boom, i) =>
              boom ? (
                <div
                  key={`${strike.targets[i]?.cityId ?? i}-boom`}
                  className={`strike-cinema__boom${
                    boom.weapon === 'drone' ? ' strike-cinema__boom--drone' : ''
                  }${boom.weapon === 'hydrogen' ? ' strike-cinema__boom--hydrogen' : ''}${
                    boom.weapon === 'magnetic' ? ' strike-cinema__boom--magnetic' : ''
                  }${boom.absorbed ? ' strike-cinema__boom--rock' : ''}${
                    boom.shieldBreak ? ' strike-cinema__boom--shield' : ''
                  }`}
                  style={{ left: boom.x, top: boom.y }}
                >
                  {boom.shieldBreak && !strike.targets[i]?.leveled ? (
                    <span className="strike-cinema__pop" />
                  ) : boom.weapon === 'drone' || boom.absorbed ? (
                    // No fireball on rock: a grey shock ring and flying debris
                    <>
                      <span className="strike-cinema__pop" />
                      {[0, 1, 2, 3, 4, 5].map((n) => (
                        <span key={n} className={`strike-cinema__spark spark-${n}`} />
                      ))}
                    </>
                  ) : (
                    <img src={boomArt(boom.weapon)} alt="" />
                  )}
                </div>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatRoundEvent(e: RoundWorldEvent): string {
  const nation = nationDef(e.nationId).name;
  const attacker = e.attackerId ? nationDef(e.attackerId).name : null;
  if (e.kind === 'nationEliminated') return `${nation} is out — all cities destroyed.`;
  if (e.kind === 'droneDamage') {
    const bill = `$${e.amount ?? DRONE_DAMAGE}M in damages`;
    return attacker
      ? `${attacker}'s drones swarmed ${e.cityName} (${nation}) — ${bill}.`
      : `Drones swarmed ${e.cityName} (${nation}) — ${bill}.`;
  }
  if (e.kind === 'dronesIntercepted') {
    return attacker
      ? `${nation}'s lasers over ${e.cityName} shot down ${attacker}'s drone swarm.`
      : `Lasers over ${e.cityName} (${nation}) shot down a drone swarm.`;
  }
  if (e.kind === 'cityRebuilt') {
    return e.automatic
      ? `${nation} rebuilt ${e.cityName} with its last $${e.amount ?? COSTS.rebuild}M — the nation survives.`
      : `${nation} rebuilt ${e.cityName} from the rubble.`;
  }
  if (e.kind === 'strikeAbsorbed') {
    // The whole table watched it bounce, so the bunker is public from here on
    const now = `${e.cityName} (${nation}) — the bunker is on every map now.`;
    return attacker
      ? `${attacker}'s warhead broke against the bunkers under ${now}`
      : `A warhead broke against the bunkers under ${now}`;
  }
  if (e.kind === 'shieldDestroyed') {
    return attacker
      ? `${attacker} shattered the shield over ${e.cityName} (${nation}).`
      : `Shield lost over ${e.cityName} (${nation}).`;
  }
  return attacker
    ? `${attacker} destroyed ${e.cityName} (${nation}).`
    : `${e.cityName} (${nation}) was destroyed.`;
}

/** Round 1, or any round we have nothing personal to report. */
function RoundBannerOverlay({ round, onDone }: { round: number; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, ROUND_BANNER_MS);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div className="round-banner round-start" role="status" aria-live="polite">
      <div className="round-banner__veil" />
      <div className="round-banner__panel round-start__panel round-start__panel--round enter-pop">
        <h2 className="round-start__title">Round {round}</h2>
        <p className="round-start__hint">Prepare your orders</p>
      </div>
    </div>
  );
}

const CITY_STATUS_LABEL: Record<BriefingCityStatus, string> = {
  quiet: 'Untouched',
  rebuilt: 'Rebuilt',
  intercepted: 'Swarm shot down',
  swarmed: 'Drone damage',
  shieldLost: 'Shield destroyed',
  absorbed: 'Bunker held',
  destroyed: 'Destroyed',
};

/**
 * Everything that happened to a player between rounds on one page — cities,
 * raiders, sanctions, treasury and the table — instead of a queue of banners
 * they have to sit through. It clears itself so an online table keeps moving.
 */
/** Damage taken, what our shots cost, and the loss those shots dealt. */
function CombatExchange({
  received,
  spent,
  caused,
}: {
  received: number;
  spent: number;
  caused: number;
}) {
  if (received <= 0 && spent <= 0 && caused <= 0) return null;
  const money = (n: number) => `$${formatMoney(n)}`;
  return (
    <div
      className="combat-exchange"
      role="status"
      aria-label={`Damages ${money(received)}. Spent ${money(spent)} on warfare, causing ${money(caused)} in enemy losses.`}
    >
      <div className={`combat-exchange__cell is-taken${received > 0 ? ' is-hot' : ''}`}>
        <em>{money(received)}</em>
        <span>Damages</span>
      </div>
      <div className="combat-exchange__strike">
        <div className="combat-exchange__cell is-spent">
          <em>{money(spent)}</em>
          <span>Spent</span>
        </div>
        <span className="combat-exchange__arrow" aria-hidden>
          →
        </span>
        <div className={`combat-exchange__cell is-caused${caused > 0 ? ' is-hot' : ''}`}>
          <em>{money(caused)}</em>
          <span>Enemy loss</span>
        </div>
      </div>
    </div>
  );
}

function cityStatusMark(status: BriefingCityStatus): { src: string; label: string } | null {
  if (status === 'shieldLost') return { src: ART.shield, label: CITY_STATUS_LABEL.shieldLost };
  if (status === 'swarmed') return { src: ART.drone, label: CITY_STATUS_LABEL.swarmed };
  if (status === 'intercepted') return { src: ART.laserIcon, label: CITY_STATUS_LABEL.intercepted };
  if (status === 'rebuilt') return { src: ART.rebuildCity, label: CITY_STATUS_LABEL.rebuilt };
  return null;
}

function orderIcon(icon: BriefingOrderIcon): string {
  if (icon === 'shield' || icon === 'hold') return ART.shield;
  if (icon === 'bunker') return ART.undergroundCity;
  if (icon === 'laser') return ART.laserIcon;
  if (icon === 'rebuild') return ART.rebuildCity;
  if (icon === 'drone') return ART.drone;
  if (icon === 'hydrogen') return ART.missileHydrogen;
  if (icon === 'magnetic') return ART.missileMagnetic;
  return ART.missile;
}

function DashIntelCard({ advice }: { advice: BriefingIntelAdvice }) {
  const art =
    advice.kind === 'spy' ? ART.cop.spy : advice.kind === 'research' ? ART.cop.research : ART.cop.sanction;
  return (
    <li className={`brief__order is-intel is-${advice.kind}`}>
      <div className="brief__order-art">
        <img className="brief__order-city" src={art} alt="" draggable={false} />
      </div>
      <div className="brief__order-copy">
        <span className="brief__order-tag">{advice.kind === 'spy' ? 'Intel' : 'Finance'}</span>
        <b>
          {advice.action}
          {advice.nationId && <em> · {nationDef(advice.nationId).shortName}</em>}
        </b>
        <span className="brief__order-where">{advice.reason}</span>
      </div>
    </li>
  );
}

function DashOrderCard({
  kind,
  order,
  state,
}: {
  kind: 'defence' | 'offence';
  order: BriefingOrder;
  state: GameState;
}) {
  const city = state.nations[order.nationId]?.cities.find((c) => c.id === order.cityId);
  const citySrc =
    city && city.isUnderground && !city.destroyed
      ? ART.citiesUnderground[city.id]
      : ART.cities[order.cityId];
  return (
    <li className={`brief__order is-${kind}`}>
      <div className="brief__order-art">
        <img className="brief__order-city" src={citySrc} alt="" draggable={false} />
        <img className="brief__order-tool" src={orderIcon(order.icon)} alt="" draggable={false} />
      </div>
      <div className="brief__order-copy">
        <span className="brief__order-tag">{kind === 'defence' ? 'Defend' : 'Attack'}</span>
        <b>{order.action}</b>
        <span className="brief__order-where">
          {order.cityName}
          {kind === 'offence' && (
            <>
              {' · '}
              <em>{nationDef(order.nationId).shortName}</em>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * The whole world, ranked, with the advisor's orders drawn on it as arrows:
 * blue over the cities to cover (and with what), red over the rival cities to
 * hit. Defences show only where this commander has eyes; everywhere else the
 * city is plain ground and the advisor points at it on guesswork.
 */
function DashWorld({
  state,
  briefing,
}: {
  state: GameState;
  briefing: RoundBriefing;
}) {
  const arrows = new Map<string, { kind: 'defence' | 'offence'; order: BriefingOrder }>();
  briefing.defenceOrders.forEach((order) => {
    if (order.action !== 'Hold') arrows.set(`${order.nationId}:${order.cityId}`, { kind: 'defence', order });
  });
  briefing.offenceOrders.forEach((order) => {
    arrows.set(`${order.nationId}:${order.cityId}`, { kind: 'offence', order });
  });

  return (
    <ol
      className={`dash__world${briefing.world.length > 5 ? ' is-many' : ''}`}
      aria-label="World standings and advisor orders"
    >
      {briefing.world.map((row) => (
        <li
          key={row.nationId}
          className={`dash__nation ${row.eliminated ? 'is-out' : ''} ${row.isYou ? 'is-you' : ''} ${
            row.rank === 1 && !row.eliminated ? 'is-lead' : ''
          }`}
        >
          <span className="dash__rank">{row.eliminated ? '—' : row.rank}</span>
          <img
            className="dash__nation-face"
            src={leaderArt(state, row.nationId)}
            alt=""
            title={nationDef(row.nationId).name}
            draggable={false}
          />
          <span className="dash__nation-copy">
            <b>{nationDef(row.nationId).shortName}</b>
            <em>{row.eliminated ? 'OUT' : `${row.total} pts`}</em>
          </span>
          <ul className="dash__nation-cities">
            {row.cities.map((city) => {
              const arrow = arrows.get(`${row.nationId}:${city.id}`);
              const cover = city.isUnderground && !city.destroyed;
              const seen = city.known || row.isYou;
              const dome = city.hasShield && !city.isUnderground && !city.destroyed;
              const mark = row.isYou && city.status ? cityStatusMark(city.status) : null;
              const assets: { key: string; icon: string; label: string }[] = [];
              if (!city.destroyed) {
                if (dome) assets.push({ key: 'shield', icon: ART.shield, label: 'Shield' });
                if (cover) assets.push({ key: 'bunker', icon: ART.undergroundCity, label: 'Bunker' });
                if (city.hasLaser) assets.push({ key: 'laser', icon: ART.laserIcon, label: 'Laser' });
                if (city.hasResearch) assets.push({ key: 'lab', icon: ART.researchIcon, label: 'Lab' });
              }
              return (
                <li
                  key={city.id}
                  className={`dash__city ${city.destroyed ? 'is-rubble' : ''} ${
                    seen ? '' : 'is-unseen'
                  } ${arrow ? `has-${arrow.kind}` : ''}`}
                  title={
                    arrow
                      ? `${arrow.order.action} — ${city.name}`
                      : city.destroyed
                        ? `${city.name} — destroyed`
                        : city.name
                  }
                >
                  {arrow && (
                    <span className={`dash__arrow is-${arrow.kind}`} aria-label={arrow.order.action}>
                      <img src={orderIcon(arrow.order.icon)} alt="" draggable={false} />
                      <em>{arrow.order.action}</em>
                    </span>
                  )}
                  <div className="dash__city-art">
                    <img
                      src={cover ? ART.citiesUnderground[city.id] : ART.cities[city.id]}
                      alt=""
                      draggable={false}
                    />
                    {dome && <i className="dash__chip-dome" aria-hidden />}
                    {mark && (
                      <img className="dash__city-mark" src={mark.src} alt="" title={mark.label} draggable={false} />
                    )}
                  </div>
                  <b className="dash__city-name">{city.name}</b>
                  {city.destroyed ? (
                    <span className="dash__city-state is-bad">Rubble</span>
                  ) : !seen ? (
                    <span className="dash__city-state">Defences unseen</span>
                  ) : assets.length === 0 ? (
                    <span className="dash__city-state is-open">Open</span>
                  ) : (
                    <span className="dash__city-assets">
                      {assets.map((a) => (
                        <span key={a.key} className={`dash__asset is-${a.key}`}>
                          <img src={a.icon} alt="" draggable={false} />
                          {a.label}
                        </span>
                      ))}
                    </span>
                  )}
                  {row.isYou && city.status && city.status !== 'quiet' && (
                    <small className={`brief__city-status is-${city.status}`}>
                      {CITY_STATUS_LABEL[city.status]}
                    </small>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function RoundBriefingOverlay({
  state,
  briefing,
  onDone,
}: {
  state: GameState;
  briefing: RoundBriefing;
  onDone: () => void;
}) {
  const [secondsLeft, setSecondsLeft] = useState(Math.round(ROUND_BRIEFING_MS / 1000));
  // One fixed deadline: a throttled tab, a re-render or a lost interval can't stretch it.
  const deadlineRef = useRef(Date.now() + ROUND_BRIEFING_MS);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let done = false;
    const check = () => {
      const left = deadlineRef.current - Date.now();
      setSecondsLeft(Math.max(0, Math.ceil(left / 1000)));
      if (left <= 0 && !done) {
        done = true;
        onDoneRef.current();
      }
    };
    const tick = window.setInterval(check, 250);
    const end = window.setTimeout(check, ROUND_BRIEFING_MS + 50);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(end);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  // The briefing is one page: shrink it to the window instead of ever scrolling.
  const fitRef = useFitToWindow<HTMLDivElement>(1400, 0.45, true, 1.5);

  const me = nationDef(briefing.nationId);

  return (
    <div
      className="round-banner round-brief"
      role="dialog"
      aria-modal="true"
      aria-label={`Round ${briefing.round} briefing`}
    >
      <div className="round-banner__veil" />
      <div className="brief__fit" ref={fitRef}>
      <div className="round-banner__panel round-brief__panel enter-pop">
        <header className="brief__top">
          <div
            className="dash__commander"
            style={{ backgroundImage: `url(${ART.flags[briefing.nationId]})` }}
          >
            <img src={leaderArt(state, briefing.nationId)} alt="" draggable={false} />
          </div>
          <div className="dash__id">
            <p className="round-start__eyebrow">{me.name}</p>
            <h2 className="round-start__title">Round {briefing.round}</h2>
          </div>
          <div className="brief__treasury" aria-label="Treasury">
            <span>Treasury</span>
            <em>${formatMoney(briefing.money)}</em>
            <small>
              <b className="is-up">+{formatMoney(briefing.income)} income</b>
              {briefing.droneRepairs > 0 && (
                <b className="is-down">−{formatMoney(briefing.droneRepairs)} repairs</b>
              )}
            </small>
          </div>
          <button type="button" className="dash__skip" onClick={onDone}>
            <svg className="dash__ring" viewBox="0 0 36 36" aria-hidden>
              <circle className="dash__ring-track" cx="18" cy="18" r="15" />
              <circle
                className="dash__ring-value"
                cx="18"
                cy="18"
                r="15"
                style={{ animationDuration: `${ROUND_BRIEFING_MS}ms` }}
              />
            </svg>
            <span className="dash__skip-count">{secondsLeft}</span>
            <span className="dash__skip-label">Skip</span>
          </button>
        </header>

        <div className="brief__strip">
          <CombatExchange
            received={briefing.damageReceived}
            spent={briefing.warfareSpent}
            caused={briefing.enemyLoss}
          />
          {(briefing.raiders.length > 0 || briefing.sanctioners.length > 0) && (
            <ul className="dash__hits" aria-label="Incoming">
              <li className="dash__hits-label">Hit you</li>
              {briefing.raiders.map((raider) => (
                <li key={raider.id} className="dash__raider" title={nationDef(raider.id).name}>
                  <img src={leaderArt(state, raider.id)} alt="" draggable={false} />
                  <span>
                    {raider.nukes > 0 && (
                      <i>
                        <img src={ART.missile} alt="" draggable={false} />
                        {raider.nukes}
                      </i>
                    )}
                    {raider.swarms > 0 && (
                      <i>
                        <img src={ART.drone} alt="" draggable={false} />
                        {raider.swarms}
                      </i>
                    )}
                  </span>
                </li>
              ))}
              {briefing.sanctioners.length > 0 && (
                <li className="dash__raider is-sanction" title="Sanctions">
                  <span className="round-brief__faces">
                    {briefing.sanctioners.map((id) => (
                      <img
                        key={id}
                        src={leaderArt(state, id)}
                        alt={nationDef(id).name}
                        title={nationDef(id).name}
                        draggable={false}
                      />
                    ))}
                  </span>
                  <b>−{Math.round(briefing.sanctionPenalty * 100)}%</b>
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="brief__grid">
          <section className="brief__card brief__card--advisor" aria-label="Advisor orders">
            <div className="brief__card-head">
              <h3 className="brief__label">Advisor</h3>
              <ul className="round-brief__arsenal" aria-label="Arsenal">
                <li title="Warheads">
                  <img src={ART.missile} alt="" draggable={false} />
                  {briefing.assets.bombs}
                </li>
                <li title="Drones">
                  <img src={ART.drone} alt="" draggable={false} />
                  {briefing.assets.drones}
                </li>
                {briefing.assets.spyNetwork && (
                  <li className="is-flag" title="Spy service">
                    <img src={ART.spyServices} alt="" draggable={false} />
                  </li>
                )}
                {briefing.assets.lasers > 0 && (
                  <li title="Lasers">
                    <img src={ART.laserIcon} alt="" draggable={false} />
                    {briefing.assets.lasers}
                  </li>
                )}
              </ul>
            </div>
            <div className="brief__advisor-row">
              <img
                className="dash__advisor"
                src={ART.advisors[briefing.nationId]}
                alt=""
                title="Military advisor"
                draggable={false}
              />
              <ul className="brief__orders" aria-label="Recommended orders">
                <DashOrderCard kind="defence" order={briefing.defence} state={state} />
                {briefing.offence ? (
                  <DashOrderCard kind="offence" order={briefing.offence} state={state} />
                ) : (
                  <li className="brief__order is-none">
                    <span className="brief__order-tag">Attack</span>
                    <b>Hold your fire</b>
                    <span className="brief__order-where">No target is worth a warhead yet</span>
                  </li>
                )}
                {briefing.intelAdvice.map((advice) => (
                  <DashIntelCard key={advice.kind} advice={advice} />
                ))}
              </ul>
            </div>
          </section>
        </div>

        <section className="brief__card brief__card--world" aria-label="World standings">
          <div className="brief__card-head">
            <h3 className="brief__label">World standings</h3>
            <span className="brief__legend">
              <i className="is-defence" /> cover
              <i className="is-offence" /> strike
            </span>
          </div>
          <DashWorld state={state} briefing={briefing} />
        </section>
      </div>
      </div>
    </div>
  );
}

function DropoutOverlay({
  playerName,
  nationName,
  onDone,
}: {
  playerName: string;
  nationName: string;
  onDone: () => void;
}) {
  useEffect(() => {
    const t = window.setTimeout(onDone, ROUND_BANNER_MS);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div className="round-banner round-start" role="status" aria-live="polite">
      <div className="round-banner__veil" />
      <div className="round-banner__panel round-start__panel round-start__panel--dropout enter-pop">
        <p className="round-start__eyebrow">Player left</p>
        <h2 className="round-start__title">{playerName} dropped out</h2>
        <p className="round-start__hint">
          {nationName} is OUT. The game continues.
        </p>
      </div>
    </div>
  );
}

function StrikeRecap({
  events,
  onContinue,
}: {
  events: RoundWorldEvent[];
  onContinue: () => void;
}) {
  const strikes = events.filter((e) => e.kind !== 'nationEliminated');
  const eliminated = events.filter((e) => e.kind === 'nationEliminated');
  const continueRef = useRef(onContinue);
  continueRef.current = onContinue;

  // Everyone's clock budgets this long; auto-dismiss keeps the table together
  useEffect(() => {
    const t = window.setTimeout(() => continueRef.current(), RECAP_AUTO_MS);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="strike-cinema" role="dialog" aria-modal="true" aria-label="Strike aftermath">
      <div className="strike-cinema__veil" />
      <div className="strike-cinema__panel strike-cinema__panel--recap enter-pop">
        <header className="strike-cinema__title">WHAT HAPPENED</header>
        {events.length === 0 ? (
          <p className="strike-recap__empty">No cities were hit this round. The board stands.</p>
        ) : (
          <ul className="strike-recap__list">
            {strikes.map((e) => (
              <li key={e.id} className={`round-event round-event--${e.kind}`}>
                {formatRoundEvent(e)}
              </li>
            ))}
            {eliminated.map((e) => (
              <li key={e.id} className="round-event round-event--nationEliminated">
                {formatRoundEvent(e)}
              </li>
            ))}
          </ul>
        )}
        <div className="strike-recap__actions">
          <button type="button" className="btn btn--xl btn--primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Owns the launch cinema for the whole app. It is driven by the round summary
 * rather than the brief resolveStrikes phase, and lives outside the board so it
 * still runs on the phases where the board is unmounted — otherwise a client
 * that adopts an already-resolved board never sees a missile.
 */
type StrikeJob = {
  /** Round whose launches still owe this client a cinema, or null. */
  jobRound: number | null;
  /** True from the moment the round resolves until the cinema has played. */
  pending: boolean;
  finish: (round: number) => void;
};

/**
 * Decides, synchronously during render, whether this client still owes the
 * previous round its strike cinema. Living in render (not in an effect) means
 * the board, briefing and summary can be held back on the very first frame —
 * otherwise an online summary that arrives with its clock already armed
 * advanced the table before the animation had a chance to start.
 */
function useStrikeJob(state: GameState): StrikeJob {
  const seenRef = useRef<Set<number>>(new Set());
  const finishedRef = useRef<Set<number>>(new Set());
  const gameKeyRef = useRef<string | null>(null);
  const [, bump] = useState(0);

  const phase = state.phase;
  const inMatch =
    phase === 'buy' ||
    phase === 'action' ||
    phase === 'income' ||
    phase === 'resolveStrikes' ||
    phase === 'roundSummary';
  const showing = phase === 'roundSummary' || phase === 'gameOver';
  const gameKey = state.onlineGameId ?? state.mode ?? null;
  const preGame =
    phase === 'session' ||
    phase === 'mode' ||
    phase === 'names' ||
    phase === 'lobby' ||
    phase === 'country';
  if (gameKeyRef.current !== gameKey || preGame) {
    seenRef.current = new Set();
    finishedRef.current = new Set();
    gameKeyRef.current = gameKey;
  }
  if (inMatch) seenRef.current.add(state.round);

  const summaryRound = state.previousRoundNumber ?? null;
  const jobRound =
    summaryRound != null &&
    seenRef.current.has(summaryRound) &&
    ((showing && state.round === summaryRound) || state.round === summaryRound + 1)
      ? summaryRound
      : null;
  const pending = jobRound != null && !finishedRef.current.has(jobRound);

  const finish = useCallback((round: number) => {
    if (finishedRef.current.has(round)) return;
    finishedRef.current.add(round);
    bump((n) => n + 1);
  }, []);

  return { jobRound, pending, finish };
}

function StrikeTheater({
  state,
  setState,
  job,
}: {
  state: GameState;
  setState: React.Dispatch<React.SetStateAction<GameState>>;
  job: StrikeJob;
}) {
  const [cinema, setCinema] = useState<StrikeShow | null>(null);
  const [recap, setRecap] = useState<RoundWorldEvent[] | null>(null);
  const cinemaResolveRef = useRef<(() => void) | null>(null);
  const recapResolveRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const finishRef = useRef(job.finish);
  finishRef.current = job.finish;

  const onCinemaComplete = useCallback(() => {
    setCinema(null);
    const resolve = cinemaResolveRef.current;
    cinemaResolveRef.current = null;
    resolve?.();
  }, []);

  const onRecapContinue = useCallback(() => {
    setRecap(null);
    const resolve = recapResolveRef.current;
    recapResolveRef.current = null;
    resolve?.();
  }, []);

  const round = job.jobRound;
  const holding = job.pending;

  // Keyed on the round alone: the cinema plays from its own snapshot of the
  // report and no later sync (next round, heartbeat, late report) may cut it off.
  useEffect(() => {
    if (round == null) return;
    if (!job.pending) return;

    const session = ++sessionRef.current;
    let cancelled = false;
    let reportTimer = 0;
    let watchdog = 0;
    const alive = () => !cancelled && sessionRef.current === session;

    const complete = () => finishRef.current(round);

    // Whatever goes wrong, the table is never held longer than this
    watchdog = window.setTimeout(() => {
      cancelled = true;
      clearTheater();
      complete();
    }, REPORT_WAIT_MS + 4_000);

    const armClock = () =>
      setState((cur) => {
        if (cur.round !== round || cur.phase !== 'roundSummary') return cur;
        if (cur.aftermathEndsAt != null) return cur;
        const next = armAftermathTimer(cur);
        if (cur.mode === 'online' && cur.onlineGameId) {
          void publishSharedPhase(cur.onlineGameId, next, 'aftermath').catch(() => undefined);
        }
        return next;
      });

    const clearTheater = () => {
      setCinema(null);
      setRecap(null);
      const cinemaResolve = cinemaResolveRef.current;
      cinemaResolveRef.current = null;
      cinemaResolve?.();
      const recapResolve = recapResolveRef.current;
      recapResolveRef.current = null;
      recapResolve?.();
    };

    const play = async (strikes: PendingStrike[], events: RoundWorldEvent[]) => {
      const volleyCount = groupStrikesByAttacker(strikes).length;
      const runtimeMs = volleyCount * (STRIKE_CINEMA_MS + 1_500) + (events.length > 0 ? RECAP_AUTO_MS : 0);
      // Re-arm the watchdog with the real runtime of this report
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        cancelled = true;
        clearTheater();
        complete();
      }, runtimeMs + 6_000);

      try {
        const volleys = groupStrikesByAttacker(strikes).slice().sort((a, b) => {
          const rank = (volley: { attackerId: NationId; strikes: PendingStrike[] }) => {
            let score = 0;
            for (const strike of volley.strikes) {
              const mine = events.filter(
                (e) => e.attackerId === volley.attackerId && e.cityId === strike.cityId,
              );
              if (mine.some((e) => e.kind === 'cityDestroyed')) score = Math.max(score, 2);
              else if (
                mine.some((e) => e.kind === 'shieldDestroyed' || e.kind === 'strikeAbsorbed')
              ) {
                score = Math.max(score, 1);
              }
            }
            return score;
          };
          return rank(a) - rank(b);
        });
        for (const volley of volleys) {
          if (!alive()) break;
          const targets: StrikeTarget[] = [];
          for (const strike of volley.strikes) {
            const weapon: StrikeWeapon =
              strike.weapon === 'drone'
                ? 'drone'
                : strike.weapon === 'hydrogen'
                  ? 'hydrogen'
                  : strike.weapon === 'magnetic'
                    ? 'magnetic'
                    : 'nuke';
            const open = targets.find(
              (t) => t.to === strike.targetNationId && t.cityId === strike.cityId,
            );
            if (open) {
              open.weapons.push(weapon);
              continue;
            }
            const city = stateRef.current.nations[strike.targetNationId]?.cities.find(
              (c) => c.id === strike.cityId,
            );
            const lasered = events.some(
              (e) =>
                e.kind === 'dronesIntercepted' &&
                e.cityId === strike.cityId &&
                e.nationId === strike.targetNationId &&
                e.attackerId === volley.attackerId,
            );
            const mine = events.filter(
              (e) =>
                e.cityId === strike.cityId &&
                e.nationId === strike.targetNationId &&
                e.attackerId === volley.attackerId,
            );
            const absorbed = mine.some((e) => e.kind === 'strikeAbsorbed');
            const leveled = mine.some((e) => e.kind === 'cityDestroyed');
            const cover = mine.find((e) => e.cover)?.cover;
            const hadBunker =
              absorbed || cover === 'bunker' || Boolean(city?.isUnderground && !leveled);
            const hadShield =
              mine.some((e) => e.kind === 'shieldDestroyed') ||
              cover === 'shield' ||
              Boolean(city?.hasShield && !leveled && !absorbed);
            const laserDown = mine.some((e) => e.laserDown);
            targets.push({
              to: strike.targetNationId,
              cityId: strike.cityId,
              cityName: city?.name ?? 'city',
              weapons: [weapon],
              droneBill: lasered ? 0 : city ? droneDamageFor(city) : DRONE_DAMAGE,
              lasered,
              absorbed,
              hadShield,
              hadBunker,
              leveled,
              laserDown,
            });
          }
          for (const target of targets) {
            const escort =
              target.weapons.includes('drone') &&
              target.weapons.some((w) => w === 'nuke' || w === 'magnetic' || w === 'hydrogen');
            const hydrogen = target.weapons.includes('hydrogen');
            // A shield only stops a lone warhead. Hydrogen ignores it, and a swarm
            // that gets through (magnetic has already darkened a laser) lets the
            // warhead level the city. The cinema must show rubble, not a bare shield pop.
            if (target.absorbed || target.lasered) continue;
            if (hydrogen || (escort && (target.hadShield || target.laserDown))) {
              target.leveled = true;
            }
          }
          await new Promise<void>((resolve) => {
            if (!alive()) {
              resolve();
              return;
            }
            cinemaResolveRef.current = resolve;
            setCinema({ from: volley.attackerId, targets });
          });
        }
        if (alive() && events.length > 0) {
          await new Promise<void>((resolve) => {
            if (!alive()) {
              resolve();
              return;
            }
            recapResolveRef.current = resolve;
            setRecap(events);
          });
        }
        if (alive()) {
          armClock();
          complete();
        }
      } finally {
        window.clearTimeout(watchdog);
      }
    };

    /** The strike report can trail the phase change, so wait for it to land. */
    let dataSeenAt = 0;
    const attempt = (waitedMs: number) => {
      if (!alive()) return;
      const strikes = stateRef.current.resolvedStrikes ?? [];
      const events = stateRef.current.previousRoundEvents ?? [];

      if (strikes.length === 0 && events.length === 0) {
        // Start the countdown so the summary is never stuck waiting on a peer
        armClock();
        if (waitedMs >= REPORT_WAIT_MS) {
          // Peaceful round (or report never came) — don't block forever
          complete();
          return;
        }
        reportTimer = window.setTimeout(
          () => attempt(waitedMs + REPORT_POLL_MS),
          REPORT_POLL_MS,
        );
        return;
      }

      // Strikes and their outcomes can land a beat apart — give the outcomes a moment
      if (strikes.length > 0 && events.length === 0) {
        dataSeenAt = dataSeenAt || Date.now();
        if (Date.now() - dataSeenAt < 1_200) {
          reportTimer = window.setTimeout(
            () => attempt(waitedMs + REPORT_POLL_MS),
            REPORT_POLL_MS,
          );
          return;
        }
      }

      void play(strikes, events);
    };
    attempt(0);

    return () => {
      cancelled = true;
      window.clearTimeout(reportTimer);
      window.clearTimeout(watchdog);
      if (sessionRef.current === session) clearTheater();
    };
    // Only the round decides when the show starts; everything else is read live.
  }, [round, setState]);

  return (
    <>
      {holding && !cinema && !recap && (
        <div className="strike-cinema strike-cinema--hold" role="status" aria-live="polite">
          <div className="strike-cinema__veil" />
          <div className="strike-cinema__panel strike-cinema__panel--hold enter-pop">
            <header className="strike-cinema__title">INCOMING</header>
            <p className="strike-cinema__hold-copy">Tracking launches…</p>
          </div>
        </div>
      )}
      {cinema && <StrikeCinema state={state} strike={cinema} onComplete={onCinemaComplete} />}
      {recap && <StrikeRecap events={recap} onContinue={onRecapContinue} />}
    </>
  );
}

function MapBackdrop({ src = ART.map }: { src?: string } = {}) {
  return (
    <div className="map-backdrop" style={{ backgroundImage: `url(${src})` }} aria-hidden />
  );
}

function cityStatusLabel(c: {
  destroyed: boolean;
  hasShield: boolean;
  hasResearch: boolean;
  isUnderground?: boolean;
  hasLaser?: boolean;
  rebuiltRound?: number;
}) {
  if (c.destroyed) return 'Destroyed';
  const bits: string[] = [];
  if (c.rebuiltRound != null) bits.push('Rebuilt');
  if (c.hasResearch) bits.push('Research');
  if (c.isUnderground) bits.push('Underground');
  else if (c.hasShield) bits.push('Shield');
  if (c.hasLaser) bits.push('Lasers');
  return bits.length ? bits.join(' · ') : 'Open';
}

/** A city with everything a spy service would have told you stripped out. */
function hideDefences(c: City): City {
  return { ...c, hasShield: false, hasResearch: false, isUnderground: false, hasLaser: false };
}

function ResourceBar({
  money,
  bombs,
  drones,
  shields,
}: {
  money: number;
  bombs: number;
  drones: number;
  shields: number;
}) {
  return (
    <div className="res-bar" aria-label="Your resources">
      <div className="res-bar__item" title="Treasury">
        <span className="res-bar__icon res-bar__icon--cash" aria-hidden>
          $
        </span>
        <span className="res-bar__val">{formatMoney(money)}</span>
      </div>
      <div className="res-bar__item" title="Bombs">
        <img className="res-bar__img" src={ART.missile} alt="" draggable={false} />
        <span className="res-bar__val">{bombs}</span>
      </div>
      <div className="res-bar__item" title="Drone packs">
        <img className="res-bar__img" src={ART.drone} alt="" draggable={false} />
        <span className="res-bar__val">{drones}</span>
      </div>
      <div className="res-bar__item" title="Shields">
        <img className="res-bar__img" src={ART.shield} alt="" draggable={false} />
        <span className="res-bar__val">{shields}</span>
      </div>
    </div>
  );
}

function WizardNationHeader({
  state,
  nationId,
  money,
  bombs,
  drones,
  idleSecondsLeft,
  compact = false,
}: {
  state: GameState;
  nationId: NationId;
  money: number;
  bombs: number;
  drones: number;
  idleSecondsLeft?: number | null;
  compact?: boolean;
}) {
  const def = nationDef(nationId);
  return (
    <div className={`modal__head wizard-nation-head ${compact ? 'wizard-nation-head--compact' : ''}`}>
      <img
        className="modal__leader"
        src={leaderArt(state, nationId)}
        alt=""
        title={state.nations[nationId].hasSpyNetwork ? 'Spy service' : undefined}
      />
      <div>
        <p className="wizard-nation-head__country">{def.name}</p>
        <h2>
          {playerDisplayName(state, nationId)}
        </h2>
        <ResourceBar
          money={money}
          bombs={bombs}
          drones={drones}
          shields={shieldsLeft(state, nationId)}
        />
        {idleSecondsLeft != null && (
          <p className={`idle-timer ${idleSecondsLeft <= 10 ? 'is-urgent' : ''}`}>
            Select within {idleSecondsLeft}s or you leave the game
          </p>
        )}
      </div>
    </div>
  );
}

function NationPod({
  id,
  variant,
  state,
  selectedCityIds,
  targetable,
  blockedCityIds,
  pendingBombCityIds,
  pendingDroneCityIds,
  selectionWeapon = 'nuke',
  /** Per-city warhead already assigned — keeps badges stable when the picker changes */
  cityWeapons,
  highlightCityIds,
  highlight,
  revealed = false,
  viewerId = null,
  /** Final-score table: show place instead of the usual player label alone */
  rank,
  onSelectCity,
}: {
  id: NationId;
  variant: 'ally' | 'enemy' | 'world';
  state: GameState;
  selectedCityIds?: string[];
  targetable?: boolean;
  blockedCityIds?: string[];
  /** Cities with locked bombs inbound (pendingStrikes) */
  pendingBombCityIds?: string[];
  /** Cities with locked drone swarms inbound */
  pendingDroneCityIds?: string[];
  /** Which weapon the open targeting step is spending */
  selectionWeapon?: WarheadKind | 'drone';
  cityWeapons?: Partial<Record<string, WarheadKind>>;
  /** Cities to pulse (e.g. destroyed this round) */
  highlightCityIds?: string[];
  highlight?: boolean;
  /** Whether every city of this nation is open to the viewer (own, or spied) */
  revealed?: boolean;
  /** Who is looking, for per-city intel: a spy service, or a swarm that got through */
  viewerId?: NationId | null;
  rank?: number;
  onSelectCity?: (nationId: NationId, cityId: string) => void;
}) {
  const n = state.nations[id];
  const def = nationDef(id);
  const score = computeScore(state, id).total;
  const blocked = new Set(blockedCityIds ?? []);
  const bombed = new Set(pendingBombCityIds ?? []);
  const swarmed = new Set(pendingDroneCityIds ?? []);
  const pulsed = new Set(highlightCityIds ?? []);
  const interactive = Boolean(onSelectCity);
  const isAngel = state.angelNationId === id;
  const isEvil = state.evilNationId === id;
  return (
    <div
      className={`nation-card nation-card--${variant} ${n.eliminated ? 'is-out' : ''} ${highlight ? 'is-turn' : ''}`}
      data-nation-id={id}
    >
      <div className="nation-card__portrait" data-nation-portrait={id}>
        <span className="nation-card__shot">
          <img
            src={leaderArt(state, id)}
            alt={def.leader}
            title={n.hasSpyNetwork ? "Spy service — reads every nation's city defences" : undefined}
          />
        </span>
        <div className="nation-card__aside">
          {(isAngel || isEvil) && (
            <span className="stance-badges">
              {isAngel && (
                <span className="stance-mark stance-mark--peace" title="Most peaceful this round">
                  <span aria-hidden>☮</span>
                  Peace
                </span>
              )}
              {isEvil && (
                <span className="stance-mark stance-mark--evil" title="Aggressor this round">
                  <span aria-hidden>☠</span>
                  Evil
                </span>
              )}
            </span>
          )}
          <div className="nation-card__meta">
            <strong>
              {rank != null ? `#${rank} ` : ''}
              {playerDisplayName(state, id)}
              {n.eliminated ? ' — OUT' : ''}
            </strong>
            <span className="nation-card__score">{score} pts</span>
            <span>
              {def.name} · ${formatMoney(n.money)}
              {n.hasNuclearTech ? ' · ☢' : ''}
              {n.bombs > 0 ? ` · 💣${n.bombs}` : ''}
              {n.drones > 0 ? ` · 🛸${n.drones}` : ''}
            </span>
          </div>
        </div>
      </div>
      <div className="nation-card__cities">
        {n.cities.map((raw) => {
          // Without eyes on a city it reads as bare ground: rubble is visible
          // from orbit, defences are not. A spy service opens the whole nation;
          // a swarm that got through opens the one city it flew over.
          const open =
            revealed || (viewerId != null && seesCity(state, viewerId, id, raw.id));
          const c = open ? raw : hideDefences(raw);
          const selected = selectedCityIds?.includes(c.id);
          const hitThisRound = blocked.has(c.id);
          const bombLocked = bombed.has(c.id) && !c.destroyed;
          const droneLocked = swarmed.has(c.id) && !c.destroyed;
          const droneSelected = Boolean(selected && selectionWeapon === 'drone');
          const justHit = pulsed.has(c.id);
          const assignedWeapon: WarheadKind | 'drone' =
            selectionWeapon === 'drone'
              ? 'drone'
              : (cityWeapons?.[c.id] ?? (selected ? selectionWeapon : 'nuke'));
          // A warhead has nothing to hit in a bunker city; drones still bill it
          const bombProof = Boolean(
            c.isUnderground &&
              selectionWeapon !== 'drone' &&
              selectionWeapon !== 'hydrogen' &&
              // Already-tagged hydrogen stays legal even if the picker moved on
              !(selected && cityWeapons?.[c.id] === 'hydrogen'),
          );
          const canTarget = Boolean(
            targetable && !c.destroyed && !hitThisRound && (!bombProof || selected),
          );
          const className = `city-tile ${c.destroyed ? 'is-destroyed' : ''} ${c.hasShield && !c.isUnderground ? 'has-shield' : ''} ${c.hasResearch ? 'has-research' : ''} ${selected ? 'is-selected' : ''} ${canTarget ? 'is-targetable' : ''} ${hitThisRound && !c.destroyed && !bombLocked ? 'is-hit-this-round' : ''} ${bombLocked ? 'is-bomb-locked' : ''} ${droneLocked || droneSelected ? 'is-drone-locked' : ''} ${c.isUnderground && !c.destroyed ? 'is-underground' : ''} ${c.hasLaser && !c.destroyed ? 'has-laser' : ''} ${c.rebuiltRound != null && !c.destroyed ? 'is-rebuilt' : ''} ${justHit ? 'is-just-hit' : ''}`;
          const unknown = !open && !c.destroyed;
          const weaponLabel =
            assignedWeapon === 'hydrogen'
              ? 'hydrogen'
              : assignedWeapon === 'magnetic'
                ? 'magnetic'
                : assignedWeapon === 'drone'
                  ? 'drones'
                  : 'nuclear';
          const title = unknown
            ? `${c.name} — defences unknown: spy them, or send a swarm over`
            : c.isUnderground && !c.destroyed
            ? selectionWeapon === 'hydrogen' || cityWeapons?.[c.id] === 'hydrogen'
              ? `${c.name} — underground city, hydrogen can crack it`
              : `${c.name} — underground city, cannot be destroyed`
            : bombLocked
            ? `${c.name} — targeted for bombing`
            : droneLocked
              ? `${c.name} — drone swarm inbound`
              : selected
                ? `${c.name} — selected for ${weaponLabel}`
                : `${c.name} — ${cityStatusLabel(c)}`;
          const body = (
            <>
              {c.rebuiltRound != null && !c.destroyed && (
                <span className="city-tile__shine" aria-hidden />
              )}
              <img
                className="city-tile__art"
                src={cityArt(c)}
                alt={c.name}
                draggable={false}
              />
              {c.hasShield && !c.isUnderground && !c.destroyed && (
                <span className="city-dome" aria-hidden />
              )}
              {c.hasResearch && !c.destroyed && (
                <span className="city-tile__research" title="Research" aria-label="Research">
                  <img src={ART.researchIcon} alt="" draggable={false} />
                </span>
              )}
              {c.hasLaser && !c.destroyed && (
                <span
                  className="city-tile__laser"
                  title={`Laser defence network — shoots down ${LASER_INTERCEPTS_PER_ROUND} swarms a round, anywhere in the nation`}
                  aria-label="Laser defence"
                >
                  <img src={ART.laserIcon} alt="" draggable={false} />
                </span>
              )}
              {(bombLocked || (selected && selectionWeapon !== 'drone')) && (
                <span
                  className={`city-tile__bomb-lock ${
                    selected && selectionWeapon !== 'drone' && !bombLocked ? 'is-pending' : ''
                  }`}
                  title={
                    bombLocked
                      ? `Targeted — ${weaponLabel}`
                      : `Selected — ${weaponLabel}`
                  }
                  aria-label={
                    bombLocked
                      ? `Targeted for ${weaponLabel}`
                      : `Selected for ${weaponLabel}`
                  }
                >
                  <img
                    src={craftArt(assignedWeapon === 'drone' ? 'nuke' : assignedWeapon)}
                    alt=""
                    draggable={false}
                  />
                </span>
              )}
              {(droneLocked || droneSelected) && (
                <span
                  className={`city-tile__drone-lock ${
                    droneSelected && !droneLocked ? 'is-pending' : ''
                  }`}
                  title={droneLocked ? 'Drone swarm inbound' : 'Selected for drones'}
                  aria-label={droneLocked ? 'Drone swarm inbound' : 'Selected for drones'}
                >
                  <img src={ART.drone} alt="" draggable={false} />
                </span>
              )}
              {c.destroyed && (
                <span className="city-smoke" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              )}
              <span className="city-tile__name">{c.name}</span>
            </>
          );
          if (!interactive) {
            return (
              <div key={c.id} data-city-id={c.id} className={`${className} city-tile--static`} title={title}>
                {body}
              </div>
            );
          }
          return (
            <button
              key={c.id}
              type="button"
              data-city-id={c.id}
              className={className}
              title={
                hitThisRound && !c.destroyed
                  ? `${c.name} — already targeted this round`
                  : title
              }
              disabled={c.destroyed || (Boolean(targetable) && hitThisRound)}
              onClick={() => onSelectCity?.(id, c.id)}
            >
              {body}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FxLayer({ events }: { events: FxEvent[] }) {
  return (
    <div className="fx-layer" aria-hidden>
      {events.map((fx) => {
        if (fx.kind === 'strike-label' && fx.label) {
          return (
            <div key={fx.id} className="fx-strike-label">
              {fx.label}
            </div>
          );
        }
        if (fx.kind === 'buy') {
          return (
            <div key={fx.id} className="fx-buy-toast">
              {fx.label}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function ModeSelect({ onSelect }: { onSelect: (m: GameMode) => void }) {
  return (
    <div className="screen screen--splash screen--hero">
      <MapBackdrop src={ART.splash} />
      <div className="splash-veil" />
      <div className="splash-content">
        <h1 className="stencil-title title-glow">WAR STRATEGY</h1>
        <p className="tagline">6 rounds · 12 countries · one superpower</p>
        <div className="mode-row">
          <button className="btn btn--xl btn--primary" onClick={() => onSelect('single')}>
            <img className="mode-row__icon" src={ART.modeSingle} alt="" />
            <span className="mode-row__copy">
              <span className="mode-row__title">Single Player</span>
              <small>Pick your country · you vs 4 AI nations</small>
            </span>
          </button>
          <button className="btn btn--xl btn--primary" onClick={() => onSelect('two')}>
            <img className="mode-row__icon" src={ART.modeTwo} alt="" />
            <span className="mode-row__copy">
              <span className="mode-row__title">Two Players</span>
              <small>Hot-seat · same device</small>
            </span>
          </button>
          <button
            className="btn btn--xl btn--primary"
            onClick={() => onSelect('online')}
            disabled={!isFirebaseConfigured()}
          >
            <img className="mode-row__icon" src={ART.modeOnline} alt="" />
            <span className="mode-row__copy">
              <span className="mode-row__title">Online Multiplayer</span>
              <small>
                {isFirebaseConfigured()
                  ? '2–5 humans · AI fills the rest'
                  : 'Set VITE_FIREBASE_* to enable'}
              </small>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerNames({
  onContinue,
}: {
  onContinue: (name1: string, name2: string) => void;
}) {
  const [name1, setName1] = useState('');
  const [name2, setName2] = useState('');

  return (
    <div className="screen screen--splash">
      <MapBackdrop />
      <div className="splash-veil" />
      <div className="splash-content">
        <h1 className="stencil-title">WHO'S PLAYING?</h1>
        <p className="tagline">Enter both names so turns are clear at the table.</p>
        <form
          className="names-form"
          onSubmit={(e) => {
            e.preventDefault();
            onContinue(name1, name2);
          }}
        >
          <label className="names-field">
            <span>Player 1</span>
            <input
              type="text"
              name="player1"
              autoComplete="nickname"
              placeholder="e.g. Alex"
              maxLength={24}
              value={name1}
              onChange={(e) => setName1(e.target.value)}
              autoFocus
            />
          </label>
          <label className="names-field">
            <span>Player 2</span>
            <input
              type="text"
              name="player2"
              autoComplete="nickname"
              placeholder="e.g. Sam"
              maxLength={24}
              value={name2}
              onChange={(e) => setName2(e.target.value)}
            />
          </label>
          <button className="btn btn--xl btn--primary" type="submit">
            Choose Countries
          </button>
        </form>
      </div>
    </div>
  );
}

function CountrySelect({
  state,
  onPick,
}: {
  state: GameState;
  onPick: (id: NationId) => void;
}) {
  const p1 = state.playerNames[1] ?? 'Player 1';
  const p2 = state.playerNames[2] ?? 'Player 2';
  const title =
    state.mode === 'two' && state.selectingFor === 2
      ? `${p2.toUpperCase()} — CHOOSE A COUNTRY`
      : state.mode === 'two'
        ? `${p1.toUpperCase()} — CHOOSE A COUNTRY`
        : 'CHOOSE A COUNTRY';

  return (
    <div className="screen screen--splash">
      <MapBackdrop />
      <div className="splash-veil" />
      <div className="splash-content splash-content--wide">
        <h1 className="stencil-title">{title}</h1>
        <div className="country-row">
          {NATIONS.map((n) => {
            const taken = state.humanNations.includes(n.id);
            return (
              <button
                key={n.id}
                className={`country-pick ${taken ? 'is-taken' : ''}`}
                disabled={taken}
                onClick={() => onPick(n.id)}
              >
                <img src={ART.leaders[n.id]} alt={n.name} />
                <span className="country-pick__name">{n.name}</span>
              </button>
            );
          })}
        </div>
        <p className="cta-bubble">Lead a Nation!</p>
      </div>
    </div>
  );
}

function canOfferStrike(state: GameState, actorId: NationId): boolean {
  return totalWarheads(state.nations[actorId]) > 0;
}

function canOfferDroneStrike(state: GameState, actorId: NationId): boolean {
  return state.nations[actorId].drones > 0;
}

/** Back to the command map while the purchasing window is still open. */
function BackToCommand({ deadline, onBack }: { deadline: number; onBack: () => void }) {
  const [open, setOpen] = useState(() => Date.now() < deadline);
  useEffect(() => {
    const check = () => setOpen(Date.now() < deadline);
    check();
    const t = window.setInterval(check, 500);
    return () => window.clearInterval(t);
  }, [deadline]);
  if (!open) return null;
  return (
    <button type="button" className="cop-link cop-link--back" onClick={onBack}>
      ← Back to command map
    </button>
  );
}

/**
 * Turn flow: the command dashboard (every purchase, on one screen), then the
 * warhead targets, then the drone targets. Null once nothing is left to aim.
 */
function nextWizardStep(
  state: GameState,
  from: WizardStep | null,
  actorId: NationId,
): WizardStep | null {
  if (from == null) return 'command';
  const sequence: WizardStep[] = ['command', 'strike', 'droneStrike'];
  for (let i = sequence.indexOf(from) + 1; i < sequence.length; i += 1) {
    const step = sequence[i];
    if (step === 'strike' && canOfferStrike(state, actorId)) return 'strike';
    if (step === 'droneStrike' && canOfferDroneStrike(state, actorId)) return 'droneStrike';
  }
  return null;
}

function GameBoard({
  state,
  setState,
  sessionUid,
  onKicked,
  roundBriefingActive = false,
}: {
  state: GameState;
  setState: React.Dispatch<React.SetStateAction<GameState>>;
  sessionUid?: string | null;
  onKicked?: (message: string) => void;
  roundBriefingActive?: boolean;
}) {
  const turnId = currentNationId(state);
  const myNationId =
    sessionUid && state.uidToNation?.[sessionUid]
      ? state.uidToNation[sessionUid]
      : null;
  const isOnline = Boolean(state.mode === 'online' && state.onlineGameId);
  /** Online: every human plans at once as their own nation; offline stays turn-based. */
  const actorId = isOnline && myNationId ? myNationId : turnId;
  const turn = state.nations[actorId];
  const [targets, setTargets] = useState<
    { nationId: NationId; cityId: string; weapon: WarheadKind }[]
  >([]);
  const [droneTargets, setDroneTargets] = useState<
    { nationId: NationId; cityId: string }[]
  >([]);
  const [strikeWeapon, setStrikeWeapon] = useState<WarheadKind>('nuke');
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  /** When the timed purchasing window on the command map closes. */
  const [purchaseDeadline, setPurchaseDeadline] = useState(0);
  const [fx, setFx] = useState<FxEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState<number | null>(null);
  /** Seconds left once every warhead/drone has a city; null when not confirming. */
  const [targetConfirmLeft, setTargetConfirmLeft] = useState<number | null>(null);
  const fxId = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const aiRunningRef = useRef(false);
  /**
   * Which nation's turn the prompts were last opened for, as `round:nation`.
   * Hot-seat passes the device to a second human inside the same round, so a
   * round number alone would swallow the second player's turn entirely.
   */
  const wizardStartedTurnRef = useRef<string | null>(null);
  const lastActivityRef = useRef(Date.now());
  const kickingRef = useRef(false);
  const onKickedRef = useRef(onKicked);
  onKickedRef.current = onKicked;

  const isResolving = state.phase === 'resolveStrikes';
  const humansPlanning =
    (state.phase === 'buy' || state.phase === 'action') && !allAliveHumansReady(state);
  const isHumanTurn = isOnline
    ? humansPlanning && turn.isHuman && !turn.eliminated
    : (state.phase === 'buy' || state.phase === 'action') &&
      state.nations[turnId].isHuman &&
      !state.nations[turnId].eliminated;
  const isMyHumanTurn = isOnline
    ? Boolean(
        myNationId &&
          humansPlanning &&
          !state.nations[myNationId].eliminated &&
          !state.humanReady?.[myNationId],
      )
    : isHumanTurn;
  const droneSelectMode = isMyHumanTurn && wizardStep === 'droneStrike';
  const strikeSelectMode = (isMyHumanTurn && wizardStep === 'strike') || droneSelectMode;
  /** Wiped out but still seated: watch the match play out to the final scores. */
  const mySeatId = isOnline
    ? myNationId
    : (state.turnOrder.find((id) => state.nations[id].isHuman) ?? null);
  const isSpectator = Boolean(mySeatId && state.nations[mySeatId].eliminated);
  const inboundSanctions = whoIsSanctioning(state, actorId);
  const waitingHumans = isOnline
    ? aliveHumanNations(state).filter((id) => !state.humanReady?.[id])
    : [];

  const bumpSelectionActivity = useCallback(() => {
    // Local idle timer only — do not push (avoids stale overwrites of purchases/ready)
    lastActivityRef.current = Date.now();
    setIdleSecondsLeft(Math.ceil(SELECTION_IDLE_MS / 1000));
  }, []);

  const syncPlanning = useCallback(
    (next: GameState, actor: NationId) => {
      if (next.mode !== 'online' || !next.onlineGameId) return;
      const gameId = next.onlineGameId;
      void enqueueHumanPlanningPush(gameId, actor, () => stateRef.current).then((merged) => {
        setState((cur) => {
          if (cur.onlineGameId !== gameId) return cur;
          // Always adopt server merge — including when the room already advanced rounds
          return applyRemoteGameSnapshot(cur, merged, actor);
        });
      });
    },
    [setState],
  );

  useEffect(() => {
    const cap = totalWarheads(turn);
    setTargets((prev) => (prev.length > cap ? prev.slice(0, cap) : prev));
  }, [turn.bombs, turn.hydrogenBombs, turn.magneticBombs]);

  useEffect(() => {
    // Prefer a warhead type that still has free slots in the current pick list
    const stock: Record<WarheadKind, number> = {
      nuke: turn.bombs,
      hydrogen: turn.hydrogenBombs ?? 0,
      magnetic: turn.magneticBombs ?? 0,
    };
    const used = { nuke: 0, hydrogen: 0, magnetic: 0 };
    for (const t of targets) used[t.weapon] += 1;
    if (stock[strikeWeapon] > used[strikeWeapon]) return;
    const next = (['nuke', 'hydrogen', 'magnetic'] as WarheadKind[]).find(
      (k) => stock[k] > used[k],
    );
    if (next) setStrikeWeapon(next);
  }, [turn.bombs, turn.hydrogenBombs, turn.magneticBombs, targets, strikeWeapon]);

  useEffect(() => {
    setDroneTargets((prev) => (prev.length > turn.drones ? prev.slice(0, turn.drones) : prev));
  }, [turn.drones]);

  const pushFx = useCallback((event: Omit<FxEvent, 'id'>, ms = 900) => {
    const id = `fx-${++fxId.current}`;
    setFx((prev) => [...prev, { ...event, id }]);
    window.setTimeout(() => {
      setFx((prev) => prev.filter((f) => f.id !== id));
    }, ms);
  }, []);

  const closeHumanTurn = useCallback(
    (
      strikeTargets: { nationId: NationId; cityId: string; weapon?: WarheadKind }[],
      swarmTargets: { nationId: NationId; cityId: string }[] = [],
    ) => {
      setWizardStep(null);
      setTargets([]);
      setDroneTargets([]);
      setTargetConfirmLeft(null);
      setState((s) => {
        const actor =
          s.mode === 'online' && sessionUid && s.uidToNation?.[sessionUid]
            ? s.uidToNation[sessionUid]
            : currentNationId(s);
        if (!actor) return s;

        let next = s.phase === 'buy' ? finishBuyPhase(s) : s;
        for (const t of strikeTargets) {
          next = queueStrike(next, t.nationId, t.cityId, actor, t.weapon ?? 'nuke');
        }
        next = queueStrikes(next, swarmTargets, actor, 'drone');

        if (s.mode === 'online' && s.onlineGameId) {
          next = touchHumanActivity(next, actor);
          next = markHumanReady(next, actor);
          const gameId = s.onlineGameId;
          stateRef.current = next;
          void lockInHumanPlanning(gameId, next, actor)
            .then((merged) => {
              setState((cur) => {
                if (cur.onlineGameId !== gameId) return cur;
                return applyPublishedGame(cur, merged, actor, {
                  seq: 0,
                  kind: 'playerReady',
                  round: merged.round,
                  publishedAt: Date.now(),
                  nationId: actor,
                });
              });
            })
            .catch((err) => {
              console.error('lock-in orders failed', err);
              // Never let a failed orders write leave peers waiting on us
              void markOnlineReady(gameId, actor).catch((e) =>
                console.error('mark ready failed', e),
              );
              void enqueueHumanPlanningPush(gameId, actor, () => stateRef.current);
            });
          return next;
        }

        next = endTurn(next);
        return next;
      });
    },
    [setState, sessionUid],
  );

  /** Apply one purchase from the command dashboard and keep online peers in step. */
  const applyOrder = useCallback(
    (fn: (s: GameState) => GameState, label?: string) => {
      const actor =
        stateRef.current.mode === 'online' &&
        sessionUid &&
        stateRef.current.uidToNation?.[sessionUid]
          ? stateRef.current.uidToNation[sessionUid]
          : currentNationId(stateRef.current);
      if (!actor) return;
      bumpSelectionActivity();
      const cur = stateRef.current;
      let next = fn(cur);
      if (next === cur) return;
      if (label) pushFx({ kind: 'buy', label }, 700);
      if (next.mode === 'online') next = touchHumanActivity(next, actor);
      stateRef.current = next;
      setState(next);
      if (next.mode === 'online') syncPlanning(next, actor);
    },
    [sessionUid, bumpSelectionActivity, pushFx, setState, syncPlanning],
  );

  const advanceAfter = useCallback(
    (s: GameState, from: WizardStep) => {
      const actor =
        s.mode === 'online' && sessionUid && s.uidToNation?.[sessionUid]
          ? s.uidToNation[sessionUid]
          : currentNationId(s);
      if (!actor) return;
      bumpSelectionActivity();
      const next = nextWizardStep(s, from, actor);
      if (next == null) closeHumanTurn([]);
      else setWizardStep(next);
    },
    [closeHumanTurn, sessionUid, bumpSelectionActivity],
  );

  // Start turn prompts when this human can act (once per round), after briefing
  useEffect(() => {
    if (!isMyHumanTurn) {
      setWizardStep(null);
      setIdleSecondsLeft(null);
      return;
    }
    if (roundBriefingActive) return;
    const turnKey = `${state.round}:${actorId}`;
    if (wizardStartedTurnRef.current === turnKey) return;

    wizardStartedTurnRef.current = turnKey;
    lastActivityRef.current = Date.now();
    setIdleSecondsLeft(Math.ceil(SELECTION_IDLE_MS / 1000));
    setTargets([]);
    setDroneTargets([]);
    setPurchaseDeadline(Date.now() + PURCHASE_WINDOW_MS);
    setWizardStep('command');
  }, [isMyHumanTurn, actorId, state.round, roundBriefingActive]);

  // Idle kick — only while this client must make selections
  useEffect(() => {
    if (!isOnline || !isMyHumanTurn || !myNationId || !state.onlineGameId) {
      setIdleSecondsLeft(null);
      return;
    }

    const tick = window.setInterval(() => {
      const remaining = SELECTION_IDLE_MS - (Date.now() - lastActivityRef.current);
      setIdleSecondsLeft(Math.max(0, Math.ceil(remaining / 1000)));
      if (remaining > 0 || kickingRef.current) return;
      kickingRef.current = true;
      const gameId = stateRef.current.onlineGameId;
      const nation = myNationId;
      void (async () => {
        try {
          if (gameId && nation) {
            const next = await kickIdleHumanFromGame(gameId, nation);
            if (next) setState(next);
          }
        } finally {
          onKickedRef.current?.(
            'You left the game — your cities were destroyed.',
          );
        }
      })();
    }, 250);

    return () => window.clearInterval(tick);
  }, [isOnline, isMyHumanTurn, myNationId, state.onlineGameId, setState]);

  // Peers: forfeit only after the selection idle window — never from lobby status / tab blur
  useEffect(() => {
    if (!isOnline || !humansPlanning || !state.onlineGameId || !sessionUid) return;

    const tick = window.setInterval(() => {
      const s = stateRef.current;
      if (!s.onlineGameId) return;
      const now = Date.now();
      for (const id of aliveHumanNations(s)) {
        if (s.humanReady?.[id]) continue;
        if (id === myNationId) continue;
        if (!isHumanDisconnected(s, id, now)) continue;
        void (async () => {
          const got = await tryAcquireAiLock(
            s.onlineGameId!,
            sessionUid,
            `kick-${s.round}-${id}`,
          );
          if (!got) return;
          await leaveOnlineGame(s.onlineGameId!, id);
        })();
      }
    }, 1000);

    return () => window.clearInterval(tick);
  }, [
    isOnline,
    humansPlanning,
    state.onlineGameId,
    state.round,
    sessionUid,
    myNationId,
  ]);

  // If we were kicked remotely, leave the board. A forfeit flips our nation to
  // AI without touching uidToNation, so watch the seat itself. Losing every
  // city is not a forfeit — that player keeps their seat and spectates.
  const mySeat = sessionUid ? state.uidToNation?.[sessionUid] : null;
  const seatHeld = Boolean(mySeat && state.nations[mySeat]?.isHuman);
  useEffect(() => {
    if (!isOnline || !sessionUid || !onKicked) return;
    if (seatHeld) {
      kickingRef.current = false;
      return;
    }
    if (
      state.phase === 'session' ||
      state.phase === 'mode' ||
      state.phase === 'lobby' ||
      state.phase === 'gameOver'
    ) {
      return;
    }
    if (kickingRef.current) return;
    kickingRef.current = true;
    onKicked('You left the game — your cities were destroyed.');
  }, [isOnline, sessionUid, seatHeld, state.phase, onKicked]);

  // If we already locked in but the shared room still lists us as waiting, publish again
  useEffect(() => {
    if (!isOnline || !myNationId || !state.onlineGameId) return;
    if (state.phase !== 'buy' && state.phase !== 'action') return;
    if (!state.humanReady?.[myNationId] || state.planningComplete) return;
    const gameId = state.onlineGameId;
    const nation = myNationId;
    let cancelled = false;
    const republish = async () => {
      const cur = stateRef.current;
      if (
        cancelled ||
        cur.onlineGameId !== gameId ||
        (cur.phase !== 'buy' && cur.phase !== 'action') ||
        !cur.humanReady?.[nation] ||
        cur.planningComplete
      ) {
        return;
      }
      try {
        // Only rewrite when the shared doc really is missing our lock-in
        const remote = await fetchGame(gameId);
        if (cancelled || !remote?.state) return;
        if (remote.state.humanReady?.[nation]) return;

        const merged = await lockInHumanPlanning(gameId, stateRef.current, nation);
        if (cancelled) return;
        setState((prev) => {
          if (prev.onlineGameId !== gameId) return prev;
          return applyPublishedGame(prev, merged, nation, {
            seq: 0,
            kind: 'playerReady',
            round: merged.round,
            publishedAt: Date.now(),
            nationId: nation,
          });
        });
      } catch (err) {
        console.error('republish ready failed', err);
        void markOnlineReady(gameId, nation).catch((e) =>
          console.error('mark ready failed', e),
        );
      }
    };
    const t = window.setTimeout(() => void republish(), 800);
    const retry = window.setInterval(() => void republish(), 2500);
    // Mobile browsers freeze timers in background tabs — re-check on resume
    const onVisible = () => {
      if (document.visibilityState === 'visible') void republish();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.clearInterval(retry);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [
    isOnline,
    myNationId,
    state.onlineGameId,
    state.phase,
    state.round,
    state.humanReady,
    state.planningComplete,
    setState,
  ]);

  // Online: AI buys/queues at round start so their board updates while humans select
  useEffect(() => {
    if (!isOnline) return;
    if (state.phase !== 'buy' && state.phase !== 'action') return;
    if (state.planningComplete || state.aiPlanningComplete) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      setState((s) => {
        if (s.phase !== 'buy' && s.phase !== 'action') return s;
        if (s.planningComplete || s.aiPlanningComplete) return s;
        // Keep AI buys local until a human lock-in publishes — never overwrite ready flags
        return runOnlineAiPlanning(s);
      });
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    isOnline,
    state.phase,
    state.round,
    state.planningComplete,
    state.aiPlanningComplete,
    state.onlineGameId,
    setState,
  ]);

  // Online: when all humans finished selections → run AI + advance to strikes/summary
  // Offline: run one AI turn at a time when it's an AI nation
  useEffect(() => {
    if (state.phase !== 'buy' && state.phase !== 'action') return;
    if (aiRunningRef.current) return;

    if (isOnline) {
      if (!allAliveHumansReady(state)) return;
      if (state.planningComplete) return;
      const gameId = state.onlineGameId;
      if (!gameId) return;
      const round = state.round;

      let cancelled = false;
      // Lock-free and idempotent: every client retries until the room publishes
      // the resolve event, so one stalled peer can never freeze the table.
      const attempt = async () => {
        if (cancelled) return;
        const cur = stateRef.current;
        if (cur.onlineGameId !== gameId || cur.round !== round) return;
        if (cur.phase !== 'buy' && cur.phase !== 'action') return;
        if (!allAliveHumansReady(cur)) return;
        try {
          const merged = await publishPlanningComplete(gameId, round);
          if (!merged || cancelled) return;
          setState((prev) => {
            if (prev.onlineGameId !== gameId) return prev;
            const myId =
              sessionUid && prev.uidToNation?.[sessionUid]
                ? prev.uidToNation[sessionUid]
                : null;
            return applyPublishedGame(prev, merged, myId, {
              seq: 0,
              kind: 'resolve',
              round: merged.round,
              publishedAt: Date.now(),
            });
          });
        } catch (err) {
          console.error('publish planning complete failed', err);
        }
      };

      const first = window.setTimeout(() => void attempt(), 200);
      const retry = window.setInterval(() => void attempt(), 1200);
      return () => {
        cancelled = true;
        window.clearTimeout(first);
        window.clearInterval(retry);
      };
    }

    const aiTurnId = currentNationId(state);
    const aiNation = state.nations[aiTurnId];
    if (aiNation.isHuman || aiNation.eliminated) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        if (cancelled || aiRunningRef.current) return;
        aiRunningRef.current = true;
        setBusy(true);
        try {
          setState((s) => runAiTurn(s));
        } finally {
          aiRunningRef.current = false;
          setBusy(false);
        }
      })();
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    state.phase,
    state.currentTurnIndex,
    state.round,
    state.onlineGameId,
    state.humanReady,
    state.planningComplete,
    isOnline,
    sessionUid,
    setState,
  ]);

  // Resolve the round's strikes and publish the board. No animation here: the
  // cinema runs off the summary instead, so a client that misses this short
  // phase still sees it.
  useEffect(() => {
    if (state.phase !== 'resolveStrikes') return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        const current = stateRef.current;
        if (current.phase !== 'resolveStrikes') return;

        let resolved = orderStrikesForResolution(current.pendingStrikes).reduce(
          (s, strike) => applyQueuedStrike(s, strike),
          current,
        );
        resolved = finishStrikeResolution(resolved);

        const gameId = current.mode === 'online' ? current.onlineGameId : null;
        if (gameId) {
          // Idempotent transaction — the first client wins, the rest adopt it,
          // so no lock a departed player can hold freezes the round.
          try {
            const published = await publishStrikeResolution(gameId, current.round);
            if (published) {
              if (published.phase === 'gameOver') {
                await finishOnlineGame(gameId, published, sessionUid ?? undefined);
              }
              resolved = published;
            }
          } catch (err) {
            console.error('failed to publish strike resolution', err);
          }
        }
        if (!cancelled) setState(resolved);
      })();
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [state.phase, state.round, state.onlineGameId, sessionUid, setState]);

  const onSelectCity = (nationId: NationId, cityId: string) => {
    if (!strikeSelectMode || busy) return;
    if (nationId === actorId) return;
    if (droneSelectMode) {
      const limit = turn.drones;
      if (limit < 1) return;
      if (turn.citiesDronedThisRound.includes(cityId)) return;
      bumpSelectionActivity();
      const exists = droneTargets.find((t) => t.cityId === cityId);
      if (exists) {
        setDroneTargets(droneTargets.filter((t) => t.cityId !== cityId));
        return;
      }
      const next =
        droneTargets.length >= limit
          ? [...droneTargets.slice(1), { nationId, cityId }]
          : [...droneTargets, { nationId, cityId }];
      setDroneTargets(next);
      return;
    }

    const stock: Record<WarheadKind, number> = {
      nuke: turn.bombs,
      hydrogen: turn.hydrogenBombs ?? 0,
      magnetic: turn.magneticBombs ?? 0,
    };
    const cap = totalWarheads(turn);
    if (cap < 1) return;
    if (turn.citiesStruckThisRound.includes(cityId)) return;
    bumpSelectionActivity();
    const exists = targets.find((t) => t.cityId === cityId);
    if (exists) {
      setTargets(targets.filter((t) => t.cityId !== cityId));
      return;
    }
    const used = targets.filter((t) => t.weapon === strikeWeapon).length;
    if (used >= stock[strikeWeapon]) return;
    const next =
      targets.length >= cap
        ? [...targets.slice(1), { nationId, cityId, weapon: strikeWeapon }]
        : [...targets, { nationId, cityId, weapon: strikeWeapon }];
    setTargets(next);
  };

  /** Targeting runs bombs first, then drones, so the last step locks the turn in. */
  const finishStrikeStep = (
    picked: { nationId: NationId; cityId: string; weapon: WarheadKind }[],
  ) => {
    bumpSelectionActivity();
    setTargetConfirmLeft(null);
    setTargets(picked);
    if (canOfferDroneStrike(stateRef.current, actorId)) {
      setWizardStep('droneStrike');
      return;
    }
    closeHumanTurn(picked);
  };

  const warheadCap = totalWarheads(turn);
  const warheadsConfirming = wizardStep === 'strike' && warheadCap > 0 && targets.length >= warheadCap;
  const dronesConfirming =
    droneSelectMode && turn.drones > 0 && droneTargets.length >= turn.drones;
  const targetConfirmKey = dronesConfirming
    ? `drone:${droneTargets.map((t) => t.cityId).join('|')}`
    : warheadsConfirming
      ? `strike:${targets.map((t) => `${t.cityId}:${t.weapon}`).join('|')}`
      : null;

  // Full loadout: 10s to retarget or tap Lock / Send; a new city resets the clock.
  useEffect(() => {
    if (targetConfirmKey == null) {
      setTargetConfirmLeft(null);
      return;
    }
    const strikePick = targets;
    const dronePick = droneTargets;
    const isDrone = targetConfirmKey.startsWith('drone:');
    const started = Date.now();
    let finished = false;
    setTargetConfirmLeft(Math.ceil(TARGET_CONFIRM_MS / 1000));
    const tick = window.setInterval(() => {
      const left = Math.ceil((TARGET_CONFIRM_MS - (Date.now() - started)) / 1000);
      if (left > 0) {
        setTargetConfirmLeft(left);
        return;
      }
      window.clearInterval(tick);
      if (finished) return;
      finished = true;
      setTargetConfirmLeft(null);
      if (isDrone) {
        closeHumanTurn(strikePick, dronePick);
        return;
      }
      bumpSelectionActivity();
      setTargets(strikePick);
      if (canOfferDroneStrike(stateRef.current, actorId)) {
        setWizardStep('droneStrike');
        return;
      }
      closeHumanTurn(strikePick);
    }, 200);
    return () => {
      finished = true;
      window.clearInterval(tick);
    };
  }, [targetConfirmKey, closeHumanTurn, actorId, bumpSelectionActivity]);

  const selectedCityIds = droneSelectMode
    ? droneTargets.map((t) => t.cityId)
    : targets.map((t) => t.cityId);
  const cityWeapons: Partial<Record<string, WarheadKind>> = {};
  for (const t of targets) cityWeapons[t.cityId] = t.weapon;
  for (const s of state.pendingStrikes) {
    if (s.attackerId !== actorId || s.weapon === 'drone' || !s.weapon) continue;
    cityWeapons[s.cityId] = s.weapon;
  }
  // Fog of war: only show your own locked targets until simultaneous resolve
  const myStrikes = state.pendingStrikes.filter((s) => s.attackerId === actorId);
  const pendingBombCityIds = [
    ...myStrikes.filter((s) => s.weapon !== 'drone').map((s) => s.cityId),
    // Warhead picks stay marked while drone targeting is open, so a player can
    // see which shield a swarm would tie up
    ...(droneSelectMode ? targets.map((t) => t.cityId) : []),
  ];
  const pendingDroneCityIds = myStrikes
    .filter((s) => s.weapon === 'drone')
    .map((s) => s.cityId);

  const allyIds = isOnline
    ? [actorId]
    : isHumanTurn
      ? [actorId]
      : state.turnOrder.filter((id) => state.nations[id].isHuman);
  const enemyIds = rankNationIds(
    state,
    state.turnOrder.filter((id) => !allyIds.includes(id)),
  );
  const enemyRank = new Map(enemyIds.map((id, i) => [id, i + 1]));
  // The Enemies panel is read by whoever is at the screen, not by whoever is
  // taking their turn: while the AI moves, `actorId` is the AI, and reading the
  // board through its eyes would hide the defences the player paid to see.
  const enemyViewerId = allyIds[0] ?? actorId;
  const enemiesRevealed = allyIds.some((id) => state.nations[id].hasSpyNetwork);

  return (
    <div className={`screen screen--board${strikeSelectMode ? ' is-striking' : ''}`}>
      <MapBackdrop
        src={
          droneSelectMode ? ART.mapDrones : wizardStep === 'strike' ? ART.mapMissiles : ART.map
        }
      />
      <FxLayer events={fx} />

      {isMyHumanTurn && wizardStep === 'command' && (
        <CommandDashboard
          state={state}
          actorId={actorId}
          leaderSrc={leaderArt(state, actorId)}
          deadline={purchaseDeadline}
          othersPending={
            isOnline ? waitingHumans.filter((id) => id !== actorId).length : null
          }
          rivals={enemyIds}
          rivalArt={(id) => leaderArt(state, id)}
          onOrder={applyOrder}
          onProceed={() => advanceAfter(stateRef.current, 'command')}
        />
      )}

      {isMyHumanTurn && wizardStep === 'strike' && (
        <div className="turn-wizard turn-wizard--dock" role="dialog" aria-modal="true">
          <div className="turn-wizard__panel turn-wizard__panel--strike enter-pop">
            <WizardNationHeader
              state={state}
              nationId={actorId}
              money={turn.money}
              bombs={warheadCap}
              drones={turn.drones}
              idleSecondsLeft={isOnline ? idleSecondsLeft : null}
              compact
            />
            <div className="turn-wizard__hero turn-wizard__hero--strike">
              <img src={craftArt(strikeWeapon)} alt="" draggable={false} />
            </div>
            <h3 className="turn-wizard__q">Hit enemy cities with your warheads?</h3>
            <p className="turn-wizard__hint">
              Pick a warhead type, then tap up to {warheadCap} enem
              {warheadCap === 1 ? 'y city' : 'y cities'}
              {targets.length > 0 ? ` · selected ${targets.length}/${warheadCap}` : ''}.
              Strikes launch with everyone else at round end.
              {!turn.hasSpyNetwork &&
                ' You have no eyes on their cities: a shield you cannot see will eat the warhead, and a bunker will break a nuclear or magnetic shot. Hydrogen cracks bunkers. Magnetic kills lasers so drones can get through.'}
            </p>
            <div className="warhead-picker" role="group" aria-label="Warhead type">
              {(
                [
                  ['nuke', 'Nuclear', turn.bombs, ART.missile],
                  ['hydrogen', 'Hydrogen', turn.hydrogenBombs ?? 0, ART.missileHydrogen],
                  ['magnetic', 'Magnetic', turn.magneticBombs ?? 0, ART.missileMagnetic],
                ] as const
              ).map(([kind, label, stock, art]) => {
                const used = targets.filter((t) => t.weapon === kind).length;
                return (
                  <button
                    key={kind}
                    type="button"
                    className={`btn warhead-picker__btn${strikeWeapon === kind ? ' btn--primary' : ''}`}
                    disabled={stock < 1}
                    onClick={() => setStrikeWeapon(kind)}
                  >
                    <img src={art} alt="" draggable={false} />
                    <span>
                      {label}
                      <small>
                        {used}/{stock}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
            {targets.length > 0 && (
              <p className="target-label">
                {targets
                  .map((t) => {
                    const name =
                      state.nations[t.nationId]?.cities.find((c) => c.id === t.cityId)?.name ??
                      t.cityId;
                    const tag =
                      t.weapon === 'hydrogen' ? 'H' : t.weapon === 'magnetic' ? 'M' : 'N';
                    return `${name} (${tag})`;
                  })
                  .join(' · ')}
              </p>
            )}
            {(targets.length < warheadCap || warheadsConfirming) && (
              <div className="turn-wizard__actions">
                <button
                  className="btn btn--xl btn--danger"
                  disabled={targets.length < 1}
                  onClick={() => finishStrikeStep(targets)}
                >
                  {warheadsConfirming && targetConfirmLeft != null
                    ? `Lock Targets (${targetConfirmLeft}s)`
                    : `Lock Targets (${targets.length})`}
                </button>
                {!warheadsConfirming && (
                  <button className="btn btn--xl" onClick={() => finishStrikeStep([])}>
                    Skip / No Strike
                  </button>
                )}
              </div>
            )}
            <BackToCommand deadline={purchaseDeadline} onBack={() => setWizardStep('command')} />
          </div>
        </div>
      )}

      {droneSelectMode && (
        <div className="turn-wizard turn-wizard--dock" role="dialog" aria-modal="true">
          <div className="turn-wizard__panel turn-wizard__panel--strike enter-pop">
            <WizardNationHeader
              state={state}
              nationId={actorId}
              money={turn.money}
              bombs={turn.bombs}
              drones={turn.drones}
              idleSecondsLeft={isOnline ? idleSecondsLeft : null}
              compact
            />
            <div className="turn-wizard__hero turn-wizard__hero--droneStrike">
              <img src={ART.drone} alt="" draggable={false} />
            </div>
            <h3 className="turn-wizard__q">Send your drone swarms?</h3>
            <p className="turn-wizard__hint">
              Tap up to {turn.drones} enemy cit{turn.drones === 1 ? 'y' : 'ies'}
              {droneTargets.length > 0 ? ` · selected ${droneTargets.length}/${turn.drones}` : ''}.
              Each pack costs that nation ${DRONE_DAMAGE}M in damages, or
              {` $${DRONE_DAMAGE / 2}M`} if the city has a shield or bunker. Laser
              batteries shoot swarms down for nothing. Swarm a city you also
              bombed and its shield is too busy to stop the warhead — the city
              falls, so there is no repair bill to collect.
              {' '}
              A swarm that gets through also reports what it flew over: that city's
              defences stay on your map for the rest of the war.
              {!turn.hasSpyNetwork &&
                ' Until then you cannot see which nations have a laser network to burn the swarm first.'}
            </p>
            {droneTargets.length > 0 && (
              <p className="target-label">
                {droneTargets
                  .map((t) => {
                    const name =
                      state.nations[t.nationId]?.cities.find((c) => c.id === t.cityId)?.name ??
                      t.cityId;
                    const paired = targets.some((b) => b.cityId === t.cityId);
                    return paired ? `${name} (+ bomb)` : name;
                  })
                  .join(' · ')}
              </p>
            )}
            {(droneTargets.length < turn.drones || dronesConfirming) && (
              <div className="turn-wizard__actions">
                <button
                  className="btn btn--xl btn--danger"
                  disabled={droneTargets.length < 1}
                  onClick={() => closeHumanTurn(targets, droneTargets)}
                >
                  {dronesConfirming && targetConfirmLeft != null
                    ? `Send Drones (${targetConfirmLeft}s)`
                    : `Send Drones (${droneTargets.length})`}
                </button>
                {!dronesConfirming && (
                  <button className="btn btn--xl" onClick={() => closeHumanTurn(targets, [])}>
                    Skip / Hold Drones
                  </button>
                )}
              </div>
            )}
            <BackToCommand deadline={purchaseDeadline} onBack={() => setWizardStep('command')} />
          </div>
        </div>
      )}

      <div className="board-split">
        <section className="board-left">
          <header className="board-left__hud">
            <div className="round-pill">
              ROUND {state.round}/{state.maxRounds}
            </div>
            <ResourceBar
              money={turn.money}
              bombs={turn.bombs}
              drones={turn.drones}
              shields={shieldsLeft(state, actorId)}
            />
          </header>

          <h3 className="board-section-title">
            {isOnline
              ? 'You'
              : isHumanTurn
                ? `${playerDisplayName(state, actorId)}`
                : 'Players'}
          </h3>

          <div className="board-left__controls">
            {isHumanTurn && (
              <div className="panel panel--shop enter-pop">
                <div className="modal__head">
                  <img
                    className="modal__leader"
                    src={leaderArt(state, actorId)}
                    alt=""
                    title={
                      turn.hasSpyNetwork
                        ? 'Spy service — enemy city defences are visible to you'
                        : undefined
                    }
                  />
                  <div>
                    <h2>
                      {playerDisplayName(state, actorId).toUpperCase()}
                    </h2>
                    {inboundSanctions.length > 0 && (
                      <p className="sanctioned-by">
                        Sanctioned by:{' '}
                        {inboundSanctions.map((id) => nationDef(id).name).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>

                <div className="board-left__your-cities" aria-label="Your cities">
                  {allyIds.map((id) => (
                    <NationPod
                      key={id}
                      id={id}
                      variant="ally"
                      state={state}
                      selectedCityIds={selectedCityIds}
                      pendingBombCityIds={pendingBombCityIds}
                      highlight={id === actorId}
                      revealed
                    />
                  ))}
                </div>

                {isOnline && !isMyHumanTurn && waitingHumans.length > 0 && (
                  <p className="upgrade-hint">
                    Waiting for{' '}
                    {waitingHumans.map((id) => playerDisplayName(state, id)).join(', ')}
                    …
                    {state.aiPlanningComplete ? ' AI orders are locked in.' : ''}
                  </p>
                )}
                {isOnline && !isMyHumanTurn && waitingHumans.length === 0 && (
                  <p className="upgrade-hint">Resolving the round for everyone…</p>
                )}
                {isOnline && isMyHumanTurn && (
                  <p className="upgrade-hint">
                    Everyone plans at once · strikes resolve together when the round ends
                  </p>
                )}
                {!isOnline && isMyHumanTurn && (
                  <p className="upgrade-hint">
                    Answer each prompt · strikes resolve together when the round ends
                  </p>
                )}
              </div>
            )}

            {!isHumanTurn && (
              <div className="board-left__nations">
                {allyIds.map((id) => (
                  <NationPod
                    key={id}
                    id={id}
                    variant="ally"
                    state={state}
                    selectedCityIds={selectedCityIds}
                    pendingBombCityIds={pendingBombCityIds}
                    highlight={id === actorId}
                    revealed
                  />
                ))}
              </div>
            )}

            {isSpectator && mySeatId && (state.phase === 'buy' || state.phase === 'action') && (
              <div className="panel panel--ai enter-pop">
                <img src={leaderArt(state, mySeatId)} alt="" />
                <h2>{nationDef(mySeatId).name} is in ruins</h2>
                <p>
                  You are out of the fight, but your score stands — watch the rest of the
                  match and the final results.
                </p>
                <div className="thinking-bar" />
              </div>
            )}

            {!isHumanTurn && !isSpectator && (state.phase === 'buy' || state.phase === 'action') && (
              <div className="panel panel--ai enter-pop">
                <img src={leaderArt(state, turnId)} alt="" />
                <h2>{nationDef(turnId).leader} is acting…</h2>
                <p>
                  {nationDef(turnId).name} · Cities {citiesLeft(state, turnId)}/3 · Bombs{' '}
                  {state.nations[turnId].bombs}
                </p>
                <div className="thinking-bar" />
              </div>
            )}

            {isResolving && (
              <div className="panel panel--ai enter-pop">
                <h2>Simultaneous strikes</h2>
                <p>All locked targets resolve together — fair for everyone.</p>
                <div className="thinking-bar" />
              </div>
            )}
          </div>
        </section>

        <section className="board-right">
          <h3 className="board-section-title">
            {strikeSelectMode
              ? `Enemies — tap up to ${droneSelectMode ? turn.drones : warheadCap} cities`
              : isOnline
                ? 'Everyone else'
                : isHumanTurn
                  ? 'Enemies'
                  : 'Opposing nations'}
          </h3>
          <div className="board-right__nations">
            {enemyIds.map((id) => (
              <NationPod
                key={id}
                id={id}
                variant="enemy"
                state={state}
                viewerId={enemyViewerId}
                revealed={enemiesRevealed}
                selectedCityIds={selectedCityIds}
                targetable={strikeSelectMode}
                blockedCityIds={
                  droneSelectMode ? turn.citiesDronedThisRound : turn.citiesStruckThisRound
                }
                pendingBombCityIds={pendingBombCityIds}
                pendingDroneCityIds={pendingDroneCityIds}
                selectionWeapon={droneSelectMode ? 'drone' : strikeWeapon}
                cityWeapons={cityWeapons}
                highlight={id === actorId}
                rank={enemyRank.get(id)}
                onSelectCity={strikeSelectMode ? onSelectCity : undefined}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function RoundSummary({
  state,
  onContinue,
  sessionUid,
}: {
  state: GameState;
  onContinue: () => void;
  sessionUid?: string | null;
}) {
  const overtimeLeaders = state.round >= state.maxRounds ? tiedForTheLead(state) : [];
  const goingToOvertime = needsOvertime(state) && overtimeLeaders.length > 1;
  const isFinal = state.round >= state.maxRounds && !goingToOvertime;
  // The last board is on screen only after the launch cinema, so it gets its own
  // fixed hold before the superpower reveal — not whatever is left on the shared clock.
  const finalDeadlineRef = useRef<number | null>(null);
  if (isFinal && finalDeadlineRef.current == null) {
    finalDeadlineRef.current = Date.now() + AFTERMATH_THINK_MS;
  }
  const endsAt = isFinal ? finalDeadlineRef.current : (state.aftermathEndsAt ?? null);
  const [secondsLeft, setSecondsLeft] = useState(() =>
    endsAt == null ? null : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)),
  );
  const continueOnceRef = useRef(false);

  // The commander dashboard is the round summary. This board only stays up
  // for the last round, on the way to the final results.
  const skipBoard = !isFinal && endsAt != null;

  useEffect(() => {
    continueOnceRef.current = false;
    if (skipBoard) {
      continueOnceRef.current = true;
      onContinue();
      return;
    }
    if (endsAt == null) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left > 0 || continueOnceRef.current) return;
      continueOnceRef.current = true;
      onContinue();
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [state.round, endsAt, onContinue, skipBoard]);

  // A city raised again in the same round is standing, so don't flag it as a ruin
  const rebuiltCityIds = new Set(
    state.roundEvents.filter((e) => e.kind === 'cityRebuilt').map((e) => e.cityId),
  );
  const destroyedCityIds = state.roundEvents
    .filter(
      (e) =>
        e.kind === 'cityDestroyed' ||
        e.kind === 'shieldDestroyed' ||
        e.kind === 'strikeAbsorbed',
    )
    .map((e) => e.cityId)
    .filter((id): id is string => Boolean(id) && !rebuiltCityIds.has(id));
  const isOnline = state.mode === 'online';
  const myNationId =
    isOnline && sessionUid && state.uidToNation?.[sessionUid]
      ? state.uidToNation[sessionUid]
      : null;
  const myCityIds = aftermathMyCityIds(
    state.turnOrder,
    (id) => Boolean(state.nations[id as NationId]?.isHuman),
    myNationId,
  ) as NationId[];
  const worldIds = rankNationIds(
    state,
    aftermathWorldIds(state.turnOrder, myCityIds) as NationId[],
  );
  const worldRank = new Map(worldIds.map((id, i) => [id, i + 1]));
  const isYouNation = (id: NationId) =>
    myNationId ? id === myNationId : Boolean(state.nations[id].isHuman);
  const worldRevealed = myCityIds.some((id) => state.nations[id].hasSpyNetwork);
  const myLedger = state.lastIncomeLedger.filter((e) => myCityIds.includes(e.nationId));
  const myCombat = combatLedger(state, myCityIds);

  if (skipBoard) return null;

  return (
    <div className="screen screen--board screen--round-report">
      <MapBackdrop />
      <div className="aftermath-countdown" role="status" aria-live="polite">
        {secondsLeft == null
          ? 'Waiting for strike reports…'
          : isFinal
            ? `Final results in ${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'}`
            : `Next round starts in ${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'}`}
        <span className="aftermath-countdown__hint">
          {secondsLeft == null
            ? 'Strategy timer starts when everyone finishes the launch sequence'
            : goingToOvertime
              ? `${overtimeLeaders.map((id) => nationDef(id).name).join(' and ')} finish level — round ${state.round + 1} decides the superpower`
              : 'Use this time to plan your strategy'}
        </span>
        {(state.angelNationId || state.evilNationId) && (
          <span className="aftermath-countdown__reputation">
            {state.angelNationId && (
              <>Angel of peace: {nationDef(state.angelNationId).name}</>
            )}
            {state.angelNationId && state.evilNationId ? ' · ' : null}
            {state.evilNationId && (
              <>International aggressor: {nationDef(state.evilNationId).name}</>
            )}
          </span>
        )}
      </div>
      <div className="board-split round-report__split">
        <section className="board-left round-report__main">
          <header className="board-left__hud">
            <div className="round-pill">ROUND {state.round} AFTERMATH</div>
          </header>

          <div className="board-left__controls">
            <div className="panel panel--shop round-report__panel">
              <CombatExchange
                received={myCombat.received}
                spent={myCombat.spent}
                caused={myCombat.caused}
              />

              <h2 className="round-report__panel-title">Scores</h2>
              <div className="score-cards score-cards--compact">
                {state.roundScores.map((row, i) => {
                  const nation = state.nations[row.nationId];
                  const isYou = isYouNation(row.nationId);
                  const isLead =
                    !row.eliminated && state.roundScores.findIndex((s) => !s.eliminated) === i;
                  return (
                    <div
                      key={row.nationId}
                      className={`score-card ${row.eliminated ? 'is-out' : ''} ${isLead ? 'is-lead' : ''} ${isYou ? 'is-you' : ''}`}
                    >
                      <img src={leaderArt(state, row.nationId)} alt="" />
                      <div>
                        <strong>
                          {row.eliminated ? 'OUT' : `#${i + 1}`} {nationDef(row.nationId).name}
                          {isYou ? ' · You' : nation.isHuman ? ' · Player' : ''}
                        </strong>
                        {(state.angelNationId === row.nationId ||
                          state.evilNationId === row.nationId) && (
                          <span className="stance-badges">
                            {state.angelNationId === row.nationId && (
                              <span className="stance-mark stance-mark--peace" title="Most peaceful this round">
                                <span aria-hidden>☮</span>
                                Peace
                              </span>
                            )}
                            {state.evilNationId === row.nationId && (
                              <span className="stance-mark stance-mark--evil" title="Aggressor this round">
                                <span aria-hidden>☠</span>
                                Evil
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <em>{row.total}</em>
                    </div>
                  );
                })}
              </div>

              {myLedger.length > 0 && (
                <>
                  <h2 className="round-report__panel-title">Treasury</h2>
                  <div className="income-ledger">
                    {myLedger.map((e) => (
                      <div key={e.nationId} className="income-ledger__row">
                        <strong>
                          ${formatMoney(state.nations[e.nationId].money)}
                        </strong>
                        <span>
                          +${formatMoney(e.revenue)} income
                          {(e.droneDamage ?? 0) > 0
                            ? ` · −$${formatMoney(e.droneDamage ?? 0)} repairs`
                            : ''}
                          {e.sanctioners.length > 0
                            ? ` · −${Math.round(e.sanctionPenalty * 100)}% sanctions`
                            : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <h2 className="round-report__panel-title">Your cities</h2>
              <div className="your-cities">
                {myCityIds.map((id) => (
                  <NationPod
                    key={id}
                    id={id}
                    variant="ally"
                    state={state}
                    revealed
                    highlightCityIds={destroyedCityIds}
                    highlight={state.nations[id].eliminated}
                  />
                ))}
              </div>

              <div className="round-report__world-mobile">
                <h2 className="round-report__panel-title">
                  {worldRevealed ? 'World' : 'World — standing'}
                </h2>
                <div className="round-report__world-list">
                  {worldIds.map((id) => (
                    <NationPod
                      key={id}
                      id={id}
                      variant="enemy"
                      state={state}
                      revealed={worldRevealed}
                      viewerId={myCityIds[0] ?? null}
                      highlightCityIds={destroyedCityIds}
                      highlight={state.nations[id].eliminated}
                      rank={worldRank.get(id)}
                    />
                  ))}
                </div>
              </div>

              <div className="round-report__actions">
                <p className="round-report__auto-hint">
                  {isFinal
                    ? `Final results in ${secondsLeft}s…`
                    : `Round ${state.round + 1} in ${secondsLeft}s`}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="board-right round-report__world-desktop">
          <h3 className="board-section-title">
            {worldRevealed ? 'World' : 'World — standing'}
          </h3>
          <div className="board-right__nations">
            {worldIds.map((id) => (
              <NationPod
                key={id}
                id={id}
                variant="enemy"
                state={state}
                revealed={worldRevealed}
                viewerId={myCityIds[0] ?? null}
                highlightCityIds={destroyedCityIds}
                highlight={state.nations[id].eliminated}
                rank={worldRank.get(id)}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function GameOver({
  state,
  sessionUid,
  displayName,
  onRestart,
  onRematch,
  rematchBusy,
  rematchError,
  onLeaderboard,
}: {
  state: GameState;
  sessionUid?: string | null;
  displayName?: string;
  onRestart: () => void;
  onRematch?: () => void;
  rematchBusy?: boolean;
  rematchError?: string | null;
  onLeaderboard?: () => void;
}) {
  const winnerName = state.winner ? nationDef(state.winner).name : 'No one';
  const creditedRef = useRef(false);
  const isOnline = state.mode === 'online';
  const commanderName = formatPlayerLabel(displayName ?? '');
  const summaryState =
    state.mode === 'single' && !state.playerNames[1]
      ? { ...state, playerNames: { ...state.playerNames, 1: commanderName } }
      : state;
  const isHost = Boolean(sessionUid && state.onlineHostUid === sessionUid);
  /** Older matches may lack onlineHostUid — allow attempt; server enforces host. */
  const canStartRematch = isOnline && Boolean(sessionUid) && (isHost || !state.onlineHostUid);
  const winnerPlayer =
    summaryState.winner && summaryState.nations[summaryState.winner]?.isHuman
      ? playerDisplayName(summaryState, summaryState.winner)
      : null;

  useEffect(() => {
    if (creditedRef.current) return;
    if (!sessionUid || !displayName) return;
    if (!state.winner) return;
    const w = state.nations[state.winner];
    if (!w?.isHuman) return;
    const isMe =
      w.ownerUid === sessionUid ||
      (state.mode !== 'online' &&
        (state.playerNames[w.playerSlot ?? -1] === displayName ||
          (state.mode === 'single' && w.playerSlot === 1)));
    if (!isMe) return;
    creditedRef.current = true;
    void incrementSuperpowerWin(sessionUid, formatPlayerLabel(displayName, sessionUid));
  }, [state, sessionUid, displayName]);

  const ranked =
    state.roundScores.length > 0
      ? state.roundScores
      : state.turnOrder.map((id) => computeScore(state, id));
  const myNationId =
    sessionUid && state.uidToNation?.[sessionUid]
      ? state.uidToNation[sessionUid]
      : !isOnline
        ? state.turnOrder.find(
            (id) => state.nations[id].isHuman && state.nations[id].playerSlot === 1,
          )
        : null;

  const ranking = (
    <div className="board-right__nations game-over-ranking">
      {ranked.map((row, i) => {
        const isYou = row.nationId === myNationId;
        return (
          <NationPod
            key={row.nationId}
            id={row.nationId}
            variant={isYou ? 'ally' : 'enemy'}
            state={summaryState}
            revealed
            rank={i + 1}
            highlight={summaryState.winner === row.nationId}
          />
        );
      })}
    </div>
  );

  const actions = (
    <div className="game-over-actions">
      {isOnline ? (
        <>
          {canStartRematch ? (
            <button className="btn btn--primary" type="button" disabled={rematchBusy} onClick={() => onRematch?.()}>
              {rematchBusy ? 'Starting…' : 'Play Again'}
            </button>
          ) : (
            <p className="round-report__auto-hint">
              Waiting for host to start Play Again…
            </p>
          )}
          <button className="btn" type="button" onClick={onRestart}>
            Leave
          </button>
        </>
      ) : (
        <button className="btn btn--primary" type="button" onClick={onRestart}>
          Play Again
        </button>
      )}
      {onLeaderboard && (
        <button className="btn" type="button" onClick={onLeaderboard}>
          Leaderboard
        </button>
      )}
    </div>
  );

  return (
    <div className="screen screen--board screen--round-report screen--game-over">
      <OutcomeTheme victory={localPlayerIsSuperpower(state, sessionUid)} />
      {state.winner ? (
        <div
          className="flag-backdrop"
          style={{
            ['--flag-color' as string]: nationDef(state.winner).color,
            backgroundImage: `url(${ART.flags[state.winner]})`,
          }}
          aria-hidden
        />
      ) : (
        <MapBackdrop />
      )}
      <div className="splash-veil splash-veil--flag" />
      <div className="game-over-layout game-over-layout--pods">
        <header className="game-over-hero enter-pop">
          {state.winner && (
            <img className="winner-art" src={ART.leadersSuper[state.winner]} alt="" />
          )}
          <div>
            <h1 className="stencil-title">SUPERPOWER</h1>
            <p className="tagline">
              {winnerPlayer
                ? `${winnerName} — ${winnerPlayer} dominated the world.`
                : `${winnerName} dominated the world.`}
            </p>
          </div>
        </header>

        <section className="game-over-ranking-panel" aria-label="Final ranking">
          <h2 className="board-section-title">Final ranking</h2>
          {ranking}
        </section>

        {actions}
        {rematchError && <p className="session-error">{rematchError}</p>}
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<GameState>(() => createInitialState());
  const [sessionUid, setSessionUid] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(getStoredDisplayName() ?? '');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const advancePastAi = useCallback((s: GameState) => runAllAiUntilHumanOrSummary(s), []);
  const appStateRef = useRef(state);
  appStateRef.current = state;
  const lastRoundBannerRef = useRef(0);
  const [roundIntro, setRoundIntro] = useState<{
    round: number;
    briefing: RoundBriefing | null;
  } | null>(null);
  const [dropoutNotice, setDropoutNotice] = useState<{
    playerName: string;
    nationName: string;
    seq: number;
  } | null>(null);
  const lastDropoutSeqRef = useRef(0);
  const [rematchBusy, setRematchBusy] = useState(false);
  const [rematchError, setRematchError] = useState<string | null>(null);
  /** Owes the last round its strike cinema — hides everything that would skip past it. */
  const strikeJob = useStrikeJob(state);
  const strikeTheaterBusy = strikeJob.pending;

  const advanceFromRoundSummary = useCallback(() => {
    const current = appStateRef.current;
    if (current.phase !== 'roundSummary') return;

    if (current.mode === 'online' && current.onlineGameId) {
      const gameId = current.onlineGameId;
      const fromRound = current.round;
      // Do not nextRound locally — publish the clock event and wait for the listener.
      void (async () => {
        try {
          const remote = await advanceOnlineRound(gameId, fromRound);
          if (!remote) return;
          if (remote.phase === 'gameOver') {
            void finishOnlineGame(gameId, remote, sessionUid ?? undefined);
          }
          setState((cur) => {
            if (cur.onlineGameId !== gameId) return cur;
            const myId =
              sessionUid && cur.uidToNation?.[sessionUid]
                ? cur.uidToNation[sessionUid]
                : null;
            return applyPublishedGame(cur, remote, myId, {
              seq: 0,
              kind: remote.phase === 'gameOver' ? 'gameOver' : 'roundStart',
              round: remote.round,
              publishedAt: Date.now(),
            });
          });
        } catch (err) {
          console.error('advance after aftermath failed', err);
        }
      })();
      return;
    }

    const n = nextRound(current);
    setState((cur) => {
      if (cur.phase !== 'roundSummary') return cur;
      if (n.phase === 'gameOver') return n;
      return advancePastAi(n);
    });
  }, [advancePastAi, sessionUid]);

  // Round start overlay: Round X, then personal attacks / sanctions / treasury
  useEffect(() => {
    const preGame =
      state.phase === 'session' ||
      state.phase === 'mode' ||
      state.phase === 'names' ||
      state.phase === 'lobby' ||
      state.phase === 'country' ||
      state.phase === 'gameOver';
    if (preGame) {
      if (state.phase === 'gameOver' || state.phase === 'mode' || state.phase === 'lobby') {
        lastRoundBannerRef.current = 0;
      }
      return;
    }
    if (state.phase !== 'buy' && state.phase !== 'action' && state.phase !== 'income') return;
    if (lastRoundBannerRef.current === state.round) return;
    lastRoundBannerRef.current = state.round;
    const myId =
      state.mode === 'online' && sessionUid && state.uidToNation?.[sessionUid]
        ? state.uidToNation[sessionUid]
        : state.humanNations[0] ?? null;
    setRoundIntro({ round: state.round, briefing: buildRoundBriefing(state, myId ?? null) });
  }, [state, sessionUid]);

  const dismissRoundStart = useCallback(() => setRoundIntro(null), []);
  const dismissDropout = useCallback(() => setDropoutNotice(null), []);

  const notePublishedDropout = useCallback(
    (sync: GameSyncEvent | undefined, myId: NationId | null) => {
      if (sync?.kind !== 'dropout' || !sync.seq) return;
      if (sync.seq <= lastDropoutSeqRef.current) return;
      lastDropoutSeqRef.current = sync.seq;
      if (sync.nationId && myId && sync.nationId === myId) return;
      setDropoutNotice({
        playerName: sync.playerName || 'A player',
        nationName: sync.nationName || (sync.nationId ? nationDef(sync.nationId).name : 'Their nation'),
        seq: sync.seq,
      });
    },
    [],
  );

  // Online game listener — preserve local nation while still planning
  useEffect(() => {
    if (!state.onlineGameId || state.mode !== 'online') return;
    lastDropoutSeqRef.current = 0;
    const gameId = state.onlineGameId;
    let joiningRematch = false;
    return listenGame(gameId, (game) => {
      if (!game) return;
      if (game.rematchGameId && game.rematchGameId !== gameId && !joiningRematch) {
        joiningRematch = true;
        const nextId = game.rematchGameId;
        void (async () => {
          try {
            const next = await fetchGame(nextId);
            if (!next?.state) {
              joiningRematch = false;
              return;
            }
            if (sessionUid) await setPlayerStatus(sessionUid, 'in_game', nextId);
            setState({
              ...next.state,
              onlineGameId: nextId,
              onlineLobbyId: next.lobbyId ?? next.state.onlineLobbyId ?? null,
              onlineHostUid: next.hostUid,
            });
          } catch {
            joiningRematch = false;
          }
        })();
        return;
      }
      if (!game.state) return;
      const myIdNow =
        sessionUid && appStateRef.current.uidToNation?.[sessionUid]
          ? appStateRef.current.uidToNation[sessionUid]
          : null;
      notePublishedDropout(game.sync, myIdNow ?? null);
      setState((prev) => {
        const myId =
          sessionUid && prev.uidToNation?.[sessionUid]
            ? prev.uidToNation[sessionUid]
            : null;
        const merged = applyPublishedGame(prev, game.state, myId, game.sync);
        return {
          ...merged,
          onlineHostUid: game.hostUid ?? merged.onlineHostUid ?? null,
          onlineLobbyId: game.lobbyId ?? merged.onlineLobbyId ?? null,
        };
      });
    });
    // Intentionally omit uidToNation — resolve myId from prev inside the callback
    // so we don't tear down the listener on every nation merge.
  }, [state.onlineGameId, state.mode, sessionUid, notePublishedDropout]);

  // Safety net: if a snapshot is missed, pull shared state so nobody sits on a dead board
  useEffect(() => {
    if (state.mode !== 'online' || !state.onlineGameId) return;
    if (
      state.phase !== 'buy' &&
      state.phase !== 'action' &&
      state.phase !== 'resolveStrikes' &&
      state.phase !== 'roundSummary'
    ) {
      return;
    }
    const gameId = state.onlineGameId;
    let cancelled = false;
    const pull = async () => {
      if (cancelled) return;
      try {
        const doc = await fetchGame(gameId);
        if (!doc?.state || cancelled) return;
        const myIdNow =
          sessionUid && appStateRef.current.uidToNation?.[sessionUid]
            ? appStateRef.current.uidToNation[sessionUid]
            : null;
        notePublishedDropout(doc.sync, myIdNow ?? null);
        setState((prev) => {
          if (prev.onlineGameId !== gameId) return prev;
          const myId =
            sessionUid && prev.uidToNation?.[sessionUid]
              ? prev.uidToNation[sessionUid]
              : null;
          const merged = applyPublishedGame(prev, doc.state, myId, doc.sync);
          const readyKey = (r?: Partial<Record<NationId, boolean>>) =>
            Object.keys(r ?? {})
              .sort()
              .map((k) => `${k}:${r?.[k as NationId] ? 1 : 0}`)
              .join(',');
          const seatsKey = (s: GameState) =>
            s.turnOrder
              .map((id) => {
                const n = s.nations[id];
                return `${id}:${n.isHuman ? 1 : 0}:${n.eliminated ? 1 : 0}`;
              })
              .join(',');
          if (
            merged.round === prev.round &&
            merged.phase === prev.phase &&
            merged.planningComplete === prev.planningComplete &&
            merged.aftermathEndsAt === prev.aftermathEndsAt &&
            readyKey(merged.humanReady) === readyKey(prev.humanReady) &&
            seatsKey(merged) === seatsKey(prev)
          ) {
            return prev;
          }
          return {
            ...merged,
            onlineHostUid: doc.hostUid ?? merged.onlineHostUid ?? null,
            onlineLobbyId: doc.lobbyId ?? merged.onlineLobbyId ?? null,
          };
        });
      } catch {
        /* next tick */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 1500);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pull();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [
    state.mode,
    state.onlineGameId,
    state.phase,
    state.round,
    sessionUid,
    notePublishedDropout,
  ]);

  // If nobody armed the aftermath timer (cinema holder dropped), arm it so the table can move
  useEffect(() => {
    if (state.phase !== 'roundSummary') return;
    if (state.aftermathEndsAt != null) return;
    const gameId = state.onlineGameId;
    const round = state.round;
    const t = window.setTimeout(() => {
      setState((cur) => {
        if (cur.phase !== 'roundSummary' || cur.round !== round) return cur;
        if (cur.aftermathEndsAt != null) return cur;
        const next = armAftermathTimer(cur);
        if (cur.mode === 'online' && gameId) {
          void publishSharedPhase(gameId, next, 'aftermath').catch(() => undefined);
        }
        return next;
      });
    }, 12_000);
    return () => window.clearTimeout(t);
  }, [state.phase, state.aftermathEndsAt, state.round, state.onlineGameId]);

  const completeSession = async (name: string) => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      if (!isFirebaseConfigured()) {
        setDisplayName(name);
        setState((s) => ({ ...s, phase: 'mode' }));
        return;
      }
      const user = await ensureAuthSession();
      if (!user) throw new Error('Could not sign in');
      await loadOrCreatePlayer(user.uid, name);
      setSessionUid(user.uid);
      setDisplayName(name);
      setState((s) => ({ ...s, phase: 'mode' }));
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : 'Session failed');
    } finally {
      setSessionLoading(false);
    }
  };

  const onResetIdentity = async () => {
    setSessionLoading(true);
    setSessionError(null);
    try {
      const user = await resetPlayerIdentity();
      if (!user) throw new Error('Could not reset identity');
      setSessionUid(user.uid);
      setDisplayName('');
      setState(createInitialState());
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : 'Could not reset identity');
    } finally {
      setSessionLoading(false);
    }
  };

  useEffect(() => {
    if (state.phase !== 'session') return;
    if (!isFirebaseConfigured()) return;
    let cancelled = false;
    void (async () => {
      try {
        const user = await ensureAuthSession();
        if (cancelled || !user) return;
        setSessionUid(user.uid);
        // Always stay on the name gate so the player can confirm or change their name
      } catch {
        /* stay on name gate */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.phase]);

  if (showLeaderboard) {
    return (
      <div className="app-shell">
        <LeaderboardScreen onBack={() => setShowLeaderboard(false)} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TitleTheme
        active={
          state.phase === 'session' || state.phase === 'mode' || state.phase === 'names'
        }
      />
      {roundIntro &&
        !strikeTheaterBusy &&
        (roundIntro.briefing ? (
          <RoundBriefingOverlay
            key={`brief-${roundIntro.round}`}
            state={state}
            briefing={roundIntro.briefing}
            onDone={dismissRoundStart}
          />
        ) : (
          <RoundBannerOverlay
            key={`round-${roundIntro.round}`}
            round={roundIntro.round}
            onDone={dismissRoundStart}
          />
        ))}
      {dropoutNotice && (
        <DropoutOverlay
          key={`drop-${dropoutNotice.seq}`}
          playerName={dropoutNotice.playerName}
          nationName={dropoutNotice.nationName}
          onDone={dismissDropout}
        />
      )}
      {state.phase === 'session' && (
        <NameGate
          initialName={displayName}
          playerUid={sessionUid}
          loading={sessionLoading}
          error={sessionError}
          onSubmit={(n) => void completeSession(n)}
          onResetIdentity={() => void onResetIdentity()}
        />
      )}
      {state.phase === 'mode' && (
        <>
          {sessionError && <p className="session-error kick-banner">{sessionError}</p>}
          <ModeSelect
            onSelect={(m) => {
              setSessionError(null);
              if (m === 'online' && sessionUid) {
                void setPlayerStatus(sessionUid, 'available', null);
              }
              setState((s) => {
                const next = setMode(s, m);
                if (m !== 'single') return next;
                return { ...next, playerNames: { 1: formatPlayerLabel(displayName) } };
              });
            }}
          />
        </>
      )}
      {state.phase === 'names' && (
        <PlayerNames
          onContinue={(n1, n2) => setState((s) => setPlayerNames(s, n1, n2))}
        />
      )}
      {state.phase === 'lobby' && sessionUid && (
        <LobbyScreen
          uid={sessionUid}
          displayName={displayName || 'Commander'}
          onBack={() => setState(createInitialState())}
          onOpenLeaderboard={() => setShowLeaderboard(true)}
          onGameReady={(gameId, gameState) => {
            setState({ ...gameState, onlineGameId: gameId });
          }}
        />
      )}
      {state.phase === 'lobby' && !sessionUid && (
        <NameGate
          initialName={displayName}
          playerUid={sessionUid}
          loading={sessionLoading}
          error={sessionError ?? 'Sign in required for online play'}
          onSubmit={(n) => void completeSession(n)}
          onResetIdentity={() => void onResetIdentity()}
        />
      )}
      {state.phase === 'country' && (
        <CountrySelect
          state={state}
          onPick={(id) =>
            setState((s) => {
              const next = pickCountry(s, id);
              // The last seat picked starts the match; the first hands over
              return next.phase === 'buy' ? advancePastAi(next) : next;
            })
          }
        />
      )}
      {(state.phase === 'buy' ||
        state.phase === 'action' ||
        state.phase === 'income' ||
        state.phase === 'resolveStrikes') && (
        <GameBoard
          state={state}
          setState={setState}
          sessionUid={sessionUid}
          roundBriefingActive={Boolean(roundIntro) || strikeTheaterBusy}
          onKicked={(message) => {
            if (sessionUid) void setPlayerStatus(sessionUid, 'available', null);
            setSessionError(message);
            setState({ ...createInitialState(), phase: 'mode' });
          }}
        />
      )}
      <StrikeTheater
        state={state}
        setState={setState}
        job={strikeJob}
      />
      {state.phase === 'roundSummary' && !strikeTheaterBusy && (
        <RoundSummary
          state={state}
          sessionUid={sessionUid}
          onContinue={advanceFromRoundSummary}
        />
      )}
      {state.phase === 'gameOver' && !strikeTheaterBusy && (
        <GameOver
          state={state}
          sessionUid={sessionUid}
          displayName={displayName}
          rematchBusy={rematchBusy}
          rematchError={rematchError}
          onRematch={() => {
            if (!state.onlineGameId || !sessionUid) return;
            setRematchBusy(true);
            setRematchError(null);
            void rematchOnlineGame(state.onlineGameId, sessionUid)
              .then(async ({ gameId, state: next }) => {
                await setPlayerStatus(sessionUid, 'in_game', gameId);
                setState({
                  ...next,
                  onlineGameId: gameId,
                  onlineLobbyId: next.onlineLobbyId ?? state.onlineLobbyId ?? null,
                  onlineHostUid: next.onlineHostUid ?? sessionUid,
                });
              })
              .catch((e) => {
                setRematchError(e instanceof Error ? e.message : 'Could not start rematch');
              })
              .finally(() => setRematchBusy(false));
          }}
          onRestart={() => {
            if (sessionUid) void setPlayerStatus(sessionUid, 'available', null);
            setRematchError(null);
            setState(createInitialState());
          }}
          onLeaderboard={() => setShowLeaderboard(true)}
        />
      )}
    </div>
  );
}
