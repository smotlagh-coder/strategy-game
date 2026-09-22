export type NationId =
  | 'us'
  | 'uk'
  | 'france'
  | 'russia'
  | 'china'
  | 'india'
  | 'pakistan'
  | 'iran'
  | 'northkorea'
  | 'canada'
  | 'brazil'
  | 'australia';

export type GameMode = 'single' | 'two' | 'online';

export type Phase =
  | 'session'
  | 'mode'
  | 'names'
  | 'country'
  | 'leaders'
  | 'lobby'
  | 'income'
  | 'buy'
  | 'action'
  | 'resolveStrikes'
  | 'roundSummary'
  | 'gameOver'
  | 'leaderboard';

export interface PendingStrike {
  attackerId: NationId;
  targetNationId: NationId;
  cityId: string;
  /** Missing means a nuke — drones were added later and old docs predate the field */
  weapon?: 'nuke' | 'drone';
}

export interface City {
  id: string;
  name: string;
  landmark: string;
  destroyed: boolean;
  hasShield: boolean;
  hasResearch: boolean;
  /** Moved underground — cannot be destroyed by nukes or drones */
  isUnderground?: boolean;
  /** Laser battery — shoots down every drone swarm sent at this city */
  hasLaser?: boolean;
  /** Round this city was last raised from rubble; also drives the "new build" shine */
  rebuiltRound?: number;
}

export interface NationState {
  id: NationId;
  money: number;
  cities: City[];
  hasNuclearTech: boolean;
  /** Round when nuclear tech was unlocked; bombs require a later round */
  nuclearTechUnlockedRound: number | null;
  bombs: number;
  hasAerospaceTech: boolean;
  /** Round when aerospace tech was unlocked; drones require a later round */
  aerospaceTechUnlockedRound: number | null;
  drones: number;
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
  /** Drone packs launched this game */
  dronesUsed: number;
  /** Drone packs purchased this round (max 3) */
  dronesBoughtThisRound: number;
  /** City ids this nation swarmed with drones this round (separate from bomb targets) */
  citiesDronedThisRound: string[];
  /** Drone damage billed to this nation at the next income (see applyIncome) */
  pendingDroneDamage?: number;
  /** Whether environment was bought this round */
  envBoughtThisRound: boolean;
  /** Buy-wizard prompts already answered this round (survives board remounts) */
  promptsDoneThisRound?: string[];
  /** Round number for which base/research income was already applied */
  incomeRound?: number;
  /** Score frozen when eliminated so wipeout doesn't zero the standings */
  lockedScore: number | null;
  /** Rounds completed while still alive */
  roundsSurvived: number;
  /** Cumulative points from cities still standing at each round end */
  citySurvivalPoints: number;
  isHuman: boolean;
  playerSlot?: number;
  /** Online multiplayer owner uid (if human) */
  ownerUid?: string;
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
  kind:
    | 'cityDestroyed'
    | 'shieldDestroyed'
    | 'nationEliminated'
    | 'droneDamage'
    | 'dronesIntercepted'
    | 'strikeAbsorbed'
    | 'cityRebuilt';
  nationId: NationId;
  cityId?: string;
  cityName?: string;
  attackerId?: NationId;
  /** Drone damage in $M, billed at the next income */
  amount?: number;
  /** Rebuild the treasury paid for on its own to keep a wiped-out nation alive */
  automatic?: boolean;
}

