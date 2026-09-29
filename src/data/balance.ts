/**
 * Live economy / scoring knobs. The game reads these at call time; the balance
 * sim swaps profiles via applyBalanceProfile() without restarting the process.
 */

/** Money is whole numbers: one unit is a tenth of the old $1M, so no decimals anywhere. */
export const MONEY_SCALE = 10;

export type CostTable = {
  /** Ballistic Missile Tech — unlocks all warhead types */
  ballisticMissileTech: number;
  aerospaceTech: number;
  underground: number;
  rebuild: number;
  shield: number;
  laser: number;
  spy: number;
  /** Nuclear warhead — city killer, 3/round */
  bomb: number;
  /** Hydrogen warhead — cracks bunkers, 1/game */
  bombHydrogen: number;
  /** Magnetic warhead — kills laser for the round, 2/game */
  bombMagnetic: number;
  drone: number;
  research: number;
};

export type BalanceProfile = {
  name: 'legacy' | 'current';
  costs: CostTable;
  startingMoney: number;
  incomePerCity: number;
  researchIncome: number;
  sanctionPenalty: number;
  /** Hard ceiling on stacked sanctions — four rivals at 10% stop at 40%, not 90%. */
  maxSanctionCut: number;
  survivalPointsPerCity: number;
  droneDamage: number;
  scoreCity: number;
  scoreResearch: number;
  scoreShield: number;
  scoreBunker: number;
  /** Points banked by the attacker when a city is destroyed */
  scoreKill: number;
  /** Bonus when an attacker's strike eliminates a nation */
  scoreElimination: number;
  /** Prestige for the round's most peaceful seat (angel) */
  scoreAngel: number;
  /** Infamy deducted from the round's most offensive seat (evil) */
  scoreEvil: number;
};

/** Pre-rebalance snapshot — kept so the Monte Carlo harness can A/B. */
export const LEGACY_PROFILE: BalanceProfile = {
  name: 'legacy',
  costs: {
    ballisticMissileTech: 40,
    aerospaceTech: 20,
    underground: 60,
    rebuild: 40,
    shield: 30,
    laser: 35,
    spy: 30,
    bomb: 20,
    bombHydrogen: 60,
    bombMagnetic: 40,
    drone: 10,
    research: 20,
  },
  startingMoney: 140,
  incomePerCity: 15,
  researchIncome: 15,
  sanctionPenalty: 0.1,
  maxSanctionCut: 0.9,
  survivalPointsPerCity: 10,
  droneDamage: 15,
  scoreCity: 30,
  scoreResearch: 12,
  scoreShield: 8,
  scoreBunker: 16,
  scoreKill: 0,
  scoreElimination: 0,
  scoreAngel: 0,
  scoreEvil: 0,
};

/**
 * Aggression and defence both have to earn the title. Kill points reward
 * strikes; rebuilt cities are worth half; a dear rebuild stops endless phoenix
 * turtling from banking the same survival score forever.
 */
export const CURRENT_PROFILE: BalanceProfile = {
  name: 'current',
  costs: {
    ballisticMissileTech: 30,
    aerospaceTech: 20,
    underground: 60,
    rebuild: 50,
    shield: 30,
    laser: 30,
    spy: 30,
    bomb: 20,
    bombHydrogen: 60,
    bombMagnetic: 40,
    drone: 10,
    research: 20,
  },
  startingMoney: 140,
  incomePerCity: 18,
  researchIncome: 10,
  sanctionPenalty: 0.1,
  maxSanctionCut: 0.4,
  survivalPointsPerCity: 4,
  droneDamage: 20,
  scoreCity: 35,
  scoreResearch: 8,
  scoreShield: 8,
  scoreBunker: 14,
  scoreKill: 20,
  scoreElimination: 25,
  scoreAngel: 10,
  scoreEvil: 12,
};

/** @deprecated Alias — the validated pack is now current. */
export const PROPOSED_PROFILE = CURRENT_PROFILE;

/** Mutated in place so existing `COSTS.x` call sites stay live. */
export const COSTS: CostTable = { ...CURRENT_PROFILE.costs };

export let STARTING_MONEY = CURRENT_PROFILE.startingMoney;
export let INCOME_PER_CITY = CURRENT_PROFILE.incomePerCity;
export let RESEARCH_INCOME = CURRENT_PROFILE.researchIncome;
export let SANCTION_PENALTY = CURRENT_PROFILE.sanctionPenalty;
export let MAX_SANCTION_CUT = CURRENT_PROFILE.maxSanctionCut;
export let SURVIVAL_POINTS_PER_CITY = CURRENT_PROFILE.survivalPointsPerCity;
export let DRONE_DAMAGE = CURRENT_PROFILE.droneDamage;
export let SCORE_CITY = CURRENT_PROFILE.scoreCity;
export let SCORE_RESEARCH = CURRENT_PROFILE.scoreResearch;
export let SCORE_SHIELD = CURRENT_PROFILE.scoreShield;
export let SCORE_BUNKER = CURRENT_PROFILE.scoreBunker;
export let SCORE_KILL = CURRENT_PROFILE.scoreKill;
export let SCORE_ELIMINATION = CURRENT_PROFILE.scoreElimination;
export let SCORE_ANGEL = CURRENT_PROFILE.scoreAngel;
export let SCORE_EVIL = CURRENT_PROFILE.scoreEvil;

export function applyBalanceProfile(profile: BalanceProfile): void {
  Object.assign(COSTS, profile.costs);
  STARTING_MONEY = profile.startingMoney;
  INCOME_PER_CITY = profile.incomePerCity;
  RESEARCH_INCOME = profile.researchIncome;
  SANCTION_PENALTY = profile.sanctionPenalty;
  MAX_SANCTION_CUT = profile.maxSanctionCut;
  SURVIVAL_POINTS_PER_CITY = profile.survivalPointsPerCity;
  DRONE_DAMAGE = profile.droneDamage;
  SCORE_CITY = profile.scoreCity;
  SCORE_RESEARCH = profile.scoreResearch;
  SCORE_SHIELD = profile.scoreShield;
  SCORE_BUNKER = profile.scoreBunker;
  SCORE_KILL = profile.scoreKill;
  SCORE_ELIMINATION = profile.scoreElimination;
  SCORE_ANGEL = profile.scoreAngel;
  SCORE_EVIL = profile.scoreEvil;
}

export function activeBalanceName(): BalanceProfile['name'] {
  return SURVIVAL_POINTS_PER_CITY === CURRENT_PROFILE.survivalPointsPerCity &&
    INCOME_PER_CITY === CURRENT_PROFILE.incomePerCity
    ? 'current'
    : 'legacy';
}
