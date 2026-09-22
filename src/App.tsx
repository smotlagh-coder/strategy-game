import './App.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ART, SFX } from './data/art';
import {
  NATIONS,
  nationDef,
  COSTS,
  DRONE_DAMAGE,
  MAX_DRONES_PER_ROUND,
  RESEARCH_INCOME,
} from './data/nations';
import { LEADER_SPEECHES, speechFor } from './data/speeches';
import {
  applyQueuedStrike,
  orderStrikesForResolution,
  aliveHumanNations,
  allAliveHumansReady,
  armAftermathTimer,
  isHumanDisconnected,
  buyAerospaceTech,
  buyBombs,
  buyRebuild,
  buyUnderground,
  canBuyRebuild,
  canBuyUnderground,
  droneDamageFor,
  buyDrones,
  buyEnvironment,
  buyNuclearTech,
  buyResearch,
  buyShield,
  createInitialState,
  currentNationId,
  computeScore,
  endTurn,
  finishBuyPhase,
  finishStrikeResolution,
  groupStrikesByAttacker,
  formatMoney,
  markHumanReady,
  markPromptDone,
  maxBombsPurchasable,
  maxDronesPurchasable,
  nextRound,
  pickCountry,
  queueStrikes,
  setMode,
  setPlayerNames,
  playerDisplayName,
  startGame,
  toggleSanction,
  touchHumanActivity,
  citiesLeft,
  shieldsLeft,
  whoIsSanctioning,
} from './game/engine';
import { runAllAiUntilHumanOrSummary, runAiTurn, runOnlineAiPlanning } from './game/ai';
import type {
  GameMode,
  GameState,
  GameSyncEvent,
  NationId,
  PendingStrike,
  RoundWorldEvent,
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
  ROUND_BRIEFING_SLIDE_MS,
  SELECTION_IDLE_MS,
  STRIKE_CINEMA_MS,
} from './lib/onlineConstants';
import { aftermathMyCityIds, aftermathWorldIds } from './lib/lobbyInvite';
import { NameGate } from './screens/NameGate';
import { LobbyScreen } from './screens/Lobby';
import { LeaderboardScreen } from './screens/Leaderboard';

type FxKind = 'buy' | 'strike-label';
type WizardStep =
  | 'tech'
  | 'aerospace'
  | 'researchAsk'
  | 'researchPick'
  | 'bombs'
  | 'drones'
  | 'undergroundAsk'
  | 'undergroundPick'
  | 'rebuildAsk'
  | 'rebuildPick'
  | 'shieldAsk'
  | 'shieldPick'
  | 'env'
  | 'sanctionAsk'
  | 'sanctionPick'
  | 'strike'
  | 'droneStrike';

