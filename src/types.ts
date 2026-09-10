export type NationId = 'us' | 'uk' | 'france' | 'russia' | 'china';

export type GameMode = 'single' | 'two';

export type Phase =
  | 'mode'
  | 'names'
  | 'country'
  | 'leaders'
  | 'income'
  | 'buy'
  | 'action'
  | 'resolveStrikes'
  | 'roundSummary'
  | 'gameOver';

export interface PendingStrike {
  attackerId: NationId;
  targetNationId: NationId;
  cityId: string;
}

export interface City {
  id: string;
  name: string;
  landmark: string;
  destroyed: boolean;
  hasShield: boolean;
  hasResearch: boolean;
}

export interface NationState {
  id: NationId;
  money: number;
  cities: City[];
  hasNuclearTech: boolean;
  /** Round when nuclear tech was unlocked; bombs require a later round */
  nuclearTechUnlockedRound: number | null;
  bombs: number;
  researchCenters: number;
  eliminated: boolean;
  /** Nations this nation is currently sanctioning */
  sanctions: NationId[];
  /** Cumulative environment contribution (positive = green, negative = bombs) */
  environmentScore: number;
  /** Bombs used this game (for scoring flavor) */
  bombsUsed: number;
  /** Environment buys this game */
  environmentBuys: number;
  /** City ids this nation already struck this round (can't hit same city twice per round) */
  citiesStruckThisRound: string[];
  /** Bombs purchased this round (max 3) */
  bombsBoughtThisRound: number;
  /** Whether environment was bought this round */
  envBoughtThisRound: boolean;
  /** Score frozen when eliminated so wipeout doesn't zero the standings */
  lockedScore: number | null;
  /** Rounds completed while still alive */
  roundsSurvived: number;
  /** Cumulative points from cities still standing at each round end */
  citySurvivalPoints: number;
  isHuman: boolean;
  playerSlot?: 1 | 2;
}

export interface RoundScore {
  nationId: NationId;
  citiesLeft: number;
  researchCenters: number;
  shields: number;
  environmentScore: number;
  roundsSurvived: number;
  citySurvivalPoints: number;
  total: number;
  eliminated: boolean;
}

export interface LogEntry {
  id: string;
  text: string;
  tone?: 'neutral' | 'attack' | 'money' | 'env' | 'sanction';
}

/** What happened during the round just completed (shown on aftermath board) */
export interface RoundWorldEvent {
  id: string;
  kind: 'cityDestroyed' | 'shieldDestroyed' | 'nationEliminated';
  nationId: NationId;
  cityId?: string;
  cityName?: string;
  attackerId?: NationId;
}

export interface GameState {
  mode: GameMode | null;
  phase: Phase;
  round: number;
  maxRounds: number;
  environment: number;
  nations: Record<NationId, NationState>;
  turnOrder: NationId[];
  currentTurnIndex: number;
  selectingFor: 1 | 2;
  humanNations: NationId[];
  /** Display names for hot-seat players */
  playerNames: Partial<Record<1 | 2, string>>;
  roundScores: RoundScore[];
  scoreHistory: RoundScore[][];
  log: LogEntry[];
  winner: NationId | 'draw' | null;
  pendingCountryPick: NationId | null;
  /** Strikes queued during turns; resolved together at round end */
  pendingStrikes: PendingStrike[];
  /** World events from the round that just ended */
  roundEvents: RoundWorldEvent[];
}
