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
  | 'lobby'
  | 'income'
  | 'buy'
  | 'action'
  | 'resolveStrikes'
  | 'roundSummary'
  | 'gameOver'
  | 'leaderboard';

/**
 * Ballistic warhead kinds. The first three are bought and need Ballistic Missile
 * Tech; the last three are bombs that exist only as research inventions (see
 * game/inventions.ts) and are fired from the lab's own stock.
 */
export type WarheadKind =
  | 'nuke'
  | 'hydrogen'
  | 'magnetic'
  | 'cluster'
  | 'biological'
  | 'chemical';

/**
 * What a research lab can invent: the three bombs that cannot be bought, and the
 * defence drones that guard a city (an invention, but not a weapon).
 */
export type InventionKind =
  | 'cluster'
  | 'biological'
  | 'chemical'
  | 'defenseDrones'
  /** Not a weapon: the lab hands the nation Ballistic Missile Tech outright */
  | 'ballisticTech'
  /** Not a weapon: the lab hands the nation Aerospace Tech outright */
  | 'aerospaceTech';

/**
 * Everything a nation can send at an enemy city. 'commando' is the
 * Heliborne: an airborne squad that takes a city over instead of destroying it.
 */
export type StrikeWeapon = WarheadKind | 'drone' | 'commando';

export interface PendingStrike {
  attackerId: NationId;
  targetNationId: NationId;
  cityId: string;
  /**
   * Missing means a nuclear warhead — drones and specialty bombs were added
   * later and old docs predate the field.
   */
  weapon?: StrikeWeapon;
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
  /** Set while the city is held by a nation other than the one it was founded for */
  originId?: NationId;
  /** Round the Heliborne took this city over (drives the "held" badge) */
  capturedRound?: number;
}

/**
 * One nation's side of an alliance. Only the owning client writes it; two
 * nations are allies exactly when each one points at the other, so every
 * effect is read off the pair instead of being stored (see game/alliance.ts).
 */
export interface AllianceState {
  /** The nation this one has invited, or is allied with once they point back */
  with: NationId | null;
  /** Identifies the current invitation, so a decline only covers that one */
  proposalId: number;
  /** Invitations this nation turned down: inviter → their proposalId */
  declined: Partial<Record<NationId, number>>;
  /** Bumped on every change — the higher counter is the owner's newer choice */
  version: number;
  /**
   * Money terms this nation attached to its current invitation, per round:
   * positive = the inviter pays the partner, negative = the inviter asks the partner to pay.
   */
  tribute?: number;
  /** Terms of the pact this nation accepted, copied from the inviter's offer */
  terms?: { proposer: NationId; tribute: number } | null;
}

export interface NationState {
  id: NationId;
  /** Alliance pact (absent until the nation first touches the alliance tools) */
  alliance?: AllianceState;
  money: number;
  cities: City[];
  /** Ballistic Missile Tech — unlocks nuclear / hydrogen / magnetic warheads */
  hasNuclearTech: boolean;
  /** Round when Ballistic Missile Tech was unlocked; warheads fire same round */
  nuclearTechUnlockedRound: number | null;
  /** Nuclear warheads in stock (max 3 bought per round) */
  bombs: number;
  /** Hydrogen warheads in stock (1 per game) — crack bunkers */
  hydrogenBombs: number;
  /** Magnetic warheads in stock (2 per game) — kill laser for the round */
  magneticBombs: number;
  /** Lifetime hydrogen purchases (cap MAX_HYDROGEN_PER_GAME) */
  hydrogenBought: number;
  /** Lifetime magnetic purchases (cap MAX_MAGNETIC_PER_GAME) */
  magneticBought: number;
  /** Hydrogen warheads launched this game (online merge) */
  hydrogenUsed: number;
  /** Magnetic warheads launched this game (online merge) */
  magneticUsed: number;
  /** A magnetic warhead queued this round shut the laser network down */
  laserOfflineThisRound?: boolean;
  hasAerospaceTech: boolean;
  /** Round when aerospace tech was unlocked; drones require a later round */
  aerospaceTechUnlockedRound: number | null;
  drones: number;
  /** Heliborne squads in stock (helicopter-borne commandos). Absent on older saves. */
  commandos?: number;
  /** Squads sent in this game (online merge) */
  commandosUsed?: number;
  /** Squads bought this round (cap MAX_COMMANDOS_PER_ROUND) */
  commandosBoughtThisRound?: number;
  /** City ids this nation sent commandos to this round */
  citiesRaidedThisRound?: string[];
  researchCenters: number;
  /** Rounds this nation has run a working research lab (every third one ends in an invention) */
  labRounds?: number;
  /**
   * Bombs the labs have invented, in order. Append-only and picked from a fixed
   * seed, so every client derives the same list and an online merge keeps the longer one.
   */
  inventions?: InventionKind[];
  /** Invented bombs already launched, per kind (online merge keeps the larger count) */
  inventionsUsed?: Partial<Record<InventionKind, number>>;
  /** Round the latest invention was announced (drives the lab overlay) */
  inventionRound?: number;
  /** Spy service bought — reveals enemy city defences for the rest of the game */
  hasSpyNetwork: boolean;
  /** Enemy city ids this nation has seen the defences of, by spying or by swarm */
  scoutedCities: string[];
  eliminated: boolean;
  /** Nations this nation is currently sanctioning */
  sanctions: NationId[];
  /**
   * Bumped on every sanction change. Only the owning client edits the list, so
   * the higher counter is always the owner's newer choice — without it an
   * online merge cannot tell a lifted sanction from a stale peer snapshot.
   */
  sanctionsVersion?: number;
  /** Bombs used this game (for scoring flavor) */
  bombsUsed: number;
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
  /** Shields installed this round (max 1) */
  shieldsBoughtThisRound: number;
  /** Research centres built this round (max 1) */
  researchBoughtThisRound: number;
  /** Swarms this nation's laser network shot down this round */
  dronesInterceptedThisRound: number;
  /** Drone damage billed to this nation at the next income (see applyIncome) */
  pendingDroneDamage?: number;
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
  /** Cumulative points from cities this nation destroyed (and eliminations) */
  attackPoints: number;
  /** Banked prestige from being the round's angel (most peaceful) */
  angelPoints: number;
  /** Banked infamy from being the round's evil seat (subtracted from score) */
  infamyPoints: number;
  /** Automatic last-city rebuilds used this match (capped at one) */
  emergencyRebuildsUsed: number;
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
  /** Cities dug into rock — counted separately from shields */
  bunkers: number;
  roundsSurvived: number;
  citySurvivalPoints: number;
  attackPoints: number;
  angelPoints: number;
  infamyPoints: number;
  total: number;
  eliminated: boolean;
}

