/** Online selection idle kick window (local timer + peer kick). */
export const SELECTION_IDLE_MS = 60_000;

/** How often a connected client writes presence while in a match. */
export const HEARTBEAT_MS = 5_000;

/** No heartbeat → treat as left so others are not stuck waiting. */
export const DISCONNECT_MS = 20_000;

/** Aftermath think time before next round / final results. */
export const AFTERMATH_THINK_MS = 5_000;

/** Round-start banner duration after advancing. */
export const ROUND_BANNER_MS = 3_000;

/** Each personal briefing slide after a round (attacks / sanctions / money). */
export const ROUND_BRIEFING_SLIDE_MS = 2_500;

export function selectionIdleSeconds(): number {
  return Math.ceil(SELECTION_IDLE_MS / 1000);
}

export function aftermathThinkSeconds(): number {
  return Math.ceil(AFTERMATH_THINK_MS / 1000);
}
