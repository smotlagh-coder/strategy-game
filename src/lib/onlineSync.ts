import type { GameState, NationId, NationState, Phase } from '../types';
import { allAliveHumansReady, ensureIncome } from '../game/engine';
import { finishOnlineHumanPlanning, runOnlineAiPlanning } from '../game/ai';

/** Later phases win merges so stale resolveStrikes cannot clobber roundSummary. */
export function phaseRank(phase: Phase | null | undefined): number {
  switch (phase) {
    case 'gameOver':
      return 100;
    case 'roundSummary':
      return 80;
    case 'resolveStrikes':
      return 60;
    case 'action':
      return 40;
    case 'buy':
      return 30;
    case 'income':
      return 20;
    default:
      return 0;
  }
}

/** Prefer higher round, then further phase, then AI/planning progress. */
export function pickFurtherState(a: GameState, b: GameState): GameState {
  if (a.round !== b.round) return a.round >= b.round ? a : b;
  if (phaseRank(a.phase) !== phaseRank(b.phase)) {
    return phaseRank(a.phase) >= phaseRank(b.phase) ? a : b;
  }
  if (Boolean(a.planningComplete) !== Boolean(b.planningComplete)) {
    return a.planningComplete ? a : b;
  }
  if (Boolean(a.aiPlanningComplete) !== Boolean(b.aiPlanningComplete)) {
    return a.aiPlanningComplete ? a : b;
  }
  return a;
}

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

const counter = (value: number | undefined) => (Number.isFinite(value) ? Number(value) : 0);

/**
 * A stockpile shrinks when a bomb is fired, so the larger side cannot simply
 * win — that resurrects warheads the nation already launched. Rebuild it from
 * the round-start stock plus the monotonic buy / launch counters.
 */
export function mergeBombStock(remote: NationState, local: NationState): number {
  const stockAtRoundStart = Math.max(
    counter(remote.bombs) - counter(remote.bombsBoughtThisRound) + counter(remote.bombsUsed),
    counter(local.bombs) - counter(local.bombsBoughtThisRound) + counter(local.bombsUsed),
  );
  const bought = Math.max(
    counter(remote.bombsBoughtThisRound),
    counter(local.bombsBoughtThisRound),
  );
  const launched = Math.max(counter(remote.bombsUsed), counter(local.bombsUsed));
  return Math.max(0, stockAtRoundStart + bought - launched);
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

  const eliminated =
    Boolean(remote.eliminated || local.eliminated) || cities.every((c) => c.destroyed);
  const seatHeld = remote.isHuman && local.isHuman;

  const remoteIncome = remote.incomeRound ?? 0;
  const localIncome = local.incomeRound ?? 0;
  // Prefer the side that already received this round's income so Math.min
  // cannot discard the +$3M grant against a stale pre-income snapshot.
  let money: number;
  let incomeRound: number | undefined;
  if (remoteIncome > localIncome) {
    money = remote.money;
    incomeRound = remote.incomeRound;
  } else if (localIncome > remoteIncome) {
    money = local.money;
    incomeRound = local.incomeRound;
  } else {
    money = Math.min(remote.money, local.money);
    incomeRound = remote.incomeRound ?? local.incomeRound;
  }

  return {
    ...remote,
    ...local,
    cities,
    researchCenters: eliminated ? 0 : researchCenters,
    hasNuclearTech: remote.hasNuclearTech || local.hasNuclearTech,
    nuclearTechUnlockedRound:
      local.nuclearTechUnlockedRound ?? remote.nuclearTechUnlockedRound,
    money: eliminated ? 0 : money,
    incomeRound: eliminated ? undefined : incomeRound,
    bombs: eliminated ? 0 : mergeBombStock(remote, local),
    bombsBoughtThisRound: Math.max(remote.bombsBoughtThisRound, local.bombsBoughtThisRound),
    bombsUsed: Math.max(remote.bombsUsed, local.bombsUsed),
    envBoughtThisRound: remote.envBoughtThisRound || local.envBoughtThisRound,
    promptsDoneThisRound: Array.from(
      new Set([...(remote.promptsDoneThisRound ?? []), ...(local.promptsDoneThisRound ?? [])]),
    ),
    environmentBuys: Math.max(remote.environmentBuys, local.environmentBuys),
    environmentScore: Math.max(remote.environmentScore, local.environmentScore),
    citiesStruckThisRound: Array.from(
      new Set([...remote.citiesStruckThisRound, ...local.citiesStruckThisRound]),
    ),
    sanctions:
      local.sanctions.length >= remote.sanctions.length ? local.sanctions : remote.sanctions,
    eliminated,
    lockedScore: Math.max(remote.lockedScore ?? 0, local.lockedScore ?? 0),
    // Forfeit / kick sticks — never revive an AI-converted nation as human.
    // Being wiped out is not a forfeit: the seat stays so that player can watch
    // the rest of the match.
    isHuman: seatHeld,
    playerSlot: seatHeld ? (local.playerSlot ?? remote.playerSlot) : undefined,
    ownerUid: seatHeld ? (local.ownerUid ?? remote.ownerUid) : undefined,
  };
}

