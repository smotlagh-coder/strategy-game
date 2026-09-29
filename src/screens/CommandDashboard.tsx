import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ART } from '../data/art';
import {
  COSTS,
  DRONE_DAMAGE,
  LASER_INTERCEPTS_PER_ROUND,
  MAX_BOMBS_PER_ROUND,
  MAX_DRONES_PER_ROUND,
  MAX_HYDROGEN_PER_GAME,
  MAX_MAGNETIC_PER_GAME,
  MAX_SANCTIONS,
  MAX_SHIELDS_PER_ROUND,
  RESEARCH_INCOME,
  nationDef,
} from '../data/nations';
import {
  buyRebuild,
  buyResearch,
  buyShield,
  buySpyNetwork,
  buyUnderground,
  canBuyRebuild,
  canBuyResearch,
  canBuyShield,
  canBuySpyNetwork,
  canBuyUnderground,
  formatMoney,
  sanctionsLeft,
  toggleSanction,
  totalWarheads,
} from '../game/engine';
import { findDefenceOrders, findIntelAdvice, findOffenceOrders } from '../game/briefing';
import {
  aerospaceBundleCost,
  ballisticBundleCost,
  buyBombsBundled,
  buyDronesBundled,
  buyHydrogenBundled,
  buyLaserBundled,
  buyMagneticBundled,
  canBuyLaserBundled,
  isTreasuryLow,
  maxBombsBundled,
  maxDronesBundled,
  maxHydrogenBundled,
  maxMagneticBundled,
} from '../game/bundles';
import type { BriefingOrderIcon } from '../game/briefing';
import { PURCHASE_WINDOW_MS } from '../lib/onlineConstants';
import { useFitToWindow } from '../lib/useFitToWindow';
import type { City, GameState, NationId } from '../types';

type CityPick = 'research' | 'underground' | 'rebuild' | 'shield' | 'laser';
type CardStatus = 'ready' | 'owned' | 'locked' | 'poor' | 'idle';

/** How long the low-treasury notice shows before the turn moves on. */
const LOW_TREASURY_NOTICE_MS = 3000;

const cash = (amount: number) => `$${formatMoney(amount)}`;

const PICK_TITLE: Record<CityPick, string> = {
  research: 'Research Center',
  underground: 'Bunker',
  rebuild: 'Rebuild',
  shield: 'Shield',
  laser: 'Laser network',
};

const PICK_COST: Record<CityPick, number> = {
  research: COSTS.research,
  underground: COSTS.underground,
  rebuild: COSTS.rebuild,
  shield: COSTS.shield,
  laser: COSTS.laser,
};

const ADVICE_ICON: Partial<Record<BriefingOrderIcon, string>> = {
  shield: ART.cop.shield,
  bunker: ART.cop.bunker,
  laser: ART.cop.laser,
  rebuild: ART.cop.rebuild,
};

/** Why a city cannot take this purchase, or undefined when it can. */
function blockedReason(pick: CityPick, city: City): string | undefined {
  if (pick === 'rebuild') return city.destroyed ? undefined : 'Standing';
  if (city.destroyed) return 'In rubble';
  if (pick === 'research' && city.hasResearch) return 'Has a lab';
  if (pick === 'underground' && city.isUnderground) return 'Bunker';
  if (pick === 'shield') {
    if (city.isUnderground) return 'Bunker — safe';
    if (city.hasShield) return 'Shielded';
  }
  if (pick === 'laser' && city.hasLaser) return 'Has lasers';
  return undefined;
}

type View = 'hub' | 'offence' | 'defence' | 'finance';
type Section = Exclude<View, 'hub'>;

const PAGE_TITLE: Record<Section, string> = {
  offence: 'Offence',
  defence: 'Defence',
  finance: 'Finance & Intel',
};

const PAGE_TAGLINE: Record<Section, string> = {
  offence: 'Take cities off rivals',
  defence: 'Keep what you have',
  finance: 'Grow income, see the map',
};

type PieIcon = {
  key: string;
  art: string;
  label: string;
  /** The player owns or has stocked this one. */
  lit: boolean;
  count?: number;
};

type PieSection = {
  id: Section;
  title: string;
  /** Angle (degrees, 0 = right, -90 = top) of the wedge's middle. */
  center: number;
  icons: PieIcon[];
  advised: boolean;
};

const WEDGE_SPAN = 120;
/** Angular gap left between wedges so they read as separate glass plates. */
const WEDGE_GAP = 3.2;
const PIE_OUTER = 47.5;
const PIE_INNER = 14.5;
const SECTION_COLOR: Record<Section, string> = {
  // Phosphor greens, told apart by shade
  offence: '#5dff7a',
  defence: '#2ee6a6',
  finance: '#b8ff5c',
};

function polar(angleDeg: number, radius: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: 50 + radius * Math.cos(a), y: 50 + radius * Math.sin(a) };
}

