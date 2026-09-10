import type { City, NationId, NationState } from '../types';

export interface NationDef {
  id: NationId;
  name: string;
  shortName: string;
  leader: string;
  color: string;
  flagColors: string[];
  cities: { id: string; name: string; landmark: string }[];
}

export const NATIONS: NationDef[] = [
  {
    id: 'china',
    name: 'China',
    shortName: 'CN',
    leader: 'Premier Zhao',
    color: '#c41e3a',
    flagColors: ['#de2910', '#ffde00'],
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
    flagColors: ['#fff', '#0039a6', '#d52b1e'],
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
    flagColors: ['#012169', '#c8102e', '#fff'],
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
    flagColors: ['#b22234', '#fff', '#3c3b6e'],
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
    flagColors: ['#002395', '#fff', '#ed2939'],
    cities: [
      { id: 'fr-1', name: 'Paris', landmark: '🗼' },
      { id: 'fr-2', name: 'Lyon', landmark: '⛪' },
      { id: 'fr-3', name: 'Marseille', landmark: '🗿' },
    ],
  },
];

export const COSTS = {
  nuclearTech: 5,
  shield: 3,
  bomb: 2,
  research: 2,
  environment: 1,
} as const;

export const STARTING_MONEY = 10;
/** Flat income every living nation receives each round */
export const BASE_INCOME = 3.5;
export const RESEARCH_INCOME = 1.5;
export const SANCTION_PENALTY = 0.2;
export const ENV_BOMB_HIT = 5;
export const ENV_IMPROVE = 10;
/** Points awarded each time a nation survives a completed round */
export const SURVIVAL_POINTS_PER_ROUND = 25;
/** Points per standing city when a nation survives a round */
export const SURVIVAL_POINTS_PER_CITY = 10;
/** Max bombs a nation may purchase in a single round */
export const MAX_BOMBS_PER_ROUND = 3;
export const MAX_ROUNDS = 5;

export function nationDef(id: NationId): NationDef {
  return NATIONS.find((n) => n.id === id)!;
}

export function makeCities(id: NationId): City[] {
  return nationDef(id).cities.map((c) => ({
    ...c,
    destroyed: false,
    hasShield: false,
    hasResearch: false,
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
    researchCenters: 0,
    eliminated: false,
    sanctions: [],
    environmentScore: 0,
    bombsUsed: 0,
    environmentBuys: 0,
    citiesStruckThisRound: [],
    bombsBoughtThisRound: 0,
    envBoughtThisRound: false,
    lockedScore: null,
    roundsSurvived: 0,
    citySurvivalPoints: 0,
    isHuman: false,
  };
}
