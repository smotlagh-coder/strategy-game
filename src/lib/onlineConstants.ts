/** Online selection idle kick window (local timer + peer kick). */
export const SELECTION_IDLE_MS = 60_000;

/** Aftermath think time before next round / final results. */
export const AFTERMATH_THINK_MS = 5_000;

/** Round-start banner duration after advancing. */
export const ROUND_BANNER_MS = 3_000;

export function selectionIdleSeconds(): number {
  return Math.ceil(SELECTION_IDLE_MS / 1000);
}

export function aftermathThinkSeconds(): number {
  return Math.ceil(AFTERMATH_THINK_MS / 1000);
}
