import type { GameState, GameSyncEvent, GameSyncKind, NationId } from '../types';
import { ensureIncome } from '../game/engine';
import { runOnlineAiPlanning } from '../game/ai';
import { applyRemoteGameSnapshot } from './onlineSync';

export function initialGameSync(at = Date.now()): GameSyncEvent {
  return { seq: 1, kind: 'roundStart', round: 1, publishedAt: at };
}

export function nextGameSync(
  prev: GameSyncEvent | null | undefined,
  kind: GameSyncKind,
  round: number,
  at = Date.now(),
  extra?: Pick<GameSyncEvent, 'nationId' | 'playerName' | 'nationName'>,
): GameSyncEvent {
  return {
    seq: (prev?.seq ?? 0) + 1,
    kind,
    round,
    publishedAt: at,
    ...extra,
  };
}

/** Published clock says this client must drop local phase and follow the room. */
export function shouldFollowPublishedClock(
  prev: GameState,
  remote: GameState,
  sync?: GameSyncEvent | null,
): boolean {
  if (remote.round > prev.round) return true;
  if (remote.phase === 'gameOver' && prev.phase !== 'gameOver') return true;
  if (!sync) return false;
  if (sync.round > prev.round) return true;
  if (sync.kind === 'gameOver' && remote.phase === 'gameOver') return true;
  if (sync.kind === 'roundStart' && remote.round > prev.round) return true;
  // Events that rewind local progress must land once, not on every snapshot,
  // or a client that has moved on gets yanked back in a loop.
  const unseen = sync.seq > (prev.syncSeq ?? 0);
  if (sync.kind === 'dropout') return unseen;
  if (
    sync.kind === 'resolve' &&
    remote.round === prev.round &&
    remote.planningComplete &&
    (prev.phase === 'buy' || prev.phase === 'action')
  ) {
    // Orders are locked room-wide; the published board is authoritative
    return true;
  }
  if (
    unseen &&
    prev.phase === 'roundSummary' &&
    remote.phase !== 'roundSummary' &&
    remote.phase !== 'gameOver' &&
    sync.kind !== 'aftermath' &&
    sync.kind !== 'roundStart' &&
    sync.kind !== 'gameOver'
  ) {
    // Local aftermath was never published — follow the shared room
    return true;
  }
  if (sync.kind === 'aftermath' && prev.phase !== 'roundSummary' && remote.phase === 'roundSummary') {
    return true;
  }
  return false;
}

/**
 * Apply a published game document. Clock/round jumps replace local state
 * instead of merging, so every client lands on the same round.
 */
export function applyPublishedGame(
  prev: GameState,
  remote: GameState,
  myNationId: NationId | null,
  sync?: GameSyncEvent | null,
): GameState {
  // Tracked locally only, so a peer's doc write can never rewind our watermark
  const syncSeq = Math.max(prev.syncSeq ?? 0, sync?.seq ?? 0);
  if (shouldFollowPublishedClock(prev, remote, sync)) {
    let next = remote;
    if (
      (next.phase === 'buy' || next.phase === 'action') &&
      !next.planningComplete &&
      !next.aiPlanningComplete
    ) {
      next = runOnlineAiPlanning(next);
    }
    return { ...ensureIncome(next), syncSeq };
  }
  return { ...applyRemoteGameSnapshot(prev, remote, myNationId), syncSeq };
}
