/**
 * Online selection idle kick window (local timer + peer kick). Kept longer than
 * the 60s purchasing window so a player who does nothing is moved on by the
 * purchase timer before the idle rule can forfeit them.
 */
export const SELECTION_IDLE_MS = 75_000;

/** How often a connected client writes presence while in a match. */
export const HEARTBEAT_MS = 5_000;

/** No heartbeat → treat as left so others are not stuck waiting. */
export const DISCONNECT_MS = 20_000;

/** Aftermath think time before next round / final results. */
export const AFTERMATH_THINK_MS = 5_000;

/** One launch cinema: missile flight, impact, and the cut away. */
export const STRIKE_CINEMA_MS = 3_400;

/** Aftermath recap dismisses itself so nobody stalls the table. */
export const RECAP_AUTO_MS = 6_000;

/** A client may enter the summary before the strike report syncs — wait this long for it. */
export const REPORT_WAIT_MS = 4_000;
export const REPORT_POLL_MS = 300;

/** Round-start banner duration after advancing. */
export const ROUND_BANNER_MS = 3_000;

/**
 * The one-page round briefing (cities, sanctions, treasury, standings). It
 * dismisses itself so an online table is never held up by a player reading.
 */
export const ROUND_BRIEFING_MS = 15_000;

/**
 * The whole purchasing period on the command map. When it runs out the player
 * moves on with what they bought; when every commander has locked in, play
 * continues at once.
 */
export const PURCHASE_WINDOW_MS = 60_000;

/**
 * After every warhead or drone pack has a city, hold this long on Lock Targets /
 * Send Drones so the player can retarget. A new city tap restarts the clock.
 */
export const TARGET_CONFIRM_MS = 10_000;

export function selectionIdleSeconds(): number {
  return Math.ceil(SELECTION_IDLE_MS / 1000);
}

export function aftermathThinkSeconds(): number {
  return Math.ceil(AFTERMATH_THINK_MS / 1000);
}
