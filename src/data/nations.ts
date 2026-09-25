import type { City, NationId, NationState } from '../types';

export interface NationDef {
  id: NationId;
  name: string;
  shortName: string;
  leader: string;
  color: string;
  cities: { id: string; name: string; landmark: string }[];
}

export const NATIONS: NationDef[] = [
  {
    id: 'china',
    name: 'China',
    shortName: 'CN',
    leader: 'Premier Zhao',
    color: '#c41e3a',
    cities: [
      { id: 'cn-1', name: 'Beijing', landmark: '🏯' },
      { id: 'cn-2', name: 'Shanghai', landmark: '🏙️' },
      { id: 'cn-3', name: 'Wuhan', landmark: '🌉' },
    ],
  },
  {
    id: 'russia',
    name: 'Russia',
    shortName: 'RU',
    leader: 'Marshal Volkov',
    color: '#0039a6',
    cities: [
      { id: 'ru-1', name: 'Moscow', landmark: '🕌' },
      { id: 'ru-2', name: 'St. Petersburg', landmark: '🏛️' },
      { id: 'ru-3', name: 'Sochi', landmark: '🏟️' },
    ],
  },
  {
    id: 'uk',
    name: 'United Kingdom',
    shortName: 'UK',
    leader: 'PM Harrington',
    color: '#012169',
    cities: [
      { id: 'uk-1', name: 'London', landmark: '🕰️' },
      { id: 'uk-2', name: 'Edinburgh', landmark: '🏰' },
      { id: 'uk-3', name: 'Manchester', landmark: '🏭' },
    ],
  },
  {
    id: 'us',
    name: 'United States',
    shortName: 'USA',
    leader: 'President Lane',
    color: '#3c3b6e',
    cities: [
      { id: 'us-1', name: 'New York', landmark: '🗽' },
      { id: 'us-2', name: 'Las Vegas', landmark: '🎰' },
      { id: 'us-3', name: 'Arizona', landmark: '🏜️' },
    ],
  },
  {
    id: 'france',
    name: 'France',
    shortName: 'FR',
    leader: 'Président Dubois',
    color: '#002395',
    cities: [
      { id: 'fr-1', name: 'Paris', landmark: '🗼' },
      { id: 'fr-2', name: 'Lyon', landmark: '⛪' },
      { id: 'fr-3', name: 'Marseille', landmark: '🗿' },
    ],
  },
  {
    id: 'india',
    name: 'India',
    shortName: 'IN',
    leader: 'PM Raghavan',
    color: '#ff9933',
    cities: [
      { id: 'in-1', name: 'New Delhi', landmark: '🛕' },
      { id: 'in-2', name: 'Mumbai', landmark: '🌇' },
      { id: 'in-3', name: 'Bengaluru', landmark: '💻' },
    ],
  },
  {
    id: 'pakistan',
    name: 'Pakistan',
    shortName: 'PK',
    leader: 'General Rahim',
    color: '#01411c',
    cities: [
      { id: 'pk-1', name: 'Islamabad', landmark: '🕌' },
      { id: 'pk-2', name: 'Karachi', landmark: '🛳️' },
      { id: 'pk-3', name: 'Lahore', landmark: '🏰' },
    ],
  },
  {
    id: 'iran',
    name: 'Iran',
    shortName: 'IR',
    leader: 'President Nasseri',
    color: '#239f40',
    cities: [
      { id: 'ir-1', name: 'Tehran', landmark: '🗼' },
      { id: 'ir-2', name: 'Isfahan', landmark: '🕌' },
      { id: 'ir-3', name: 'Bandar Abbas', landmark: '⚓' },
    ],
  },
  {
    id: 'northkorea',
    name: 'North Korea',
    shortName: 'DPRK',
    leader: 'Marshal Kang',
    color: '#ed1c27',
    cities: [
      { id: 'kp-1', name: 'Pyongyang', landmark: '🚩' },
      { id: 'kp-2', name: 'Hamhung', landmark: '🏭' },
      { id: 'kp-3', name: 'Wonsan', landmark: '🚢' },
    ],
  },
  {
    id: 'canada',
    name: 'Canada',
    shortName: 'CA',
    leader: 'PM Gagnon',
    color: '#d52b1e',
    cities: [
      { id: 'ca-1', name: 'Ottawa', landmark: '🏛️' },
      { id: 'ca-2', name: 'Toronto', landmark: '🗼' },
      { id: 'ca-3', name: 'Vancouver', landmark: '🏔️' },
    ],
  },
  {
    id: 'brazil',
    name: 'Brazil',
    shortName: 'BR',
    leader: 'President Ferreira',
    color: '#009c3b',
    cities: [
      { id: 'br-1', name: 'Brasília', landmark: '🏛️' },
      { id: 'br-2', name: 'Rio de Janeiro', landmark: '⛰️' },
      { id: 'br-3', name: 'São Paulo', landmark: '🌆' },
    ],
  },
  {
    id: 'australia',
    name: 'Australia',
    shortName: 'AU',
    leader: 'PM Whitlock',
    color: '#00247d',
    cities: [
      { id: 'au-1', name: 'Canberra', landmark: '🏛️' },
      { id: 'au-2', name: 'Sydney', landmark: '🎭' },
      { id: 'au-3', name: 'Melbourne', landmark: '🏙️' },
    ],
  },
];

