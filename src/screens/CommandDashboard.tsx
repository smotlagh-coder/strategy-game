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
import type { City, GameState, NationId } from '../types';

type CityPick = 'research' | 'underground' | 'rebuild' | 'shield' | 'laser';

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

type Section = 'offence' | 'defence' | 'finance';

const SECTIONS: Section[] = ['offence', 'defence', 'finance'];

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
  /** Short name under the icon once the segment is open. */
  short: string;
  label: string;
  /** One line about what it does, shown under the map. */
  info: string;
  /** The player owns or has stocked this one. */
  lit: boolean;
  count?: number;
  price?: string;
  priceNote?: string;
  note?: string;
  tone?: 'ready' | 'owned' | 'poor' | 'idle';
  advised?: boolean;
  /** Nothing to buy here right now. */
  locked?: boolean;
  /** Waiting for a city to be picked. */
  selected?: boolean;
  onPress?: () => void;
  /** Extra controls inside an open tile (the sanction roster). */
  extra?: ReactNode;
};

type PieSection = {
  id: Section;
  title: string;
  icons: PieIcon[];
  advised: boolean;
};

/** Where one segment sits on the circle: degrees, 0 = 3 o'clock, clockwise. */
type Span = { start: number; span: number };
type Layout = Record<Section, Span>;

/** Every segment takes a third of the circle until one is opened. */
const HUB_START: Record<Section, number> = { offence: -150, defence: -30, finance: 90 };
/** An open segment takes 300° (7 o'clock round the top to 5 o'clock). */
const OPEN_SPAN = 300;
/** The two folded segments take 30° each (5–6 and 6–7 o'clock). */
const SHUT_SPAN = 30;
const OPEN_START = 120;
const MORPH_MS = 560;

/** Angular gap left between segments so they read as separate glass plates. */
const WEDGE_GAP = 3.2;
const PIE_OUTER = 47.5;
const PIE_INNER = 14.5;
/** Radius (in % of the circle) where open tiles sit. */
const TILE_RADIUS = 30.5;
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
function platePath(start: number, span: number) {
  const a1 = start + WEDGE_GAP / 2;
  const a2 = start + span - WEDGE_GAP / 2;
  const large = a2 - a1 > 180 ? 1 : 0;
  const o1 = polar(a1, PIE_OUTER);
  const o2 = polar(a2, PIE_OUTER);
  const i2 = polar(a2, PIE_INNER);
  const i1 = polar(a1, PIE_INNER);
  return `M${pt(o1)} A${PIE_OUTER} ${PIE_OUTER} 0 ${large} 1 ${pt(o2)} L${pt(i2)} A${PIE_INNER} ${PIE_INNER} 0 ${large} 0 ${pt(i1)} Z`;
}

