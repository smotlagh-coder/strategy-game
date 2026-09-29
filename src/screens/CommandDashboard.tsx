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
  buyAerospaceTech,
  buyBombs,
  buyDrones,
  buyHydrogenBomb,
  buyLaser,
  buyMagneticBombs,
  buyNuclearTech,
  buyRebuild,
  buyResearch,
  buyShield,
  buySpyNetwork,
  buyUnderground,
  canBuyBombs,
  canBuyDrones,
  canBuyLaser,
  canBuyRebuild,
  canBuyResearch,
  canBuyShield,
  canBuySpyNetwork,
  canBuyUnderground,
  formatMoney,
  maxBombsPurchasable,
  maxDronesPurchasable,
  maxHydrogenPurchasable,
  maxMagneticPurchasable,
  sanctionsLeft,
  toggleSanction,
  totalWarheads,
} from '../game/engine';
import { findDefenceOrders, findOffenceOrders } from '../game/briefing';
import type { BriefingOrderIcon } from '../game/briefing';
import { PURCHASE_WINDOW_MS } from '../lib/onlineConstants';
import type { City, GameState, NationId } from '../types';

type CityPick = 'research' | 'underground' | 'rebuild' | 'shield' | 'laser';
type CardStatus = 'ready' | 'owned' | 'locked' | 'poor' | 'idle';

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
const PIE_R = 48;

function polar(angleDeg: number, radius: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: 50 + radius * Math.cos(a), y: 50 + radius * Math.sin(a) };
}

function wedgePath(center: number) {
  const a = polar(center - WEDGE_SPAN / 2, PIE_R);
  const b = polar(center + WEDGE_SPAN / 2, PIE_R);
  return `M50 50 L${a.x.toFixed(3)} ${a.y.toFixed(3)} A${PIE_R} ${PIE_R} 0 0 1 ${b.x.toFixed(3)} ${b.y.toFixed(3)} Z`;
}

/** Spread n icons along one arc so every wedge reads as a tidy fan. */
function iconAngles(center: number, n: number) {
  const step = n >= 6 ? 17 : n === 4 ? 22 : 26;
  return Array.from({ length: n }, (_, i) => center + (i - (n - 1) / 2) * step);
}

/**
 * The command map: one big circle in three wedges. Each wedge lists what lives
 * inside it, and icons you already own shine so a glance shows what is covered.
 */