const pt = (p: { x: number; y: number }) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`;

/** A ring segment: outer arc, straight edge in, inner arc back. */
function platePath(center: number) {
  const half = WEDGE_SPAN / 2 - WEDGE_GAP / 2;
  const o1 = polar(center - half, PIE_OUTER);
  const o2 = polar(center + half, PIE_OUTER);
  const i2 = polar(center + half, PIE_INNER);
  const i1 = polar(center - half, PIE_INNER);
  return `M${pt(o1)} A${PIE_OUTER} ${PIE_OUTER} 0 0 1 ${pt(o2)} L${pt(i2)} A${PIE_INNER} ${PIE_INNER} 0 0 0 ${pt(i1)} Z`;
}

/** A thin arc along a wedge at one radius, covering `fraction` of the span. */
function arcPath(center: number, radius: number, fraction: number, span = 84) {
  const start = center - span / 2;
  const end = start + span * Math.max(0, Math.min(1, fraction));
  const a = polar(start, radius);
  const b = polar(end, radius);
  return `M${pt(a)} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${pt(b)}`;
}

/** Spread n icons along one arc so every wedge reads as a tidy fan. */
function iconAngles(center: number, n: number) {
  const step = n >= 6 ? 17 : n === 4 ? 22 : 26;
  return Array.from({ length: n }, (_, i) => center + (i - (n - 1) / 2) * step);
}

/**
 * The command map: three glass plates around a hub. Each plate lists what
 * lives inside it and how much of it you already have; icons you own glow.
 * The hub ring is the purchasing clock.
 */
function CopPie({
  sections,
  leaderSrc,
  progress,
  urgent,
  onOpen,
}: {
  sections: PieSection[];
  leaderSrc: string;
  /** Purchasing time left, 1 → 0. */
  progress: number;
  urgent: boolean;
  onOpen: (section: Section) => void;
}) {
  const ringR = 10.6;
  const ringLen = 2 * Math.PI * ringR;
  return (
    <div className="cop-pie" role="group" aria-label="Command map">
      <svg viewBox="0 0 100 100" className="cop-pie__svg">
        <defs>
          {sections.map((sec) => (
            <radialGradient
              key={sec.id}
              id={`cop-grad-${sec.id}`}
              gradientUnits="userSpaceOnUse"
              cx="50"
              cy="50"
              r={PIE_OUTER}
            >
              <stop offset="0.25" stopColor={SECTION_COLOR[sec.id]} stopOpacity="0" />
              <stop offset="0.7" stopColor={SECTION_COLOR[sec.id]} stopOpacity="0" />
              <stop offset="1" stopColor={SECTION_COLOR[sec.id]} stopOpacity="0.03" />
            </radialGradient>
          ))}
        </defs>

        <circle cx="50" cy="50" r="49.2" className="cop-pie__ticks" />
        <circle cx="50" cy="50" r="49.7" className="cop-pie__halo" />

        {sections.map((sec) => {
          const lit = sec.icons.filter((i) => i.lit).length;
          return (
            <g
              key={sec.id}
              className={`cop-pie__plate cop-pie__plate--${sec.id}`}
              style={{ ['--tone' as string]: SECTION_COLOR[sec.id] }}
            >
              <path d={platePath(sec.center)} className="cop-pie__base" />
              <path
                d={platePath(sec.center)}
                className="cop-pie__wedge"
                fill={`url(#cop-grad-${sec.id})`}
                role="button"
                tabIndex={0}
                aria-label={`${PAGE_TITLE[sec.id]} — open`}
                onClick={() => onOpen(sec.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen(sec.id);
                  }
                }}
              />
              <path d={arcPath(sec.center, PIE_INNER + 2.4, 1)} className="cop-pie__track" />
              <path
                d={arcPath(sec.center, PIE_INNER + 2.4, lit / sec.icons.length)}
                className="cop-pie__meter"
              />
            </g>
          );
        })}

        <circle cx="50" cy="50" r={PIE_INNER - 2.2} className="cop-pie__hubdisc" />
        <circle cx="50" cy="50" r={ringR} className="cop-pie__ring-track" />
        <circle
          cx="50"
          cy="50"
          r={ringR}
          className={`cop-pie__ring${urgent ? ' is-urgent' : ''}`}
          strokeDasharray={ringLen}
          strokeDashoffset={ringLen * (1 - Math.max(0, Math.min(1, progress)))}
          transform="rotate(-90 50 50)"
        />
      </svg>

      {sections.map((sec) => {
        const lit = sec.icons.filter((i) => i.lit).length;
        const label = polar(sec.center, 25);
        return (
          <div
            key={sec.id}
            className="cop-pie__group"
            style={{ ['--tone' as string]: SECTION_COLOR[sec.id] }}
          >
            <div
              className={`cop-pie__label cop-pie__label--${sec.id}`}
              style={{ left: `${label.x}%`, top: `${label.y}%` }}
            >
              <b>{sec.title}</b>
              <span className="cop-pie__count">
                {lit}/{sec.icons.length}
              </span>
              {sec.advised && <em className="cop-pie__star">★ Advisor</em>}
            </div>
            {iconAngles(sec.center, sec.icons.length).map((angle, i) => {
              const icon = sec.icons[i];
              const at = polar(angle, 39);
              return (
                <span
                  key={icon.key}
                  className={`cop-pie__icon${icon.lit ? ' is-lit' : ''}`}
                  style={{ left: `${at.x}%`, top: `${at.y}%` }}
                  title={`${icon.label}${icon.lit ? ' — yours' : ''}`}
                >
                  <img src={icon.art} alt="" draggable={false} />
                  {icon.count != null && icon.count > 0 && <em>{icon.count}</em>}
                </span>
              );
            })}
          </div>
        );
      })}

      <div className="cop-pie__hub" aria-hidden>
        <img src={leaderSrc} alt="" draggable={false} />
      </div>
    </div>
  );
}

