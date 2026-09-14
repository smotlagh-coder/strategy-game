import './App.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ART, SFX } from './data/art';
import { NATIONS, nationDef, COSTS, RESEARCH_INCOME } from './data/nations';
import { LEADER_SPEECHES, speechFor } from './data/speeches';
import {
  applyQueuedStrike,
  aliveHumanNations,
  allAliveHumansReady,
  buyBombs,
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
  formatMoney,
  markHumanReady,
  maxBombsPurchasable,
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
  whoIsSanctioning,
} from './game/engine';
import { runAllAiUntilHumanOrSummary, runAiTurn, finishOnlineHumanPlanning, runOnlineAiPlanning } from './game/ai';
import type { GameMode, GameState, NationId, RoundWorldEvent } from './types';
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
  fetchGame,
  finishOnlineGame,
  incrementSuperpowerWin,
  kickIdleHumanFromGame,
  listenGame,
  enqueueHumanPlanningPush,
  pushGameState,
  rematchOnlineGame,
  tryAcquireAiLock,
} from './lib/multiplayer';
import { applyRemoteGameSnapshot } from './lib/onlineSync';
import { SELECTION_IDLE_MS } from './lib/onlineConstants';
import { aftermathMyCityIds, aftermathWorldIds } from './lib/lobbyInvite';
import { NameGate } from './screens/NameGate';
import { LobbyScreen } from './screens/Lobby';
import { LeaderboardScreen } from './screens/Leaderboard';

type FxKind = 'buy' | 'strike-label';
type WizardStep =
  | 'tech'
  | 'researchAsk'
  | 'researchPick'
  | 'bombs'
  | 'shieldAsk'
  | 'shieldPick'
  | 'env'
  | 'sanctionAsk'
  | 'sanctionPick'
  | 'strike';