function CopPie({
  sections,
  leaderSrc,
  onOpen,
}: {
  sections: PieSection[];
  leaderSrc: string;
  onOpen: (section: Section) => void;
}) {
  return (
    <div className="cop-pie" role="group" aria-label="Command map">
      <svg viewBox="0 0 100 100" className="cop-pie__svg">
        <defs>
          <radialGradient id="cop-grad-offence" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#3a1410" />
            <stop offset="100%" stopColor="#8a2a1c" />
          </radialGradient>
          <radialGradient id="cop-grad-defence" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#0c2a44" />
            <stop offset="100%" stopColor="#1f6f9c" />
          </radialGradient>
          <radialGradient id="cop-grad-finance" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#3a2c08" />
            <stop offset="100%" stopColor="#a17a12" />
          </radialGradient>
        </defs>
        {sections.map((sec) => (
          <path
            key={sec.id}
            d={wedgePath(sec.center)}
            className={`cop-pie__wedge cop-pie__wedge--${sec.id}`}
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
        ))}
        <circle cx="50" cy="50" r={PIE_R} className="cop-pie__rim" />
      </svg>

      {sections.map((sec) => {
        const lit = sec.icons.filter((i) => i.lit).length;
        const label = polar(sec.center, 20);
        return (
          <div key={sec.id} className="cop-pie__group">
            <div
              className={`cop-pie__label cop-pie__label--${sec.id}`}
              style={{ left: `${label.x}%`, top: `${label.y}%` }}
            >
              <b>{sec.title}</b>
              <span>
                {sec.advised ? '★ Advisor · ' : ''}
                {lit}/{sec.icons.length} ready
              </span>
            </div>
            {iconAngles(sec.center, sec.icons.length).map((angle, i) => {
              const icon = sec.icons[i];
              const at = polar(angle, 36.5);
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
}: {
  art: string;
  name: string;
  price: string;
  priceNote?: string;
  status: CardStatus;
  advised?: boolean;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className={`cop-card is-${status}${advised ? ' is-advised' : ''}`}>
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
        <div className="cop-card__actions">{children}</div>
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
  playerName,
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
  playerName: string;
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
  const me = state.nations[actorId];
  const [pick, setPick] = useState<CityPick | null>(null);
  const [view, setView] = useState<View>('hub');
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
  useEffect(() => {
    let fired = false;
    const check = () => {
      const left = deadline - Date.now();
      setMsLeft(Math.max(0, left));
      if (left <= 0 && !fired) {
        fired = true;
        proceedRef.current();
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

  const warheads = totalWarheads(me);
  const bombMax = maxBombsPurchasable(state, actorId);
  const hydrogenMax = maxHydrogenPurchasable(state, actorId);
  const magneticMax = maxMagneticPurchasable(state, actorId);
  const droneMax = maxDronesPurchasable(state, actorId);
  const armed = canBuyBombs(state, actorId);
  const droneReady = canBuyDrones(state, actorId);
  const rubble = me.cities.filter((c) => c.destroyed).length;
  const hasBunker = me.cities.some((c) => c.isUnderground && !c.destroyed);
  const hasLaserNet = me.cities.some((c) => c.hasLaser && !c.destroyed);
  const slotsLeft = sanctionsLeft(state, actorId);

  const pickable: Record<CityPick, boolean> = {
    research: canBuyResearch(state, actorId),
    underground: canBuyUnderground(state, actorId),
    rebuild: canBuyRebuild(state, actorId),
    shield: canBuyShield(state, actorId),
    laser: canBuyLaser(state, actorId),
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
      onOrder((s) => buyLaser(s, city.id, actorId), `Laser network — ${city.name}`);
    }
  };

  /** A button that opens the city strip for one purchase. */
  const cityButton = (kind: CityPick, label: string) => {
    const cost = PICK_COST[kind];
    const affordable = canPay(cost);
    return (
      <button
        type="button"
        className={`cop-btn${pick === kind ? ' is-active' : ''}`}
        disabled={!pickable[kind]}
        onClick={() => setPick(pick === kind ? null : kind)}
      >
        {!affordable ? `Need ${cash(need(cost))}` : pick === kind ? 'Pick a city ↓' : label}
      </button>
    );
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

  const techStatus = (owned: boolean, cost: number): CardStatus =>
    owned ? 'owned' : canPay(cost) ? 'ready' : 'poor';

  const citiesStrip = (
    <div className={`cop-cities${pick ? ' is-picking' : ''}`} aria-label="Your cities">
      {pick && (
        <p className="cop-cities__prompt">
          <b>
            {PICK_TITLE[pick]} · {cash(PICK_COST[pick])}
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
          key: 'ballistic',
          art: ART.cop.ballisticTech,
          label: 'Ballistic Missile Tech',
          lit: me.hasNuclearTech,
        },
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
          key: 'aerospace',
          art: ART.cop.aerospaceTech,
          label: 'Aerospace Tech',
          lit: me.hasAerospaceTech,
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
      advised: false,
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

  const stock = [
    { key: 'warheads', src: ART.missile, value: warheads, label: 'Warheads' },
    {
      key: 'drones',
      src: ART.cop.drone,
      value: me.drones,
      label: 'Drone packs',
    },
    {
      key: 'shields',
      src: ART.cop.shield,
      value: me.cities.filter((c) => c.hasShield && !c.isUnderground && !c.destroyed).length,
      label: 'Shields',
    },
  ];

  return (
    <div className="cop" role="dialog" aria-modal="true" aria-label="Command dashboard">
      <div className="cop__panel enter-pop">
        <header className="cop__top">
          <div className="cop__id">
            <img src={leaderSrc} alt="" draggable={false} />
            <div>
              <p>{nationDef(actorId).name}</p>
              <h2>{playerName}</h2>
            </div>
          </div>

          <div className="cop__treasury" aria-label="Treasury">
            <span>TREASURY</span>
            <b>{cash(money)}</b>
          </div>

          <ul className="cop__stock" aria-label="Arsenal">
            {stock.map((s) => (
              <li key={s.key} title={s.label}>
                <img src={s.src} alt="" draggable={false} />
                {s.value}
              </li>
            ))}
            {me.hasSpyNetwork && (
              <li title="Spy service active" className="is-flag">
                <img src={ART.cop.spy} alt="" draggable={false} />
              </li>
            )}
          </ul>
        </header>

        <div
          className={`cop__clock${secondsLeft <= 10 ? ' is-urgent' : ''}`}
          role="timer"
          aria-label="Purchasing time left"
        >
          <span className="cop__clock-label">
            {secondsLeft > 0 ? 'Purchasing closes in' : 'Time is up'}
          </span>
          <b>{secondsLeft}s</b>
          <i aria-hidden>
            <em
              style={{
                width: `${Math.min(100, (msLeft / PURCHASE_WINDOW_MS) * 100)}%`,
              }}
            />
          </i>
        </div>

        <div className={`cop__view cop__view--${view}`} key={view}>
          {view === 'hub' && (
            <>
              <CopPie sections={pieSections} leaderSrc={leaderSrc} onOpen={openView} />
              <p className="cop-pie-hint">
                Tap a section to open it · shining icons are already yours
              </p>
            </>
          )}

          {view !== 'hub' && (
            <div className="cop__page-head">
              <button type="button" className="cop-back" onClick={() => openView('hub')}>
                ← Command map
              </button>
              <h3 className={`cop__page-title cop__page-title--${view}`}>
                <span>{PAGE_TITLE[view]}</span>
                <em>{PAGE_TAGLINE[view]}</em>
              </h3>
            </div>
          )}

          {view === 'offence' && (
            <section className="cop__page cop__page--offence" aria-label="Offence">
              <CopCard
                art={ART.cop.ballisticTech}
                name="Ballistic Missile Tech"
                price={cash(COSTS.ballisticMissileTech)}
                priceNote="once"
                status={techStatus(me.hasNuclearTech, COSTS.ballisticMissileTech)}
                detail={
                  me.hasNuclearTech ? 'Unlocked — warheads are open' : 'Unlocks warheads right away'
                }
              >
                {me.hasNuclearTech ? (
                  <span className="cop-owned">✓ Owned</span>
                ) : (
                  <button
                    type="button"
                    className="cop-btn"
                    disabled={!canPay(COSTS.ballisticMissileTech)}
                    onClick={() =>
                      onOrder((s) => buyNuclearTech(s, actorId), 'Ballistic Missile Tech Unlocked!')
                    }
                  >
                    {canPay(COSTS.ballisticMissileTech)
                      ? 'Buy'
                      : `Need ${cash(need(COSTS.ballisticMissileTech))}`}
                  </button>
                )}
              </CopCard>

              <CopCard
                art={ART.missile}
                name="Nuclear warheads"
                price={cash(COSTS.bomb)}
                priceNote="each"
                status={!armed ? 'locked' : bombMax > 0 ? 'ready' : 'poor'}
                advised={advisedOffence.has('nuke')}
                detail={
                  armed
                    ? `In stock ${me.bombs} · ${MAX_BOMBS_PER_ROUND - me.bombsBoughtThisRound} more this round. Stops at shields without a swarm; breaks on bunkers.`
                    : 'Needs Ballistic Missile Tech'
                }
              >
                {armed &&
                  qtyButtons([1, 2, 3], bombMax, (n) =>
                    onOrder((s) => buyBombs(s, n, actorId), `+${n} Nuclear`),
                  )}
              </CopCard>

              <CopCard
                art={ART.missileMagnetic}
                name="Magnetic bombs"
                price={cash(COSTS.bombMagnetic)}
                priceNote="each"
                status={!armed ? 'locked' : magneticMax > 0 ? 'ready' : 'poor'}
                advised={advisedOffence.has('magnetic')}
                detail={
                  armed
                    ? `Kills laser networks so swarms get through · ${
                        MAX_MAGNETIC_PER_GAME - (me.magneticBought ?? 0)
                      } left in the game · stock ${me.magneticBombs ?? 0}`
                    : 'Needs Ballistic Missile Tech'
                }
              >
                {armed &&
                  qtyButtons([1, 2], magneticMax, (n) =>
                    onOrder((s) => buyMagneticBombs(s, n, actorId), `+${n} Magnetic`),
                  )}
              </CopCard>

              <CopCard
                art={ART.missileHydrogen}
                name="Hydrogen bomb"
                price={cash(COSTS.bombHydrogen)}
                status={!armed ? 'locked' : hydrogenMax > 0 ? 'ready' : 'poor'}
                advised={advisedOffence.has('hydrogen')}
                detail={
                  armed
                    ? `Cracks bunkers and ignores shields · ${
                        MAX_HYDROGEN_PER_GAME - (me.hydrogenBought ?? 0)
                      } left in the game · stock ${me.hydrogenBombs ?? 0}`
                    : 'Needs Ballistic Missile Tech'
                }
              >
                {armed &&
                  qtyButtons([1], hydrogenMax, () =>
                    onOrder((s) => buyHydrogenBomb(s, actorId), '+1 Hydrogen'),
                  )}
              </CopCard>

              <CopCard
                art={ART.cop.aerospaceTech}
                name="Aerospace Tech"
                price={cash(COSTS.aerospaceTech)}
                priceNote="once"
                status={techStatus(me.hasAerospaceTech, COSTS.aerospaceTech)}
                detail={
                  me.hasAerospaceTech
                    ? 'Unlocked — drones and laser defences are open'
                    : 'Unlocks drone packs and laser defences'
                }
              >
                {me.hasAerospaceTech ? (
                  <span className="cop-owned">✓ Owned</span>
                ) : (
                  <button
                    type="button"
                    className="cop-btn"
                    disabled={!canPay(COSTS.aerospaceTech)}
                    onClick={() =>
                      onOrder((s) => buyAerospaceTech(s, actorId), 'Aerospace Tech Unlocked!')
                    }
                  >
                    {canPay(COSTS.aerospaceTech)
                      ? 'Buy'
                      : `Need ${cash(need(COSTS.aerospaceTech))}`}
                  </button>
                )}
              </CopCard>

              <CopCard
                art={ART.cop.drone}
                name="Drone packs"
                price={cash(COSTS.drone)}
                priceNote="each"
                status={!droneReady ? 'locked' : droneMax > 0 ? 'ready' : 'poor'}
                advised={advisedOffence.has('drone')}
                detail={
                  droneReady
                    ? `In stock ${me.drones} · up to ${MAX_DRONES_PER_ROUND - me.dronesBoughtThisRound} more. Bills a city ${cash(DRONE_DAMAGE)} and keeps its shield busy.`
                    : 'Needs Aerospace Tech'
                }
              >
                {droneReady &&
                  qtyButtons([1, 2, 3], droneMax, (n) =>
                    onOrder((s) => buyDrones(s, n, actorId), `+${n} Drone Pack${n > 1 ? 's' : ''}`),
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
                priceNote={`${MAX_SHIELDS_PER_ROUND}/round`}
                status={pickable.shield ? 'ready' : canPay(COSTS.shield) ? 'idle' : 'poor'}
                advised={advisedDefence.has('shield')}
                detail={
                  me.shieldsBoughtThisRound >= MAX_SHIELDS_PER_ROUND
                    ? 'Installed this round — one per round'
                    : 'Absorbs one warhead, then it is spent. Not needed on a bunker.'
                }
              >
                {cityButton('shield', 'Place')}
              </CopCard>

              <CopCard
                art={ART.cop.bunker}
                name="Bunker"
                price={cash(COSTS.underground)}
                priceNote="1/game"
                status={hasBunker ? 'owned' : pickable.underground ? 'ready' : 'poor'}
                advised={advisedDefence.has('bunker')}
                detail={
                  hasBunker
                    ? 'Your bunker city is dug in — only a hydrogen bomb cracks it'
                    : `One city, for the whole match: nukes cannot destroy it. Drones still cost it ${cash(DRONE_DAMAGE / 2)}.`
                }
              >
                {hasBunker ? (
                  <span className="cop-owned">✓ Dug in</span>
                ) : (
                  cityButton('underground', 'Place')
                )}
              </CopCard>

              <CopCard
                art={ART.cop.laser}
                name="Laser network"
                price={cash(COSTS.laser)}
                priceNote="1/nation"
                status={
                  !me.hasAerospaceTech
                    ? 'locked'
                    : hasLaserNet
                      ? 'owned'
                      : pickable.laser
                        ? 'ready'
                        : 'poor'
                }
                advised={advisedDefence.has('laser')}
                detail={
                  !me.hasAerospaceTech
                    ? 'Needs Aerospace Tech'
                    : hasLaserNet
                      ? 'Covering every city — burns with its control site'
                      : `Covers every city · shoots down ${LASER_INTERCEPTS_PER_ROUND} swarms a round. A magnetic bomb darkens it.`
                }
              >
                {!me.hasAerospaceTech ? null : hasLaserNet ? (
                  <span className="cop-owned">✓ Online</span>
                ) : (
                  cityButton('laser', 'Place')
                )}
              </CopCard>

              <CopCard
                art={ART.cop.rebuild}
                name="Rebuild"
                price={cash(COSTS.rebuild)}
                status={rubble === 0 ? 'idle' : pickable.rebuild ? 'ready' : 'poor'}
                advised={advisedDefence.has('rebuild')}
                detail={
                  rubble === 0
                    ? 'No rubble — every city is standing'
                    : `${rubble} ${rubble === 1 ? 'city' : 'cities'} in ruins. Stands again at half score, bare of upgrades.`
                }
              >
                {rubble === 0 ? (
                  <span className="cop-owned">All standing</span>
                ) : (
                  cityButton('rebuild', 'Rebuild')
                )}
              </CopCard>
            </section>
          )}

          {view === 'finance' && (
            <section className="cop__page cop__page--finance" aria-label="Finance and intelligence">
              {citiesStrip}
              <CopCard
                art={ART.cop.research}
                name="Research Center"
                price={cash(COSTS.research)}
                status={pickable.research ? 'ready' : canPay(COSTS.research) ? 'idle' : 'poor'}
                detail={`That city earns +${cash(RESEARCH_INCOME)} every round while it stands. Burns with the city.`}
              >
                {cityButton('research', 'Build')}
              </CopCard>
              <CopCard
                art={ART.cop.spy}
                name="Spy service"
                price={cash(COSTS.spy)}
                priceNote="once"
                status={me.hasSpyNetwork ? 'owned' : canPay(COSTS.spy) ? 'ready' : 'poor'}
                detail={
                  me.hasSpyNetwork
                    ? 'Active — every enemy defence is on your map'
                    : 'Shields, bunkers, labs and lasers on every enemy city'
                }
              >
                {me.hasSpyNetwork ? (
                  <span className="cop-owned">✓ Active</span>
                ) : (
                  <button
                    type="button"
                    className="cop-btn"
                    disabled={!canBuySpyNetwork(state, actorId)}
                    onClick={() => onOrder((s) => buySpyNetwork(s, actorId), 'Spy service opened')}
                  >
                    {canPay(COSTS.spy) ? 'Buy' : `Need ${cash(need(COSTS.spy))}`}
                  </button>
                )}
              </CopCard>

              <article className="cop-card is-ready cop-card--sanction">
                <img className="cop-card__art" src={ART.cop.sanction} alt="" draggable={false} />
                <div className="cop-card__body">
                  <h4>Sanctions</h4>
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
                          className={`cop-sanction${on ? ' is-on' : ''}`}
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

        <footer className="cop__foot">
          <p>
            {othersPending != null && othersPending > 0
              ? `${othersPending} other commander${othersPending === 1 ? ' is' : 's are'} still ordering · `
              : ''}
            {warheads > 0 || me.drones > 0
              ? `Ready to fire: ${warheads} warhead${warheads === 1 ? '' : 's'} · ${me.drones} drone pack${
                  me.drones === 1 ? '' : 's'
                }`
              : 'Nothing armed yet — buy weapons above, or lock in with no strike.'}
          </p>
          <button type="button" className="btn btn--xl btn--primary" onClick={onProceed}>
            {warheads > 0 || me.drones > 0 ? 'Choose Targets →' : 'Lock Orders'}
          </button>
        </footer>
      </div>
    </div>
  );
}
