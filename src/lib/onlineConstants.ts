/** Online selection idle kick window (local timer + peer kick). */
export const SELECTION_IDLE_MS = 60_000;

export function selectionIdleSeconds(): number {
  return Math.ceil(SELECTION_IDLE_MS / 1000);
}