/** A thin arc along a segment at one radius, covering `fraction` of the span. */
function arcPath(center: number, radius: number, fraction: number, span: number) {
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

/** Where every segment should sit when `active` is open (null = all equal). */
function targetLayout(active: Section | null, from: Layout | null): Layout {
  const out = {} as Layout;
  const a = active ? SECTIONS.indexOf(active) : -1;
  for (const id of SECTIONS) {
    let start = HUB_START[id];
    let span = 120;
    if (active) {
      const off = (SECTIONS.indexOf(id) - a + 3) % 3;
      span = off === 0 ? OPEN_SPAN : SHUT_SPAN;
      // Folded segments follow the open one clockwise: 5–6 o'clock, then 6–7
      start = off === 0 ? OPEN_START : off === 1 ? OPEN_START + OPEN_SPAN : OPEN_START + OPEN_SPAN + SHUT_SPAN;
    }
    if (from) {
      // Same spot on the circle, reached by whichever lap moves the segment's two
      // edges least. That keeps neighbours edge to edge: the opening segment's
      // leading edge sweeps into the one it replaces, so it visibly grows out of
      // where it was instead of the whole wheel spinning.
      const now = from[id];
      let best = start;
      let bestCost = Infinity;
      for (let lap = -3; lap <= 3; lap++) {
        const cand = start + 360 * lap;
        const cost =
          Math.abs(cand - now.start) + Math.abs(cand + span - (now.start + now.span));
        if (cost < bestCost) {
          bestCost = cost;
          best = cand;
        }
      }
      start = best;
    }
    out[id] = { start, span };
  }
  return out;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** The segments glide between layouts, so opening one reads as an accordion. */
function useSectionLayout(active: Section | null): Layout {
  const [layout, setLayout] = useState<Layout>(() => targetLayout(null, null));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    const from = layoutRef.current;
    const to = targetLayout(active, from);
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setLayout(to);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / MORPH_MS);
      const e = ease(p);
      const next = {} as Layout;
      for (const id of SECTIONS) {
        next[id] = {
          start: from[id].start + (to[id].start - from[id].start) * e,
          span: from[id].span + (to[id].span - from[id].span) * e,
        };
      }
      setLayout(next);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return layout;
}

/**
 * The command map: three glass plates around a hub. Opening one grows it to
 * 300° and folds the other two into 30° strips of small status icons; the
 * open plate holds the things you can buy, right where you are looking.
 * The hub ring is the purchasing clock, and tapping the hub shows all three.
 */
function CopPie({
  sections,
  active,
  leaderSrc,
  progress,
  urgent,
  onSelect,
  onFocusIcon,
}: {
  sections: PieSection[];
  active: Section | null;
  leaderSrc: string;
  /** Purchasing time left, 1 → 0. */
  progress: number;
  urgent: boolean;
  onSelect: (section: Section | null) => void;
  onFocusIcon: (key: string) => void;
}) {
  const layout = useSectionLayout(active);
  // Icons and tiles sit where their segment will settle, then fade in once it has grown
  const settled = targetLayout(active, null);
  const ringR = 10.6;
  const ringLen = 2 * Math.PI * ringR;
  return (
    <div className={`cx-pie${active ? ' has-open' : ''}`} role="group" aria-label="Command map">
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
          const { start, span } = layout[sec.id];
          const center = start + span / 2;
          const lit = sec.icons.filter((i) => i.lit).length;
          const isOpen = active === sec.id;
          const d = platePath(start, span);
          return (
            <g
              key={sec.id}
              className={`cop-pie__plate cop-pie__plate--${sec.id}${isOpen ? ' is-open' : ''}`}
              style={{ ['--tone' as string]: SECTION_COLOR[sec.id] }}
            >
              <path d={d} className="cop-pie__base" />
              <path
                d={d}
                className={`cop-pie__wedge${isOpen ? ' is-open' : ''}`}
                fill={`url(#cop-grad-${sec.id})`}
                role="button"
                tabIndex={isOpen ? -1 : 0}
                aria-label={`${PAGE_TITLE[sec.id]}${isOpen ? ' — open' : ' — open it'}`}
                onClick={() => onSelect(sec.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(sec.id);
                  }
                }}
              />
              {span > 60 && (
                <>
                  <path
                    d={arcPath(center, PIE_INNER + 2.4, 1, span * 0.7)}
                    className="cop-pie__track"
                  />
                  <path
                    d={arcPath(center, PIE_INNER + 2.4, lit / sec.icons.length, span * 0.7)}
                    className="cop-pie__meter"
                  />
                </>
              )}
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
        const { start, span } = settled[sec.id];
        const center = start + span / 2;
        const lit = sec.icons.filter((i) => i.lit).length;
        const mode = active == null ? 'hub' : active === sec.id ? 'open' : 'shut';
        const n = sec.icons.length;
        return (
          <div
            key={`${sec.id}-${mode}`}
            className={`cop-pie__group cx-group cx-group--${mode}`}
            style={{ ['--tone' as string]: SECTION_COLOR[sec.id] }}
          >
            {mode === 'hub' && (
              <>
                <div
                  className={`cop-pie__label cop-pie__label--${sec.id}`}
                  style={{ left: `${polar(center, 25).x}%`, top: `${polar(center, 25).y}%` }}
                >
                  <b>{sec.title}</b>
                  <span className="cop-pie__count">
                    {lit}/{n}
                  </span>
                  {sec.advised && <em className="cop-pie__star">★ Advisor</em>}
                </div>
                {iconAngles(center, n).map((angle, i) => {
                  const icon = sec.icons[i];
                  const at = polar(angle, 39);
                  return (
                    <span
                      key={icon.key}
                      className={`cop-pie__icon cx-fade${icon.lit ? ' is-lit' : ''}`}
                      style={{ left: `${at.x}%`, top: `${at.y}%` }}
                      title={`${icon.label}${icon.lit ? ' — yours' : ''}`}
                    >
                      <img src={icon.art} alt="" draggable={false} />
                      {icon.count != null && icon.count > 0 && <em>{icon.count}</em>}
                    </span>
                  );
                })}
              </>
            )}

            {mode === 'shut' &&
              sec.icons.map((icon, i) => {
                // A short stack down the strip's middle line, outermost first
                const top = 41;
                const bottom = 19.5;
                const radius = n > 1 ? top - ((top - bottom) * i) / (n - 1) : (top + bottom) / 2;
                const at = polar(center, radius);
                return (
                  <span
                    key={icon.key}
                    className={`cx-mini cx-fade${icon.lit ? ' is-lit' : ''}`}
                    style={{ left: `${at.x}%`, top: `${at.y}%` }}
                    title={`${icon.label}${icon.lit ? ' — yours' : ''}`}
                  >
                    <img src={icon.art} alt="" draggable={false} />
                    {icon.count != null && icon.count > 0 ? (
                      <em>{icon.count}</em>
                    ) : (
                      icon.lit && <em className="is-tick">✓</em>
                    )}
                  </span>
                );
              })}

            {mode === 'open' &&
              sec.icons.map((icon, i) => {
                const angle = start + (span * (i + 0.5)) / n;
                const at = polar(angle, TILE_RADIUS);
                const style = { left: `${at.x}%`, top: `${at.y}%` };
                const inner = (
                  <>
                    <span className="cx-tile__orb">
                      <img src={icon.art} alt="" draggable={false} />
                      {icon.count != null && icon.count > 0 ? (
                        <em key={icon.count}>{icon.count}</em>
                      ) : (
                        icon.lit && <em className="is-tick">✓</em>
                      )}
                    </span>
                    {icon.advised && (
                      <i className="cx-tile__star" title="Your advisor recommends this">
                        ★
                      </i>
                    )}
                    <b>{icon.short}</b>
                    {icon.price && (
                      <span className="cx-tile__price">
                        {icon.price}
                        {icon.priceNote && <small> {icon.priceNote}</small>}
                      </span>
                    )}
                    {icon.note && <small className="cx-tile__note">{icon.note}</small>}
                    {icon.extra}
                  </>
                );
                const cls = `cx-tile cx-fade is-${icon.tone ?? 'idle'}${icon.lit ? ' is-lit' : ''}${
                  icon.advised ? ' is-advised' : ''
                }${icon.selected ? ' is-selected' : ''}${icon.locked ? ' is-off' : ''}${
                  icon.extra ? ' cx-tile--wide' : ''
                }`;
                return icon.onPress ? (
                  <button
                    key={icon.key}
                    type="button"
                    className={cls}
                    style={style}
                    aria-disabled={icon.locked ? true : undefined}
                    aria-label={`${icon.label}${icon.price ? `, ${icon.price}` : ''}`}
                    onClick={() => {
                      onFocusIcon(icon.key);
                      if (!icon.locked) icon.onPress?.();
                    }}
                    onMouseEnter={() => onFocusIcon(icon.key)}
                    onFocus={() => onFocusIcon(icon.key)}
                  >
                    {inner}
                  </button>
                ) : (
                  <div
                    key={icon.key}
                    className={cls}
                    style={style}
                    onMouseEnter={() => onFocusIcon(icon.key)}
                    onFocus={() => onFocusIcon(icon.key)}
                  >
                    {inner}
                  </div>
                );
              })}
          </div>
        );
      })}

      <button
        type="button"
        className="cx-hub"
        disabled={active == null}
        onClick={() => onSelect(null)}
        aria-label="Show all three sections"
        title={active ? 'Show all sections' : undefined}
      >
        <img src={leaderSrc} alt="" draggable={false} />
      </button>
    </div>
  );
}

