import type { GameState, NationId, NationState } from '../types';
import { allAliveHumansReady } from '../game/engine';
import { finishOnlineHumanPlanning } from '../game/ai';

/** Once ready in a round, stay ready — stale pushes must not clear it. */
export function mergeHumanReadyFlags(
  remote?: Partial<Record<NationId, boolean>>,
  local?: Partial<Record<NationId, boolean>>,
): Partial<Record<NationId, boolean>> {
  const out: Partial<Record<NationId, boolean>> = {};
  for (const key of new Set([
    ...Object.keys(remote ?? {}),
    ...Object.keys(local ?? {}),
  ])) {
    const id = key as NationId;
    if (remote?.[id] || local?.[id]) out[id] = true;
  }
  return out;
}

/** Union city upgrades so a stale push cannot wipe research/shields. */
export function mergeNationPlanning(
  remote: NationState | undefined,
  local: NationState | undefined,
): NationState {
  if (!remote && local) return local;
  if (remote && !local) return remote;
  if (!remote || !local) {
    throw new Error('mergeNationPlanning: missing nation state');
  }
  if (!remote.isHuman && local.isHuman) return remote;
  if (!local.isHuman && remote.isHuman) return local;

  const cities = remote.cities.map((rc) => {
    const lc = local.cities.find((c) => c.id === rc.id) ?? rc;
    const destroyed = Boolean(rc.destroyed || lc.destroyed);
    if (destroyed) {
      return { ...rc, destroyed: true, hasShield: false, hasResearch: false };
    }
    return {
      ...rc,
      hasShield: Boolean(rc.hasShield || lc.hasShield),
      hasResearch: Boolean(rc.hasResearch || lc.hasResearch),
    };
  });
  const researchCenters = cities.filter((c) => !c.destroyed && c.hasResearch).length;

  return {
    ...remote,
    ...local,
    cities,
    researchCenters,
    hasNuclearTech: remote.hasNuclearTech || local.hasNuclearTech,
    nuclearTechUnlockedRound:
      local.nuclearTechUnlockedRound ?? remote.nuclearTechUnlockedRound,
    money: Math.min(remote.money, local.money),
    bombs: Math.max(remote.bombs, local.bombs),
    bombsBoughtThisRound: Math.max(remote.bombsBoughtThisRound, local.bombsBoughtThisRound),
    bombsUsed: Math.max(remote.bombsUsed, local.bombsUsed),
    envBoughtThisRound: remote.envBoughtThisRound || local.envBoughtThisRound,
    environmentBuys: Math.max(remote.environmentBuys, local.environmentBuys),
    environmentScore: Math.max(remote.environmentScore, local.environmentScore),
    citiesStruckThisRound: Array.from(
      new Set([...remote.citiesStruckThisRound, ...local.citiesStruckThisRound]),
    ),
    sanctions:
      local.sanctions.length >= remote.sanctions.length ? local.sanctions : remote.sanctions,
    isHuman: remote.isHuman && local.isHuman,
    playerSlot: local.playerSlot ?? remote.playerSlot,
    ownerUid: local.ownerUid ?? remote.ownerUid,
  };
}

/**
 * How a client applies a remote Firestore game snapshot while optionally
 * still mid-selection for `myNationId`.
 */
export function applyRemoteGameSnapshot(
  prev: GameState,
  remote: GameState,
  myNationId: NationId | null,
): GameState {
  if (prev.round !== remote.round) {
    // Prefer the higher round; never merge across rounds
    return remote.round >= prev.round ? remote : prev;
  }

  const ready = mergeHumanReadyFlags(remote.humanReady, prev.humanReady);

  // Prefer terminal phases from either side
  const remoteTerminal =
    remote.phase === 'resolveStrikes' ||
    remote.phase === 'roundSummary' ||
    remote.phase === 'gameOver';
  const prevTerminal =
    prev.phase === 'resolveStrikes' ||
    prev.phase === 'roundSummary' ||
    prev.phase === 'gameOver';

  if (remote.planningComplete || prev.planningComplete || remoteTerminal || prevTerminal) {
    const base = remoteTerminal || (remote.planningComplete && !prevTerminal) ? remote : prev;
    const other = base === remote ? prev : remote;
    const nations = { ...base.nations };
    for (const id of base.turnOrder) {
      if (other.nations[id] && base.nations[id]) {
        nations[id] = mergeNationPlanning(base.nations[id], other.nations[id]);
      }
    }
    let next: GameState = {
      ...base,
      nations,
      humanReady: ready,
      planningComplete: Boolean(remote.planningComplete || prev.planningComplete || remoteTerminal),
      pendingStrikes:
        (remote.pendingStrikes?.length ?? 0) >= (prev.pendingStrikes?.length ?? 0)
          ? remote.pendingStrikes
          : prev.pendingStrikes,
    };
    // If everyone is ready but we never left planning, finish now (once)
    if (
      !next.planningComplete &&
      (next.phase === 'buy' || next.phase === 'action') &&
      allAliveHumansReady(next)
    ) {
      next = finishOnlineHumanPlanning(next);
    }
    return next;
  }

  // Still selecting locally: keep my in-progress nation, take everyone else from remote
  if (
    myNationId &&
    (prev.phase === 'buy' || prev.phase === 'action') &&
    !ready[myNationId]
  ) {
    const myStrikes = prev.pendingStrikes.filter((s) => s.attackerId === myNationId);
    const otherStrikes = remote.pendingStrikes.filter((s) => s.attackerId !== myNationId);
    return {
      ...remote,
      nations: {
        ...remote.nations,
        [myNationId]: mergeNationPlanning(remote.nations[myNationId], prev.nations[myNationId]),
      },
      pendingStrikes: [...otherStrikes, ...myStrikes],
      humanReady: ready,
      humanLastActive: {
        ...remote.humanLastActive,
        ...prev.humanLastActive,
        [myNationId]: Math.max(
          remote.humanLastActive?.[myNationId] ?? 0,
          prev.humanLastActive?.[myNationId] ?? 0,
        ),
      },
      environment: prev.nations[myNationId]?.envBoughtThisRound
        ? Math.max(prev.environment, remote.environment)
        : remote.environment,
    };
  }

  const nations = { ...remote.nations };
  if (myNationId && prev.nations[myNationId] && remote.nations[myNationId]) {
    nations[myNationId] = mergeNationPlanning(remote.nations[myNationId], prev.nations[myNationId]);
  }
  let next: GameState = {
    ...remote,
    nations,
    humanReady: ready,
  };
  if (
    (next.phase === 'buy' || next.phase === 'action') &&
    allAliveHumansReady(next) &&
    !next.planningComplete
  ) {
    next = finishOnlineHumanPlanning(next);
  }
  return next;
}

