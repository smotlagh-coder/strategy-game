/**
 * Live economy / scoring knobs. The game reads these at call time; the balance
 * sim swaps profiles via applyBalanceProfile() without restarting the process.
 */

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
};

/** Pre-rebalance snapshot — kept so the Monte Carlo harness can A/B. */
export const LEGACY_PROFILE: BalanceProfile = {
  name: 'legacy',
  costs: {
    ballisticMissileTech: 4,
    aerospaceTech: 2,
    underground: 6,
    rebuild: 4,
    shield: 3,
    laser: 3.5,
    spy: 3,
    bomb: 2,
    bombHydrogen: 6,
    bombMagnetic: 4,
    drone: 1,
    research: 2,
  },
  startingMoney: 14,
  incomePerCity: 1.5,
  researchIncome: 1.5,
  sanctionPenalty: 0.1,
  maxSanctionCut: 0.9,
  survivalPointsPerCity: 10,
  droneDamage: 1.5,
  scoreCity: 30,
  scoreResearch: 12,
  scoreShield: 8,
  scoreBunker: 16,
};

/**
 * Sim-validated live pack. Sanctions stay at 10%: four rivals already cut 40%,
 * and maxSanctionCut stops any future rate bump from stacking past that.
 * (15% was rejected — four pile-ons would have stolen 60%.)
 */
export const CURRENT_PROFILE: BalanceProfile = {
  name: 'current',
  costs: {
    ballisticMissileTech: 3,
    aerospaceTech: 2,
    underground: 6,
    rebuild: 3,
    shield: 3,
    laser: 3,
    spy: 3,
    bomb: 2,
    bombHydrogen: 6,
    bombMagnetic: 4,
    drone: 1,
    research: 2,
  },
  startingMoney: 14,
  incomePerCity: 1.75,
  researchIncome: 1.0,
  sanctionPenalty: 0.1,
  maxSanctionCut: 0.4,
  survivalPointsPerCity: 5,
  droneDamage: 2.0,
  scoreCity: 35,
  scoreResearch: 8,
  scoreShield: 10,
  scoreBunker: 18,
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
}

export function activeBalanceName(): BalanceProfile['name'] {
  return SURVIVAL_POINTS_PER_CITY === CURRENT_PROFILE.survivalPointsPerCity &&
    INCOME_PER_CITY === CURRENT_PROFILE.incomePerCity
    ? 'current'
    : 'legacy';
}
