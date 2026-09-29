import {
  COSTS,
  DRONE_DAMAGE,
  MAX_ROUNDS,
  MAX_SANCTIONS,
  RESEARCH_INCOME,
  SANCTION_PENALTY,
  nationDef,
} from '../data/nations';
import {
  allScores,
  assetLossFor,
  canBuyBombs,
  canBuyDrones,
  canBuyRebuild,
  canBuyResearch,
  canBuySpyNetwork,
  researchCount,
  sanctionsLeft,
  canBuyShield,
  canBuyUnderground,
  cityAsSeenBy,
  seesCity,
  formatMoney,
  totalWarheads,
  whoIsSanctioning,
} from './engine';
import {
  maxBombsBundled,
  maxDronesBundled,
  maxHydrogenBundled,
  maxMagneticBundled,
} from './bundles';
import type { City, GameState, NationId, PendingStrike, RoundScore, RoundWorldEvent } from '../types';

/** What one of your cities lived through in the round just played. */
export type BriefingCityStatus =
  | 'quiet'
  | 'rebuilt'
  | 'intercepted'
  | 'swarmed'
  | 'shieldLost'
  | 'absorbed'
  | 'destroyed';

/** Worst thing that happened to a city is what its tile reports. */
const STATUS_ORDER: BriefingCityStatus[] = [
  'quiet',
  'rebuilt',
  'intercepted',
  'swarmed',
  'shieldLost',
  'absorbed',
  'destroyed',
];

const EVENT_STATUS: Partial<Record<RoundWorldEvent['kind'], BriefingCityStatus>> = {
  cityRebuilt: 'rebuilt',
  dronesIntercepted: 'intercepted',
  droneDamage: 'swarmed',
  shieldDestroyed: 'shieldLost',
  strikeAbsorbed: 'absorbed',
  cityDestroyed: 'destroyed',
};

export interface BriefingCity {
  id: string;
  name: string;
  status: BriefingCityStatus;
  destroyed: boolean;
  isUnderground: boolean;
  hasShield: boolean;
  hasResearch: boolean;
  hasLaser: boolean;
  /** Rivals that aimed at this city in the round just played */
  attackers: NationId[];
}

/** A rival's whole volley against us, collapsed into one row. */
export interface BriefingRaider {
  id: NationId;
  nukes: number;
  swarms: number;
  cities: string[];
}

/** What the nation owns going into the round. */
export interface BriefingAssets {
  standing: number;
  rubble: number;
  shields: number;
  bunkers: number;
  labs: number;
  lasers: number;
  bombs: number;
  drones: number;
  spyNetwork: boolean;
  /** Warheads / packs can actually be bought and fired this round */
  canArmNukes: boolean;
  canArmDrones: boolean;
  money: number;
}

export type BriefingWeaknessId =
  | 'lastStand'
  | 'cannotRebuild'
  | 'finalPush'
  | 'rubbleIdle'
  | 'openCities'
  | 'brokeTreasury'
  | 'noWarheads'
  | 'emptyArsenal'
  | 'sanctionSqueeze'
  | 'losingRace'
  | 'holding';

/** The one thing most likely to lose the game, and what to do about it. */
export interface BriefingWeakness {
  id: BriefingWeaknessId;
  severity: 'critical' | 'high' | 'watch' | 'none';
  title: string;
  detail: string;
  advice: string;
}

/** One visual order chip on the commander dashboard. */
export type BriefingOrderIcon =
  | 'shield'
  | 'bunker'
  | 'laser'
  | 'rebuild'
  | 'nuke'
  | 'drone'
  | 'hydrogen'
  | 'magnetic'
  | 'hold';

export interface BriefingOrder {
  /** Short verb shown above the city name */
  action: string;
  nationId: NationId;
  cityId: string;
  cityName: string;
  icon: BriefingOrderIcon;
}

/** Finance and intelligence moves the advisor can recommend. */
export type BriefingIntelKind = 'spy' | 'research' | 'sanction';

export interface BriefingIntelAdvice {
  kind: BriefingIntelKind;
  /** Short verb shown above the detail */
  action: string;
  /** One plain sentence on why this is worth doing now */
  reason: string;
  /** The rival to sanction, when the advice is a sanction */
  nationId?: NationId;
}

/** One city on the world table, as this commander is able to read it. */
export interface BriefingWorldCity {
  id: string;
  name: string;
  destroyed: boolean;
  /** Spy service or a swarm has read this city — otherwise defences are not known */
  known: boolean;
  hasShield: boolean;
  isUnderground: boolean;
  hasResearch: boolean;
  hasLaser: boolean;
  /** What last round did to the city — only known for the viewer's own cities */
  status?: BriefingCityStatus;
}