function CopCard({
  art,
  name,
  price,
  priceNote,
  status,
  advised,
  children,
  detail,
  onPress,
  locked,
  active,
  cta,
}: {
  art: string;
  name: string;
  price: string;
  priceNote?: string;
  status: CardStatus;
  advised?: boolean;
  detail: ReactNode;
  children?: ReactNode;
  /** Cards without quantities are one big button: tapping anywhere buys. */
  onPress?: () => void;
  /** Nothing to buy here right now: the whole card greys out. */
  locked?: boolean;
  /** This card is waiting for a city to be picked. */
  active?: boolean;
  /** What tapping does (or why it cannot), shown where the button used to be. */
  cta?: ReactNode;
}) {
  const tap = onPress != null;
  const press = () => {
    if (tap && !locked) onPress();
  };
  return (
    <article
      className={`cop-card is-${status}${advised ? ' is-advised' : ''}${tap ? ' cop-card--tap' : ''}${
        tap && locked ? ' is-off' : ''
      }${active ? ' is-active' : ''}`}
      {...(tap
        ? {
            role: 'button',
            tabIndex: locked ? -1 : 0,
            'aria-disabled': locked ? true : undefined,
            onClick: press,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                press();
              }
            },
          }
        : {})}
    >
      <img className="cop-card__art" src={art} alt="" draggable={false} />
      <div className="cop-card__body">
        <h4>
          {name}
          {advised && (
            <span className="cop-card__star" title="Your advisor recommends this">
              ★ Advisor
            </span>
          )}
        </h4>
        <p>{detail}</p>
      </div>
      <div className="cop-card__buy">
        <span className="cop-card__price">
          {price}
          {priceNote && <small>{priceNote}</small>}
        </span>
        <div className="cop-card__actions">
          {children}
          {tap && cta != null && <span className="cop-card__cta">{cta}</span>}
        </div>
      </div>
    </article>
  );
}

/**
 * The whole turn on one screen: treasury first, then everything that can be
 * bought split into what it does to rivals (offence) and what it does for you
 * (defence and economy). Nothing is asked in sequence, so no purchase is
 * decided without seeing the others — and every price sits next to its button.
 */