function wizardArt(step: WizardStep): string {
  switch (step) {
    case 'tech':
      return ART.nukeTech;
    case 'researchAsk':
    case 'researchPick':
      return ART.map;
    case 'bombs':
    case 'strike':
      return ART.missile;
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

function playSfx(src: string, volume = 0.85) {
  try {
    const audio = new Audio(src);
    audio.volume = volume;
    void audio.play().catch(() => {
      /* autoplay / missing file — ignore */
    });
  } catch {
    /* ignore */
  }
}

interface StrikeShow {
  from: NationId;
  to: NationId;
  cityId: string;
  cityName: string;
}

const STRIKE_FLIGHT_MS = 1750;
const STRIKE_IMPACT_MS = 1000;

function StrikeCinema({
  strike,
  onComplete,
}: {
  strike: StrikeShow;
  onComplete: () => void;
}) {
  const missileRef = useRef<HTMLDivElement>(null);
  const [impact, setImpact] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    setImpact(false);
    playSfx(SFX.launch, 0.9);
    let raf = 0;
    let impactTimer = 0;
    let safetyTimer = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      onCompleteRef.current();
    };

    // Absolute failsafe so a turn can never hang forever
    safetyTimer = window.setTimeout(finish, STRIKE_FLIGHT_MS + STRIKE_IMPACT_MS + 800);

    const start = () => {
      const el = missileRef.current;
      if (!el) {
        impactTimer = window.setTimeout(finish, STRIKE_FLIGHT_MS + STRIKE_IMPACT_MS);
        return;
      }

      const t0 = performance.now();
      const x0 = 16;
      const y0 = 64;
      const x1 = 50;
      const y1 = 14;
      const x2 = 84;
      const y2 = 60;

      const tick = (now: number) => {
        if (finished) return;
        const u = Math.min(1, (now - t0) / STRIKE_FLIGHT_MS);
        const t = u * u * (3 - 2 * u);
        const omt = 1 - t;
        const x = omt * omt * x0 + 2 * omt * t * x1 + t * t * x2;
        const y = omt * omt * y0 + 2 * omt * t * y1 + t * t * y2;
        const dx = 2 * omt * (x1 - x0) + 2 * t * (x2 - x1);
        const dy = 2 * omt * (y1 - y0) + 2 * t * (y2 - y1);
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        el.style.left = `${x}%`;
        el.style.top = `${y}%`;
        el.style.transform = `translate(-50%, -50%) rotate(${angle}deg) scale(${0.85 + t * 0.35})`;
        el.style.opacity = u < 0.04 ? String(u / 0.04) : '1';

        if (u < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          playSfx(SFX.explosion, 0.95);
          setImpact(true);
          el.style.opacity = '0';
          impactTimer = window.setTimeout(finish, STRIKE_IMPACT_MS);
        }
      };

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(start);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(impactTimer);
      window.clearTimeout(safetyTimer);
    };
  }, [strike.from, strike.to, strike.cityId]);

  const from = nationDef(strike.from);
  const to = nationDef(strike.to);

  return (
    <div className="strike-cinema" role="dialog" aria-modal="true" aria-label="Nuclear strike">
      <div className="strike-cinema__veil" />
      <div className="strike-cinema__panel enter-pop">
        <header className="strike-cinema__title">NUCLEAR LAUNCH</header>

        <div className="strike-cinema__row">
          <div className="strike-cinema__side strike-cinema__side--from">
            <div className="strike-cinema__flag">DEPARTING</div>
            <img className="strike-cinema__leader" src={ART.leaders[strike.from]} alt="" />
            <strong>{from.name}</strong>
            <span>{from.leader}</span>
          </div>

          <div className="strike-cinema__arc" aria-hidden>
            <svg className="strike-cinema__path" viewBox="0 0 100 100" preserveAspectRatio="none">
              <path d="M 16 64 Q 50 14 84 60" />
            </svg>
            <div ref={missileRef} className="strike-cinema__missile">
              <img src={ART.missile} alt="" draggable={false} />
              <span className="strike-cinema__flame" />
            </div>
            {impact && (
              <div className="strike-cinema__boom">
                <img src={ART.explosion} alt="" />
              </div>
            )}
          </div>

          <div className="strike-cinema__side strike-cinema__side--to">
            <div className="strike-cinema__flag strike-cinema__flag--danger">TARGET</div>
            <div className="strike-cinema__target-art">
              <img className="strike-cinema__city" src={ART.cities[strike.cityId]} alt="" />
              <img className="strike-cinema__leader-sm" src={ART.leaders[strike.to]} alt="" />
            </div>
            <strong>{to.name}</strong>
            <span>{strike.cityName}</span>
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
  if (e.kind === 'shieldDestroyed') {
    return attacker
      ? `${attacker} shattered the shield over ${e.cityName} (${nation}).`
      : `Shield lost over ${e.cityName} (${nation}).`;
  }
  return attacker
    ? `${attacker} destroyed ${e.cityName} (${nation}).`
    : `${e.cityName} (${nation}) was destroyed.`;
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

function cityStatusLabel(c: { destroyed: boolean; hasShield: boolean; hasResearch: boolean }) {
  if (c.destroyed) return 'Destroyed';
  const bits: string[] = [];
  if (c.hasResearch) bits.push('Research');
  if (c.hasShield) bits.push('Shield');
  return bits.length ? bits.join(' · ') : 'Open';
}

function NationFlag({
  nationId,
  className = '',
}: {
  nationId: NationId;
  className?: string;
}) {
  const colors = nationDef(nationId).flagColors;
  return (
    <span
      className={`nation-flag ${className}`.trim()}
      role="img"
      aria-label={`${nationDef(nationId).name} flag`}
      style={{
        backgroundImage: `linear-gradient(90deg, ${colors
          .map((c, i) => {
            const start = (i / colors.length) * 100;
            const end = ((i + 1) / colors.length) * 100;
            return `${c} ${start}%, ${c} ${end}%`;
          })
          .join(', ')})`,
      }}
    />
  );
}

function WizardNationHeader({
  state,
  nationId,
  money,
  bombs,
  environment,
  idleSecondsLeft,
  compact = false,
}: {
  state: GameState;
  nationId: NationId;
  money: number;
  bombs: number;
  environment: number;
  idleSecondsLeft?: number | null;
  compact?: boolean;
}) {
  const def = nationDef(nationId);
  return (
    <div className={`modal__head wizard-nation-head ${compact ? 'wizard-nation-head--compact' : ''}`}>
      <div className="wizard-nation-head__emblem">
        <NationFlag nationId={nationId} className="wizard-nation-head__flag" />
        <img className="modal__leader" src={ART.leaders[nationId]} alt="" />
      </div>
      <div>
        <p className="wizard-nation-head__country">{def.name}</p>
        <h2>
          {playerDisplayName(state, nationId)}
        </h2>
        <p>
          ${formatMoney(money)} · Bombs {bombs} · Env {environment}%
        </p>
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
            {def.name}
            {n.eliminated ? ' — OUT' : ''}
          </strong>
          <span className="nation-card__score">{score} pts</span>
          <span>
            {n.isHuman ? playerDisplayName(state, id) : 'AI'} · ${formatMoney(n.money)}
            {n.hasNuclearTech ? ' · ☢' : ''}
            {n.bombs > 0 ? ` · 💣${n.bombs}` : ''}
          </span>
        </div>
      </div>
      <div className="nation-card__cities">
        {n.cities.map((c) => {
          const selected = selectedCityIds?.includes(c.id);
          const hitThisRound = blocked.has(c.id);
          const bombLocked = bombed.has(c.id) && !c.destroyed;
          const justHit = pulsed.has(c.id);
          const canTarget = Boolean(targetable && !c.destroyed && !hitThisRound);
          const className = `city-tile ${c.destroyed ? 'is-destroyed' : ''} ${c.hasShield ? 'has-shield' : ''} ${c.hasResearch ? 'has-research' : ''} ${selected ? 'is-selected' : ''} ${canTarget ? 'is-targetable' : ''} ${hitThisRound && !c.destroyed && !bombLocked ? 'is-hit-this-round' : ''} ${bombLocked ? 'is-bomb-locked' : ''} ${justHit ? 'is-just-hit' : ''}`;
          const title = bombLocked
            ? `${c.name} — targeted for bombing`
            : selected
              ? `${c.name} — selected for bombing`
              : `${c.name} — ${cityStatusLabel(c)}`;
          const body = (
            <>
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
                  🔍
                </span>
              )}
              {(selected || bombLocked) && (
                <span
                  className={`city-tile__bomb-lock ${selected && !bombLocked ? 'is-pending' : ''}`}
                  title={bombLocked ? 'Targeted for bombing' : 'Selected for bombing'}
                  aria-label={bombLocked ? 'Targeted for bombing' : 'Selected for bombing'}
                >
                  <img src={ART.missile} alt="" draggable={false} />
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
        <p className="tagline">5 rounds · 5 nations · one superpower</p>
        <div className="mode-row">
          <button className="btn btn--xl btn--primary" onClick={() => onSelect('single')}>
            Single Player
            <small>You vs 4 AI nations</small>
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
  const order = useMemo(() => LEADER_SPEECHES.map((s) => s.nationId), []);
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
          {NATIONS.map((n) => {
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

function canOfferShield(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return (
    n.money >= COSTS.shield && n.cities.some((c) => !c.destroyed && !c.hasShield)
  );
}

function canOfferEnv(state: GameState, actorId: NationId): boolean {
  const n = state.nations[actorId];
  return (
    !n.envBoughtThisRound && n.money >= COSTS.environment && state.environment < 100
  );
}

function canOfferSanction(state: GameState, actorId: NationId): boolean {
  return state.turnOrder.some((nid) => nid !== actorId && !state.nations[nid].eliminated);
}

function canOfferStrike(state: GameState, actorId: NationId): boolean {
  return state.nations[actorId].bombs > 0;
}

/** Next wizard prompt after `from` (null = start of turn). */
function nextWizardStep(
  state: GameState,
  from: WizardStep | null,
  actorId: NationId,
): WizardStep | null {
  const sequence: WizardStep[] = [
    'tech',
    'researchAsk',
    'bombs',
    'shieldAsk',
    'env',
    'sanctionAsk',
    'strike',
  ];
  let start = 0;
  if (from === 'researchPick') start = sequence.indexOf('researchAsk') + 1;
  else if (from === 'shieldPick') start = sequence.indexOf('shieldAsk') + 1;
  else if (from === 'sanctionPick') start = sequence.indexOf('sanctionAsk') + 1;
  else if (from != null) start = sequence.indexOf(from) + 1;

  for (let i = start; i < sequence.length; i += 1) {
    const step = sequence[i];
    if (step === 'tech' && canOfferTech(state, actorId)) return 'tech';
    if (step === 'researchAsk' && canOfferResearch(state, actorId)) return 'researchAsk';
    if (step === 'bombs' && canOfferBombs(state, actorId)) return 'bombs';
    if (step === 'shieldAsk' && canOfferShield(state, actorId)) return 'shieldAsk';
    if (step === 'env' && canOfferEnv(state, actorId)) return 'env';
    if (step === 'sanctionAsk' && canOfferSanction(state, actorId)) return 'sanctionAsk';
    if (step === 'strike' && canOfferStrike(state, actorId)) return 'strike';
  }
  return null;
}

function GameBoard({
  state,
  setState,
  sessionUid,
  onKicked,
}: {
  state: GameState;
  setState: React.Dispatch<React.SetStateAction<GameState>>;
  sessionUid?: string | null;
  onKicked?: (message: string) => void;
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
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  const [fx, setFx] = useState<FxEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [cinema, setCinema] = useState<StrikeShow | null>(null);
  const [strikeRecap, setStrikeRecap] = useState<RoundWorldEvent[] | null>(null);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState<number | null>(null);
  const fxId = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cinemaResolveRef = useRef<(() => void) | null>(null);
  const recapResolveRef = useRef<(() => void) | null>(null);
  const aiRunningRef = useRef(false);
  const wizardStartedRoundRef = useRef<number | null>(null);
  const resolvedRoundRef = useRef<number | null>(null);
  const lastActivityRef = useRef(Date.now());
  const kickingRef = useRef(false);
  const onKickedRef = useRef(onKicked);
  onKickedRef.current = onKicked;

  // Allow a fresh resolve pass when a new round begins
  useEffect(() => {
    resolvedRoundRef.current = null;
  }, [state.round]);

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
  const strikeSelectMode = isMyHumanTurn && wizardStep === 'strike';
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
        setState((cur) =>
          cur.onlineGameId === gameId && cur.round === merged.round ? merged : cur,
        );
      });
    },
    [setState],
  );

  useEffect(() => {
    setTargets((prev) => (prev.length > turn.bombs ? prev.slice(0, turn.bombs) : prev));
  }, [turn.bombs]);

  const pushFx = useCallback((event: Omit<FxEvent, 'id'>, ms = 900) => {
    const id = `fx-${++fxId.current}`;
    setFx((prev) => [...prev, { ...event, id }]);
    window.setTimeout(() => {
      setFx((prev) => prev.filter((f) => f.id !== id));
    }, ms);
  }, []);

  const playStrikeCinema = useCallback((fromNation: NationId, toNation: NationId, cityId: string) => {
    const cityName =
      stateRef.current.nations[toNation]?.cities.find((c) => c.id === cityId)?.name ?? 'city';
    return new Promise<void>((resolve) => {
      cinemaResolveRef.current = resolve;
      setCinema({ from: fromNation, to: toNation, cityId, cityName });
    });
  }, []);

  const onCinemaComplete = useCallback(() => {
    setCinema(null);
    const resolve = cinemaResolveRef.current;
    cinemaResolveRef.current = null;
    resolve?.();
  }, []);

  const playStrikeRecap = useCallback((events: RoundWorldEvent[]) => {
    return new Promise<void>((resolve) => {
      // Empty aftermath — don't trap players in a "nothing happened" Continue loop
      if (events.length === 0) {
        setStrikeRecap(null);
        window.setTimeout(() => resolve(), 350);
        return;
      }
      recapResolveRef.current = resolve;
      setStrikeRecap(events);
    });
  }, []);

  const onRecapContinue = useCallback(() => {
    setStrikeRecap(null);
    const resolve = recapResolveRef.current;
    recapResolveRef.current = null;
    resolve?.();
  }, []);

  const closeHumanTurn = useCallback(
    (strikeTargets: { nationId: NationId; cityId: string }[]) => {
      setWizardStep(null);
      setTargets([]);
      setState((s) => {
        const actor =
          s.mode === 'online' && sessionUid && s.uidToNation?.[sessionUid]
            ? s.uidToNation[sessionUid]
            : currentNationId(s);
        if (!actor) return s;

        let next = s.phase === 'buy' ? finishBuyPhase(s) : s;
        next = queueStrikes(next, strikeTargets, actor);

        if (s.mode === 'online' && s.onlineGameId) {
          next = touchHumanActivity(next, actor);
          next = markHumanReady(next, actor);
          if (allAliveHumansReady(next)) {
            next = finishOnlineHumanPlanning(next);
          }
          const gameId = s.onlineGameId;
          stateRef.current = next;
          void enqueueHumanPlanningPush(gameId, actor, () => stateRef.current).then((merged) => {
            setState((cur) => {
              if (cur.onlineGameId !== gameId || cur.round !== merged.round) return cur;
              // If merge still has all humans ready but stuck in planning, finish now
              if (
                (merged.phase === 'buy' || merged.phase === 'action') &&
                allAliveHumansReady(merged) &&
                !merged.planningComplete
              ) {
                const done = finishOnlineHumanPlanning(merged);
                if (done !== merged) {
                  void pushGameState(gameId, done, true);
                  return done;
                }
              }
              return merged;
            });
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
      let nextState = s;
      if (s.mode === 'online') {
        nextState = touchHumanActivity(s, actor);
        stateRef.current = nextState;
        setState(nextState);
        syncPlanning(nextState, actor);
      }
      const next = nextWizardStep(nextState, from, actor);
      if (next == null) closeHumanTurn([]);
      else setWizardStep(next);
    },
    [closeHumanTurn, sessionUid, bumpSelectionActivity, setState, syncPlanning],
  );

  // Start turn prompts when this human can act (once per round)
  useEffect(() => {
    if (!isMyHumanTurn) {
      setWizardStep(null);
      setIdleSecondsLeft(null);
      return;
    }
    if (wizardStartedRoundRef.current === state.round) return;

    wizardStartedRoundRef.current = state.round;
    lastActivityRef.current = Date.now();
    setIdleSecondsLeft(Math.ceil(SELECTION_IDLE_MS / 1000));
    setTargets([]);
    const first = nextWizardStep(stateRef.current, null, actorId);
    if (first == null) {
      const t = window.setTimeout(() => closeHumanTurn([]), 40);
      return () => window.clearTimeout(t);
    }
    setWizardStep(first);
  }, [isMyHumanTurn, actorId, state.round, closeHumanTurn]);

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
            'You were removed for not making a selection within 60 seconds.',
          );
        }
      })();
    }, 250);

    return () => window.clearInterval(tick);
  }, [isOnline, isMyHumanTurn, myNationId, state.onlineGameId, setState]);

  // Peers: kick other humans who went idle during selection
  useEffect(() => {
    if (!isOnline || !humansPlanning || !state.onlineGameId || !sessionUid) return;

    const tick = window.setInterval(() => {
      const s = stateRef.current;
      if (!s.onlineGameId) return;
      const now = Date.now();
      for (const id of aliveHumanNations(s)) {
        if (s.humanReady?.[id]) continue;
        if (id === myNationId) continue; // local idle timer handles self
        const last =
          s.humanLastActive?.[id] ?? s.humanPlanningStartedAt ?? now;
        if (now - last < SELECTION_IDLE_MS) continue;
        void (async () => {
          const got = await tryAcquireAiLock(
            s.onlineGameId!,
            sessionUid,
            `kick-${s.round}-${id}`,
          );
          if (!got) return;
          const next = await kickIdleHumanFromGame(s.onlineGameId!, id);
          if (next) setState(next);
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
    setState,
  ]);

  // If we were kicked remotely, leave the board
  useEffect(() => {
    if (!isOnline || !sessionUid || !onKicked) return;
    const stillHere = Boolean(state.uidToNation?.[sessionUid]);
    if (stillHere) {
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
    onKicked('You were removed for not making a selection within 60 seconds.');
  }, [isOnline, sessionUid, state.uidToNation, state.phase, onKicked]);

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
        const next = runOnlineAiPlanning(s);
        if (next.mode === 'online' && next.onlineGameId && next.aiPlanningComplete) {
          void pushGameState(next.onlineGameId, next, true);
        }
        return next;
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

      let cancelled = false;
      const t = window.setTimeout(() => {
        void (async () => {
          if (cancelled || aiRunningRef.current) return;
          if (stateRef.current.planningComplete) return;
          if (state.onlineGameId && sessionUid) {
            const got = await tryAcquireAiLock(
              state.onlineGameId,
              sessionUid,
              `post-human-${state.round}`,
            );
            if (!got || cancelled) return;
          }
          aiRunningRef.current = true;
          setBusy(true);
          try {
            setState((s) => {
              if (s.phase !== 'buy' && s.phase !== 'action') return s;
              if (!allAliveHumansReady(s) || s.planningComplete) return s;
              const next = finishOnlineHumanPlanning(s);
              if (next.mode === 'online' && next.onlineGameId) {
                void pushGameState(next.onlineGameId, next, true);
              }
              return next;
            });
          } finally {
            aiRunningRef.current = false;
            setBusy(false);
          }
        })();
      }, 200);

      return () => {
        cancelled = true;
        window.clearTimeout(t);
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

  // Fair simultaneous strike resolution at round end (one lock holder; peers follow sync)
  useEffect(() => {
    if (state.phase !== 'resolveStrikes') return;
    if (resolvedRoundRef.current === state.round) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        if (isOnline && state.onlineGameId && sessionUid) {
          const got = await tryAcquireAiLock(
            state.onlineGameId,
            sessionUid,
            `resolve-${state.round}`,
          );
          // Losers wait for the lock holder's push (roundSummary / next round)
          if (!got || cancelled) return;
        }
        if (resolvedRoundRef.current === state.round) return;
        setBusy(true);
        const strikes = [...stateRef.current.pendingStrikes];
        for (const strike of strikes) {
          if (cancelled) break;
          await playStrikeCinema(strike.attackerId, strike.targetNationId, strike.cityId);
        }
        if (cancelled) {
          setBusy(false);
          return;
        }

        let resolved = stateRef.current;
        if (resolved.phase !== 'resolveStrikes') {
          setBusy(false);
          return;
        }
        for (const strike of strikes) resolved = applyQueuedStrike(resolved, strike);
        resolved = finishStrikeResolution(resolved);
        resolvedRoundRef.current = state.round;

        await playStrikeRecap(resolved.roundEvents);
        if (!cancelled) {
          if (resolved.mode === 'online' && resolved.onlineGameId) {
            if (resolved.phase === 'gameOver') {
              void finishOnlineGame(resolved.onlineGameId, resolved, sessionUid ?? undefined);
            } else {
              void pushGameState(resolved.onlineGameId, resolved, true);
            }
          }
          setState(resolved);
        }
        setBusy(false);
      })();
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      setStrikeRecap(null);
      const resolveRecap = recapResolveRef.current;
      recapResolveRef.current = null;
      resolveRecap?.();
    };
  }, [
    state.phase,
    state.round,
    state.onlineGameId,
    isOnline,
    sessionUid,
    setState,
    playStrikeCinema,
    playStrikeRecap,
  ]);

  const onSelectCity = (nationId: NationId, cityId: string) => {
    if (!strikeSelectMode || busy) return;
    if (nationId === actorId) return;
    if (turn.bombs < 1) return;
    if (turn.citiesStruckThisRound.includes(cityId)) return;
    bumpSelectionActivity();
    setTargets((prev) => {
      const exists = prev.find((t) => t.cityId === cityId);
      if (exists) return prev.filter((t) => t.cityId !== cityId);
      if (prev.length >= turn.bombs) return [...prev.slice(1), { nationId, cityId }];
      return [...prev, { nationId, cityId }];
    });
  };

  const unshieldedCities = turn.cities.filter((c) => !c.destroyed && !c.hasShield);
  const researchCities = turn.cities.filter((c) => !c.destroyed && !c.hasResearch);
  const bombMax = maxBombsPurchasable(state, actorId);
  const selectedCityIds = targets.map((t) => t.cityId);
  const pendingBombCityIds = state.pendingStrikes.map((s) => s.cityId);

  const allyIds = isOnline
    ? [actorId]
    : isHumanTurn
      ? [actorId]
      : state.turnOrder.filter((id) => state.nations[id].isHuman);
  const enemyIds = state.turnOrder.filter((id) => !allyIds.includes(id));

  return (
    <div className="screen screen--board">
      <MapBackdrop />
      <FxLayer events={fx} />
      {cinema && <StrikeCinema strike={cinema} onComplete={onCinemaComplete} />}
      {strikeRecap && <StrikeRecap events={strikeRecap} onContinue={onRecapContinue} />}

      {isMyHumanTurn && wizardStep && wizardStep !== 'strike' && (
        <div className="turn-wizard" role="dialog" aria-modal="true">
          <div className="turn-wizard__panel enter-pop">
            <WizardNationHeader
              state={state}
              nationId={actorId}
              money={turn.money}
              bombs={turn.bombs}
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
                  Free · each sanctioned rival loses 20% of their income
                </p>
                <div className="turn-wizard__actions">
                  <button
                    className="btn btn--xl btn--primary"
                    onClick={() => {
                      bumpSelectionActivity();
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
                  Tap to toggle · −20% income each · currently sanctioning{' '}
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
              environment={state.environment}
              idleSecondsLeft={isOnline ? idleSecondsLeft : null}
              compact
            />
            <div className="turn-wizard__hero turn-wizard__hero--strike">
              <img src={ART.missile} alt="" draggable={false} />
            </div>
            <h3 className="turn-wizard__q">Hit enemy cities with your bombs?</h3>
            <p className="turn-wizard__hint">
              Tap up to {turn.bombs} cities on the right
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
                onClick={() => closeHumanTurn(targets)}
              >
                Lock Targets ({targets.length})
              </button>
              <button className="btn btn--xl" onClick={() => closeHumanTurn([])}>
                Skip / No Strike
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
          </header>

          <div className="board-left__log" aria-live="polite">
            {state.log.slice(-4).map((e) => (
              <div key={e.id} className={`log-line log-line--${e.tone ?? 'neutral'}`}>
                {e.text}
              </div>
            ))}
          </div>

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
                    <p>
                      ${formatMoney(turn.money)} · Bombs {turn.bombs} · 🔍
                      {turn.cities.filter((c) => !c.destroyed && c.hasResearch).length}
                      {turn.hasNuclearTech ? ' · ☢' : ''}
                    </p>
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

            {!isHumanTurn && (state.phase === 'buy' || state.phase === 'action') && (
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
                blockedCityIds={turn.citiesStruckThisRound}
                pendingBombCityIds={pendingBombCityIds}
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
  const destroyedCityIds = state.roundEvents
    .filter((e) => e.kind === 'cityDestroyed' || e.kind === 'shieldDestroyed')
    .map((e) => e.cityId)
    .filter((id): id is string => Boolean(id));
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
  const worldIds = aftermathWorldIds(state.turnOrder, myCityIds) as NationId[];
  const isYouNation = (id: NationId) =>
    myNationId ? id === myNationId : Boolean(state.nations[id].isHuman);

  return (
    <div className="screen screen--board screen--round-report">
      <MapBackdrop />
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
                  <span>🔍 Research</span>
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
                {state.round >= state.maxRounds ? (
                  <p className="round-report__auto-hint">Showing final results…</p>
                ) : (
                  <>
                    <button className="btn btn--xl btn--primary" onClick={onContinue}>
                      {`Start Round ${state.round + 1}`}
                    </button>
                    {isOnline && (
                      <p className="round-report__auto-hint">
                        Next round starts automatically for everyone…
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="board-right round-report__world-desktop">
          <h3 className="board-section-title">World — shields, research, ruins</h3>
          <p className="round-report__legend">
            <span>🛡 Shield</span>
            <span>🔍 Research</span>
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
  const advancingRoundRef = useRef(false);
  const [rematchBusy, setRematchBusy] = useState(false);
  const [rematchError, setRematchError] = useState<string | null>(null);

  const advanceFromRoundSummary = useCallback(() => {
    setState((s) => {
      if (s.phase !== 'roundSummary') return s;
      const n = nextRound(s);
      if (n.phase === 'gameOver') {
        if (n.mode === 'online' && n.onlineGameId) {
          void finishOnlineGame(n.onlineGameId, n, sessionUid ?? undefined);
        }
        return n;
      }
      if (n.mode === 'online' && n.onlineGameId) {
        void pushGameState(n.onlineGameId, n, true);
        return n;
      }
      return advancePastAi(n);
    });
  }, [advancePastAi, sessionUid]);

  // Auto-advance aftermath: next round, or final results → game over
  useEffect(() => {
    if (state.phase !== 'roundSummary') {
      advancingRoundRef.current = false;
      return;
    }
    const isFinal = state.round >= state.maxRounds;
    if (state.mode === 'online') {
      if (!state.onlineGameId || !sessionUid) return;
      if (advancingRoundRef.current) return;

      let cancelled = false;
      const t = window.setTimeout(() => {
        void (async () => {
          if (cancelled || advancingRoundRef.current) return;
          const got = await tryAcquireAiLock(
            state.onlineGameId!,
            sessionUid,
            `next-${state.round}`,
          );
          if (!got || cancelled) return;
          advancingRoundRef.current = true;
          advanceFromRoundSummary();
        })();
      }, isFinal ? 1200 : 900);

      return () => {
        cancelled = true;
        window.clearTimeout(t);
      };
    }

    // Offline: still auto-show final results; mid-rounds need the Continue button
    if (!isFinal) return;
    const t = window.setTimeout(() => advanceFromRoundSummary(), 1200);
    return () => window.clearTimeout(t);
  }, [
    state.phase,
    state.mode,
    state.onlineGameId,
    state.round,
    state.maxRounds,
    sessionUid,
    advanceFromRoundSummary,
  ]);

  // Online game listener — preserve local nation while still planning
  useEffect(() => {
    if (!state.onlineGameId || state.mode !== 'online') return;
    const gameId = state.onlineGameId;
    const myId =
      sessionUid && state.uidToNation?.[sessionUid]
        ? state.uidToNation[sessionUid]
        : null;
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
      setState((prev) => {
        const merged = applyRemoteGameSnapshot(prev, game.state, myId);
        return {
          ...merged,
          onlineHostUid: game.hostUid ?? merged.onlineHostUid ?? null,
          onlineLobbyId: game.lobbyId ?? merged.onlineLobbyId ?? null,
        };
      });
    });
  }, [state.onlineGameId, state.mode, sessionUid, state.uidToNation]);

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
          onKicked={(message) => {
            if (sessionUid) void setPlayerStatus(sessionUid, 'available', null);
            setSessionError(message);
            setState({ ...createInitialState(), phase: 'mode' });
          }}
        />
      )}
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