/** Server-side merge when one human pushes planning state. */
export function mergeHumanPlanningWrite(
  remote: GameState,
  local: GameState,
  nationId: NationId,
): GameState {
  if (remote.round > local.round) return remote;
  if (local.round > remote.round) return local;

  if (remote.planningComplete) {
    return {
      ...remote,
      humanReady: mergeHumanReadyFlags(remote.humanReady, local.humanReady),
      nations: {
        ...remote.nations,
        [nationId]: mergeNationPlanning(remote.nations[nationId], local.nations[nationId]),
      },
    };
  }

  const strikeKey = (s: { attackerId: string; targetNationId: string; cityId: string }) =>
    `${s.attackerId}:${s.targetNationId}:${s.cityId}`;
  const remoteOtherStrikes = (remote.pendingStrikes ?? []).filter((s) => s.attackerId !== nationId);
  const localMyStrikes = (local.pendingStrikes ?? []).filter((s) => s.attackerId === nationId);
  const pendingStrikes = [...remoteOtherStrikes, ...localMyStrikes];
  const seen = new Set<string>();
  const deduped = pendingStrikes.filter((s) => {
    const k = strikeKey(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const mergedReady = mergeHumanReadyFlags(remote.humanReady, local.humanReady);
  const localEnvBuy = local.nations[nationId]?.envBoughtThisRound ? 1 : 0;
  const remoteHadMine = remote.nations[nationId]?.envBoughtThisRound ? 1 : 0;
  let environment = remote.environment;
  if (localEnvBuy && !remoteHadMine) {
    environment = Math.min(100, remote.environment + 10);
  }

  const mergedLastActive: Partial<Record<NationId, number>> = {
    ...remote.humanLastActive,
    ...local.humanLastActive,
  };
  for (const id of new Set([
    ...Object.keys(remote.humanLastActive ?? {}),
    ...Object.keys(local.humanLastActive ?? {}),
  ])) {
    const nid = id as NationId;
    mergedLastActive[nid] = Math.max(
      remote.humanLastActive?.[nid] ?? 0,
      local.humanLastActive?.[nid] ?? 0,
    );
  }

  const mergedNations = { ...remote.nations };
  mergedNations[nationId] = mergeNationPlanning(remote.nations[nationId], local.nations[nationId]);

  const remoteTerminal =
    remote.phase === 'resolveStrikes' ||
    remote.phase === 'roundSummary' ||
    remote.phase === 'gameOver';
  const localTerminal =
    local.phase === 'resolveStrikes' ||
    local.phase === 'roundSummary' ||
    local.phase === 'gameOver';

  let merged: GameState = {
    ...remote,
    phase: remoteTerminal
      ? remote.phase
      : localTerminal
        ? local.phase
        : local.phase === 'action' || remote.phase === 'action'
          ? 'action'
          : remote.phase,
    currentTurnIndex: Math.max(remote.currentTurnIndex, local.currentTurnIndex),
    environment,
    nations: mergedNations,
    humanReady: mergedReady,
    humanLastActive: mergedLastActive,
    humanPlanningStartedAt:
      remote.humanPlanningStartedAt ?? local.humanPlanningStartedAt ?? null,
    pendingStrikes: deduped,
    round: remote.round,
    uidToNation: { ...remote.uidToNation, ...local.uidToNation },
    humanNations: remote.turnOrder.filter((id) => mergedNations[id]?.isHuman),
    planningComplete: Boolean(remote.planningComplete || local.planningComplete),
  };

  const uidMap = { ...(merged.uidToNation ?? {}) };
  for (const [uid, nid] of Object.entries(uidMap)) {
    if (!merged.nations[nid as NationId]?.isHuman) delete uidMap[uid];
  }
  merged.uidToNation = uidMap;

  if (
    !merged.planningComplete &&
    (merged.phase === 'buy' || merged.phase === 'action') &&
    allAliveHumansReady(merged)
  ) {
    merged = finishOnlineHumanPlanning(merged);
  }

  return merged;
}