function mergeNationMaps(base: GameState, other: GameState): GameState['nations'] {
  const nations = { ...base.nations };
  for (const id of base.turnOrder) {
    if (other.nations[id] && base.nations[id]) {
      nations[id] = mergeNationPlanning(base.nations[id], other.nations[id]);
    }
  }
  return nations;
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
  const prevRound = Number(prev.round ?? 0);
  const remoteRound = Number(remote.round ?? 0);
  if (prevRound !== remoteRound) {
    let next = remoteRound >= prevRound ? remote : prev;
    if (
      next === remote &&
      (next.phase === 'buy' || next.phase === 'action') &&
      !next.planningComplete &&
      !next.aiPlanningComplete
    ) {
      next = runOnlineAiPlanning(next);
    }
    return ensureIncome(next);
  }

  // Remote already left planning (strikes / aftermath / next phase) — follow it
  if (phaseRank(remote.phase) > phaseRank(prev.phase)) {
    return ensureIncome({
      ...remote,
      nations: mergeNationMaps(remote, prev),
      humanReady: mergeHumanReadyFlags(remote.humanReady, prev.humanReady),
      planningComplete:
        Boolean(remote.planningComplete) ||
        phaseRank(remote.phase) >= phaseRank('resolveStrikes'),
      aftermathEndsAt: remote.aftermathEndsAt ?? prev.aftermathEndsAt ?? null,
      previousRoundEvents: remote.previousRoundEvents?.length
        ? remote.previousRoundEvents
        : prev.previousRoundEvents,
      // Losing this list costs the client its strike animation
      resolvedStrikes: remote.resolvedStrikes?.length
        ? remote.resolvedStrikes
        : prev.resolvedStrikes,
      previousRoundNumber: remote.previousRoundNumber ?? prev.previousRoundNumber ?? null,
      aiPlanningComplete: Boolean(remote.aiPlanningComplete || prev.aiPlanningComplete),
    });
  }

  // Same round: never go backwards in phase (stops resolveStrikes ↔ summary loops)
  const further = pickFurtherState(prev, remote);
  const other = further === prev ? remote : prev;
  const ready =
    further.phase === 'buy' || further.phase === 'action'
      ? mergeHumanReadyFlags(remote.humanReady, prev.humanReady)
      : further.humanReady;

  // Past planning: follow the furthest phase, union nation upgrades
  if (
    further.planningComplete ||
    phaseRank(further.phase) >= phaseRank('resolveStrikes')
  ) {
    return ensureIncome({
      ...further,
      nations: mergeNationMaps(further, other),
      humanReady: ready ?? further.humanReady,
      planningComplete: true,
      aftermathEndsAt: further.aftermathEndsAt ?? other.aftermathEndsAt ?? null,
      previousRoundEvents: further.previousRoundEvents?.length
        ? further.previousRoundEvents
        : other.previousRoundEvents,
      // Losing this list costs the client its strike animation
      resolvedStrikes: further.resolvedStrikes?.length
        ? further.resolvedStrikes
        : other.resolvedStrikes,
      previousRoundNumber: further.previousRoundNumber ?? other.previousRoundNumber ?? null,
    });
  }

  // Still selecting locally: keep my in-progress nation, take everyone else from remote
  if (
    myNationId &&
    (prev.phase === 'buy' || prev.phase === 'action') &&
    !ready?.[myNationId]
  ) {
    const myStrikes = prev.pendingStrikes.filter((s) => s.attackerId === myNationId);
    const otherStrikes = remote.pendingStrikes.filter((s) => s.attackerId !== myNationId);
    let next: GameState = {
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
      aiPlanningComplete: Boolean(remote.aiPlanningComplete || prev.aiPlanningComplete),
    };
    if (!next.aiPlanningComplete) next = runOnlineAiPlanning(next);
    if (allAliveHumansReady(next) && !next.planningComplete) {
      next = finishOnlineHumanPlanning(next);
    }
    return ensureIncome(next);
  }

  const nations = { ...remote.nations };
  if (myNationId && prev.nations[myNationId] && remote.nations[myNationId]) {
    nations[myNationId] = mergeNationPlanning(remote.nations[myNationId], prev.nations[myNationId]);
  }
  let next: GameState = {
    ...remote,
    nations,
    humanReady: ready,
    aiPlanningComplete: Boolean(remote.aiPlanningComplete || prev.aiPlanningComplete),
  };
  if (!next.aiPlanningComplete && (next.phase === 'buy' || next.phase === 'action')) {
    next = runOnlineAiPlanning(next);
  }
  if (
    (next.phase === 'buy' || next.phase === 'action') &&
    allAliveHumansReady(next) &&
    !next.planningComplete
  ) {
    next = finishOnlineHumanPlanning(next);
  }
  return ensureIncome(next);
}