/** Nations seated in a single match — the rest of the roster sits it out. */
export const TABLE_SIZE = 5;

export {
  COSTS,
  STARTING_MONEY,
  INCOME_PER_CITY,
  RESEARCH_INCOME,
  SANCTION_PENALTY,
  MAX_SANCTION_CUT,
  SURVIVAL_POINTS_PER_CITY,
  DRONE_DAMAGE,
  SCORE_CITY,
  SCORE_RESEARCH,
  SCORE_SHIELD,
  SCORE_BUNKER,
  SCORE_KILL,
  SCORE_ELIMINATION,
  SCORE_ANGEL,
  SCORE_EVIL,
  applyBalanceProfile,
  CURRENT_PROFILE,
  LEGACY_PROFILE,
  PROPOSED_PROFILE,
} from './balance';
import { STARTING_MONEY } from './balance';

/**
 * Sanctions one nation may run at once. Unlimited free sanctions meant
 * everyone sanctioned everyone and the choice said nothing; at two, naming a
 * target is a public statement about who you intend to go after.
 */
export const MAX_SANCTIONS = 2;
/** @deprecated Unused — survival is awarded per standing city instead. */
export const SURVIVAL_POINTS_PER_ROUND = 25;
/** Max nuclear bombs a nation may purchase in a single round */
export const MAX_BOMBS_PER_ROUND = 3;
/** Hydrogen bombs allowed over an entire match */
export const MAX_HYDROGEN_PER_GAME = 1;
/** Magnetic bombs allowed over an entire match */
export const MAX_MAGNETIC_PER_GAME = 2;
/** Max drone packs a nation may purchase in a single round */
export const MAX_DRONES_PER_ROUND = 3;
/**
 * Shields a nation may install in a single round. One keeps a city exposed
 * while defences go up city by city, instead of a whole nation walling off in
 * its opening turn.
 */
export const MAX_SHIELDS_PER_ROUND = 1;

/** Research centres a nation can break ground on in a single round. */
export const MAX_RESEARCH_PER_ROUND = 1;
/**
 * Swarms one laser battery can shoot down per round. The battery defends the
 * whole nation, so this budget — not the city it sits on — is what a swarming
 * rival has to overwhelm.
 */
export const LASER_INTERCEPTS_PER_ROUND = 2;
export const MAX_ROUNDS = 5;
/**
 * Extra rounds a deadlocked final round can buy. Two nations with untouchable
 * bunkers can stay level forever, so the overtime runs out and the tiebreakers
 * settle it.
 */
export const MAX_OVERTIME_ROUNDS = 3;

export function nationDef(id: NationId): NationDef {
  return NATIONS.find((n) => n.id === id)!;
}

export function makeCities(id: NationId): City[] {
  return nationDef(id).cities.map((c) => ({
    ...c,
    destroyed: false,
    hasShield: false,
    hasResearch: false,
    isUnderground: false,
    hasLaser: false,
  }));
}

export function initialNation(id: NationId): NationState {
  return {
    id,
    money: STARTING_MONEY,
    cities: makeCities(id),
    hasNuclearTech: false,
    nuclearTechUnlockedRound: null,
    bombs: 0,
    hydrogenBombs: 0,
    magneticBombs: 0,
    hydrogenBought: 0,
    magneticBought: 0,
    hydrogenUsed: 0,
    magneticUsed: 0,
    laserOfflineThisRound: false,
    hasAerospaceTech: false,
    hasSpyNetwork: false,
    scoutedCities: [],
    aerospaceTechUnlockedRound: null,
    drones: 0,
    researchCenters: 0,
    eliminated: false,
    sanctions: [],
    sanctionsVersion: 0,
    bombsUsed: 0,
    citiesStruckThisRound: [],
    bombsBoughtThisRound: 0,
    dronesUsed: 0,
    dronesBoughtThisRound: 0,
    citiesDronedThisRound: [],
    shieldsBoughtThisRound: 0,
    researchBoughtThisRound: 0,
    dronesInterceptedThisRound: 0,
    pendingDroneDamage: 0,
    promptsDoneThisRound: [],
    lockedScore: null,
    roundsSurvived: 0,
    citySurvivalPoints: 0,
    attackPoints: 0,
    angelPoints: 0,
    infamyPoints: 0,
    emergencyRebuildsUsed: 0,
    isHuman: false,
  };
}