/** One ranked nation on the world table. */
export interface BriefingWorldRow {
  nationId: NationId;
  rank: number;
  total: number;
  eliminated: boolean;
  isYou: boolean;
  cities: BriefingWorldCity[];
}

export interface RoundBriefing {
  round: number;
  nationId: NationId;
  cities: BriefingCity[];
  raiders: BriefingRaider[];
  sanctioners: NationId[];
  sanctionPenalty: number;
  /** Treasury now, after this round's income landed */
  money: number;
  previousBalance: number;
  income: number;
  droneRepairs: number;
  /** Cities + shields wiped last round, at replacement cost */
  assetLoss: number;
  /** Asset loss plus drone repair bills — what the round took from us */
  damageReceived: number;
  /** What our launched warheads and swarms cost to fire */
  warfareSpent: number;
  /** Replacement cost and repair bills our attacks put on other nations */
  enemyLoss: number;
  scores: RoundScore[];
  assets: BriefingAssets;
  weakness: BriefingWeakness;
  /** Cover / rebuild this city first */
  defence: BriefingOrder;
  /** Strike this rival city next, when armed */
  offence: BriefingOrder | null;
  /** Every city the advisor wants covered, most urgent first */
  defenceOrders: BriefingOrder[];
  /** Every rival city the advisor wants hit, best first — only what we can actually see */
  offenceOrders: BriefingOrder[];
  /** Spy, research and sanction moves that make sense this round */
  intelAdvice: BriefingIntelAdvice[];
  /** Ranked table of the whole world, defences hidden wherever we have no eyes */
  world: BriefingWorldRow[];
  /** Nobody laid a finger on us — the page is standings and treasury only */
  untouched: boolean;
}

const NUKE_KINDS: RoundWorldEvent['kind'][] = [
  'cityDestroyed',
  'shieldDestroyed',
  'strikeAbsorbed',
];

const cash = (amount: number) => `$${formatMoney(amount)}`;

const LOSS_KINDS: RoundWorldEvent['kind'][] = [
  'cityDestroyed',
  'shieldDestroyed',
  'droneDamage',
];

/** What one launched weapon cost the attacker. A missing kind is a nuclear warhead. */
export function weaponSpend(weapon: PendingStrike['weapon']): number {
  if (weapon === 'drone') return COSTS.drone;
  if (weapon === 'hydrogen') return COSTS.bombHydrogen;
  if (weapon === 'magnetic') return COSTS.bombMagnetic;
  return COSTS.bomb;
}

function stampedLoss(event: RoundWorldEvent): number {
  if (event.amount != null) return event.amount;
  if (event.kind === 'shieldDestroyed') return COSTS.shield;
  if (event.kind === 'droneDamage') return DRONE_DAMAGE;
  if (event.kind === 'cityDestroyed') return COSTS.rebuild;
  return 0;
}

export interface CombatLedger {
  received: number;
  spent: number;
  caused: number;
}

/**
 * Last round's exchange for these seats: damage taken, money spent firing,
 * and the loss those shots put on everyone else.
 */