/** Server-side merge when one human pushes planning state. */
export function mergeHumanPlanningWrite(
  remote: GameState,
  local: GameState,
  nationId: NationId,
): GameState {
  // Planning writes cannot change the shared round — only the published clock can.
  if (local.round !== remote.round) return remote;

  // Never let a stale writer pull the shared doc backwards
  const further = pickFurtherState(remote, local);
  if (phaseRank(further.phase) >= phaseRank('resolveStrikes') || further.planningComplete) {
    const other = further === remote ? local : remote;
    return {
      ...further,
      nations: {
        ...mergeNationMaps(further, other),
        [nationId]: mergeNationPlanning(further.nations[nationId], local.nations[nationId]),
      },
      humanReady:
        further.phase === 'buy' || further.phase === 'action'
          ? mergeHumanReadyFlags(remote.humanReady, local.humanReady)
          : further.humanReady,
      planningComplete: true,
    };
  }

  const strikeKey = (s: { attackerId: string; targetNationId: string; cityId: string }) =>
    `${s.attackerId}:${s.targetNationId}:${s.cityId}`;

  // Prefer the snapshot that already ran AI so buys/strikes aren't wiped by a stale peer
  const preferred = pickFurtherState(remote, local);
  const nonWriterStrikes = (preferred.pendingStrikes ?? []).filter((s) => s.attackerId !== nationId);
  const localMyStrikes = (local.pendingStrikes ?? []).filter((s) => s.attackerId === nationId);
  const pendingStrikes = [...nonWriterStrikes, ...localMyStrikes];
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
  let environment = preferred.environment;
  if (localEnvBuy && !remoteHadMine) {
    environment = Math.min(100, preferred.environment + 10);
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

  const mergedNations = { ...preferred.nations };
  for (const id of preferred.turnOrder) {
    if (!preferred.nations[id] || !remote.nations[id] || !local.nations[id]) continue;
    if (preferred.nations[id].isHuman || remote.nations[id].isHuman || local.nations[id].isHuman) {
      mergedNations[id] = mergeNationPlanning(remote.nations[id], local.nations[id]);
    }
  }
  mergedNations[nationId] = mergeNationPlanning(preferred.nations[nationId], local.nations[nationId]);

  let merged: GameState = {
    ...preferred,
    phase: preferred.phase === 'action' ? 'action' : 'buy',
    currentTurnIndex: Math.max(remote.currentTurnIndex, local.currentTurnIndex),
    environment,
    nations: mergedNations,
    humanReady: mergedReady,
    humanLastActive: mergedLastActive,
    humanHeartbeat: (() => {
      const out: Partial<Record<NationId, number>> = {
        ...remote.humanHeartbeat,
        ...local.humanHeartbeat,
      };
      for (const id of new Set([
        ...Object.keys(remote.humanHeartbeat ?? {}),
        ...Object.keys(local.humanHeartbeat ?? {}),
      ])) {
        const nid = id as NationId;
        out[nid] = Math.max(
          remote.humanHeartbeat?.[nid] ?? 0,
          local.humanHeartbeat?.[nid] ?? 0,
        );
      }
      return out;
    })(),
    humanPlanningStartedAt:
      remote.humanPlanningStartedAt ?? local.humanPlanningStartedAt ?? null,
    pendingStrikes: deduped,
    round: preferred.round,
    uidToNation: { ...remote.uidToNation, ...local.uidToNation },
    humanNations: preferred.turnOrder.filter((id) => mergedNations[id]?.isHuman),
    planningComplete: false,
    aiPlanningComplete: Boolean(remote.aiPlanningComplete || local.aiPlanningComplete),
  };

  const uidMap = { ...(merged.uidToNation ?? {}) };
  for (const [uid, nid] of Object.entries(uidMap)) {
    if (!merged.nations[nid as NationId]?.isHuman) delete uidMap[uid];
  }
  merged.uidToNation = uidMap;

  if (!merged.aiPlanningComplete) {
    merged = runOnlineAiPlanning(merged);
  }

  if (
    (merged.phase === 'buy' || merged.phase === 'action') &&
    allAliveHumansReady(merged)
  ) {
    merged = finishOnlineHumanPlanning(merged);
  }

  return ensureIncome(merged);
}
