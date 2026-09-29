import { useMemo, useState } from 'react';
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
  idleSecondsLeft,
  rivals,
  rivalArt,
  onOrder,
  onProceed,
}: {
  state: GameState;
  actorId: NationId;
  leaderSrc: string;
  playerName: string;
  idleSecondsLeft: number | null;
  rivals: NationId[];
  rivalArt: (id: NationId) => string;
  /** Apply an order to the live state (and sync it when online). */
  onOrder: (fn: (s: GameState) => GameState, label?: string) => void;
  onProceed: () => void;
}) {
  const me = state.nations[actorId];
  const [pick, setPick] = useState<CityPick | null>(null);
  const [tab, setTab] = useState<'offence' | 'defence'>('offence');

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
    if (kind === 'research') onOrder((s) => buyResearch(s, city.id, actorId), `Research in ${city.name}`);
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

  const stock = [
    { key: 'warheads', src: ART.missile, value: warheads, label: 'Warheads' },
    { key: 'drones', src: ART.cop.drone, value: me.drones, label: 'Drone packs' },
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

        {idleSecondsLeft != null && (
          <p className={`idle-timer cop__idle ${idleSecondsLeft <= 10 ? 'is-urgent' : ''}`}>
            Lock in within {idleSecondsLeft}s or you leave the game
          </p>
        )}

        <div className="cop__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'offence'}
            className={tab === 'offence' ? 'is-on is-offence' : 'is-offence'}
            onClick={() => setTab('offence')}
          >
            Offence
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'defence'}
            className={tab === 'defence' ? 'is-on is-defence' : 'is-defence'}
            onClick={() => setTab('defence')}
          >
            Defence
          </button>
        </div>

        <div className="cop__cols">
          <section
            className={`cop__col cop__col--offence${tab === 'offence' ? ' is-shown' : ''}`}
            aria-label="Offence"
          >
            <h3 className="cop__col-title">
              <span>Offence</span>
              <em>Take cities off rivals</em>
            </h3>

            <CopCard
              art={ART.cop.ballisticTech}
              name="Ballistic Missile Tech"
              price={cash(COSTS.ballisticMissileTech)}
              priceNote="once"
              status={techStatus(me.hasNuclearTech, COSTS.ballisticMissileTech)}
              detail={me.hasNuclearTech ? 'Unlocked — warheads are open' : 'Unlocks warheads right away'}
            >
              {me.hasNuclearTech ? (
                <span className="cop-owned">✓ Owned</span>
              ) : (
                <button
                  type="button"
                  className="cop-btn"
                  disabled={!canPay(COSTS.ballisticMissileTech)}
                  onClick={() => onOrder((s) => buyNuclearTech(s, actorId), 'Ballistic Missile Tech Unlocked!')}
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
              {armed && qtyButtons([1], hydrogenMax, () => onOrder((s) => buyHydrogenBomb(s, actorId), '+1 Hydrogen'))}
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
                  onClick={() => onOrder((s) => buyAerospaceTech(s, actorId), 'Aerospace Tech Unlocked!')}
                >
                  {canPay(COSTS.aerospaceTech) ? 'Buy' : `Need ${cash(need(COSTS.aerospaceTech))}`}
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

          <section
            className={`cop__col cop__col--defence${tab === 'defence' ? ' is-shown' : ''}`}
            aria-label="Defence"
          >
            <h3 className="cop__col-title">
              <span>Defence &amp; economy</span>
              <em>Keep what you have</em>
            </h3>

            <div className={`cop-cities${pick ? ' is-picking' : ''}`} aria-label="Your cities">
              {pick && (
                <p className="cop-cities__prompt">
                  <b>
                    {PICK_TITLE[pick]} · {cash(PICK_COST[pick])}
                  </b>{' '}
                  — tap a city
                  {pick === 'underground'
                    ? ' (this is your one bunker; a shield on it is scrapped)'
                    : ''}
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
                        {advice && !pick && ADVICE_ICON[advice] && (
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
              {hasBunker ? <span className="cop-owned">✓ Dug in</span> : cityButton('underground', 'Place')}
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
              {rubble === 0 ? <span className="cop-owned">All standing</span> : cityButton('rebuild', 'Rebuild')}
            </CopCard>

            <CopCard
              art={ART.cop.research}
              name="Research Center"
              price={cash(COSTS.research)}
              status={pickable.research ? 'ready' : canPay(COSTS.research) ? 'idle' : 'poor'}
              detail={`That city earns +${cash(RESEARCH_INCOME)} every round while it stands. Burns with the city.`}
            >
              {cityButton('research', 'Build')}
            </CopCard>
          </section>
        </div>

        <footer className="cop__foot">
          <p>
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