function wizardArt(step: WizardStep): string {
  switch (step) {
    case 'tech':
      return ART.nukeTech;
    case 'aerospace':
      return ART.aerospaceTech;
    case 'drones':
    case 'droneStrike':
      return ART.drone;
    case 'researchAsk':
    case 'researchPick':
      return ART.researchLab;
    case 'bombs':
    case 'strike':
      return ART.missile;
    case 'undergroundAsk':
    case 'undergroundPick':
      return ART.undergroundCity;
    case 'rebuildAsk':
    case 'rebuildPick':
      return ART.rebuildCity;
    case 'shieldAsk':
    case 'shieldPick':
      return ART.shield;
    case 'env':
      return ART.map;
    case 'sanctionAsk':
    case 'sanctionPick':
      return ART.sanction;
    default:
      return ART.missile;
  }
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

interface StrikeTarget {
  to: NationId;
  cityId: string;
  cityName: string;
  /** A city can catch a warhead and a drone swarm in the same volley */
  weapons: ('nuke' | 'drone')[];
  /** Repair bill per drone pack — halved when the city has a shield or bunker */
  droneBill?: number;
}

/** One attacker's whole volley — every missile flies in the same panel. */
interface StrikeShow {
  from: NationId;
  targets: StrikeTarget[];
}

const STRIKE_FLIGHT_MS = 1750;
const STRIKE_IMPACT_MS = 1300;

function StrikeCinema({
  strike,
  onComplete,
}: {
  strike: StrikeShow;
  onComplete: () => void;
}) {
  const flightRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLImageElement>(null);
  const cityRefs = useRef<(HTMLImageElement | null)[]>([]);
  const missileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);
  const [booms, setBooms] = useState<
    ({ x: number; y: number; weapon: 'nuke' | 'drone' } | null)[]
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
    target.weapons.map((weapon) => ({ targetIndex, weapon })),
  );
  const nukeCount = flightPlan.filter((f) => f.weapon === 'nuke').length;
  const droneCount = flightPlan.length - nukeCount;
  const title =
    nukeCount === 0
      ? droneCount > 1
        ? `DRONE SWARMS — ${droneCount} PACKS`
        : 'DRONE SWARM'
      : droneCount > 0
        ? 'COMBINED STRIKE — DRONES ESCORT THE WARHEADS'
        : count > 1
          ? `NUCLEAR LAUNCH — ${count} MISSILES`
          : 'NUCLEAR LAUNCH';

  const planRef = useRef(flightPlan);
  planRef.current = flightPlan;

  useEffect(() => {
    const plan = planRef.current;
    setBooms([]);
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
      const tick = (now: number) => {
        if (finished) return;
        sawFrame = true;
        const u = Math.min(1, (now - t0) / STRIKE_FLIGHT_MS);
        const t = u * u * (3 - 2 * u);
        const omt = 1 - t;
        for (const arc of arcs) {
          const el = arc.missile!;
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
        }

        if (u < 1) {
          if (!usingTimer) raf = requestAnimationFrame(tick);
        } else {
          window.clearInterval(frameTimer);
          // Whole volley lands together, so one panel covers every target
          const impacts: ({ x: number; y: number; weapon: 'nuke' | 'drone' } | null)[] =
            strikeRef.current.targets.map(() => null);
          for (const arc of arcs) {
            const landed = impacts[arc.targetIndex];
            // A warhead outshines any swarm sharing the same city
            if (landed?.weapon === 'nuke') continue;
            impacts[arc.targetIndex] = { ...arc.p2, weapon: arc.weapon };
          }
          const anyNuke = impacts.some((i) => i?.weapon === 'nuke');
          if (anyNuke) playSfx(SFX.explosion, 0.95);
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
              src={ART.leaders[strike.from]}
              alt=""
            />
            <strong>{from.name}</strong>
            <span>{from.leader}</span>
          </div>

          <div className="strike-cinema__arc" aria-hidden />

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
                return (
                  <div className="strike-cinema__target" key={`${target.to}-${target.cityId}`}>
                    <div
                      className={`strike-cinema__target-art ${
                        booms[i]?.weapon === 'nuke'
                          ? 'is-burning'
                          : booms[i]
                            ? 'is-rattled'
                            : ''
                      }`}
                    >
                      <img
                        ref={(el) => {
                          cityRefs.current[i] = el;
                        }}
                        className="strike-cinema__city"
                        src={ART.cities[target.cityId]}
                        alt=""
                      />
                      <img className="strike-cinema__leader-sm" src={ART.leaders[target.to]} alt="" />
                      {booms[i]?.weapon === 'nuke' && (
                        <span className="strike-cinema__fire" aria-hidden />
                      )}
                      {booms[i]?.weapon === 'drone' && (
                        <span className="strike-cinema__dust" aria-hidden />
                      )}
                    </div>
                    <strong>{to.name}</strong>
                    <span>{target.cityName}</span>
                    {target.weapons.includes('drone') && (
                      <span className="strike-cinema__tag">
                        {target.weapons.includes('nuke')
                          ? 'Shield swarmed'
                          : `−$${target.droneBill ?? DRONE_DAMAGE}M damages`}
                      </span>
                    )}
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
                  className={leg.weapon === 'drone' ? 'is-drone' : undefined}
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
                  leg.weapon === 'drone' ? ' strike-cinema__missile--drone' : ''
                }`}
              >
                <img src={leg.weapon === 'drone' ? ART.drone : ART.missile} alt="" draggable={false} />
                {leg.weapon === 'nuke' && <span className="strike-cinema__flame" />}
              </div>
            ))}
            {booms.map((boom, i) =>
              boom ? (
                <div
                  key={`${strike.targets[i]?.cityId ?? i}-boom`}
                  className={`strike-cinema__boom${
                    boom.weapon === 'drone' ? ' strike-cinema__boom--drone' : ''
                  }`}
                  style={{ left: boom.x, top: boom.y }}
                >
                  {boom.weapon === 'drone' ? (
                    <>
                      <span className="strike-cinema__pop" />
                      {[0, 1, 2, 3, 4, 5].map((n) => (
                        <span key={n} className={`strike-cinema__spark spark-${n}`} />
                      ))}
                    </>
                  ) : (
                    <img src={ART.explosion} alt="" />
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
  if (e.kind === 'cityRebuilt') {
    return e.automatic
      ? `${nation} rebuilt ${e.cityName} with its last $${e.amount ?? COSTS.rebuild}M — the nation survives.`
      : `${nation} rebuilt ${e.cityName} from the rubble.`;
  }
  if (e.kind === 'strikeAbsorbed') {
    return attacker
      ? `${attacker}'s warhead broke against the bunkers under ${e.cityName} (${nation}).`
      : `A warhead broke against the bunkers under ${e.cityName} (${nation}).`;
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

type RoundStartSlide =
  | { kind: 'round'; round: number }
  | { kind: 'attack'; attackers: { id: NationId; cities: string[] }[] }
  | { kind: 'sanction'; from: NationId[] }
  | { kind: 'drones'; attackers: { id: NationId; cities: string[] }[]; bill: number }
  | { kind: 'money'; amount: number; income?: number; droneDamage?: number };

function buildRoundStartSlides(state: GameState, myId: NationId | null): RoundStartSlide[] {
  const slides: RoundStartSlide[] = [{ kind: 'round', round: state.round }];
  if (!myId || state.round < 2) return slides;

  const hits = (state.previousRoundEvents ?? []).filter(
    (e) =>
      e.nationId === myId &&
      (e.kind === 'cityDestroyed' ||
        e.kind === 'shieldDestroyed' ||
        e.kind === 'strikeAbsorbed') &&
      e.attackerId,
  );
  if (hits.length > 0) {
    const byAttacker = new Map<NationId, string[]>();
    for (const h of hits) {
      const attacker = h.attackerId as NationId;
      const cities = byAttacker.get(attacker) ?? [];
      if (h.cityName && !cities.includes(h.cityName)) cities.push(h.cityName);
      byAttacker.set(attacker, cities);
    }
    slides.push({
      kind: 'attack',
      attackers: Array.from(byAttacker.entries()).map(([id, cities]) => ({ id, cities })),
    });
  }

  const swarms = (state.previousRoundEvents ?? []).filter(
    (e) => e.nationId === myId && e.kind === 'droneDamage' && e.attackerId,
  );
  if (swarms.length > 0) {
    const byAttacker = new Map<NationId, string[]>();
    let bill = 0;
    for (const s of swarms) {
      const attacker = s.attackerId as NationId;
      const cities = byAttacker.get(attacker) ?? [];
      if (s.cityName && !cities.includes(s.cityName)) cities.push(s.cityName);
      byAttacker.set(attacker, cities);
      bill += s.amount ?? DRONE_DAMAGE;
    }
    slides.push({
      kind: 'drones',
      attackers: Array.from(byAttacker.entries()).map(([id, cities]) => ({ id, cities })),
      bill: +bill.toFixed(2),
    });
  }

  const from = whoIsSanctioning(state, myId);
  if (from.length > 0) slides.push({ kind: 'sanction', from });

  const ledger = state.lastIncomeLedger.find((e) => e.nationId === myId);
  slides.push({
    kind: 'money',
    amount: state.nations[myId]?.money ?? 0,
    income: ledger?.revenue,
    droneDamage: ledger?.droneDamage,
  });
  return slides;
}

function RoundStartOverlay({
  slides,
  onDone,
}: {
  slides: RoundStartSlide[];
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const slide = slides[index];

  useEffect(() => {
    if (!slide) {
      onDone();
      return;
    }
    const ms = slide.kind === 'round' ? ROUND_BANNER_MS : ROUND_BRIEFING_SLIDE_MS;
    const t = window.setTimeout(() => {
      if (index >= slides.length - 1) onDone();
      else setIndex((i) => i + 1);
    }, ms);
    return () => window.clearTimeout(t);
  }, [index, slide, slides.length, onDone]);

  if (!slide) return null;

  let title = '';
  let body: ReactNode = null;
  let tone = 'round';
  if (slide.kind === 'round') {
    title = `Round ${slide.round}`;
    body = <p className="round-start__hint">Prepare your orders</p>;
    tone = 'round';
  } else if (slide.kind === 'attack') {
    title = 'Incoming strikes';
    tone = 'attack';
    body = (
      <ul className="round-start__list">
        {slide.attackers.map((a) => (
          <li key={a.id} className="round-start__row">
            <img src={ART.leaders[a.id]} alt="" />
            <div>
              <strong>{nationDef(a.id).name}</strong>
              <span>
                targeted your cities
                {a.cities.length ? `: ${a.cities.join(' · ')}` : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (slide.kind === 'drones') {
    title = 'Drone damage';
    tone = 'attack';
    body = (
      <ul className="round-start__list">
        {slide.attackers.map((a) => (
          <li key={a.id} className="round-start__row">
            <img src={ART.leaders[a.id]} alt="" />
            <div>
              <strong>{nationDef(a.id).name}</strong>
              <span>
                swarmed {a.cities.length ? a.cities.join(' · ') : 'your cities'} with drones
              </span>
            </div>
          </li>
        ))}
        <li className="round-start__row round-start__row--note">
          <div>
            <strong>−${formatMoney(slide.bill)}</strong>
            <span>repair bill taken from this round&apos;s treasury</span>
          </div>
        </li>
      </ul>
    );
  } else if (slide.kind === 'sanction') {
    title = 'Sanctions';
    tone = 'sanction';
    body = (
      <ul className="round-start__list">
        {slide.from.map((id) => (
          <li key={id} className="round-start__row">
            <img src={ART.leaders[id]} alt="" />
            <div>
              <strong>{nationDef(id).name}</strong>
              <span>sanctioned you (−10% income)</span>
            </div>
          </li>
        ))}
      </ul>
    );
  } else {
    title = 'Treasury';
    tone = 'money';
    body = (
      <div className="round-start__money">
        <p className="round-start__cash">${formatMoney(slide.amount)}</p>
        <p className="round-start__hint">
          {slide.income != null && slide.income > 0
            ? `Including $${formatMoney(slide.income)} income this round`
            : 'Available for this round'}
          {slide.droneDamage != null && slide.droneDamage > 0
            ? ` · −$${formatMoney(slide.droneDamage)} drone damage`
            : ''}
        </p>
      </div>
    );
  }

  return (
    <div
      className="round-banner round-start"
      role="status"
      aria-live="polite"
      aria-label={title}
    >
      <div className="round-banner__veil" />
      <div
        key={`${slide.kind}-${index}`}
        className={`round-banner__panel round-start__panel round-start__panel--${tone} enter-pop`}
      >
        <p className="round-start__eyebrow">
          {index + 1} / {slides.length}
        </p>
        <h2 className="round-start__title">{title}</h2>
        {body}
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
function StrikeTheater({
  state,
  setState,
  cinemaHoldRef,
}: {
  state: GameState;
  setState: React.Dispatch<React.SetStateAction<GameState>>;
  cinemaHoldRef: React.MutableRefObject<{ round: number; until: number } | null>;
}) {
  const [cinema, setCinema] = useState<StrikeShow | null>(null);
  const [recap, setRecap] = useState<RoundWorldEvent[] | null>(null);
  const cinemaResolveRef = useRef<(() => void) | null>(null);
  const recapResolveRef = useRef<(() => void) | null>(null);
  const playedRoundRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

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

  const phase = state.phase;
  const round = state.round;
  const summaryRound = state.previousRoundNumber;
  const showing = phase === 'roundSummary' || phase === 'gameOver';

  useEffect(() => {
    if (!showing) return;
    if (summaryRound !== round) return;
    if (playedRoundRef.current === round) return;

    let cancelled = false;
    let reportTimer = 0;

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

    const play = async (strikes: PendingStrike[], events: RoundWorldEvent[]) => {
      // Keep a peer that already moved on from cutting our animation short
      const volleyCount = groupStrikesByAttacker(strikes).length;
      const runtimeMs = volleyCount * STRIKE_CINEMA_MS + (events.length > 0 ? RECAP_AUTO_MS : 0);
      cinemaHoldRef.current = { round, until: Date.now() + runtimeMs + 4_000 };

      // A report that arrived late must not be cut off by a clock already ticking
      setState((cur) => {
        if (cur.round !== round || cur.phase !== 'roundSummary') return cur;
        const needUntil = Date.now() + runtimeMs + AFTERMATH_THINK_MS;
        if (cur.aftermathEndsAt == null || cur.aftermathEndsAt >= needUntil) return cur;
        return { ...cur, aftermathEndsAt: needUntil };
      });

      try {
        for (const volley of groupStrikesByAttacker(strikes)) {
          if (cancelled) break;
          const targets: StrikeTarget[] = [];
          for (const strike of volley.strikes) {
            const weapon = strike.weapon === 'drone' ? 'drone' : 'nuke';
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
            targets.push({
              to: strike.targetNationId,
              cityId: strike.cityId,
              cityName: city?.name ?? 'city',
              weapons: [weapon],
              droneBill: city ? droneDamageFor(city) : DRONE_DAMAGE,
            });
          }
          await new Promise<void>((resolve) => {
            cinemaResolveRef.current = resolve;
            setCinema({ from: volley.attackerId, targets });
          });
        }
        if (!cancelled && events.length > 0) {
          await new Promise<void>((resolve) => {
            recapResolveRef.current = resolve;
            setRecap(events);
          });
        }
      } finally {
        cinemaHoldRef.current = null;
      }
      if (!cancelled) armClock();
    };

    /** The strike report can trail the phase change, so wait for it to land. */
    const attempt = (waitedMs: number) => {
      if (cancelled || playedRoundRef.current === round) return;
      const strikes = stateRef.current.resolvedStrikes ?? [];
      const events = stateRef.current.previousRoundEvents ?? [];

      if (strikes.length === 0 && events.length === 0) {
        // Start the countdown so the summary is never stuck waiting on a peer
        armClock();
        if (waitedMs >= REPORT_WAIT_MS) return;
        reportTimer = window.setTimeout(
          () => attempt(waitedMs + REPORT_POLL_MS),
          REPORT_POLL_MS,
        );
        return;
      }

      playedRoundRef.current = round;
      void play(strikes, events);
    };
    attempt(0);

    return () => {
      cancelled = true;
      window.clearTimeout(reportTimer);
      cinemaHoldRef.current = null;
      setCinema(null);
      setRecap(null);
      cinemaResolveRef.current = null;
      recapResolveRef.current = null;
    };
  }, [showing, round, summaryRound, setState, cinemaHoldRef]);

  return (
    <>
      {cinema && <StrikeCinema strike={cinema} onComplete={onCinemaComplete} />}
      {recap && <StrikeRecap events={recap} onContinue={onRecapContinue} />}
    </>
  );
}

function MapBackdrop() {
  return (
    <div className="map-backdrop" style={{ backgroundImage: `url(${ART.map})` }} aria-hidden />
  );
}

function EnvMeter({ value }: { value: number }) {
  const tone = value >= 70 ? 'good' : value >= 40 ? 'warn' : 'bad';
  return (
    <div className={`env-meter env-meter--${tone}`}>
      <span className="env-meter__icon">🌳</span>
      <strong>{value}%</strong>
    </div>
  );
}

function cityStatusLabel(c: {
  destroyed: boolean;
  hasShield: boolean;
  hasResearch: boolean;
  isUnderground?: boolean;
  rebuiltRound?: number;
}) {
  if (c.destroyed) return 'Destroyed';
  const bits: string[] = [];
  if (c.rebuiltRound != null) bits.push('Rebuilt');
  if (c.hasResearch) bits.push('Research');
  if (c.isUnderground) bits.push('Underground');
  else if (c.hasShield) bits.push('Shield');
  return bits.length ? bits.join(' · ') : 'Open';
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
  environment,
  idleSecondsLeft,
  compact = false,
}: {
  state: GameState;
  nationId: NationId;
  money: number;
  bombs: number;
  drones: number;
  environment: number;
  idleSecondsLeft?: number | null;
  compact?: boolean;
}) {
  const def = nationDef(nationId);
  return (
    <div className={`modal__head wizard-nation-head ${compact ? 'wizard-nation-head--compact' : ''}`}>
      <div className="wizard-nation-head__emblem">
        <img className="modal__leader" src={ART.leaders[nationId]} alt="" />
      </div>
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
        <p className="wizard-nation-head__env">Env {environment}%</p>
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
  highlightCityIds,
  highlight,
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
  selectionWeapon?: 'nuke' | 'drone';
  /** Cities to pulse (e.g. destroyed this round) */
  highlightCityIds?: string[];
  highlight?: boolean;
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
  return (
    <div
      className={`nation-card nation-card--${variant} ${n.eliminated ? 'is-out' : ''} ${highlight ? 'is-turn' : ''}`}
      data-nation-id={id}
    >
      <div className="nation-card__portrait" data-nation-portrait={id}>
        <img src={ART.leaders[id]} alt={def.leader} />
        <div className="nation-card__meta">
          <strong>
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
      <div className="nation-card__cities">
        {n.cities.map((c) => {
          const selected = selectedCityIds?.includes(c.id);
          const hitThisRound = blocked.has(c.id);
          const bombLocked = bombed.has(c.id) && !c.destroyed;
          const droneLocked = swarmed.has(c.id) && !c.destroyed;
          const droneSelected = Boolean(selected && selectionWeapon === 'drone');
          const justHit = pulsed.has(c.id);
          // A warhead has nothing to hit in a bunker city; drones still bill it
          const bombProof = Boolean(c.isUnderground && selectionWeapon === 'nuke');
          const canTarget = Boolean(targetable && !c.destroyed && !hitThisRound && !bombProof);
          const className = `city-tile ${c.destroyed ? 'is-destroyed' : ''} ${c.hasShield ? 'has-shield' : ''} ${c.hasResearch ? 'has-research' : ''} ${selected ? 'is-selected' : ''} ${canTarget ? 'is-targetable' : ''} ${hitThisRound && !c.destroyed && !bombLocked ? 'is-hit-this-round' : ''} ${bombLocked ? 'is-bomb-locked' : ''} ${droneLocked || droneSelected ? 'is-drone-locked' : ''} ${c.isUnderground && !c.destroyed ? 'is-underground' : ''} ${c.rebuiltRound != null && !c.destroyed ? 'is-rebuilt' : ''} ${justHit ? 'is-just-hit' : ''}`;
          const title = c.isUnderground && !c.destroyed
            ? `${c.name} — underground city, cannot be destroyed`
            : bombLocked
            ? `${c.name} — targeted for bombing`
            : droneLocked
              ? `${c.name} — drone swarm inbound`
              : selected
                ? `${c.name} — selected for ${selectionWeapon === 'drone' ? 'drones' : 'bombing'}`
                : `${c.name} — ${cityStatusLabel(c)}`;
          const body = (
            <>
              {c.rebuiltRound != null && !c.destroyed && (
                <span className="city-tile__shine" aria-hidden />
              )}
              <img
                className="city-tile__art"
                src={ART.cities[c.id]}
                alt={c.name}
                draggable={false}
              />
              {c.hasShield && !c.destroyed && (
                <span className="city-tile__dome" aria-hidden />
              )}
              {c.hasResearch && !c.destroyed && (
                <span className="city-tile__research" title="Research" aria-label="Research">
                  <img src={ART.researchIcon} alt="" draggable={false} />
                </span>
              )}
              {c.isUnderground && !c.destroyed && (
                <span
                  className="city-tile__bunker"
                  title="Underground city — cannot be destroyed"
                  aria-label="Underground city"
                >
                  <img src={ART.undergroundIcon} alt="" draggable={false} />
                </span>
              )}
              {(bombLocked || (selected && selectionWeapon === 'nuke')) && (
                <span
                  className={`city-tile__bomb-lock ${
                    selected && selectionWeapon === 'nuke' && !bombLocked ? 'is-pending' : ''
                  }`}
                  title={bombLocked ? 'Targeted for bombing' : 'Selected for bombing'}
                  aria-label={bombLocked ? 'Targeted for bombing' : 'Selected for bombing'}
                >
                  <img src={ART.missile} alt="" draggable={false} />
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
    <div className="screen screen--splash">
      <MapBackdrop />
      <div className="splash-veil" />
      <div className="splash-content">
        <h1 className="stencil-title title-glow">NUCLEAR WAR</h1>
        <p className="tagline">5 rounds · 12 countries · one superpower</p>
        <div className="mode-row">
          <button className="btn btn--xl btn--primary" onClick={() => onSelect('single')}>
            Single Player
            <small>Pick your country · you vs 4 AI nations</small>
          </button>
          <button className="btn btn--xl btn--primary" onClick={() => onSelect('two')}>
            Two Players
            <small>Hot-seat · same device</small>
          </button>
          <button
            className="btn btn--xl btn--primary"
            onClick={() => onSelect('online')}
            disabled={!isFirebaseConfigured()}
          >
            Online Multiplayer
            <small>
              {isFirebaseConfigured()
                ? '2–5 humans · AI fills the rest'
                : 'Set VITE_FIREBASE_* to enable'}
            </small>
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

function MeetLeaders({ state, onContinue }: { state: GameState; onContinue: () => void }) {
  // Only the countries seated at this table speak at the summit
  const seated = state.turnOrder;
  const order = useMemo(
    () => LEADER_SPEECHES.map((s) => s.nationId).filter((id) => seated.includes(id)),
    [seated],
  );
  const [index, setIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const current = speechFor(order[Math.min(index, order.length - 1)]);
  const done = index >= order.length;

  const playAt = useCallback((i: number) => {
    if (i >= order.length) {
      setIndex(order.length);
      return;
    }
    const speech = speechFor(order[i]);
    audioRef.current?.pause();
    const audio = new Audio(speech.audioSrc);
    audioRef.current = audio;
    setIndex(i);
    audio.play().catch(() => {
      // Autoplay blocked until user gesture — show line anyway and advance on timer
      window.setTimeout(() => playAt(i + 1), 4500);
    });
    audio.onended = () => {
      window.setTimeout(() => playAt(i + 1), 400);
    };
  }, [order]);

  const startBriefing = () => {
    setStarted(true);
    playAt(0);
  };

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  return (
    <div className="screen screen--splash">
      <MapBackdrop />
      <div className="splash-veil" />
      <div className="splash-content splash-content--wide">
        <h1 className="stencil-title">MEET THE LEADERS</h1>
        <p className="tagline">
          {started
            ? done
              ? 'Briefing complete. Trust no one.'
              : `${nationDef(current.nationId).leader} addresses the summit…`
            : 'Each leader will state their position on nuclear technology. Listen carefully — they may be lying.'}
        </p>

        <div className="leaders-row">
          {seated.map((id) => {
            const n = nationDef(id);
            const human = state.nations[n.id].isHuman;
            const speaking = started && !done && current.nationId === n.id;
            const spoken = started && order.indexOf(n.id) < index;
            return (
              <div
                key={n.id}
                className={`leader-reveal ${human ? 'is-human' : ''} ${speaking ? 'is-speaking' : ''} ${spoken ? 'has-spoken' : ''}`}
              >
                <img src={ART.leaders[n.id]} alt={n.leader} />
                <strong>{n.name}</strong>
                <span>{n.leader}</span>
                <em>{human ? playerDisplayName(state, n.id) : 'Computer'}</em>
                {speaking && <span className="speaking-eq" aria-hidden />}
              </div>
            );
          })}
        </div>

        {started && !done && (
          <div className="speech-bubble enter-pop" key={current.nationId}>
            <img src={ART.leaders[current.nationId]} alt="" />
            <div>
              <strong>{nationDef(current.nationId).leader}</strong>
              <p>“{current.publicLine}”</p>
            </div>
          </div>
        )}

        {done && (
          <p className="deceit-hint enter-pop">
            Official statements end here. True intentions remain classified — watch what they buy.
          </p>
        )}

        <div className="meet-actions">
          {!started && (
            <button className="btn btn--xl btn--primary" onClick={startBriefing}>
              Play Leader Briefing
            </button>
          )}
          {started && !done && (
            <button
              className="btn btn--primary"
              onClick={() => {
                audioRef.current?.pause();
                playAt(index + 1);
              }}
            >
              Skip Line →
            </button>
          )}
          <button
            className="btn btn--xl btn--primary"
            disabled={!done && started}
            onClick={() => {
              audioRef.current?.pause();
              onContinue();
            }}
          >
            {done || !started ? 'Begin Round 1' : 'Wait for briefing…'}
          </button>
          {started && !done && (
            <button
              className="btn"
              onClick={() => {
                audioRef.current?.pause();
                setIndex(order.length);
              }}
            >
              Skip All
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function canOfferTech(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return !n.hasNuclearTech && n.money >= COSTS.nuclearTech;
}

function canOfferAerospace(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return !n.hasAerospaceTech && n.money >= COSTS.aerospaceTech;
}

function canOfferDrones(state: GameState, actorId: NationId): boolean {
  return maxDronesPurchasable(state, actorId) > 0;
}

function canOfferResearch(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return (
    n.money >= COSTS.research && n.cities.some((c) => !c.destroyed && !c.hasResearch)
  );
}

function canOfferBombs(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return n.money >= COSTS.bomb && maxBombsPurchasable(state, actorId) > 0;
}

function canOfferUnderground(state: GameState, actorId: NationId): boolean {
  return canBuyUnderground(state, actorId);
}

function canOfferRebuild(state: GameState, actorId: NationId): boolean {
  return canBuyRebuild(state, actorId);
}

function canOfferShield(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return (
    n.money >= COSTS.shield &&
    n.cities.some((c) => !c.destroyed && !c.hasShield && !c.isUnderground)
  );
}

function canOfferEnv(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return (
    !n.envBoughtThisRound && n.money >= COSTS.environment && state.environment < 100
  );
}

function canOfferSanction(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  if (n.promptsDoneThisRound?.includes('sanctionAsk')) return false;
  return state.turnOrder.some((nid) => nid !== actorId && !state.nations[nid].eliminated);
}

function canOfferStrike(state: GameState, actorId: NationId): boolean {
  return state.nations[actorId].bombs > 0;
}

function canOfferDroneStrike(state: GameState, actorId: NationId): boolean {
  return state.nations[actorId].drones > 0;
}

/** Next wizard prompt after `from` (null = start of turn). */
function nextWizardStep(
  state: GameState,
  from: WizardStep | null,
  actorId: NationId,
): WizardStep | null {
  const sequence: WizardStep[] = [
    'tech',
    'aerospace',
    'researchAsk',
    'bombs',
    'drones',
    'undergroundAsk',
    'rebuildAsk',
    'shieldAsk',
    'env',
    'sanctionAsk',
    'strike',
    'droneStrike',
  ];
  let start = 0;
  if (from === 'researchPick') start = sequence.indexOf('researchAsk') + 1;
  else if (from === 'undergroundPick') start = sequence.indexOf('undergroundAsk') + 1;
  else if (from === 'rebuildPick') start = sequence.indexOf('rebuildAsk') + 1;
  else if (from === 'shieldPick') start = sequence.indexOf('shieldAsk') + 1;
  else if (from === 'sanctionPick') start = sequence.indexOf('sanctionAsk') + 1;
  else if (from != null) start = sequence.indexOf(from) + 1;

  for (let i = start; i < sequence.length; i += 1) {
    const step = sequence[i];
    if (step === 'tech' && canOfferTech(state, actorId)) return 'tech';
    if (step === 'aerospace' && canOfferAerospace(state, actorId)) return 'aerospace';
    if (step === 'researchAsk' && canOfferResearch(state, actorId)) return 'researchAsk';
    if (step === 'bombs' && canOfferBombs(state, actorId)) return 'bombs';
    if (step === 'drones' && canOfferDrones(state, actorId)) return 'drones';
    if (step === 'undergroundAsk' && canOfferUnderground(state, actorId)) {
      return 'undergroundAsk';
    }
    if (step === 'rebuildAsk' && canOfferRebuild(state, actorId)) return 'rebuildAsk';
    if (step === 'shieldAsk' && canOfferShield(state, actorId)) return 'shieldAsk';
    if (step === 'env' && canOfferEnv(state, actorId)) return 'env';
    if (step === 'sanctionAsk' && canOfferSanction(state, actorId)) return 'sanctionAsk';
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
  const [targets, setTargets] = useState<{ nationId: NationId; cityId: string }[]>([]);
  const [droneTargets, setDroneTargets] = useState<
    { nationId: NationId; cityId: string }[]
  >([]);
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  const [fx, setFx] = useState<FxEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState<number | null>(null);
  const fxId = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const aiRunningRef = useRef(false);
  const wizardStartedRoundRef = useRef<number | null>(null);
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
    setTargets((prev) => (prev.length > turn.bombs ? prev.slice(0, turn.bombs) : prev));
  }, [turn.bombs]);

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
      strikeTargets: { nationId: NationId; cityId: string }[],
      swarmTargets: { nationId: NationId; cityId: string }[] = [],
    ) => {
      setWizardStep(null);
      setTargets([]);
      setDroneTargets([]);
      setState((s) => {
        const actor =
          s.mode === 'online' && sessionUid && s.uidToNation?.[sessionUid]
            ? s.uidToNation[sessionUid]
            : currentNationId(s);
        if (!actor) return s;

        let next = s.phase === 'buy' ? finishBuyPhase(s) : s;
        next = queueStrikes(next, strikeTargets, actor);
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

  const advanceAfter = useCallback(
    (s: GameState, from: WizardStep) => {
      const actor =
        s.mode === 'online' && sessionUid && s.uidToNation?.[sessionUid]
          ? s.uidToNation[sessionUid]
          : currentNationId(s);
      if (!actor) return;
      bumpSelectionActivity();
      let nextState = markPromptDone(s, actor, from);
      if (from === 'researchPick') nextState = markPromptDone(nextState, actor, 'researchAsk');
      if (from === 'undergroundPick') {
        nextState = markPromptDone(nextState, actor, 'undergroundAsk');
      }
      if (from === 'rebuildPick') nextState = markPromptDone(nextState, actor, 'rebuildAsk');
      if (from === 'shieldPick') nextState = markPromptDone(nextState, actor, 'shieldAsk');
      if (from === 'sanctionPick') nextState = markPromptDone(nextState, actor, 'sanctionAsk');
      if (s.mode === 'online') {
        nextState = touchHumanActivity(nextState, actor);
        stateRef.current = nextState;
        setState(nextState);
        syncPlanning(nextState, actor);
      } else {
        stateRef.current = nextState;
        setState(nextState);
      }
      const next = nextWizardStep(nextState, from, actor);
      if (next == null) closeHumanTurn([]);
      else setWizardStep(next);
    },
    [closeHumanTurn, sessionUid, bumpSelectionActivity, setState, syncPlanning],
  );

  // Start turn prompts when this human can act (once per round), after briefing
  useEffect(() => {
    if (!isMyHumanTurn) {
      setWizardStep(null);
      setIdleSecondsLeft(null);
      return;
    }
    if (roundBriefingActive) return;
    if (wizardStartedRoundRef.current === state.round) return;

    wizardStartedRoundRef.current = state.round;
    lastActivityRef.current = Date.now();
    setIdleSecondsLeft(Math.ceil(SELECTION_IDLE_MS / 1000));
    setTargets([]);
    setDroneTargets([]);
    const first = nextWizardStep(stateRef.current, null, actorId);
    if (first == null) {
      const t = window.setTimeout(() => closeHumanTurn([]), 40);
      return () => window.clearTimeout(t);
    }
    setWizardStep(first);
  }, [isMyHumanTurn, actorId, state.round, closeHumanTurn, roundBriefingActive]);

  // 60s idle kick — only while this client must make selections
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

  // Peers: forfeit only after the 60s selection window — never from lobby status / tab blur
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
    const limit = droneSelectMode ? turn.drones : turn.bombs;
    if (limit < 1) return;
    const spent = droneSelectMode ? turn.citiesDronedThisRound : turn.citiesStruckThisRound;
    if (spent.includes(cityId)) return;
    bumpSelectionActivity();
    const pick = droneSelectMode ? setDroneTargets : setTargets;
    pick((prev) => {
      const exists = prev.find((t) => t.cityId === cityId);
      if (exists) return prev.filter((t) => t.cityId !== cityId);
      if (prev.length >= limit) return [...prev.slice(1), { nationId, cityId }];
      return [...prev, { nationId, cityId }];
    });
  };

  /** Targeting runs bombs first, then drones, so the last step locks the turn in. */
  const finishStrikeStep = (picked: { nationId: NationId; cityId: string }[]) => {
    bumpSelectionActivity();
    setTargets(picked);
    if (canOfferDroneStrike(stateRef.current, actorId)) {
      setWizardStep('droneStrike');
      return;
    }
    closeHumanTurn(picked);
  };

  const unshieldedCities = turn.cities.filter(
    (c) => !c.destroyed && !c.hasShield && !c.isUnderground,
  );
  const surfaceCities = turn.cities.filter((c) => !c.destroyed && !c.isUnderground);
  const burntCities = turn.cities.filter((c) => c.destroyed);
  const researchCities = turn.cities.filter((c) => !c.destroyed && !c.hasResearch);
  const bombMax = maxBombsPurchasable(state, actorId);
  const droneMax = maxDronesPurchasable(state, actorId);
  const selectedCityIds = droneSelectMode
    ? droneTargets.map((t) => t.cityId)
    : targets.map((t) => t.cityId);
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
  const enemyIds = state.turnOrder.filter((id) => !allyIds.includes(id));

  return (
    <div className={`screen screen--board${strikeSelectMode ? ' is-striking' : ''}`}>
      <MapBackdrop />
      <FxLayer events={fx} />

      {isMyHumanTurn && wizardStep && !strikeSelectMode && (
        <div className="turn-wizard" role="dialog" aria-modal="true">
          <div className="turn-wizard__panel enter-pop">
            <WizardNationHeader
              state={state}
              nationId={actorId}
              money={turn.money}
              bombs={turn.bombs}
              drones={turn.drones}
              environment={state.environment}
              idleSecondsLeft={isOnline ? idleSecondsLeft : null}
            />

            <div className={`turn-wizard__hero turn-wizard__hero--${wizardStep}`}>
              <img src={wizardArt(wizardStep)} alt="" draggable={false} />
            </div>

            {wizardStep === 'tech' && (
              <>
                <h3 className="turn-wizard__q">Do you want to purchase Nuclear Tech?</h3>
                <p className="turn-wizard__hint">
                  Unlocks bomb production next round · {COSTS.nuclearTech}M
                </p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      pushFx({ kind: 'buy', label: 'Nuclear Tech Unlocked!' }, 700);
                      const next = buyNuclearTech(stateRef.current, actorId);
                      setState(next);
                      advanceAfter(next, 'tech');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'tech')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'aerospace' && (
              <>
                <h3 className="turn-wizard__q">Do you want to purchase Aerospace Tech?</h3>
                <p className="turn-wizard__hint">
                  Unlocks drone packs next round · {COSTS.aerospaceTech}M
                </p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      pushFx({ kind: 'buy', label: 'Aerospace Tech Unlocked!' }, 700);
                      const next = buyAerospaceTech(stateRef.current, actorId);
                      setState(next);
                      advanceAfter(next, 'aerospace');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'aerospace')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'researchAsk' && (
              <>
                <h3 className="turn-wizard__q">Do you want to build a Research Center?</h3>
                <p className="turn-wizard__hint">
                  {COSTS.research}M · that city earns +${RESEARCH_INCOME}M each round
                </p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      bumpSelectionActivity();
                      setWizardStep('researchPick');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'researchAsk')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'researchPick' && (
              <>
                <h3 className="turn-wizard__q">Select the city for your Research Center</h3>
                <p className="turn-wizard__hint">Cities that already have research are hidden</p>
                <div className="turn-wizard__city-grid">
                  {researchCities.map((c) => (
                    <button
                      key={c.id}
                      className="turn-wizard__city-card"
                      onClick={() => {
                        pushFx({ kind: 'buy', label: `Research in ${c.name}` }, 700);
                        const next = buyResearch(stateRef.current, c.id, actorId);
                        setState(next);
                        advanceAfter(next, 'researchPick');
                      }}
                    >
                      <img src={ART.cities[c.id]} alt="" draggable={false} />
                      <span>{c.name}</span>
                    </button>
                  ))}
                </div>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'researchPick')}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'bombs' && (
              <>
                <h3 className="turn-wizard__q">How many bombs do you want to buy?</h3>
                <p className="turn-wizard__hint">
                  {COSTS.bomb}M each · max {bombMax} this round (cap 3)
                </p>
                <div className="turn-wizard__actions turn-wizard__actions--wrap">
                  {[0, 1, 2, 3].map((n) => (
                    <button
                      key={n}
                      className="btn btn--xl btn--primary"
                      disabled={n > bombMax}
                      onClick={() => {
                        if (n === 0) {
                          advanceAfter(stateRef.current, 'bombs');
                          return;
                        }
                        pushFx({ kind: 'buy', label: `+${n} Bomb${n > 1 ? 's' : ''}` }, 700);
                        const next = buyBombs(stateRef.current, n, actorId);
                        setState(next);
                        advanceAfter(next, 'bombs');
                      }}
                    >
                      {n === 0 ? 'No Bomb' : `${n} Bomb${n > 1 ? 's' : ''}`}
                    </button>
                  ))}
                </div>
              </>
            )}

            {wizardStep === 'drones' && (
              <>
                <h3 className="turn-wizard__q">How many drone packs do you want?</h3>
                <p className="turn-wizard__hint">
                  {COSTS.drone}M each · max {droneMax} this round (cap {MAX_DRONES_PER_ROUND}) ·
                  drones cost the target ${DRONE_DAMAGE}M in damages (half against a
                  shielded or underground city) and tie up a city&apos;s
                  shield so a bomb sent with them lands
                </p>
                <div className="turn-wizard__actions turn-wizard__actions--wrap">
                  {[0, 1, 2, 3].map((n) => (
                    <button
                      key={n}
                      className="btn btn--xl btn--primary"
                      disabled={n > droneMax}
                      onClick={() => {
                        if (n === 0) {
                          advanceAfter(stateRef.current, 'drones');
                          return;
                        }
                        pushFx({ kind: 'buy', label: `+${n} Drone Pack${n > 1 ? 's' : ''}` }, 700);
                        const next = buyDrones(stateRef.current, n, actorId);
                        setState(next);
                        advanceAfter(next, 'drones');
                      }}
                    >
                      {n === 0 ? 'No Drones' : `${n} Pack${n > 1 ? 's' : ''}`}
                    </button>
                  ))}
                </div>
              </>
            )}

            {wizardStep === 'undergroundAsk' && (
              <>
                <h3 className="turn-wizard__q">Move a city underground?</h3>
                <p className="turn-wizard__hint">
                  {COSTS.underground}M · one city per nation, for the whole match · nukes
                  cannot destroy it and it never needs a shield. Drone swarms still cost it
                  {` $${DRONE_DAMAGE / 2}M`} in repairs.
                </p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      bumpSelectionActivity();
                      setWizardStep('undergroundPick');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'undergroundAsk')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'undergroundPick' && (
              <>
                <h3 className="turn-wizard__q">Which city goes underground?</h3>
                <p className="turn-wizard__hint">
                  This is your one bunker city — it can never be destroyed
                </p>
                <div className="turn-wizard__city-grid">
                  {surfaceCities.map((c) => (
                    <button
                      key={c.id}
                      className="turn-wizard__city-card"
                      onClick={() => {
                        pushFx({ kind: 'buy', label: `${c.name} goes underground` }, 700);
                        const next = buyUnderground(stateRef.current, c.id, actorId);
                        setState(next);
                        advanceAfter(next, 'undergroundPick');
                      }}
                    >
                      <img src={ART.cities[c.id]} alt="" draggable={false} />
                      <span>{c.name}</span>
                    </button>
                  ))}
                </div>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'undergroundPick')}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'rebuildAsk' && (
              <>
                <h3 className="turn-wizard__q">Rebuild a burnt city?</h3>
                <p className="turn-wizard__hint">
                  ${COSTS.rebuild}M · the city stands again and scores as normal, but it comes
                  back bare — no shield, no research, no bunker.
                </p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      bumpSelectionActivity();
                      setWizardStep('rebuildPick');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'rebuildAsk')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'rebuildPick' && (
              <>
                <h3 className="turn-wizard__q">Which city do you rebuild?</h3>
                <p className="turn-wizard__hint">Construction finishes before the next strikes</p>
                <div className="turn-wizard__city-grid">
                  {burntCities.map((c) => (
                    <button
                      key={c.id}
                      className="turn-wizard__city-card"
                      onClick={() => {
                        pushFx({ kind: 'buy', label: `${c.name} rebuilt` }, 700);
                        const next = buyRebuild(stateRef.current, c.id, actorId);
                        setState(next);
                        advanceAfter(next, 'rebuildPick');
                      }}
                    >
                      <img src={ART.cities[c.id]} alt="" draggable={false} />
                      <span>{c.name}</span>
                    </button>
                  ))}
                </div>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'rebuildPick')}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'shieldAsk' && (
              <>
                <h3 className="turn-wizard__q">Do you want to purchase a shield?</h3>
                <p className="turn-wizard__hint">{COSTS.shield}M · protects one city</p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      bumpSelectionActivity();
                      setWizardStep('shieldPick');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'shieldAsk')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'shieldPick' && (
              <>
                <h3 className="turn-wizard__q">Select the city for your shield</h3>
                <p className="turn-wizard__hint">Cities that already have a shield are hidden</p>
                <div className="turn-wizard__city-grid">
                  {unshieldedCities.map((c) => (
                    <button
                      key={c.id}
                      className="turn-wizard__city-card"
                      onClick={() => {
                        pushFx({ kind: 'buy', label: `Shield on ${c.name}` }, 700);
                        const next = buyShield(stateRef.current, c.id, actorId);
                        setState(next);
                        advanceAfter(next, 'shieldPick');
                      }}
                    >
                      <img src={ART.cities[c.id]} alt="" draggable={false} />
                      <span>{c.name}</span>
                    </button>
                  ))}
                </div>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'shieldPick')}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'env' && (
              <>
                <h3 className="turn-wizard__q">
                  Improve the environment by 10% for {COSTS.environment}M?
                </h3>
                <p className="turn-wizard__hint">Once per round · world is at {state.environment}%</p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      pushFx({ kind: 'buy', label: 'Environment +10%' }, 700);
                      const next = buyEnvironment(stateRef.current, actorId);
                      setState(next);
                      advanceAfter(next, 'env');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'env')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'sanctionAsk' && (
              <>
                <h3 className="turn-wizard__q">Do you want to impose sanctions?</h3>
                <p className="turn-wizard__hint">
                  Free · each sanctioned rival loses 10% of their income
                </p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      bumpSelectionActivity();
                      setState((s) => markPromptDone(s, actorId, 'sanctionAsk'));
                      setWizardStep('sanctionPick');
                    }}
                  >
                    Yes
                  </button>
                  <button
                    className="btn btn--xl"
                    onClick={() => advanceAfter(stateRef.current, 'sanctionAsk')}
                  >
                    No
                  </button>
                </div>
              </>
            )}

            {wizardStep === 'sanctionPick' && (
              <>
                <h3 className="turn-wizard__q">Choose rivals to sanction</h3>
                <p className="turn-wizard__hint">
                  Tap to toggle · −10% income each · currently sanctioning{' '}
                  {turn.sanctions.filter((nid) => !state.nations[nid]?.eliminated).length}
                </p>
                <div className="turn-wizard__sanction-grid">
                  {enemyIds.map((nid) => {
                    const n = nationDef(nid);
                    const alive = !state.nations[nid].eliminated;
                    const active = turn.sanctions.includes(nid);
                    return (
                      <button
                        key={nid}
                        type="button"
                        className={`turn-wizard__sanction-card ${active ? 'is-on' : ''}`}
                        disabled={!alive}
                        onClick={() => {
                          bumpSelectionActivity();
                          setState((s) => {
                            const next = touchHumanActivity(
                              toggleSanction(s, nid, actorId),
                              actorId,
                            );
                            stateRef.current = next;
                            syncPlanning(next, actorId);
                            return next;
                          });
                        }}
                      >
                        <img src={ART.leaders[nid]} alt="" draggable={false} />
                        <strong>{n.name}</strong>
                        <span>{active ? 'Sanctioning' : alive ? 'Tap to sanction' : 'Out'}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => advanceAfter(stateRef.current, 'sanctionPick')}
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {isMyHumanTurn && wizardStep === 'strike' && (
        <div className="turn-wizard turn-wizard--dock" role="dialog" aria-modal="true">
          <div className="turn-wizard__panel turn-wizard__panel--strike enter-pop">
            <WizardNationHeader
              state={state}
              nationId={actorId}
              money={turn.money}
              bombs={turn.bombs}
              drones={turn.drones}
              environment={state.environment}
              idleSecondsLeft={isOnline ? idleSecondsLeft : null}
              compact
            />
            <div className="turn-wizard__hero turn-wizard__hero--strike">
              <img src={ART.missile} alt="" draggable={false} />
            </div>
            <h3 className="turn-wizard__q">Hit enemy cities with your bombs?</h3>
            <p className="turn-wizard__hint">
              Tap up to {turn.bombs} enemy cit{turn.bombs === 1 ? 'y' : 'ies'}
              {targets.length > 0
                ? ` · selected ${targets.length}/${turn.bombs}`
                : ''}
              . Strikes launch with everyone else at round end.
            </p>
            {targets.length > 0 && (
              <p className="target-label">
                {targets
                  .map((t) => {
                    const name =
                      state.nations[t.nationId]?.cities.find((c) => c.id === t.cityId)?.name ??
                      t.cityId;
                    return name;
                  })
                  .join(' · ')}
              </p>
            )}
            <div className="turn-wizard__actions">
              <button
                className="btn btn--xl btn--danger"
                disabled={targets.length < 1}
                onClick={() => finishStrikeStep(targets)}
              >
                Lock Targets ({targets.length})
              </button>
              <button className="btn btn--xl" onClick={() => finishStrikeStep([])}>
                Skip / No Strike
              </button>
            </div>
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
              environment={state.environment}
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
              {` $${DRONE_DAMAGE / 2}M`} if the city has a shield or bunker. Swarm a
              city you also
              bombed and its shield is too busy to stop the warhead.
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
            <div className="turn-wizard__actions">
              <button
                className="btn btn--xl btn--danger"
                disabled={droneTargets.length < 1}
                onClick={() => closeHumanTurn(targets, droneTargets)}
              >
                Send Drones ({droneTargets.length})
              </button>
              <button className="btn btn--xl" onClick={() => closeHumanTurn(targets, [])}>
                Skip / Hold Drones
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="board-split">
        <section className="board-left">
          <header className="board-left__hud">
            <EnvMeter value={state.environment} />
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
                  <img className="modal__leader" src={ART.leaders[actorId]} alt="" />
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
                  />
                ))}
              </div>
            )}

            {isSpectator && mySeatId && (state.phase === 'buy' || state.phase === 'action') && (
              <div className="panel panel--ai enter-pop">
                <img src={ART.leaders[mySeatId]} alt="" />
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
                <img src={ART.leaders[turnId]} alt="" />
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
              ? `Enemies — tap up to ${turn.bombs} cities`
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
                selectedCityIds={selectedCityIds}
                targetable={strikeSelectMode}
                blockedCityIds={
                  droneSelectMode ? turn.citiesDronedThisRound : turn.citiesStruckThisRound
                }
                pendingBombCityIds={pendingBombCityIds}
                pendingDroneCityIds={pendingDroneCityIds}
                selectionWeapon={droneSelectMode ? 'drone' : 'nuke'}
                highlight={id === actorId}
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
  const endsAt = state.aftermathEndsAt ?? null;
  const [secondsLeft, setSecondsLeft] = useState(() =>
    endsAt == null ? null : Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)),
  );
  const continueOnceRef = useRef(false);

  useEffect(() => {
    continueOnceRef.current = false;
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
  }, [state.round, endsAt, onContinue]);

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
  const isFinal = state.round >= state.maxRounds;
  const myNationId =
    isOnline && sessionUid && state.uidToNation?.[sessionUid]
      ? state.uidToNation[sessionUid]
      : null;
  const myCityIds = aftermathMyCityIds(
    state.turnOrder,
    (id) => Boolean(state.nations[id as NationId]?.isHuman),
    myNationId,
  ) as NationId[];
  const worldIds = aftermathWorldIds(state.turnOrder, myCityIds) as NationId[];
  const isYouNation = (id: NationId) =>
    myNationId ? id === myNationId : Boolean(state.nations[id].isHuman);

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
            : 'Use this time to plan your strategy'}
        </span>
      </div>
      <div className="board-split round-report__split">
        <section className="board-left round-report__main">
          <header className="board-left__hud">
            <EnvMeter value={state.environment} />
            <div className="round-pill">ROUND {state.round} AFTERMATH</div>
          </header>

          <div className="board-left__controls">
            <div className="panel panel--shop round-report__panel">
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
                      <img src={ART.leaders[row.nationId]} alt="" />
                      <div>
                        <strong>
                          {row.eliminated ? 'OUT' : `#${i + 1}`} {nationDef(row.nationId).name}
                          {nation.isHuman
                            ? ` (${playerDisplayName(state, row.nationId)})`
                            : ''}
                        </strong>
                        <span>
                          Cities {row.citiesLeft} · Survived {row.citySurvivalPoints} · 🔍
                          {row.researchCenters} · 🛡{row.shields}
                          {isYou ? ' · You' : nation.isHuman ? ' · Player' : ' · AI'}
                        </span>
                      </div>
                      <em>{row.total}</em>
                    </div>
                  );
                })}
              </div>

              {state.lastIncomeLedger.length > 0 && (
                <>
                  <h2 className="round-report__panel-title">Treasury</h2>
                  <div className="income-ledger">
                    {state.lastIncomeLedger
                      .filter((e) =>
                        myNationId
                          ? e.nationId === myNationId
                          : state.nations[e.nationId].isHuman,
                      )
                      .map((e) => (
                        <div key={e.nationId} className="income-ledger__row">
                          <strong>{nationDef(e.nationId).name}</strong>
                          <span>
                            Prev ${formatMoney(e.previousBalance)} → Revenue +$
                            {formatMoney(e.revenue)} → Now $
                            {formatMoney(state.nations[e.nationId].money)}
                          </span>
                          {e.sanctioners.length > 0 && (
                            <small>
                              Sanctioned by{' '}
                              {e.sanctioners.map((id) => nationDef(id).name).join(' · ')} (−
                              {Math.round(e.sanctionPenalty * 100)}%)
                            </small>
                          )}
                          {(e.droneDamage ?? 0) > 0 && (
                            <small>
                              Drone damage repairs −${formatMoney(e.droneDamage ?? 0)}
                            </small>
                          )}
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
                    highlightCityIds={destroyedCityIds}
                    highlight={state.nations[id].eliminated}
                  />
                ))}
              </div>

              <div className="round-report__world-mobile">
                <h2 className="round-report__panel-title">World — shields, research, ruins</h2>
                <p className="round-report__legend">
                  <span>🛡 Shield</span>
                  <span>
                    <img
                      className="legend-icon"
                      src={ART.researchIcon}
                      alt=""
                      draggable={false}
                    />{' '}
                    Research
                  </span>
                  <span className="round-report__legend-burnt">Burnt = destroyed</span>
                </p>
                <div className="round-report__world-list">
                  {worldIds.map((id) => (
                    <NationPod
                      key={id}
                      id={id}
                      variant="enemy"
                      state={state}
                      highlightCityIds={destroyedCityIds}
                      highlight={state.nations[id].eliminated}
                    />
                  ))}
                </div>
              </div>

              <div className="round-report__actions">
                <p className="round-report__auto-hint">
                  {isFinal
                    ? `Final results in ${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'}…`
                    : `Round ${state.round + 1} starts in ${secondsLeft} ${secondsLeft === 1 ? 'second' : 'seconds'} — study the board`}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="board-right round-report__world-desktop">
          <h3 className="board-section-title">World — shields, research, ruins</h3>
          <p className="round-report__legend">
            <span>🛡 Shield</span>
            <span>
              <img className="legend-icon" src={ART.researchIcon} alt="" draggable={false} />{' '}
              Research
            </span>
            <span className="round-report__legend-burnt">Burnt = destroyed</span>
          </p>
          <div className="board-right__nations">
            {worldIds.map((id) => (
              <NationPod
                key={id}
                id={id}
                variant="enemy"
                state={state}
                highlightCityIds={destroyedCityIds}
                highlight={state.nations[id].eliminated}
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
  const winnerName =
    state.winner && state.winner !== 'draw' ? nationDef(state.winner).name : 'No one';
  const isMutual = state.winner === 'draw';
  const creditedRef = useRef(false);
  const isOnline = state.mode === 'online';
  const isHost = Boolean(sessionUid && state.onlineHostUid === sessionUid);
  /** Older matches may lack onlineHostUid — allow attempt; server enforces host. */
  const canStartRematch = isOnline && Boolean(sessionUid) && (isHost || !state.onlineHostUid);
  const winnerPlayer =
    state.winner && state.winner !== 'draw' && state.nations[state.winner]?.isHuman
      ? playerDisplayName(state, state.winner)
      : null;

  useEffect(() => {
    if (creditedRef.current) return;
    if (!sessionUid || !displayName) return;
    if (!state.winner || state.winner === 'draw') return;
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

  return (
    <div className="screen screen--board screen--round-report screen--game-over">
      <MapBackdrop />
      <div className="splash-veil splash-veil--fire" />
      <div className="game-over-layout">
        <header className="game-over-hero enter-pop">
          {state.winner && state.winner !== 'draw' && (
            <img className="winner-art" src={ART.leaders[state.winner]} alt="" />
          )}
          <div>
            <h1 className="stencil-title">{isMutual ? 'MUTUAL DESTRUCTION' : 'SUPERPOWER'}</h1>
            <p className="tagline">
              {isMutual
                ? 'The environment hit 0%. The world burns. Nobody wins.'
                : winnerPlayer
                  ? `${winnerName} — ${winnerPlayer} dominates the board.`
                  : `${winnerName} dominates the board.`}
            </p>
            <EnvMeter value={state.environment} />
          </div>
        </header>

        <section className="panel panel--shop game-over-scores">
          <h2 className="round-report__panel-title">Final scores</h2>
          <div className="score-cards score-cards--compact">
            {(state.roundScores.length > 0
              ? state.roundScores
              : state.turnOrder.map((id) => computeScore(state, id))
            ).map((row, i) => {
              const nation = state.nations[row.nationId];
              const isYou =
                Boolean(sessionUid && nation.ownerUid === sessionUid) ||
                (!isOnline && nation.isHuman && nation.playerSlot === 1);
              const isWinner = state.winner === row.nationId;
              return (
                <div
                  key={row.nationId}
                  className={`score-card ${row.eliminated ? 'is-out' : ''} ${isWinner ? 'is-lead' : ''} ${isYou ? 'is-you' : ''}`}
                >
                  <img src={ART.leaders[row.nationId]} alt="" />
                  <div>
                    <strong>
                      #{i + 1} {nationDef(row.nationId).name}
                      {nation.isHuman ? ` (${playerDisplayName(state, row.nationId)})` : ''}
                      {isWinner ? ' ★' : ''}
                    </strong>
                    <span>
                      Cities {row.citiesLeft} · Survived {row.citySurvivalPoints} · 🔍
                      {row.researchCenters} · 🛡{row.shields}
                      {isYou ? ' · You' : nation.isHuman ? ' · Player' : ' · AI'}
                    </span>
                  </div>
                  <em>{row.total}</em>
                </div>
              );
            })}
          </div>
        </section>

        <div className="mode-row game-over-actions">
          {isOnline ? (
            <>
              {canStartRematch ? (
                <button
                  className="btn btn--xl btn--primary"
                  type="button"
                  disabled={rematchBusy}
                  onClick={() => onRematch?.()}
                >
                  {rematchBusy ? 'Starting…' : 'Play Again'}
                </button>
              ) : (
                <p className="round-report__auto-hint">
                  Waiting for host to start Play Again…
                </p>
              )}
              <button className="btn btn--xl" type="button" onClick={onRestart}>
                Leave
              </button>
            </>
          ) : (
            <button className="btn btn--xl btn--primary" type="button" onClick={onRestart}>
              Play Again
            </button>
          )}
          {onLeaderboard && (
            <button className="btn btn--xl" type="button" onClick={onLeaderboard}>
              Leaderboard
            </button>
          )}
        </div>
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
  // Set while a client is playing the strike cinema, so the published aftermath
  // doesn't cut the animation short mid-flight.
  const cinemaHoldRef = useRef<{ round: number; until: number } | null>(null);
  const lastRoundBannerRef = useRef(0);
  const [roundStartSlides, setRoundStartSlides] = useState<RoundStartSlide[] | null>(null);
  const [dropoutNotice, setDropoutNotice] = useState<{
    playerName: string;
    nationName: string;
    seq: number;
  } | null>(null);
  const lastDropoutSeqRef = useRef(0);
  const [rematchBusy, setRematchBusy] = useState(false);
  const [rematchError, setRematchError] = useState<string | null>(null);

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
      state.phase === 'leaders' ||
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
    setRoundStartSlides(buildRoundStartSlides(state, myId ?? null));
  }, [state, sessionUid]);

  /** True while the local strike cinema still owes this round its animation. */
  const holdsCinema = useCallback((remote: GameState) => {
    const hold = cinemaHoldRef.current;
    if (!hold) return false;
    if (Date.now() > hold.until) return false;
    // Only block the next round; summary updates for this round are welcome
    return Number(remote.round) > hold.round;
  }, []);

  const dismissRoundStart = useCallback(() => setRoundStartSlides(null), []);
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
      // Let the launch cinema finish before adopting the aftermath board
      if (holdsCinema(game.state)) return;
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
  }, [state.onlineGameId, state.mode, sessionUid, notePublishedDropout, holdsCinema]);

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
        if (holdsCinema(doc.state)) return;
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
    holdsCinema,
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
      {roundStartSlides && roundStartSlides.length > 0 && (
        <RoundStartOverlay
          key={`rs-${roundStartSlides[0].kind === 'round' ? roundStartSlides[0].round : 0}`}
          slides={roundStartSlides}
          onDone={dismissRoundStart}
        />
      )}
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
              setState((s) => setMode(s, m));
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
        <CountrySelect state={state} onPick={(id) => setState((s) => pickCountry(s, id))} />
      )}
      {state.phase === 'leaders' && (
        <MeetLeaders state={state} onContinue={() => setState((s) => advancePastAi(startGame(s)))} />
      )}
      {(state.phase === 'buy' ||
        state.phase === 'action' ||
        state.phase === 'income' ||
        state.phase === 'resolveStrikes') && (
        <GameBoard
          state={state}
          setState={setState}
          sessionUid={sessionUid}
          roundBriefingActive={Boolean(roundStartSlides)}
          onKicked={(message) => {
            if (sessionUid) void setPlayerStatus(sessionUid, 'available', null);
            setSessionError(message);
            setState({ ...createInitialState(), phase: 'mode' });
          }}
        />
      )}
      <StrikeTheater state={state} setState={setState} cinemaHoldRef={cinemaHoldRef} />
      {state.phase === 'roundSummary' && (
        <RoundSummary
          state={state}
          sessionUid={sessionUid}
          onContinue={advanceFromRoundSummary}
        />
      )}
      {state.phase === 'gameOver' && (
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