/** Income applied at round start (shown on aftermath) */
export interface IncomeLedgerEntry {
  nationId: NationId;
  previousBalance: number;
  revenue: number;
  balanceAfterIncome: number;
  sanctionPenalty: number;
  sanctioners: NationId[];
  /** Repair bill for drone damage taken last round */
  droneDamage?: number;
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
  selectingFor: number;
  humanNations: NationId[];
  /** Display names for hot-seat / online players by slot */
  playerNames: Partial<Record<number, string>>;
  /** Online: uid → nation */
  uidToNation?: Partial<Record<string, NationId>>;
  onlineGameId?: string | null;
  /** Online: lobby this match was started from (for rematch) */
  onlineLobbyId?: string | null;
  /** Online: host uid for rematch permissions */
  onlineHostUid?: string | null;
  roundScores: RoundScore[];
  scoreHistory: RoundScore[][];
  /** Strikes that produced the current summary, so every client can replay them. */
  resolvedStrikes?: PendingStrike[];
  /** Highest published sync event this client has followed (local only). */
  syncSeq?: number;
  log: LogEntry[];
  winner: NationId | 'draw' | null;
  pendingCountryPick: NationId | null;
  /** Strikes queued during turns; resolved together at round end */
  pendingStrikes: PendingStrike[];
  /** World events from the round that just ended */
  roundEvents: RoundWorldEvent[];
  /** Income applied at the start of the current round */
  lastIncomeLedger: IncomeLedgerEntry[];
  /** Online: humans who finished buy/strike planning this round */
  humanReady?: Partial<Record<NationId, boolean>>;
  /** Online: when human parallel planning began this round */
  humanPlanningStartedAt?: number | null;
  /** Online: last selection activity per human nation (idle kick) */
  humanLastActive?: Partial<Record<NationId, number>>;
  /** Online: last presence beat per human (tab closed / left) */
  humanHeartbeat?: Partial<Record<NationId, number>>;
  /** Online: human planning finished and AI/strikes advanced — blocks re-entry loops */
  planningComplete?: boolean;
  /** Online: AI nations already bought/queued strikes for this round (runs at round start) */
  aiPlanningComplete?: boolean;
  /** Epoch ms when aftermath ends and the next round (or finals) may start */
  aftermathEndsAt?: number | null;
  /** Events from the round that just ended (kept after nextRound clears roundEvents) */
  previousRoundEvents?: RoundWorldEvent[];
  /** Round number those previousRoundEvents belong to */
  previousRoundNumber?: number | null;
}

/** Firestore player presence doc */
export type PlayerStatus = 'available' | 'in_game' | 'offline';

export interface PlayerDoc {
  displayName: string;
  /** Per-browser client UUID (informational; auth uid is the real identity key) */
  clientId?: string;
  status: PlayerStatus;
  lastSeen: number;
  currentGameId: string | null;
  superpowerWins: number;
}

export interface InviteDoc {
  fromUid: string;
  toUid: string;
  fromName: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  createdAt: number;
  lobbyId?: string;
  /** Short public code for the lobby this invite belongs to */
  lobbyCode?: string;
}

export interface OnlineLobby {
  id: string;
  hostUid: string;
  memberUids: string[];
  memberNames: Record<string, string>;
  status: 'open' | 'starting' | 'closed';
  createdAt: number;
  /** Short unique code shown in the lobby UI */
  code?: string;
  /** Country claims, first come first served — uid to nation */
  nationPicks?: Record<string, NationId>;
  /** Set when host starts — members join this game */
  gameId?: string | null;
}

/** Shared table clock — clients follow this event, they do not invent the next round. */
export type GameSyncKind =
  | 'roundStart'
  | 'aftermath'
  | 'gameOver'
  | 'dropout'
  | 'playerReady'
  | 'resolve';

export interface GameSyncEvent {
  seq: number;
  kind: GameSyncKind;
  round: number;
  publishedAt: number;
  /** Set on dropout — who left */
  nationId?: NationId;
  playerName?: string;
  nationName?: string;
}

export interface OnlineGameDoc {
  hostUid: string;
  playerUids: string[];
  playerNames: Record<string, string>;
  nationAssignments: Record<string, NationId>;
  status: 'lobby' | 'active' | 'finished';
  state: GameState;
  /** Monotonic event every client listens for (round start / aftermath / game over) */
  sync?: GameSyncEvent;
  aiLock: string | null;
  updatedAt: number;
  /** When host starts Play Again — peers join this new game */
  rematchGameId?: string | null;
  lobbyId?: string | null;
}
