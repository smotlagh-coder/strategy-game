import type { GameState, RoundScore } from '../types';

/** Firestore rejects `undefined` field values — drop them recursively before writes. */
export function stripUndefined<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    out[key] = stripUndefined(child);
  }
  return out as T;
}

/** One past round of standings, wrapped because Firestore has no array-in-array. */
type EncodedScoreRound = { rows: RoundScore[] };

function encodeScoreHistory(history: RoundScore[][] | undefined): EncodedScoreRound[] {
  return (history ?? []).map((rows) => ({ rows: rows ?? [] }));
}

function decodeScoreHistory(history: unknown): RoundScore[][] {
  if (!Array.isArray(history)) return [];
  return history.map((entry) => {
    if (Array.isArray(entry)) return entry as RoundScore[];
    const rows = (entry as EncodedScoreRound | null)?.rows;
    return Array.isArray(rows) ? rows : [];
  });
}

/**
 * Shape a game state for Firestore. `scoreHistory` is `RoundScore[][]`, and
 * Firestore cannot store an array inside an array — an unencoded write throws
 * and silently loses whatever else that write carried (ready flags, orders).
 */
export function encodeGameState(state: GameState): Record<string, unknown> {
  return stripUndefined({
    ...state,
    scoreHistory: encodeScoreHistory(state.scoreHistory),
  }) as unknown as Record<string, unknown>;
}

/** Inverse of encodeGameState; tolerates docs written before the wrapper existed. */
export function decodeGameState(raw: GameState): GameState {
  return {
    ...raw,
    scoreHistory: decodeScoreHistory((raw as { scoreHistory?: unknown }).scoreHistory),
  };
}

/**
 * Paths Firestore would reject in a payload. Used by tests to keep new state
 * fields from reintroducing the silent-write-failure class of bug.
 */
export function findUnsupportedFirestoreValues(value: unknown, path = ''): string[] {
  const bad: string[] = [];
  const walk = (node: unknown, at: string, insideArray: boolean) => {
    if (node === undefined) {
      bad.push(`${at} (undefined)`);
      return;
    }
    if (node === null) return;
    if (Array.isArray(node)) {
      if (insideArray) {
        bad.push(`${at} (nested array)`);
        return;
      }
      node.forEach((item, i) => walk(item, `${at}[${i}]`, true));
      return;
    }
    if (typeof node === 'function' || typeof node === 'symbol') {
      bad.push(`${at} (${typeof node})`);
      return;
    }
    if (typeof node !== 'object') return;
    if (node instanceof Map || node instanceof Set || node instanceof Date) {
      bad.push(`${at} (${node.constructor.name})`);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, at ? `${at}.${key}` : key, false);
    }
  };
  walk(value, path, false);
  return bad;
}