export function combatLedger(state: GameState, nationIds: NationId[]): CombatLedger {
  const mine = new Set(nationIds);
  const events = state.previousRoundEvents ?? [];
  const received = +nationIds
    .reduce((sum, id) => {
      const ledger = state.lastIncomeLedger.find((e) => e.nationId === id);
      const repairs =
        ledger?.droneDamage ??
        events
          .filter((e) => e.nationId === id && e.kind === 'droneDamage')
          .reduce((bill, e) => bill + stampedLoss(e), 0);
      return sum + assetLossFor(events, id) + repairs;
    }, 0)
    .toFixed(2);
  const spent = +(state.resolvedStrikes ?? [])
    .filter((strike) => mine.has(strike.attackerId))
    .reduce((sum, strike) => sum + weaponSpend(strike.weapon), 0)
    .toFixed(2);
  const caused = +events
    .filter(
      (event) =>
        event.attackerId != null &&
        mine.has(event.attackerId) &&
        LOSS_KINDS.includes(event.kind),
    )
    .reduce((sum, event) => sum + stampedLoss(event), 0)
    .toFixed(2);
  return { received, spent, caused };
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function readAssets(state: GameState, myId: NationId): BriefingAssets {
  const n = state.nations[myId];
  const alive = n.cities.filter((c) => !c.destroyed);
  return {
    standing: alive.length,
    rubble: n.cities.length - alive.length,
    shields: alive.filter((c) => c.hasShield).length,
    bunkers: alive.filter((c) => c.isUnderground).length,
    labs: alive.filter((c) => c.hasResearch).length,
    lasers: alive.filter((c) => c.hasLaser).length,
    bombs: totalWarheads(n),
    drones: n.drones,
    spyNetwork: Boolean(n.hasSpyNetwork),
    // Tech comes with the first purchase, so an untouched arsenal can still be armed
    canArmNukes: canBuyBombs(state, myId) || !n.hasNuclearTech,
    canArmDrones: canBuyDrones(state, myId) || !n.hasAerospaceTech,
    money: n.money,
  };
}

/**
 * The single thing most likely to end this player's game, ordered by what
 * actually loses matches: losing your last city, then rubble you are not
 * turning back into points, then cities nobody is defending, then having no
 * way to take points off anyone. Only one is shown — a list of five problems
 * is not advice.
 */
function findWeakness(
  state: GameState,
  myId: NationId,
  assets: BriefingAssets,
  scores: RoundScore[],
  sanctioners: NationId[],
  income: number,
  sanctionPenalty: number,
): BriefingWeakness {
  const n = state.nations[myId];
  const alive = n.cities.filter((c) => !c.destroyed);
  const money = assets.money;
  const mine = scores.find((s) => s.nationId === myId);
  const top = scores.find((s) => !s.eliminated);
  const leading = top?.nationId === myId;
  const chaser = scores.find((s) => !s.eliminated && s.nationId !== myId);
  const rival = leading ? chaser : top;
  const rivalName = rival ? nationDef(rival.nationId).name : 'the leader';
  const gap = Math.max(0, (rival?.total ?? 0) - (mine?.total ?? 0));
  const lead = leading ? Math.max(0, (mine?.total ?? 0) - (chaser?.total ?? 0)) : 0;
  const roundsLeft = Math.max(0, MAX_ROUNDS - state.round);
  const armedRivals = state.turnOrder.filter(
    (id) => id !== myId && !state.nations[id].eliminated && state.nations[id].bombs > 0,
  );

  // Last city standing, and a warhead can still reach it
  const lastCity = alive.length === 1 ? alive[0] : null;
  if (lastCity && !lastCity.isUnderground) {
    return {
      id: 'lastStand',
      severity: 'critical',
      title: 'One city from elimination',
      detail: `${lastCity.name} is all you have left, ${
        lastCity.hasShield ? 'behind a single shield' : 'and nothing is covering it'
      }.${armedRivals.length > 0 ? ` ${plural(armedRivals.length, 'rival')} holding warheads.` : ''}`,
      advice:
        money >= COSTS.underground
          ? `Move it underground for ${cash(COSTS.underground)} — only a hydrogen bomb cracks a bunker.`
          : !lastCity.hasShield && money >= COSTS.shield
            ? `Put the ${cash(COSTS.shield)} shield up now; it absorbs the next warhead outright.`
            : `Keep ${cash(COSTS.rebuild)} in the bank — without the rebuild you are out the moment it falls.`,
    };
  }

  if (assets.rubble > 0 && money < COSTS.rebuild) {
    return {
      id: 'cannotRebuild',
      severity: alive.length <= 1 ? 'critical' : 'high',
      title: 'Rubble you cannot afford to raise',
      detail: `${plural(assets.rubble, 'city', 'cities')} in ruins and ${cash(
        money,
      )} in the treasury — a rebuild costs ${cash(COSTS.rebuild)}.`,
      advice: `Buy nothing this round and the income covers it next. A standing city is 30 points plus 10 more every round it survives.`,
    };
  }

  // Last scheduled round: defence no longer scores, only points do
  if (roundsLeft <= 0 && gap > 0) {
    return {
      id: 'finalPush',
      severity: 'critical',
      title: 'Final round, and behind',
      detail: `${rivalName} leads you by ${gap} points with nothing left to play after this.`,
      advice:
        assets.bombs > 0
          ? `Defence cannot close ${gap} points. Put your ${plural(assets.bombs, 'warhead')} into ${rivalName}'s cities — each one is 30 points off them.`
          : assets.canArmNukes && money >= COSTS.bomb
            ? `Buy warheads at ${cash(COSTS.bomb)} each and fire everything at ${rivalName}; nothing else moves the score now.`
            : `Rebuild and build labs — with no arsenal, points on the board are all you can still add.`,
    };
  }

  if (assets.rubble > 0) {
    return {
      id: 'rubbleIdle',
      severity: 'high',
      title: 'Rubble left sitting',
      detail: `${plural(assets.rubble, 'city', 'cities')} in ruins, and rubble scores nothing while ${plural(
        roundsLeft,
        'round',
      )} remain.`,
      advice: `Rebuild for ${cash(COSTS.rebuild)} — the best value on the board, and you can cover ${Math.floor(
        money / COSTS.rebuild,
      )} of them right now.`,
    };
  }

  if (assets.shields === 0 && assets.bunkers === 0) {
    return {
      id: 'openCities',
      severity: armedRivals.length > 0 ? 'critical' : 'high',
      title: 'Nothing over your cities',
      detail:
        armedRivals.length > 0
          ? `No shields, no bunkers, and ${plural(armedRivals.length, 'rival')} are holding warheads tonight.`
          : `No shields and no bunkers anywhere — every city is a one-warhead kill.`,
      advice:
        money >= COSTS.underground
          ? `${cash(COSTS.shield)} buys a shield that eats one warhead; ${cash(COSTS.underground)} buries a city for good. Cover the one you would hate to lose.`
          : money >= COSTS.shield
            ? `Put the ${cash(COSTS.shield)} shield over your best city before you spend on anything else.`
            : `A shield is ${cash(COSTS.shield)} and you are ${cash(COSTS.shield - money)} short — bank this round rather than spending small.`,
    };
  }

  if (money < COSTS.shield) {
    return {
      id: 'brokeTreasury',
      severity: 'high',
      title: 'Treasury too thin to act',
      detail: `${cash(money)} does not cover a shield (${cash(COSTS.shield)}), a warhead (${cash(
        COSTS.bomb,
      )}) or a rebuild (${cash(COSTS.rebuild)}).`,
      advice:
        assets.labs < assets.standing && money >= COSTS.research
          ? `A research centre is ${cash(COSTS.research)} and pays ${cash(RESEARCH_INCOME)} every round after — the only buy that fixes this.`
          : `Spend nothing and let the income stack; you cannot defend or attack from here.`,
    };
  }

  if (!n.hasNuclearTech) {
    return {
      id: 'noWarheads',
      severity: roundsLeft <= 1 ? 'critical' : 'high',
      title: 'No warheads, no deterrent',
      detail: `You cannot take a city off anyone, and a nation that cannot hit back is the cheapest target at the table.`,
      advice:
        money >= COSTS.ballisticMissileTech + COSTS.bomb
          ? `Your first warhead brings Ballistic Missile Tech with it: ${cash(
              COSTS.ballisticMissileTech + COSTS.bomb,
            )} in all, then ${cash(COSTS.bomb)} each — buy it this round.`
          : `Your first warhead comes to ${cash(
              COSTS.ballisticMissileTech + COSTS.bomb,
            )} with Ballistic Missile Tech included, and you are ${cash(
              COSTS.ballisticMissileTech + COSTS.bomb - money,
            )} short. Hold the cash until you can.`,
    };
  }

  if (assets.bombs === 0 && assets.drones === 0) {
    return {
      id: 'emptyArsenal',
      severity: leading ? 'watch' : 'high',
      title: 'Nothing loaded to fire',
      detail: `No warheads and no drone packs, so this round you can only watch the table score.`,
      advice:
        assets.canArmNukes && money >= COSTS.bomb
          ? `Warheads are ${cash(COSTS.bomb)} each, up to 3 a round. Drone packs at ${cash(
              COSTS.drone,
            )} bill a rival ${cash(DRONE_DAMAGE)} a hit and keep a shield busy.`
          : `Save for warheads at ${cash(COSTS.bomb)} each; a nation with an empty rack never wins a tie.`,
    };
  }

  if (sanctioners.length >= MAX_SANCTIONS && sanctionPenalty > 0) {
    const gross = income / (1 - sanctionPenalty);
    return {
      id: 'sanctionSqueeze',
      severity: 'watch',
      title: 'Income being strangled',
      detail: `${sanctioners
        .map((id) => nationDef(id).name)
        .join(' and ')} are both sanctioning you — ${Math.round(
        sanctionPenalty * 100,
      )}% off everything you earn, ${cash(gross - income)} gone this round.`,
      advice: `A sanction list is a target list: they are squeezing you because they mean to shoot at you. Cover your cities, and a research centre still nets ${cash(
        RESEARCH_INCOME * (1 - sanctionPenalty),
      )} a round through the squeeze.`,
    };
  }

  if (gap >= 30) {
    return {
      id: 'losingRace',
      severity: roundsLeft <= 1 ? 'high' : 'watch',
      title: `${rivalName} is pulling away`,
      detail: `${gap} points behind with ${plural(roundsLeft, 'round')} to play. Every city is 30 points plus 10 a round it survives.`,
      advice:
        assets.bombs > 0
          ? `Take a city off ${rivalName} — it swings 30 points and everything that city would have earned them.`
          : `Points come from cities, labs and shields you keep. Buy what scores, not what merely survives.`,
    };
  }

  return {
    id: 'holding',
    severity: 'none',
    title: leading ? 'You are ahead — now hold it' : 'No glaring weakness',
    detail: leading
      ? `${lead} points clear of ${rivalName}. The whole table reads the scoreboard, so the lead is the target.`
      : `Cities covered, treasury working, arsenal loaded.`,
    advice: leading
      ? `Spend on what cannot be taken away: bunkers at ${cash(COSTS.underground)}, and rebuilds the moment anything falls.`
      : `Press it — ${plural(roundsLeft, 'round')} left, and the nation that banks cities wins.`,
  };
}

function cityValue(city: City): number {
  let score = 1;
  if (city.hasResearch) score += 3;
  if (city.hasLaser) score += 2;
  if (city.hasShield) score += 1;
  if (city.isUnderground) score += 1;
  return score;
}

/**
 * What to spend on defence, in the order it matters: rebuild rubble, then one
 * bunker or shield over the city worth most, a laser net when swarms are about,
 * then a second shield. Every order fits the treasury; if nothing does, the one
 * order is to hold the best city. Your own cities are never hidden from you.
 */
export function findDefenceOrders(state: GameState, myId: NationId): BriefingOrder[] {
  const n = state.nations[myId];
  const rubble = n.cities.filter((c) => c.destroyed);
  const alive = n.cities.filter((c) => !c.destroyed);
  const order = (city: City, action: string, icon: BriefingOrderIcon): BriefingOrder => ({
    action,
    nationId: myId,
    cityId: city.id,
    cityName: city.name,
    icon,
  });
  const orders: BriefingOrder[] = [];
  let budget = n.money;

  if (rubble.length > 0 && canBuyRebuild(state, myId)) {
    orders.push(order(rubble[0], 'Rebuild', 'rebuild'));
    budget -= COSTS.rebuild;
  }

  const byValue = [...alive].sort((a, b) => cityValue(b) - cityValue(a));
  const open = byValue.filter((c) => !c.hasShield && !c.isUnderground);
  const covered = new Set<string>();

  // One bunker per nation: bury the city that matters most
  const target = open[0];
  if (target) {
    if (canBuyUnderground(state, myId) && budget >= COSTS.underground && alive.every((c) => !c.isUnderground)) {
      orders.push(order(target, 'Bunker', 'bunker'));
      budget -= COSTS.underground;
      covered.add(target.id);
    } else if (canBuyShield(state, myId) && budget >= COSTS.shield) {
      orders.push(order(target, 'Shield', 'shield'));
      budget -= COSTS.shield;
      covered.add(target.id);
    }
  }

  // Swarms go around shields; one laser network shoots them down nation-wide
  const swarmThreat =
    (state.previousRoundEvents ?? []).some(
      (e) => e.nationId === myId && (e.kind === 'droneDamage' || e.kind === 'dronesIntercepted'),
    ) ||
    state.turnOrder.some((id) => id !== myId && !state.nations[id].eliminated && state.nations[id].drones > 0);
  const laserPrice = COSTS.laser + (n.hasAerospaceTech ? 0 : COSTS.aerospaceTech);
  if (
    swarmThreat &&
    !alive.some((c) => c.hasLaser) &&
    budget >= laserPrice &&
    alive.length > 0
  ) {
    const host = byValue.find((c) => !c.hasLaser) ?? byValue[0];
    orders.push(order(host, 'Laser', 'laser'));
    budget -= laserPrice;
  }

  // A second shield on the next most valuable open city
  const next = open.find((c) => !covered.has(c.id));
  if (next && orders.length < 3 && canBuyShield(state, myId) && budget >= COSTS.shield) {
    orders.push(order(next, 'Shield', 'shield'));
    budget -= COSTS.shield;
  }

  if (orders.length > 0) return orders.slice(0, 3);

  const prize = byValue[0] ?? n.cities[0];
  return [order(prize, 'Hold', 'hold')];
}

const DEFENCE_PRICE: Record<BriefingOrderIcon, () => number> = {
  rebuild: () => COSTS.rebuild,
  bunker: () => COSTS.underground,
  shield: () => COSTS.shield,
  laser: () => COSTS.laser,
  nuke: () => 0,
  drone: () => 0,
  hydrogen: () => 0,
  magnetic: () => 0,
  hold: () => 0,
};

/**
 * Spy service, research centres and sanctions — the finance and intel side of
 * the dashboard. Each is advised only when it pays: money the defence orders
 * already claim is never double-booked, a spy service only when there is a
 * warhead or swarm to aim with it, and nothing that would bear fruit after the
 * last round.
 */
export function findIntelAdvice(
  state: GameState,
  myId: NationId,
  defenceOrders: BriefingOrder[] = findDefenceOrders(state, myId),
  offenceOrders: BriefingOrder[] = findOffenceOrders(state, myId),
): BriefingIntelAdvice[] {
  const me = state.nations[myId];
  if (!me || me.eliminated) return [];
  const advice: BriefingIntelAdvice[] = [];
  const roundsLeft = Math.max(0, state.maxRounds - state.round);
  const defenceSpend = defenceOrders.reduce((sum, o) => sum + DEFENCE_PRICE[o.icon](), 0);
  const spare = me.money - defenceSpend;
  const rivals = state.turnOrder.filter((id) => id !== myId && !state.nations[id].eliminated);
  if (rivals.length === 0) return [];

  // Eyes before warheads: blind, shields and bunkers eat the volley
  const armed = totalWarheads(me) > 0 || me.drones > 0;
  const aimCost = armed ? 0 : COSTS.bomb;
  if (
    !me.hasSpyNetwork &&
    canBuySpyNetwork(state, myId) &&
    offenceOrders.length > 0 &&
    spare >= COSTS.spy + aimCost
  ) {
    advice.push({
      kind: 'spy',
      action: 'Spy service',
      reason: `${cash(COSTS.spy)} once shows every rival shield, bunker and laser, so no warhead is wasted.`,
    });
  }

  // A centre repays its price in a couple of rounds and adds score meanwhile
  if (
    roundsLeft >= 2 &&
    researchCount(state, myId) < 2 &&
    canBuyResearch(state, myId) &&
    spare >= COSTS.research
  ) {
    advice.push({
      kind: 'research',
      action: 'Research',
      reason: `${cash(COSTS.research)} for +${cash(RESEARCH_INCOME)} every round it stands, with ${roundsLeft} rounds to go.`,
    });
  }

  // Sanctions cost nothing: squeeze the leader, or whoever has been raiding us
  if (roundsLeft >= 1 && sanctionsLeft(state, myId) > 0) {
    const scores = allScores(state);
    const raiders = new Set(
      (state.previousRoundEvents ?? [])
        .filter((e) => e.nationId === myId && e.attackerId)
        .map((e) => e.attackerId as NationId),
    );
    const candidates = rivals.filter((id) => !me.sanctions.includes(id));
    const pick = candidates
      .map((id) => ({
        id,
        rank: scores.findIndex((row) => row.nationId === id),
        raider: raiders.has(id),
      }))
      .sort((a, b) => Number(b.raider) - Number(a.raider) || a.rank - b.rank)[0];
    if (pick) {
      const name = nationDef(pick.id).name;
      advice.push({
        kind: 'sanction',
        action: 'Sanction',
        nationId: pick.id,
        reason: pick.raider
          ? `${name} raided you. Free: −${Math.round(SANCTION_PENALTY * 100)}% of their income.`
          : `${name} ${pick.rank === 0 ? 'leads the table' : 'is your strongest open rival'}. Free: −${Math.round(SANCTION_PENALTY * 100)}% of their income.`,
      });
    }
  }

  return advice;
}

/** Cover, bury, or rebuild the city most worth saving this round. */
export function findDefenceOrder(state: GameState, myId: NationId): BriefingOrder {
  return findDefenceOrders(state, myId)[0];
}

/**
 * Rival cities worth hitting next, best first. The advisor only reasons from
 * what this commander can see: without a spy service (or a swarm that flew
 * over the city) shields, bunkers and lasers are unknown, so the advice is a
 * plain warhead on the strongest rival and never claims an open city.
 */
export function findOffenceOrders(state: GameState, myId: NationId, limit = 3): BriefingOrder[] {
  const me = state.nations[myId];
  const scores = allScores(state);
  const rivals = state.turnOrder.filter((id) => id !== myId && !state.nations[id].eliminated);
  if (rivals.length === 0) return [];

  const mine = scores.find((s) => s.nationId === myId);
  const top = scores.find((s) => !s.eliminated && s.nationId !== myId);
  const sanctioners = new Set(whoIsSanctioning(state, myId));
  const prior = state.previousRoundEvents ?? [];
  const raiders = new Set(
    prior.filter((e) => e.nationId === myId && e.attackerId).map((e) => e.attackerId as NationId),
  );

  // What is in stock, or what the treasury can still buy (tech comes with the first purchase)
  const canNuke = totalWarheads(me) > 0 || maxBombsBundled(state, myId) > 0;
  const canHydrogen = (me.hydrogenBombs ?? 0) > 0 || maxHydrogenBundled(state, myId) > 0;
  const canMagnetic = (me.magneticBombs ?? 0) > 0 || maxMagneticBundled(state, myId) > 0;
  const canSwarm = me.drones > 0 || maxDronesBundled(state, myId) > 0;
  if (!canNuke && !canHydrogen && !canSwarm) return [];

  const nationRank = (id: NationId): number => {
    let score = 0;
    if (id === top?.nationId) score += 40;
    if (sanctioners.has(id)) score += 12;
    if (raiders.has(id)) score += 10;
    const row = scores.find((s) => s.nationId === id);
    score += Math.min(20, Math.max(0, (row?.total ?? 0) - (mine?.total ?? 0)));
    return score;
  };

  type Candidate = { nationId: NationId; city: City; action: string; icon: BriefingOrderIcon; score: number };
  const picks: Candidate[] = [];
  const nuke = { action: 'Nuke', icon: 'nuke' as BriefingOrderIcon };
  const swarm = { action: 'Drone', icon: 'drone' as BriefingOrderIcon };

  for (const nationId of rivals) {
    const nation = state.nations[nationId];
    // Only what we can read: a laser we cannot see does not exist for the advisor
    const laserKnown = nation.cities.some(
      (c) => !c.destroyed && seesCity(state, myId, nationId, c.id) && c.hasLaser,
    );
    for (const raw of nation.cities) {
      if (raw.destroyed) continue;
      const known = seesCity(state, myId, nationId, raw.id);
      const city = cityAsSeenBy(state, myId, nationId, raw);
      let pick: { action: string; icon: BriefingOrderIcon } | null = null;
      let score = nationRank(nationId) + cityValue(city);

      if (!known) {
        // Blind: a warhead is a gamble, and a swarm is how we learn what is there
        if (canNuke) pick = nuke;
        else if (canSwarm) pick = swarm;
        score += 2;
      } else if (city.isUnderground) {
        if (canHydrogen) {
          pick = { action: 'Hydrogen', icon: 'hydrogen' };
          score += 8;
        }
      } else if (city.hasShield) {
        if (canSwarm) {
          pick = swarm;
          score += 6;
        } else if (canHydrogen) {
          pick = { action: 'Hydrogen', icon: 'hydrogen' };
          score += 5;
        } else if (canNuke) {
          pick = nuke;
          score -= 20; // A bare warhead dies on the dome
        }
      } else if (canNuke) {
        pick = nuke;
        score += 14; // Open city — best kill
      } else if (canSwarm) {
        pick = swarm;
        score += 4;
      }

      if (pick && known && laserKnown && !city.isUnderground && canMagnetic && pick.icon !== 'drone') {
        pick = { action: 'Magnetic', icon: 'magnetic' };
        score += 4;
      }
      if (!pick) continue;
      picks.push({ nationId, city: raw, action: pick.action, icon: pick.icon, score });
    }
  }

  picks.sort((a, b) => b.score - a.score);
  return picks.slice(0, limit).map((best) => ({
    action: best.action,
    nationId: best.nationId,
    cityId: best.city.id,
    cityName: best.city.name,
    icon: best.icon,
  }));
}

/** The single best rival city to hit next. */
export function findOffenceOrder(state: GameState, myId: NationId): BriefingOrder | null {
  return findOffenceOrders(state, myId, 1)[0] ?? null;
}

/** Ranked world table with every defence the viewer has no eyes on hidden. */
function buildWorld(
  state: GameState,
  myId: NationId,
  scores: RoundScore[],
  ownStatus: Map<string, BriefingCityStatus>,
): BriefingWorldRow[] {
  return scores.map((row, i) => {
    const nation = state.nations[row.nationId];
    return {
      nationId: row.nationId,
      rank: i + 1,
      total: row.total,
      eliminated: row.eliminated,
      isYou: row.nationId === myId,
      cities: nation.cities.map((raw) => {
        const known = seesCity(state, myId, row.nationId, raw.id);
        const city = cityAsSeenBy(state, myId, row.nationId, raw);
        return {
          id: raw.id,
          name: raw.name,
          destroyed: raw.destroyed,
          known,
          hasShield: Boolean(city.hasShield),
          isUnderground: Boolean(city.isUnderground),
          hasResearch: Boolean(city.hasResearch),
          hasLaser: Boolean(city.hasLaser),
          status: row.nationId === myId ? ownStatus.get(raw.id) : undefined,
        };
      }),
    };
  });
}

/**
 * Everything a player needs to see between rounds, gathered into one page:
 * what was done to their cities, who is squeezing them, what the treasury
 * looks like and where the table stands. Null in round 1, where none of it
 * exists yet.
 */
export function buildRoundBriefing(
  state: GameState,
  myId: NationId | null,
): RoundBriefing | null {
  if (!myId || !state.nations[myId] || state.round < 2) return null;

  const events = (state.previousRoundEvents ?? []).filter(
    (e) => e.nationId === myId && e.cityId,
  );

  const cities: BriefingCity[] = state.nations[myId].cities.map((city) => {
    const hits = events.filter((e) => e.cityId === city.id);
    let status: BriefingCityStatus = 'quiet';
    for (const hit of hits) {
      const next = EVENT_STATUS[hit.kind];
      if (next && STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(status)) status = next;
    }
    return {
      id: city.id,
      name: city.name,
      status,
      destroyed: city.destroyed,
      isUnderground: Boolean(city.isUnderground),
      hasShield: city.hasShield,
      hasResearch: city.hasResearch,
      hasLaser: Boolean(city.hasLaser),
      attackers: Array.from(
        new Set(hits.map((e) => e.attackerId).filter((id): id is NationId => Boolean(id))),
      ),
    };
  });

  const raiders: BriefingRaider[] = [];
  for (const event of events) {
    if (!event.attackerId) continue;
    let raider = raiders.find((r) => r.id === event.attackerId);
    if (!raider) {
      raider = { id: event.attackerId, nukes: 0, swarms: 0, cities: [] };
      raiders.push(raider);
    }
    if (NUKE_KINDS.includes(event.kind)) raider.nukes += 1;
    else raider.swarms += 1;
    if (event.cityName && !raider.cities.includes(event.cityName)) {
      raider.cities.push(event.cityName);
    }
  }

  const ledger = state.lastIncomeLedger.find((e) => e.nationId === myId);
  const money = state.nations[myId].money;
  const droneRepairs =
    ledger?.droneDamage ??
    events
      .filter((e) => e.kind === 'droneDamage')
      .reduce((sum, e) => sum + (e.amount ?? DRONE_DAMAGE), 0);
  // The ledger names whoever actually taxed this round's income; before it
  // lands, the live list is the best answer
  const sanctioners = ledger?.sanctioners ?? whoIsSanctioning(state, myId);
  const sanctionPenalty = ledger?.sanctionPenalty ?? 0;
  const income = ledger?.revenue ?? 0;
  const scores = allScores(state);
  const assets = readAssets(state, myId);
  const priorEvents = state.previousRoundEvents ?? [];
  const combat = combatLedger(state, [myId]);
  const defenceOrders = findDefenceOrders(state, myId);
  const offenceOrders = findOffenceOrders(state, myId);
  const intelAdvice = findIntelAdvice(state, myId, defenceOrders, offenceOrders);

  return {
    round: state.round,
    nationId: myId,
    cities,
    raiders,
    sanctioners,
    sanctionPenalty,
    money,
    previousBalance: ledger?.previousBalance ?? money,
    income,
    droneRepairs: +droneRepairs.toFixed(2),
    assetLoss: assetLossFor(priorEvents, myId),
    damageReceived: combat.received,
    warfareSpent: combat.spent,
    enemyLoss: combat.caused,
    scores,
    assets,
    weakness: findWeakness(state, myId, assets, scores, sanctioners, income, sanctionPenalty),
    defence: defenceOrders[0],
    offence: offenceOrders[0] ?? null,
    defenceOrders,
    offenceOrders,
    intelAdvice,
    world: buildWorld(state, myId, scores, new Map(cities.map((c) => [c.id, c.status]))),
    untouched: raiders.length === 0 && cities.every((c) => c.status === 'quiet'),
  };
}
