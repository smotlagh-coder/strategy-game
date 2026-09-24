import { COSTS, DRONE_DAMAGE, MAX_ROUNDS, MAX_SANCTIONS, RESEARCH_INCOME, nationDef } from '../data/nations';
import {
  allScores,
  assetLossFor,
  canBuyBombs,
  canBuyDrones,
  formatMoney,
  totalWarheads,
  whoIsSanctioning,
} from './engine';
import type { GameState, NationId, RoundScore, RoundWorldEvent } from '../types';

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
  scores: RoundScore[];
  assets: BriefingAssets;
  weakness: BriefingWeakness;
  /** Nobody laid a finger on us — the page is standings and treasury only */
  untouched: boolean;
}

const NUKE_KINDS: RoundWorldEvent['kind'][] = [
  'cityDestroyed',
  'shieldDestroyed',
  'strikeAbsorbed',
];

const cash = (amount: number) => `$${formatMoney(amount)}`;

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
    canArmNukes: canBuyBombs(state, myId),
    canArmDrones: canBuyDrones(state, myId),
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
          ? `Move it underground for ${cash(COSTS.underground)} — a bunker city cannot be nuked at all.`
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
        money >= COSTS.ballisticMissileTech
          ? `Ballistic Missile Tech is ${cash(COSTS.ballisticMissileTech)}, warheads ${cash(COSTS.bomb)} each after that — buy it this round.`
          : `Ballistic Missile Tech is ${cash(COSTS.ballisticMissileTech)} and you are ${cash(
              COSTS.ballisticMissileTech - money,
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
    scores,
    assets,
    weakness: findWeakness(state, myId, assets, scores, sanctioners, income, sanctionPenalty),
    untouched: raiders.length === 0 && cities.every((c) => c.status === 'quiet'),
  };
}