/**
 * The whole turn on one screen: your cities and treasury on top, and one
 * circle below. Opening a segment grows it to 300° and shows what it sells;
 * the other two fold into small status strips, so nothing is a separate page.
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
  const [active, setActive] = useState<Section | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const me = state.nations[actorId];
  const select = (next: Section | null) => {
    setPick(null);
    setFocusKey(null);
    setActive(next);
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
        else setActive(null);
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

  /** A laser network's price includes Aerospace Tech until the nation owns it. */
  const pickCost = (kind: CityPick) => PICK_COST[kind] + (kind === 'laser' ? aerospaceExtra : 0);

  /** Tapping a purchase that needs a city lights up the cities that can take it. */
  const cityTap = (kind: CityPick, label: string) => {
    const cost = pickCost(kind);
    const locked = !pickable[kind];
    return {
      onPress: () => setPick(pick === kind ? null : kind),
      locked,
      selected: pick === kind,
      tone: (locked ? (canPay(cost) ? 'idle' : 'poor') : 'ready') as PieIcon['tone'],
      note: !canPay(cost)
        ? `Need ${cash(need(cost))}`
        : locked
          ? 'Unavailable'
          : pick === kind
            ? 'Pick a city ↑'
            : label,
    };
  };

  /** Stock purchases: tap once per unit. */
  const stockNote = (max: number, cost: number, left: number) =>
    max > 0 ? `${left} left` : !canPay(cost) ? `Need ${cash(need(cost))}` : 'Limit reached';
  const stockTone = (max: number, cost: number): PieIcon['tone'] =>
    max > 0 ? 'ready' : !canPay(cost) ? 'poor' : 'idle';

  const ownedShields = me.cities.filter(
    (c) => c.hasShield && !c.isUnderground && !c.destroyed,
  ).length;
  const labs = me.cities.filter((c) => c.hasResearch && !c.destroyed).length;
  const rebuiltStanding = me.cities.filter((c) => c.rebuiltRound != null && !c.destroyed).length;

  const nukeCost = COSTS.bomb + ballisticExtra;
  const magneticCost = COSTS.bombMagnetic + ballisticExtra;
  const hydrogenCost = COSTS.bombHydrogen + ballisticExtra;
  const droneCost = COSTS.drone + aerospaceExtra;
  const withTech = (extra: number) => (extra > 0 ? 'with tech' : undefined);

  const sanctionRoster = (
    <div className="cx-faces">
      {rivals.map((id) => {
        const alive = !state.nations[id].eliminated;
        const on = me.sanctions.includes(id);
        const full = !on && slotsLeft < 1;
        return (
          <button
            key={id}
            type="button"
            className={`cx-face${on ? ' is-on' : ''}${id === advisedSanction ? ' is-advised' : ''}`}
            disabled={!alive || full}
            title={`${nationDef(id).name}${on ? ' — sanctioned' : ''}`}
            aria-label={`${on ? 'Lift sanctions on' : 'Sanction'} ${nationDef(id).name}`}
            aria-pressed={on}
            onClick={() => onOrder((s) => toggleSanction(s, id, actorId))}
          >
            <img src={rivalArt(id)} alt="" draggable={false} />
          </button>
        );
      })}
    </div>
  );

  const pieSections: PieSection[] = [
    {
      id: 'offence',
      title: 'Offence',
      advised: advisedOffence.size > 0,
      icons: [
        {
          key: 'nuke',
          art: ART.missile,
          short: 'Nuclear',
          label: 'Nuclear warheads',
          info: 'Shields absorb it; bunkers break it.',
          lit: me.bombs > 0,
          count: me.bombs,
          price: cash(nukeCost),
          priceNote: withTech(ballisticExtra),
          note: stockNote(bombMax, nukeCost, MAX_BOMBS_PER_ROUND - me.bombsBoughtThisRound),
          tone: stockTone(bombMax, nukeCost),
          advised: advisedOffence.has('nuke'),
          locked: bombMax < 1,
          onPress: () => onOrder((s) => buyBombsBundled(s, 1, actorId), '+1 Nuclear'),
        },
        {
          key: 'magnetic',
          art: ART.missileMagnetic,
          short: 'Magnetic',
          label: 'Magnetic bombs',
          info: 'Disables laser networks.',
          lit: (me.magneticBombs ?? 0) > 0,
          count: me.magneticBombs ?? 0,
          price: cash(magneticCost),
          priceNote: withTech(ballisticExtra),
          note: stockNote(magneticMax, magneticCost, MAX_MAGNETIC_PER_GAME - (me.magneticBought ?? 0)),
          tone: stockTone(magneticMax, magneticCost),
          advised: advisedOffence.has('magnetic'),
          locked: magneticMax < 1,
          onPress: () => onOrder((s) => buyMagneticBundled(s, 1, actorId), '+1 Magnetic'),
        },
        {
          key: 'hydrogen',
          art: ART.missileHydrogen,
          short: 'Hydrogen',
          label: 'Hydrogen bomb',
          info: 'Cracks bunkers, ignores shields.',
          lit: (me.hydrogenBombs ?? 0) > 0,
          count: me.hydrogenBombs ?? 0,
          price: cash(hydrogenCost),
          priceNote: withTech(ballisticExtra),
          note: stockNote(hydrogenMax, hydrogenCost, MAX_HYDROGEN_PER_GAME - (me.hydrogenBought ?? 0)),
          tone: stockTone(hydrogenMax, hydrogenCost),
          advised: advisedOffence.has('hydrogen'),
          locked: hydrogenMax < 1,
          onPress: () => onOrder((s) => buyHydrogenBundled(s, actorId), '+1 Hydrogen'),
        },
        {
          key: 'drone',
          art: ART.cop.drone,
          short: 'Drones',
          label: 'Drone packs',
          info: `Each hit bills ${cash(DRONE_DAMAGE)}.`,
          lit: me.drones > 0,
          count: me.drones,
          price: cash(droneCost),
          priceNote: withTech(aerospaceExtra),
          note: stockNote(droneMax, droneCost, MAX_DRONES_PER_ROUND - me.dronesBoughtThisRound),
          tone: stockTone(droneMax, droneCost),
          advised: advisedOffence.has('drone'),
          locked: droneMax < 1,
          onPress: () => onOrder((s) => buyDronesBundled(s, 1, actorId), '+1 Drone Pack'),
        },
      ],
    },
    {
      id: 'defence',
      title: 'Defence',
      advised: [...advisedDefence].some((i) => i !== 'hold'),
      icons: [
        {
          key: 'shield',
          art: ART.cop.shield,
          short: 'Shield',
          label: 'Shield',
          info: `Absorbs one warhead, then it is spent · ${MAX_SHIELDS_PER_ROUND} a round.`,
          lit: ownedShields > 0,
          count: ownedShields,
          price: cash(COSTS.shield),
          advised: advisedDefence.has('shield'),
          ...cityTap('shield', 'Tap to place'),
          ...(me.shieldsBoughtThisRound >= MAX_SHIELDS_PER_ROUND && { note: 'Placed this round' }),
        },
        {
          key: 'bunker',
          art: ART.cop.bunker,
          short: 'Bunker',
          label: 'Bunker',
          info: `One city, all match. Nukes cannot destroy it; drones bill ${cash(DRONE_DAMAGE / 2)}.`,
          lit: hasBunker,
          price: cash(COSTS.underground),
          advised: advisedDefence.has('bunker'),
          ...(hasBunker
            ? { locked: true, tone: 'owned' as const, note: '✓ Dug in', onPress: () => undefined }
            : cityTap('underground', 'Tap to place')),
        },
        {
          key: 'laser',
          art: ART.cop.laser,
          short: 'Laser',
          label: 'Laser network',
          info: `Covers every city · stops ${LASER_INTERCEPTS_PER_ROUND} swarms a round.`,
          lit: hasLaserNet,
          price: cash(pickCost('laser')),
          priceNote: withTech(aerospaceExtra),
          advised: advisedDefence.has('laser'),
          ...(hasLaserNet
            ? { locked: true, tone: 'owned' as const, note: '✓ Online', onPress: () => undefined }
            : cityTap('laser', 'Tap to place')),
        },
        {
          key: 'rebuild',
          art: ART.cop.rebuild,
          short: 'Rebuild',
          label: 'Rebuild',
          info: rubble === 0 ? 'Every city is standing.' : `${rubble} in ruins. Returns at half score, bare.`,
          lit: rebuiltStanding > 0,
          count: rebuiltStanding,
          price: cash(COSTS.rebuild),
          advised: advisedDefence.has('rebuild'),
          ...(rubble === 0
            ? { locked: true, tone: 'idle' as const, note: 'All standing', onPress: () => undefined }
            : cityTap('rebuild', 'Tap to rebuild')),
        },
      ],
    },
    {
      id: 'finance',
      title: 'Finance & Intel',
      advised: intelAdvice.length > 0,
      icons: [
        {
          key: 'research',
          art: ART.cop.research,
          short: 'Research',
          label: 'Research Center',
          info: `That city earns +${cash(RESEARCH_INCOME)} a round. Burns with it.`,
          lit: labs > 0,
          count: labs,
          price: cash(COSTS.research),
          advised: advisedIntel.has('research'),
          ...cityTap('research', 'Tap to build'),
        },
        {
          key: 'sanctions',
          art: ART.cop.sanction,
          short: 'Sanctions',
          label: 'Sanctions',
          info: `−10% of their income each · up to ${MAX_SANCTIONS} rivals · ${slotsLeft} slot${
            slotsLeft === 1 ? '' : 's'
          } left.`,
          lit: me.sanctions.length > 0,
          count: me.sanctions.length,
          price: 'Free',
          note: `${slotsLeft} slot${slotsLeft === 1 ? '' : 's'} left`,
          tone: 'ready',
          advised: advisedIntel.has('sanction'),
          extra: sanctionRoster,
        },
        {
          key: 'spy',
          art: ART.cop.spy,
          short: 'Spy',
          label: 'Spy service',
          info: me.hasSpyNetwork
            ? 'Active · every enemy defence on your map.'
            : 'See every enemy shield, bunker, lab and laser.',
          lit: me.hasSpyNetwork,
          price: cash(COSTS.spy),
          note: me.hasSpyNetwork
            ? '✓ Active'
            : canPay(COSTS.spy)
              ? 'Tap to buy'
              : `Need ${cash(need(COSTS.spy))}`,
          tone: me.hasSpyNetwork ? 'owned' : canPay(COSTS.spy) ? 'ready' : 'poor',
          advised: advisedIntel.has('spy'),
          locked: !canBuySpyNetwork(state, actorId),
          onPress: () => onOrder((s) => buySpyNetwork(s, actorId), 'Spy service opened'),
        },
      ],
    },
  ];

  const hasStrike = warheads > 0 || me.drones > 0;
  const openSection = pieSections.find((s) => s.id === active) ?? null;
  const focused = openSection?.icons.find((i) => i.key === focusKey) ?? null;

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

  const citiesStrip = (
    <div className={`cx-cities${pick ? ' is-picking' : ''}`} aria-label="Your cities">
      <p className="cx-cities__prompt">
        {pick ? (
          <>
            <b>
              {PICK_TITLE[pick]} · {cash(pickCost(pick))}
            </b>{' '}
            — tap a glowing city
            {pick === 'underground' ? ' (a shield on it is scrapped)' : ''}
            <button type="button" className="cop-link" onClick={() => setPick(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>Your cities</>
        )}
      </p>
      <div className="cx-cities__row">
        {me.cities.map((city) => {
          const reason = pick ? blockedReason(pick, city) : undefined;
          const cover = city.isUnderground && !city.destroyed;
          const advice = adviceByCity.get(city.id);
          const inner = (
            <>
              <span className="cx-city__art">
                <img
                  src={cover ? ART.citiesUnderground[city.id] : ART.cities[city.id]}
                  alt=""
                  draggable={false}
                />
                {city.hasShield && !city.isUnderground && !city.destroyed && (
                  <i className="cx-city__dome" aria-hidden />
                )}
                {advice && !pick && active === 'defence' && ADVICE_ICON[advice] && (
                  <img
                    className="cx-city__advice"
                    src={ADVICE_ICON[advice]}
                    alt=""
                    title="Advisor: cover this city"
                    draggable={false}
                  />
                )}
              </span>
              <b>{city.name}</b>
              <span className="cx-city__tags">
                {city.destroyed && <em className="is-bad">Rubble</em>}
                {city.hasShield && !city.isUnderground && !city.destroyed && <em>Shield</em>}
                {city.hasLaser && !city.destroyed && (
                  <img className="cx-city__icon" src={ART.cop.laser} alt="Laser network" title="Laser network" />
                )}
                {city.hasResearch && !city.destroyed && (
                  <img className="cx-city__icon" src={ART.cop.research} alt="Research Center" title="Research Center" />
                )}
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
              className={`cx-city ${reason ? 'is-blocked' : 'is-pickable'}${
                city.destroyed ? ' is-rubble' : ''
              }`}
              disabled={Boolean(reason)}
              onClick={() => buyInto(city)}
            >
              {inner}
            </button>
          ) : (
            <div
              key={city.id}
              className={`cx-city${city.destroyed ? ' is-rubble' : ''}${
                advice && active === 'defence' ? ' is-advised' : ''
              }`}
            >
              {inner}
            </div>
          );
        })}
      </div>
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

      <div className="cx-stage">
        <header className="cx-top">
          <div className="cx-top__bar">
            <div className="cx-top__id">
              <img src={leaderSrc} alt="" draggable={false} />
              <b>{nationDef(actorId).shortName}</b>
            </div>
            {treasury}
            {clock}
          </div>
          {citiesStrip}
        </header>

        <div className="cx-mid">
          <CopPie
            sections={pieSections}
            active={active}
            leaderSrc={leaderSrc}
            progress={msLeft / PURCHASE_WINDOW_MS}
            urgent={secondsLeft <= 10}
            onSelect={(next) => {
              if (next !== active) select(next);
            }}
            onFocusIcon={setFocusKey}
          />
        </div>

        <footer className="cx-foot">
          <div className="cx-foot__info">
            <p className="cx-foot__caption">
              {focused ? (
                <>
                  <b>{focused.label}</b> — {focused.info}
                </>
              ) : openSection ? (
                <>
                  <b>{PAGE_TITLE[openSection.id]}</b> — {PAGE_TAGLINE[openSection.id]}
                </>
              ) : (
                'Tap a section to open it · shining icons are yours'
              )}
            </p>
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
          </div>
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
            <span className="cop-target__label">{hasStrike ? 'Choose targets' : 'Lock orders'}</span>
          </button>
        </footer>
      </div>

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