export interface LogEntry {
  id: string;
  text: string;
  tone?: 'neutral' | 'attack' | 'money' | 'sanction';
}

/** The things a city can carry that a strike can take away */
export type CityAsset = 'shield' | 'laser' | 'research' | 'bunker';

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
    | 'cityRebuilt'
    | 'cityCaptured'
    | 'raidRepelled'
    /** A laser network shot a chemical or biological bomb out of the sky */
    | 'warheadIntercepted'
    /** Defence drones met an incoming attack in the sky and neutralised it */
    | 'strikeNeutralized';
  nationId: NationId;
  cityId?: string;
  cityName?: string;
  attackerId?: NationId;
  /** Other nations that also aimed at this city in the round — they share the kill credit */
  sharedWith?: NationId[];
  /** Drone repair bill, or capital lost when a city / shield is wiped */
  amount?: number;
  /** Rebuild the treasury paid for on its own to keep a wiped-out nation alive */
  automatic?: boolean;
  /** What was covering the city when this strike landed */
  cover?: 'shield' | 'bunker' | 'laser';
  /** The weapon behind a hit that is not a plain warhead or swarm (cluster, gas) */
  weapon?: StrikeWeapon;
  /** A magnetic bomb had already darkened a laser network for this hit */
  laserDown?: boolean;
  /** An ally's laser network covered the city (its own network was spent or absent) */
  coveredBy?: NationId;
  /** Assets the city lost in this event (shield, laser, research lab, bunker) */
  lost?: CityAsset[];
  /** Score banked by the captor for a takeover */
  points?: number;
  /** The takeover needed no warhead */
  clean?: boolean;
}

/** Income applied at round start (shown on aftermath) */
export interface IncomeLedgerEntry {
  nationId: NationId;
  previousBalance: number;
  revenue: number;
  balanceAfterIncome: number;
  sanctionPenalty: number;
  sanctioners: NationId[];
  /** Pact money moved this round: positive = received from the ally, negative = paid to them */
  pactTransfer?: number;
  /** Repair bill for drone damage taken last round */
  droneDamage?: number;
  /** Lab running costs paid this round */
  researchUpkeep?: number;
  /** Labs left idle because the treasury could not cover their upkeep */
  labsIdle?: number;
}

export interface GameState {
  mode: GameMode | null;
  phase: Phase;
  round: number;
  maxRounds: number;
  nations: Record<NationId, NationState>;
  /** Per-match number that decides what the research labs invent (same on every client) */
  matchSeed?: number;
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
  winner: NationId | null;
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
  /** Living seat crowned most peaceful last resolution (angel portrait + prestige) */
  angelNationId?: NationId | null;
  /** Living seat crowned most offensive last resolution (evil portrait + infamy) */
  evilNationId?: NationId | null;
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