export function CommandDashboard({
  state,
  actorId,
  leaderSrc,
  deadline,
  othersPending,
  rivals,
  rivalArt,
  onOrder,
  onProceed,
}: {
  state: GameState;
  actorId: NationId;
  leaderSrc: string;
  /** Wall-clock time (ms) at which the purchasing window closes. */
  deadline: number;
  /** Online: other commanders still ordering; null offline. */
  othersPending: number | null;
  rivals: NationId[];
  rivalArt: (id: NationId) => string;
  /** Apply an order to the live state (and sync it when online). */
  onOrder: (fn: (s: GameState) => GameState, label?: string) => void;
  onProceed: () => void;
}) {
  const [pick, setPick] = useState<CityPick | null>(null);
  const [view, setView] = useState<View>('hub');
  // Roomy windows (iPad landscape, desktop) grow the page so it reads at a glance
  const fitRef = useFitToWindow<HTMLDivElement>(1120, 0.45, view !== 'hub', 1.7);
  const me = state.nations[actorId];
  const openView = (next: View) => {
    setPick(null);
    setView(next);
  };

  // Purchasing is timed: at zero the player moves on whatever is bought so far.
  const [msLeft, setMsLeft] = useState(() => Math.max(0, deadline - Date.now()));
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const proceedRef = useRef(onProceed);
  proceedRef.current = onProceed;
  // However it is triggered (timer, low treasury, the button) the turn moves on once
  const proceededRef = useRef(false);
  const proceed = () => {
    if (proceededRef.current) return;
    proceededRef.current = true;
    proceedRef.current();
  };
  const proceedNowRef = useRef(proceed);
  proceedNowRef.current = proceed;
  useEffect(() => {
    let fired = false;
    const check = () => {
      const left = deadline - Date.now();
      setMsLeft(Math.max(0, left));
      if (left <= 0 && !fired) {
        fired = true;
        proceedNowRef.current();
      }
    };
    check();
    const tick = window.setInterval(check, 200);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [deadline]);
  const secondsLeft = Math.ceil(msLeft / 1000);

  // Nothing left to buy with what is in the treasury: say so for a moment, then move on.
  const lowTreasury = isTreasuryLow(state, actorId);
  const [lowUntil, setLowUntil] = useState<number | null>(null);
  useEffect(() => {
    if (!lowTreasury) {
      setLowUntil(null);
      return;
    }
    setLowUntil((prev) => prev ?? Date.now() + LOW_TREASURY_NOTICE_MS);
  }, [lowTreasury]);
  useEffect(() => {
    if (lowUntil == null) return;
    const wait = Math.max(0, lowUntil - Date.now());
    const t = window.setTimeout(() => proceedNowRef.current(), wait);
    return () => window.clearTimeout(t);
  }, [lowUntil]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pickRef.current) setPick(null);
        else setView('hub');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const money = me.money;
  const need = (cost: number) => Math.max(0, +(cost - money).toFixed(2));
  const canPay = (cost: number) => money >= cost;

  const defenceOrders = useMemo(() => findDefenceOrders(state, actorId), [state, actorId]);
  const offenceOrders = useMemo(() => findOffenceOrders(state, actorId), [state, actorId]);
  const adviceByCity = new Map<string, BriefingOrderIcon>();
  for (const order of defenceOrders) {
    if (order.icon !== 'hold') adviceByCity.set(order.cityId, order.icon);
  }
  const advisedDefence = new Set(defenceOrders.map((o) => o.icon));
  const advisedOffence = new Set(offenceOrders.map((o) => o.icon));
  const intelAdvice = useMemo(
    () => findIntelAdvice(state, actorId, defenceOrders, offenceOrders),
    [state, actorId, defenceOrders, offenceOrders],
  );
  const advisedIntel = new Set(intelAdvice.map((a) => a.kind));
  const advisedSanction = intelAdvice.find((a) => a.kind === 'sanction')?.nationId ?? null;

  const warheads = totalWarheads(me);
  // Tech is bundled into the first warhead / drone pack / laser, so it is never a card of its own
  const bombMax = maxBombsBundled(state, actorId);
  const hydrogenMax = maxHydrogenBundled(state, actorId);
  const magneticMax = maxMagneticBundled(state, actorId);
  const droneMax = maxDronesBundled(state, actorId);
  const ballisticExtra = ballisticBundleCost(state, actorId);
  const aerospaceExtra = aerospaceBundleCost(state, actorId);
  const ballisticNote = ballisticExtra > 0 ? ` · +${cash(ballisticExtra)} tech, once` : '';
  const ballisticDetail =
    ballisticExtra > 0
      ? `First one also unlocks Ballistic Missile Tech (${cash(ballisticExtra)}, once). `
      : '';
  const aerospaceDetail =
    aerospaceExtra > 0
      ? `First one also unlocks Aerospace Tech (${cash(aerospaceExtra)}, once). `
      : '';
  const rubble = me.cities.filter((c) => c.destroyed).length;
  const hasBunker = me.cities.some((c) => c.isUnderground && !c.destroyed);
  const hasLaserNet = me.cities.some((c) => c.hasLaser && !c.destroyed);
  const slotsLeft = sanctionsLeft(state, actorId);

  const pickable: Record<CityPick, boolean> = {
    research: canBuyResearch(state, actorId),
    underground: canBuyUnderground(state, actorId),
    rebuild: canBuyRebuild(state, actorId),
    shield: canBuyShield(state, actorId),
    laser: canBuyLaserBundled(state, actorId),
  };

  // A page with nothing left to buy sends the player back to the command map so
  // there is no Back button to hunt for. Sanctions are free and always
  // reachable from their wedge, so they do not keep the Intel page open.
  const pageEmpty: Record<Exclude<View, 'hub'>, boolean> = {
    offence: bombMax + hydrogenMax + magneticMax + droneMax === 0,
    defence: !pickable.underground && !pickable.rebuild && !pickable.shield && !pickable.laser,
    finance: !pickable.research && !canBuySpyNetwork(state, actorId),
  };
  const emptyHere = view !== 'hub' && pageEmpty[view];
  const viewSeenRef = useRef<View>('hub');
  const enteredEmptyRef = useRef(false);
  useEffect(() => {
    if (view === 'hub') {
      viewSeenRef.current = 'hub';
      return;
    }
    // Opening a page that is already spent is the player's choice: leave it be.
    if (viewSeenRef.current !== view) {
      viewSeenRef.current = view;
      enteredEmptyRef.current = emptyHere;
    }
    if (!emptyHere || enteredEmptyRef.current || lowTreasury || pick) return;
    // Short beat so the last purchase visibly lands before the page closes
    const t = window.setTimeout(() => setView('hub'), 700);
    return () => window.clearTimeout(t);
  }, [view, emptyHere, lowTreasury, pick]);

  const buyInto = (city: City) => {
    if (!pick) return;
    const kind = pick;
    setPick(null);
    if (kind === 'research')
      onOrder((s) => buyResearch(s, city.id, actorId), `Research in ${city.name}`);
    if (kind === 'underground') {
      onOrder((s) => buyUnderground(s, city.id, actorId), `${city.name} goes underground`);
    }
    if (kind === 'rebuild') onOrder((s) => buyRebuild(s, city.id, actorId), `${city.name} rebuilt`);
    if (kind === 'shield') onOrder((s) => buyShield(s, city.id, actorId), `Shield on ${city.name}`);
    if (kind === 'laser') {
      onOrder((s) => buyLaserBundled(s, city.id, actorId), `Laser network — ${city.name}`);
    }
  };

  /** Tapping the whole card opens the city strip for one purchase. */
  const cityTap = (kind: CityPick, label: string) => {
    const cost = pickCost(kind);
    const locked = !pickable[kind];
    return {
      onPress: () => setPick(pick === kind ? null : kind),
      locked,
      active: pick === kind,
      cta: !canPay(cost)
        ? `Need ${cash(need(cost))}`
        : locked
          ? 'Unavailable'
          : pick === kind
            ? 'Pick a city ↑'
            : label,
    };
  };

  const qtyButtons = (counts: readonly number[], max: number, buy: (n: number) => void) =>
    counts.map((n) => (
      <button
        key={n}
        type="button"
        className="cop-btn cop-btn--qty"
        disabled={n > max}
        onClick={() => buy(n)}
        aria-label={`Buy ${n}`}
      >
        {n}
      </button>
    ));

  /** A laser network's price includes Aerospace Tech until the nation owns it. */
  const pickCost = (kind: CityPick) => PICK_COST[kind] + (kind === 'laser' ? aerospaceExtra : 0);

  const citiesStrip = (
    <div className={`cop-cities${pick ? ' is-picking' : ''}`} aria-label="Your cities">
      {pick && (
        <p className="cop-cities__prompt">
          <b>
            {PICK_TITLE[pick]} · {cash(pickCost(pick))}
          </b>{' '}
          — tap a city
          {pick === 'underground' ? ' (this is your one bunker; a shield on it is scrapped)' : ''}
          <button type="button" className="cop-link" onClick={() => setPick(null)}>
            Cancel
          </button>
        </p>
      )}
      <div className="cop-cities__row">
        {me.cities.map((city) => {
          const reason = pick ? blockedReason(pick, city) : undefined;
          const cover = city.isUnderground && !city.destroyed;
          const advice = adviceByCity.get(city.id);
          const inner = (
            <>
              <span className="cop-city__art">
                <img
                  src={cover ? ART.citiesUnderground[city.id] : ART.cities[city.id]}
                  alt=""
                  draggable={false}
                />
                {city.hasShield && !city.isUnderground && !city.destroyed && (
                  <i className="cop-city__dome" aria-hidden />
                )}
                {advice && !pick && view === 'defence' && ADVICE_ICON[advice] && (
                  <img
                    className="cop-city__advice"
                    src={ADVICE_ICON[advice]}
                    alt=""
                    title="Advisor: cover this city"
                    draggable={false}
                  />
                )}
              </span>
              <b>{city.name}</b>
              <span className="cop-city__tags">
                {city.destroyed && <em className="is-bad">Rubble</em>}
                {cover && <em>Bunker</em>}
                {city.hasShield && !city.isUnderground && !city.destroyed && <em>Shield</em>}
                {city.hasLaser && !city.destroyed && <em>Laser</em>}
                {city.hasResearch && !city.destroyed && <em>Lab</em>}
                {!city.destroyed &&
                  !cover &&
                  !city.hasShield &&
                  !city.hasLaser &&
                  !city.hasResearch && <em className="is-open">Open</em>}
                {reason && <em className="is-bad">{reason}</em>}
              </span>
            </>
          );
          return pick ? (
            <button
              key={city.id}
              type="button"
              className={`cop-city is-pickable${city.destroyed ? ' is-rubble' : ''}`}
              disabled={Boolean(reason)}
              onClick={() => buyInto(city)}
            >
              {inner}
            </button>
          ) : (
            <div
              key={city.id}
              className={`cop-city${city.destroyed ? ' is-rubble' : ''}${
                advice ? ' is-advised' : ''
              }`}
            >
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );

  const ownedShields = me.cities.filter(
    (c) => c.hasShield && !c.isUnderground && !c.destroyed,
  ).length;
  const labs = me.cities.filter((c) => c.hasResearch && !c.destroyed).length;
  const rebuiltStanding = me.cities.filter((c) => c.rebuiltRound != null && !c.destroyed).length;
  const pieSections: PieSection[] = [
    {
      id: 'offence',
      title: 'Offence',
      center: -90,
      advised: advisedOffence.size > 0,
      icons: [
        {
          key: 'nuke',
          art: ART.missile,
          label: 'Nuclear warheads',
          lit: me.bombs > 0,
          count: me.bombs,
        },
        {
          key: 'magnetic',
          art: ART.missileMagnetic,
          label: 'Magnetic bombs',
          lit: (me.magneticBombs ?? 0) > 0,
          count: me.magneticBombs ?? 0,
        },
        {
          key: 'hydrogen',
          art: ART.missileHydrogen,
          label: 'Hydrogen bomb',
          lit: (me.hydrogenBombs ?? 0) > 0,
          count: me.hydrogenBombs ?? 0,
        },
        {
          key: 'drone',
          art: ART.cop.drone,
          label: 'Drone packs',
          lit: me.drones > 0,
          count: me.drones,
        },
      ],
    },
    {
      id: 'defence',
      title: 'Defence',
      center: 30,
      advised: [...advisedDefence].some((i) => i !== 'hold'),
      icons: [
        {
          key: 'shield',
          art: ART.cop.shield,
          label: 'Shield',
          lit: ownedShields > 0,
          count: ownedShields,
        },
        { key: 'bunker', art: ART.cop.bunker, label: 'Bunker', lit: hasBunker },
        {
          key: 'laser',
          art: ART.cop.laser,
          label: 'Laser network',
          lit: hasLaserNet,
        },
        {
          key: 'rebuild',
          art: ART.cop.rebuild,
          label: 'Rebuild',
          lit: rebuiltStanding > 0,
          count: rebuiltStanding,
        },
      ],
    },
    {
      id: 'finance',
      title: 'Finance & Intel',
      center: 150,
      advised: intelAdvice.length > 0,
      icons: [
        {
          key: 'research',
          art: ART.cop.research,
          label: 'Research Center',
          lit: labs > 0,
          count: labs,
        },
        {
          key: 'sanctions',
          art: ART.cop.sanction,
          label: 'Sanctions',
          lit: me.sanctions.length > 0,
          count: me.sanctions.length,
        },
        {
          key: 'spy',
          art: ART.cop.spy,
          label: 'Spy service',
          lit: me.hasSpyNetwork,
        },
      ],
    },
  ];

  const hasStrike = warheads > 0 || me.drones > 0;

  const clock = (
    <div
      className={`cop__clock${secondsLeft <= 10 ? ' is-urgent' : ''}`}
      role="timer"
      aria-label="Purchasing time left"
    >
      <span className="cop__clock-label">
        {secondsLeft > 0 ? 'Purchasing closes' : 'Time is up'}
      </span>
      <b>{secondsLeft}s</b>
      <i aria-hidden>
        <em style={{ width: `${Math.min(100, (msLeft / PURCHASE_WINDOW_MS) * 100)}%` }} />
      </i>
    </div>
  );

  const treasury = (
    <div className="cop__treasury" aria-label="Treasury">
      <span>TREASURY</span>
      <b>{cash(money)}</b>
    </div>
  );

  return (
    <div className="cop" role="dialog" aria-modal="true" aria-label="Command dashboard">
      <div
        className="cop__flag"
        style={{ backgroundImage: `url(${ART.flags[actorId]})` }}
        aria-hidden
      />
      <div className="cop__veil" />

      {view === 'hub' ? (
        <div className="cop__hub cop__view cop__view--hub" key="hub">
          <CopPie
            sections={pieSections}
            leaderSrc={leaderSrc}
            progress={msLeft / PURCHASE_WINDOW_MS}
            urgent={secondsLeft <= 10}
            onOpen={openView}
          />

          <div className="cop__corner cop__corner--tl">{treasury}</div>
          <div className="cop__corner cop__corner--tr">{clock}</div>

          <div className="cop__corner cop__corner--bl">
            <p className="cop__status">
              {hasStrike
                ? `Ready to fire: ${warheads} warhead${warheads === 1 ? '' : 's'} · ${me.drones} drone pack${
                    me.drones === 1 ? '' : 's'
                  }`
                : 'Nothing armed yet'}
            </p>
            {othersPending != null && othersPending > 0 && (
              <p className="cop__status is-waiting">
                {othersPending} other commander{othersPending === 1 ? ' is' : 's are'} still
                ordering
              </p>
            )}
            <p className="cop__hint">Tap a wedge to open it · shining icons are yours</p>
          </div>

          <div className="cop__corner cop__corner--br">
            <button
              type="button"
              className={`cop-target${hasStrike ? '' : ' is-lock'}`}
              onClick={proceed}
              aria-label={hasStrike ? 'Choose targets' : 'Lock orders'}
            >
              <span className="cop-target__disc">
                {hasStrike ? (
                  <svg viewBox="0 0 48 48" aria-hidden>
                    <circle cx="24" cy="24" r="15" />
                    <circle cx="24" cy="24" r="7" />
                    <circle cx="24" cy="24" r="1.8" className="dot" />
                    <path d="M24 3v10M24 35v10M3 24h10M35 24h10" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 48 48" aria-hidden>
                    <path d="M12 25l8 8 16-18" className="tick" />
                  </svg>
                )}
              </span>
              <span className="cop-target__label">
                {hasStrike ? 'Choose targets' : 'Lock orders'}
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="cop__fit" ref={fitRef} key="fit">
          <div className="cop__panel enter-pop">
            <header className="cop__bar">
              <button type="button" className="cop-back" onClick={() => openView('hub')}>
                ← Command map
              </button>
              <h3 className={`cop__page-title cop__page-title--${view}`}>
                <span>{PAGE_TITLE[view]}</span>
                <em>{PAGE_TAGLINE[view]}</em>
              </h3>
              <div className="cop__bar-end">
                {clock}
                {treasury}
              </div>
            </header>

            <div className={`cop__view cop__view--${view}`} key={view}>
              {view === 'offence' && (
                <section className="cop__page cop__page--offence" aria-label="Offence">
                  <CopCard
                    art={ART.missile}
                    name="Nuclear warheads"
                    price={cash(COSTS.bomb)}
                    priceNote={`each${ballisticNote}`}
                    status={bombMax > 0 ? 'ready' : 'poor'}
                    advised={advisedOffence.has('nuke')}
                    detail={`${ballisticDetail}In stock ${me.bombs} · ${MAX_BOMBS_PER_ROUND - me.bombsBoughtThisRound} more this round. Stops at shields without a swarm; breaks on bunkers.`}
                  >
                    {qtyButtons([1, 2, 3], bombMax, (n) =>
                      onOrder((s) => buyBombsBundled(s, n, actorId), `+${n} Nuclear`),
                    )}
                  </CopCard>

                  <CopCard
                    art={ART.missileMagnetic}
                    name="Magnetic bombs"
                    price={cash(COSTS.bombMagnetic)}
                    priceNote={`each${ballisticNote}`}
                    status={magneticMax > 0 ? 'ready' : 'poor'}
                    advised={advisedOffence.has('magnetic')}
                    detail={`${ballisticDetail}Kills laser networks so swarms get through · ${
                      MAX_MAGNETIC_PER_GAME - (me.magneticBought ?? 0)
                    } left in the game · stock ${me.magneticBombs ?? 0}`}
                  >
                    {qtyButtons([1, 2], magneticMax, (n) =>
                      onOrder((s) => buyMagneticBundled(s, n, actorId), `+${n} Magnetic`),
                    )}
                  </CopCard>

                  <CopCard
                    art={ART.missileHydrogen}
                    name="Hydrogen bomb"
                    price={cash(COSTS.bombHydrogen)}
                    priceNote={ballisticExtra > 0 ? `${ballisticNote.slice(3)}` : undefined}
                    status={hydrogenMax > 0 ? 'ready' : 'poor'}
                    advised={advisedOffence.has('hydrogen')}
                    detail={`${ballisticDetail}Cracks bunkers and ignores shields · ${
                      MAX_HYDROGEN_PER_GAME - (me.hydrogenBought ?? 0)
                    } left in the game · stock ${me.hydrogenBombs ?? 0}`}
                  >
                    {qtyButtons([1], hydrogenMax, () =>
                      onOrder((s) => buyHydrogenBundled(s, actorId), '+1 Hydrogen'),
                    )}
                  </CopCard>

                  <CopCard
                    art={ART.cop.drone}
                    name="Drone packs"
                    price={cash(COSTS.drone)}
                    priceNote={`each${aerospaceExtra > 0 ? ` · +${cash(aerospaceExtra)} tech, once` : ''}`}
                    status={droneMax > 0 ? 'ready' : 'poor'}
                    advised={advisedOffence.has('drone')}
                    detail={`${aerospaceDetail}In stock ${me.drones} · up to ${MAX_DRONES_PER_ROUND - me.dronesBoughtThisRound} more. Bills a city ${cash(DRONE_DAMAGE)} and keeps its shield busy.`}
                  >
                    {qtyButtons([1, 2, 3], droneMax, (n) =>
                      onOrder(
                        (s) => buyDronesBundled(s, n, actorId),
                        `+${n} Drone Pack${n > 1 ? 's' : ''}`,
                      ),
                    )}
                  </CopCard>
                </section>
              )}

              {view === 'defence' && (
                <section className="cop__page cop__page--defence" aria-label="Defence">
                  {citiesStrip}
                  <CopCard
                    art={ART.cop.shield}
                    name="Shield"
                    price={cash(COSTS.shield)}
                    {...cityTap('shield', 'Tap to place')}
                    priceNote={`${MAX_SHIELDS_PER_ROUND}/round`}
                    status={pickable.shield ? 'ready' : canPay(COSTS.shield) ? 'idle' : 'poor'}
                    advised={advisedDefence.has('shield')}
                    detail={
                      me.shieldsBoughtThisRound >= MAX_SHIELDS_PER_ROUND
                        ? 'Installed this round — one per round'
                        : 'Absorbs one warhead, then it is spent. Not needed on a bunker.'
                    }
                  >
                  </CopCard>

                  <CopCard
                    art={ART.cop.bunker}
                    name="Bunker"
                    price={cash(COSTS.underground)}
                    {...(hasBunker
                      ? { onPress: () => undefined, locked: true, cta: '✓ Dug in' }
                      : cityTap('underground', 'Tap to place'))}
                    priceNote="1/game"
                    status={hasBunker ? 'owned' : pickable.underground ? 'ready' : 'poor'}
                    advised={advisedDefence.has('bunker')}
                    detail={
                      hasBunker
                        ? 'Your bunker city is dug in — only a hydrogen bomb cracks it'
                        : `One city, for the whole match: nukes cannot destroy it. Drones still cost it ${cash(DRONE_DAMAGE / 2)}.`
                    }
                  >
                  </CopCard>

                  <CopCard
                    art={ART.cop.laser}
                    name="Laser network"
                    price={cash(COSTS.laser)}
                    {...(hasLaserNet
                      ? { onPress: () => undefined, locked: true, cta: '✓ Online' }
                      : cityTap('laser', 'Tap to place'))}
                    priceNote={`1/nation${aerospaceExtra > 0 ? ` · +${cash(aerospaceExtra)} tech, once` : ''}`}
                    status={hasLaserNet ? 'owned' : pickable.laser ? 'ready' : 'poor'}
                    advised={advisedDefence.has('laser')}
                    detail={
                      hasLaserNet
                        ? 'Covering every city — burns with its control site'
                        : `${aerospaceDetail}Covers every city · shoots down ${LASER_INTERCEPTS_PER_ROUND} swarms a round. A magnetic bomb darkens it.`
                    }
                  >
                  </CopCard>

                  <CopCard
                    art={ART.cop.rebuild}
                    name="Rebuild"
                    price={cash(COSTS.rebuild)}
                    {...(rubble === 0
                      ? { onPress: () => undefined, locked: true, cta: 'All standing' }
                      : cityTap('rebuild', 'Tap to rebuild'))}
                    status={rubble === 0 ? 'idle' : pickable.rebuild ? 'ready' : 'poor'}
                    advised={advisedDefence.has('rebuild')}
                    detail={
                      rubble === 0
                        ? 'No rubble — every city is standing'
                        : `${rubble} ${rubble === 1 ? 'city' : 'cities'} in ruins. Stands again at half score, bare of upgrades.`
                    }
                  >
                  </CopCard>
                </section>
              )}

              {view === 'finance' && (
                <section
                  className="cop__page cop__page--finance"
                  aria-label="Finance and intelligence"
                >
                  {citiesStrip}
                  <CopCard
                    art={ART.cop.research}
                    name="Research Center"
                    advised={advisedIntel.has('research')}
                    price={cash(COSTS.research)}
                    {...cityTap('research', 'Tap to build')}
                    status={pickable.research ? 'ready' : canPay(COSTS.research) ? 'idle' : 'poor'}
                    detail={`That city earns +${cash(RESEARCH_INCOME)} every round while it stands. Burns with the city.`}
                  />
                  <CopCard
                    art={ART.cop.spy}
                    name="Spy service"
                    advised={advisedIntel.has('spy')}
                    price={cash(COSTS.spy)}
                    priceNote="once"
                    onPress={() => onOrder((s) => buySpyNetwork(s, actorId), 'Spy service opened')}
                    locked={!canBuySpyNetwork(state, actorId)}
                    cta={
                      me.hasSpyNetwork
                        ? '✓ Active'
                        : canPay(COSTS.spy)
                          ? 'Tap to buy'
                          : `Need ${cash(need(COSTS.spy))}`
                    }
                    status={me.hasSpyNetwork ? 'owned' : canPay(COSTS.spy) ? 'ready' : 'poor'}
                    detail={
                      me.hasSpyNetwork
                        ? 'Active — every enemy defence is on your map'
                        : 'Shields, bunkers, labs and lasers on every enemy city'
                    }
                  >
                  </CopCard>

                  <article
                    className={`cop-card is-ready cop-card--sanction${advisedIntel.has('sanction') ? ' is-advised' : ''}`}
                  >
                    <img
                      className="cop-card__art"
                      src={ART.cop.sanction}
                      alt=""
                      draggable={false}
                    />
                    <div className="cop-card__body">
                      <h4>
                        Sanctions
                        {advisedIntel.has('sanction') && (
                          <span className="cop-card__star" title="Your advisor recommends this">
                            ★ Advisor
                          </span>
                        )}
                      </h4>
                      <p>
                        −10% of their income each · up to {MAX_SANCTIONS} rivals · {slotsLeft} slot
                        {slotsLeft === 1 ? '' : 's'} left. They will take it personally.
                      </p>
                      <div className="cop-sanctions">
                        {rivals.map((id) => {
                          const alive = !state.nations[id].eliminated;
                          const on = me.sanctions.includes(id);
                          const full = !on && slotsLeft < 1;
                          return (
                            <button
                              key={id}
                              type="button"
                              className={`cop-sanction${on ? ' is-on' : ''}${id === advisedSanction ? ' is-advised' : ''}`}
                              disabled={!alive || full}
                              title={`${nationDef(id).name}${on ? ' — sanctioned' : ''}`}
                              onClick={() => onOrder((s) => toggleSanction(s, id, actorId))}
                            >
                              <img src={rivalArt(id)} alt="" draggable={false} />
                              <span>{nationDef(id).shortName}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="cop-card__buy">
                      <span className="cop-card__price">Free</span>
                    </div>
                  </article>
                </section>
              )}
            </div>
          </div>
        </div>
      )}

      {lowUntil != null && (
        <div className="cop-low" role="status" aria-live="polite" key={lowUntil}>
          <b>Treasury is low</b>
          <span>{hasStrike ? 'Moving to Choose Targets' : 'Moving to battle'}</span>
          <i aria-hidden>
            <em style={{ animationDuration: `${LOW_TREASURY_NOTICE_MS}ms` }} />
          </i>
        </div>
      )}
    </div>
  );
}
