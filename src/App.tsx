import './App.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ART, SFX } from './data/art';
import { NATIONS, nationDef, COSTS } from './data/nations';
import { LEADER_SPEECHES, speechFor } from './data/speeches';
import {
  applyQueuedStrike,
  buyBombs,
  buyEnvironment,
  buyNuclearTech,
  buyShield,
  createInitialState,
  currentNationId,
  computeScore,
  endTurn,
  finishBuyPhase,
  finishStrikeResolution,
  formatMoney,
  maxBombsPurchasable,
  nextRound,
  pickCountry,
  queueStrikes,
  setMode,
  setPlayerNames,
  playerDisplayName,
  startGame,
  toggleSanction,
  citiesLeft,
} from './game/engine';
import { runAllAiUntilHumanOrSummary, runAiTurn } from './game/ai';
import type { GameMode, GameState, NationId } from './types';

type FxKind = 'buy' | 'strike-label';
type WizardStep = 'tech' | 'bombs' | 'shieldAsk' | 'shieldPick' | 'env' | 'strike';

function wizardArt(step: WizardStep): string {
  switch (step) {
    case 'tech':
      return ART.nukeTech;
    case 'bombs':
    case 'strike':
      return ART.missile;
    case 'shieldAsk':
    case 'shieldPick':
      return ART.shield;
    case 'env':
      return ART.map;
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

function NationPod({
  id,
  variant,
  state,
  selectedCityIds,
  targetable,
  blockedCityIds,
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
  /** Cities to pulse (e.g. destroyed this round) */
  highlightCityIds?: string[];
  highlight?: boolean;
  onSelectCity?: (nationId: NationId, cityId: string) => void;
}) {
  const n = state.nations[id];
  const def = nationDef(id);
  const score = computeScore(state, id).total;
  const blocked = new Set(blockedCityIds ?? []);
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
          const justHit = pulsed.has(c.id);
          const canTarget = Boolean(targetable && !c.destroyed && !hitThisRound);
          const className = `city-tile ${c.destroyed ? 'is-destroyed' : ''} ${c.hasShield ? 'has-shield' : ''} ${c.hasResearch ? 'has-research' : ''} ${selected ? 'is-selected' : ''} ${canTarget ? 'is-targetable' : ''} ${hitThisRound && !c.destroyed ? 'is-hit-this-round' : ''} ${justHit ? 'is-just-hit' : ''}`;
          const title = `${c.name} — ${cityStatusLabel(c)}`;
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
                  ? `${c.name} — already struck this round`
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
            <small>Hot-seat · rest are AI</small>
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

function canOfferTech(state: GameState): boolean {
  const n = state.nations[currentNationId(state)];
  return !n.hasNuclearTech && n.money >= COSTS.nuclearTech;
}

function canOfferBombs(state: GameState): boolean {
  const n = state.nations[currentNationId(state)];
  return n.money >= COSTS.bomb && maxBombsPurchasable(state) > 0;
}

function canOfferShield(state: GameState): boolean {
  const n = state.nations[currentNationId(state)];
  return (
    n.money >= COSTS.shield && n.cities.some((c) => !c.destroyed && !c.hasShield)
  );
}

function canOfferEnv(state: GameState): boolean {
  const n = state.nations[currentNationId(state)];
  return (
    !n.envBoughtThisRound && n.money >= COSTS.environment && state.environment < 100
  );
}

function canOfferStrike(state: GameState): boolean {
  return state.nations[currentNationId(state)].bombs > 0;
}

/** Next wizard prompt after `from` (null = start of turn). */
function nextWizardStep(state: GameState, from: WizardStep | null): WizardStep | null {
  const sequence: WizardStep[] = ['tech', 'bombs', 'shieldAsk', 'env', 'strike'];
  let start = 0;
  if (from === 'shieldPick') start = sequence.indexOf('shieldAsk') + 1;
  else if (from != null) start = sequence.indexOf(from) + 1;

  for (let i = start; i < sequence.length; i += 1) {
    const step = sequence[i];
    if (step === 'tech' && canOfferTech(state)) return 'tech';
    if (step === 'bombs' && canOfferBombs(state)) return 'bombs';
    if (step === 'shieldAsk' && canOfferShield(state)) return 'shieldAsk';
    if (step === 'env' && canOfferEnv(state)) return 'env';
    if (step === 'strike' && canOfferStrike(state)) return 'strike';
  }
  return null;
}

function GameBoard({
  state,
  setState,
}: {
  state: GameState;
  setState: React.Dispatch<React.SetStateAction<GameState>>;
}) {
  const turnId = currentNationId(state);
  const turn = state.nations[turnId];
  const def = nationDef(turnId);
  const [targets, setTargets] = useState<{ nationId: NationId; cityId: string }[]>([]);
  const [wizardStep, setWizardStep] = useState<WizardStep | null>(null);
  const [fx, setFx] = useState<FxEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [cinema, setCinema] = useState<StrikeShow | null>(null);
  const fxId = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cinemaResolveRef = useRef<(() => void) | null>(null);
  const aiRunningRef = useRef(false);

  const isResolving = state.phase === 'resolveStrikes';
  const isHumanTurn =
    (state.phase === 'buy' || state.phase === 'action') && turn.isHuman && !turn.eliminated;
  const strikeSelectMode = isHumanTurn && wizardStep === 'strike';

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

  const closeHumanTurn = useCallback(
    (strikeTargets: { nationId: NationId; cityId: string }[]) => {
      setWizardStep(null);
      setTargets([]);
      setState((s) => {
        let next = s.phase === 'buy' ? finishBuyPhase(s) : s;
        next = queueStrikes(next, strikeTargets);
        return endTurn(next);
      });
    },
    [setState],
  );

  const advanceAfter = useCallback(
    (s: GameState, from: WizardStep) => {
      const next = nextWizardStep(s, from);
      if (next == null) closeHumanTurn([]);
      else setWizardStep(next);
    },
    [closeHumanTurn],
  );

  // Start sequential turn prompts when a human's turn begins
  useEffect(() => {
    if (!isHumanTurn) {
      setWizardStep(null);
      return;
    }
    setTargets([]);
    const first = nextWizardStep(stateRef.current, null);
    if (first == null) {
      const t = window.setTimeout(() => closeHumanTurn([]), 40);
      return () => window.clearTimeout(t);
    }
    setWizardStep(first);
  }, [isHumanTurn, turnId, state.round, closeHumanTurn]);

  // AI: buy, queue strikes, end turn (strikes resolve together later)
  useEffect(() => {
    if (turn.isHuman || turn.eliminated) return;
    if (state.phase !== 'buy' && state.phase !== 'action') return;
    if (aiRunningRef.current) return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      if (cancelled || aiRunningRef.current) return;
      aiRunningRef.current = true;
      setBusy(true);
      try {
        setState((s) => runAiTurn(s));
      } finally {
        aiRunningRef.current = false;
        setBusy(false);
      }
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    state.phase,
    state.currentTurnIndex,
    state.round,
    turn.isHuman,
    turn.eliminated,
    setState,
  ]);

  // Fair simultaneous strike resolution at round end
  useEffect(() => {
    if (state.phase !== 'resolveStrikes') return;

    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        setBusy(true);
        const strikes = [...stateRef.current.pendingStrikes];
        for (const strike of strikes) {
          if (cancelled) break;
          await playStrikeCinema(strike.attackerId, strike.targetNationId, strike.cityId);
        }
        if (!cancelled) {
          setState((s) => {
            if (s.phase !== 'resolveStrikes') return s;
            let next = s;
            for (const strike of strikes) next = applyQueuedStrike(next, strike);
            return finishStrikeResolution(next);
          });
        }
        setBusy(false);
      })();
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [state.phase, state.round, setState, playStrikeCinema]);

  const onSelectCity = (nationId: NationId, cityId: string) => {
    if (!strikeSelectMode || busy) return;
    if (nationId === turnId) return;
    if (turn.bombs < 1) return;
    if (turn.citiesStruckThisRound.includes(cityId)) return;
    setTargets((prev) => {
      const exists = prev.find((t) => t.cityId === cityId);
      if (exists) return prev.filter((t) => t.cityId !== cityId);
      if (prev.length >= turn.bombs) return [...prev.slice(1), { nationId, cityId }];
      return [...prev, { nationId, cityId }];
    });
  };

  const unshieldedCities = turn.cities.filter((c) => !c.destroyed && !c.hasShield);
  const bombMax = maxBombsPurchasable(state);
  const selectedCityIds = targets.map((t) => t.cityId);

  const allyIds = isHumanTurn
    ? [turnId]
    : state.turnOrder.filter((id) => state.nations[id].isHuman);
  const enemyIds = state.turnOrder.filter((id) => !allyIds.includes(id));

  return (
    <div className="screen screen--board">
      <MapBackdrop />
      <FxLayer events={fx} />
      {cinema && <StrikeCinema strike={cinema} onComplete={onCinemaComplete} />}

      {isHumanTurn && wizardStep && wizardStep !== 'strike' && (
        <div className="turn-wizard" role="dialog" aria-modal="true">
          <div className="turn-wizard__panel enter-pop">
            <div className="modal__head">
              <img className="modal__leader" src={ART.leaders[turnId]} alt="" />
              <div>
                <h2>
                  {playerDisplayName(state, turnId).toUpperCase()} — {def.shortName}
                </h2>
                <p>
                  ${formatMoney(turn.money)} · Bombs {turn.bombs} · Env {state.environment}%
                </p>
              </div>
            </div>

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
                      const next = buyNuclearTech(stateRef.current);
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
                        const next = buyBombs(stateRef.current, n);
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
                    onClick={() => setWizardStep('shieldPick')}
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
                        const next = buyShield(stateRef.current, c.id);
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
                      const next = buyEnvironment(stateRef.current);
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
          </div>
        </div>
      )}

      {isHumanTurn && wizardStep === 'strike' && (
        <div className="turn-wizard turn-wizard--dock" role="dialog" aria-modal="true">
          <div className="turn-wizard__panel turn-wizard__panel--strike enter-pop">
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
                    return `${nationDef(t.nationId).shortName} · ${name}`;
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
            {isHumanTurn ? `${playerDisplayName(state, turnId)}` : 'Players'}
          </h3>
          <div className="board-left__nations">
            {allyIds.map((id) => (
              <NationPod
                key={id}
                id={id}
                variant="ally"
                state={state}
                selectedCityIds={selectedCityIds}
                highlight={id === turnId}
              />
            ))}
          </div>

          <div className="board-left__controls">
            {isHumanTurn && (
              <div className="panel panel--shop enter-pop">
                <div className="modal__head">
                  <img className="modal__leader" src={ART.leaders[turnId]} alt="" />
                  <div>
                    <h2>
                      {playerDisplayName(state, turnId).toUpperCase()} — {def.shortName}
                    </h2>
                    <p>
                      ${formatMoney(turn.money)} · Bombs {turn.bombs} · 🔍
                      {turn.cities.filter((c) => !c.destroyed && c.hasResearch).length}
                    </p>
                  </div>
                </div>
                <p className="upgrade-hint">
                  Answer each prompt · strikes resolve together when the round ends
                </p>
                <div className="sanction-row">
                  {enemyIds.map((nid) => {
                    const n = nationDef(nid);
                    const alive = !state.nations[nid].eliminated;
                    const active = turn.sanctions.includes(nid);
                    return (
                      <button
                        key={nid}
                        className={`sanction-chip ${active ? 'is-on' : ''}`}
                        disabled={!alive}
                        onClick={() => setState((s) => toggleSanction(s, nid))}
                      >
                        <img src={ART.leaders[nid]} alt="" />
                        {active ? 'Sanctioning' : 'Sanction'} {n.shortName}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {!isHumanTurn && (state.phase === 'buy' || state.phase === 'action') && (
              <div className="panel panel--ai enter-pop">
                <img src={ART.leaders[turnId]} alt="" />
                <h2>{def.leader} is acting…</h2>
                <p>
                  {def.name} · Cities {citiesLeft(state, turnId)}/3 · Bombs {turn.bombs}
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
                highlight={id === turnId}
                onSelectCity={strikeSelectMode ? onSelectCity : undefined}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function formatRoundEvent(e: GameState['roundEvents'][number]): string {
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

function RoundSummary({
  state,
  onContinue,
}: {
  state: GameState;
  onContinue: () => void;
}) {
  const destroyedCityIds = state.roundEvents
    .filter((e) => e.kind === 'cityDestroyed' || e.kind === 'shieldDestroyed')
    .map((e) => e.cityId)
    .filter((id): id is string => Boolean(id));
  const eliminated = state.roundEvents.filter((e) => e.kind === 'nationEliminated');
  const strikes = state.roundEvents.filter((e) => e.kind !== 'nationEliminated');
  const humanIds = state.turnOrder.filter((id) => state.nations[id].isHuman);
  const rivalIds = state.turnOrder.filter((id) => !state.nations[id].isHuman);

  return (
    <div className="screen screen--board screen--round-report">
      <MapBackdrop />
      <div className="board-split">
        <section className="board-left">
          <header className="board-left__hud">
            <EnvMeter value={state.environment} />
            <div className="round-pill">ROUND {state.round} AFTERMATH</div>
          </header>

          <h3 className="board-section-title">Your nations</h3>
          <div className="board-left__nations">
            {humanIds.map((id) => (
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

          <div className="board-left__controls">
            <div className="panel panel--shop round-report__panel">
              <h2 className="round-report__panel-title">What happened</h2>
              {state.roundEvents.length === 0 ? (
                <p className="round-report__empty">No cities were hit this round. The board stands.</p>
              ) : (
                <ul className="round-report__event-list">
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

              <h2 className="round-report__panel-title">Scores</h2>
              <div className="score-cards score-cards--compact">
                {state.roundScores.map((row, i) => (
                  <div
                    key={row.nationId}
                    className={`score-card ${row.eliminated ? 'is-out' : ''} ${i === 0 ? 'is-lead' : ''}`}
                  >
                    <img src={ART.leaders[row.nationId]} alt="" />
                    <div>
                      <strong>
                        #{i + 1} {nationDef(row.nationId).name}
                      </strong>
                      <span>
                        Cities {row.citiesLeft} · Survived {row.citySurvivalPoints} · 🔍
                        {row.researchCenters} · 🛡{row.shields}
                      </span>
                    </div>
                    <em>{row.total}</em>
                  </div>
                ))}
              </div>

              <button className="btn btn--xl btn--primary" onClick={onContinue}>
                {state.round >= state.maxRounds ? 'Final Results' : `Start Round ${state.round + 1}`}
              </button>
            </div>
          </div>
        </section>

        <section className="board-right">
          <h3 className="board-section-title">World — shields, research, ruins</h3>
          <p className="round-report__legend">
            <span>🛡 Shield</span>
            <span>🔍 Research</span>
            <span className="round-report__legend-burnt">Burnt = destroyed</span>
          </p>
          <div className="board-right__nations">
            {rivalIds.map((id) => (
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

function GameOver({ state, onRestart }: { state: GameState; onRestart: () => void }) {
  const winnerName =
    state.winner && state.winner !== 'draw' ? nationDef(state.winner).name : 'No one';
  return (
    <div className="screen screen--splash">
      <MapBackdrop />
      <div className="splash-veil splash-veil--fire" />
      <div className="splash-content">
        {state.winner && state.winner !== 'draw' && (
          <img className="winner-art enter-pop" src={ART.leaders[state.winner]} alt="" />
        )}
        <h1 className="stencil-title">
          {state.winner === 'draw' ? 'MUTUAL DESTRUCTION' : 'SUPERPOWER'}
        </h1>
        <p className="tagline">
          {state.winner === 'draw' ? 'The world burns. Nobody wins.' : `${winnerName} dominates the board.`}
        </p>
        <EnvMeter value={state.environment} />
        <button className="btn btn--xl btn--primary" onClick={onRestart}>
          Play Again
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<GameState>(() => createInitialState());
  const advancePastAi = useCallback((s: GameState) => runAllAiUntilHumanOrSummary(s), []);

  return (
    <div className="app-shell">
      {state.phase === 'mode' && <ModeSelect onSelect={(m) => setState((s) => setMode(s, m))} />}
      {state.phase === 'names' && (
        <PlayerNames
          onContinue={(n1, n2) => setState((s) => setPlayerNames(s, n1, n2))}
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
        <GameBoard state={state} setState={setState} />
      )}
      {state.phase === 'roundSummary' && (
        <RoundSummary
          state={state}
          onContinue={() =>
            setState((s) => {
              const n = nextRound(s);
              if (n.phase === 'gameOver') return n;
              return advancePastAi(n);
            })
          }
        />
      )}
      {state.phase === 'gameOver' && (
        <GameOver state={state} onRestart={() => setState(createInitialState())} />
      )}
    </div>
  );
}
