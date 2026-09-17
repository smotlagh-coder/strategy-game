import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { getDb, isFirebaseConfigured } from './firebase';
import { setPlayerStatus } from './session';
import {
  createInitialState,
  beginHumanPlanning,
  forfeitNation,
  allAliveHumansReady,
  applyQueuedStrike,
  armAftermathTimer,
  finishStrikeResolution,
  nextRound,
  playerDisplayName,
  seatTable,
} from '../game/engine';
import { finishOnlineHumanPlanning, runOnlineAiPlanning } from '../game/ai';
import { NATIONS, nationDef } from '../data/nations';
import {
  mergeHumanPlanningWrite,
  phaseRank,
} from './onlineSync';
import { initialGameSync, nextGameSync } from './gameSync';
import { decodeGameState, encodeGameState, stripUndefined } from './firestoreCodec';
import { canJoinLobby, lobbyCodeFromId } from './lobbyInvite';
import type {
  GameState,
  GameSyncKind,
  InviteDoc,
  NationId,
  OnlineGameDoc,
  OnlineLobby,
  PlayerDoc,
} from '../types';

export { mergeHumanReadyFlags, mergeNationPlanning } from './onlineSync';

const ONLINE_MS = 60_000;

export { stripUndefined, encodeGameState, decodeGameState } from './firestoreCodec';

/** Every read goes through here so `scoreHistory` comes back as a real array. */
function readGameDoc(snap: { exists: () => boolean; data: () => unknown }): OnlineGameDoc | null {
  if (!snap.exists()) return null;
  const game = snap.data() as OnlineGameDoc;
  return { ...game, state: decodeGameState(game.state) };
}

export function isPlayerOnline(p: PlayerDoc, now = Date.now()): boolean {
  return now - p.lastSeen < ONLINE_MS && p.status !== 'offline';
}

/** Presence tick — does not merge planning or change phase. */
export async function touchGameHeartbeat(gameId: string, nationId: NationId) {
  await updateDoc(doc(getDb(), 'games', gameId), {
    [`state.humanHeartbeat.${nationId}`]: Date.now(),
    updatedAt: Date.now(),
  });
}

/** Leave / disconnect — same as idle kick so the table can move on. */
export async function leaveOnlineGame(
  gameId: string,
  nationId: NationId,
): Promise<GameState | null> {
  return kickIdleHumanFromGame(gameId, nationId);
}

export function listenPlayers(cb: (players: { uid: string; data: PlayerDoc }[]) => void): Unsubscribe {
  const q = collection(getDb(), 'players');
  return onSnapshot(q, (snap) => {
    const rows = snap.docs.map((d) => ({ uid: d.id, data: d.data() as PlayerDoc }));
    cb(rows);
  });
}

export function listenInvitesFor(
  uid: string,
  cb: (invites: { id: string; data: InviteDoc }[]) => void,
): Unsubscribe {
  const q = query(
    collection(getDb(), 'invites'),
    where('toUid', '==', uid),
    where('status', '==', 'pending'),
  );
  return onSnapshot(
    q,
    (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, data: d.data() as InviteDoc })));
    },
    (err) => {
      console.error('listenInvitesFor', err);
      cb([]);
    },
  );
}

/** Pending invites this player has sent (host side). */
export function listenOutgoingInvites(
  fromUid: string,
  cb: (invites: { id: string; data: InviteDoc }[]) => void,
): Unsubscribe {
  const q = query(
    collection(getDb(), 'invites'),
    where('fromUid', '==', fromUid),
    where('status', '==', 'pending'),
  );
  return onSnapshot(
    q,
    (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, data: d.data() as InviteDoc })));
    },
    (err) => {
      console.error('listenOutgoingInvites', err);
      cb([]);
    },
  );
}

export async function sendInvite(fromUid: string, fromName: string, toUid: string, lobbyId: string) {
  // Must filter fromUid (== auth.uid) so security rules allow the query.
  // Use fromUid+status (existing index); filter toUid/lobby client-side.
  const existing = await getDocs(
    query(
      collection(getDb(), 'invites'),
      where('fromUid', '==', fromUid),
      where('status', '==', 'pending'),
    ),
  );
  const alreadyPending = existing.docs.some((d) => {
    const data = d.data() as InviteDoc;
    return data.toUid === toUid && (!data.lobbyId || data.lobbyId === lobbyId);
  });
  if (alreadyPending) {
    throw new Error('That player already has a pending invite');
  }

  const payload: InviteDoc = {
    fromUid,
    toUid,
    fromName,
    status: 'pending',
    createdAt: Date.now(),
    lobbyId,
    lobbyCode: lobbyCodeFromId(lobbyId),
  };
  await addDoc(collection(getDb(), 'invites'), payload);
}

export async function respondInvite(inviteId: string, accept: boolean) {
  await updateDoc(doc(getDb(), 'invites', inviteId), {
    status: accept ? 'accepted' : 'declined',
  });
}

export async function fetchLobby(lobbyId: string): Promise<OnlineLobby | null> {
  const snap = await getDoc(doc(getDb(), 'lobbies', lobbyId));
  if (!snap.exists()) return null;
  const data = snap.data() as OnlineLobby;
  return { ...data, id: data.id ?? snap.id };
}

/** Close leftover open lobbies this host still has from previous games. */
export async function closeOpenLobbiesForHost(hostUid: string, keepId?: string) {
  const q = query(
    collection(getDb(), 'lobbies'),
    where('hostUid', '==', hostUid),
    where('status', '==', 'open'),
  );
  const snap = await getDocs(q);
  await Promise.all(
    snap.docs
      .filter((d) => d.id !== keepId)
      .map((d) =>
        updateDoc(d.ref, { status: 'closed', gameId: null }).catch(() => undefined),
      ),
  );
}

export async function cancelPendingInvitesForLobby(fromUid: string, lobbyId: string) {
  const existing = await getDocs(
    query(
      collection(getDb(), 'invites'),
      where('fromUid', '==', fromUid),
      where('status', '==', 'pending'),
    ),
  );
  await Promise.all(
    existing.docs
      .filter((d) => (d.data() as InviteDoc).lobbyId === lobbyId)
      .map((d) => updateDoc(d.ref, { status: 'cancelled' }).catch(() => undefined)),
  );
}

export async function createLobby(hostUid: string, hostName: string): Promise<string> {
  await closeOpenLobbiesForHost(hostUid).catch(() => undefined);
  const ref = doc(collection(getDb(), 'lobbies'));
  const lobby: OnlineLobby = {
    id: ref.id,
    hostUid,
    memberUids: [hostUid],
    memberNames: { [hostUid]: hostName },
    status: 'open',
    createdAt: Date.now(),
    code: lobbyCodeFromId(ref.id),
    gameId: null,
  };
  await setDoc(ref, lobby);
  return ref.id;
}

export function listenLobby(lobbyId: string, cb: (lobby: OnlineLobby | null) => void): Unsubscribe {
  return onSnapshot(doc(getDb(), 'lobbies', lobbyId), (snap) => {
    cb(snap.exists() ? (snap.data() as OnlineLobby) : null);
  });
}

export async function joinLobby(lobbyId: string, uid: string, name: string) {
  const ref = doc(getDb(), 'lobbies', lobbyId);
  await runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Lobby not found');
    const lobby = snap.data() as OnlineLobby;
    if (!canJoinLobby(lobby)) throw new Error('This lobby is no longer available');
    if (lobby.memberUids.includes(uid)) return;
    if (lobby.memberUids.length >= 5) throw new Error('Lobby full');
    tx.update(ref, {
      memberUids: [...lobby.memberUids, uid],
      memberNames: { ...lobby.memberNames, [uid]: name },
    });
  });
}

export async function leaveLobby(lobbyId: string, uid: string) {
  const ref = doc(getDb(), 'lobbies', lobbyId);
  await runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const lobby = snap.data() as OnlineLobby;
    const memberUids = lobby.memberUids.filter((id) => id !== uid);
    const memberNames = { ...lobby.memberNames };
    delete memberNames[uid];
    // Free the country they had claimed
    const nationPicks = { ...(lobby.nationPicks ?? {}) };
    delete nationPicks[uid];
    if (memberUids.length === 0 || lobby.hostUid === uid) {
      tx.update(ref, { status: 'closed', memberUids, memberNames, nationPicks });
    } else {
      tx.update(ref, { memberUids, memberNames, nationPicks });
    }
  });
}

/** Members holding a country, ignoring claims left behind by players who quit. */
export function lobbyNationPicks(lobby: OnlineLobby): Record<string, NationId> {
  const picks: Record<string, NationId> = {};
  const used = new Set<NationId>();
  for (const uid of lobby.memberUids) {
    const pick = lobby.nationPicks?.[uid];
    if (!pick || used.has(pick)) continue;
    used.add(pick);
    picks[uid] = pick;
  }
  return picks;
}

/**
 * Claim a country in the lobby. First come, first served: the transaction
 * refuses a nation another member already holds. Pass null to release.
 */
export async function claimLobbyNation(
  lobbyId: string,
  uid: string,
  nationId: NationId | null,
): Promise<void> {
  const ref = doc(getDb(), 'lobbies', lobbyId);
  await runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Lobby not found');
    const lobby = snap.data() as OnlineLobby;
    if (!lobby.memberUids.includes(uid)) throw new Error('Join the lobby first');
    if (lobby.gameId || lobby.status !== 'open') {
      throw new Error('The match already started');
    }

    const picks = lobbyNationPicks(lobby);
    if (nationId == null) {
      delete picks[uid];
    } else {
      const heldByOther = Object.entries(picks).some(
        ([owner, nation]) => nation === nationId && owner !== uid,
      );
      if (heldByOther) {
        throw new Error('Someone just claimed that country — pick another');
      }
      picks[uid] = nationId;
    }
    tx.update(ref, { nationPicks: picks });
  });
}

/** Honour lobby country claims, then deal countries to members who never picked. */
export function assignNations(
  memberUids: string[],
  picks: Record<string, NationId> = {},
  rng: () => number = Math.random,
): Record<string, NationId> {
  const chosen = new Map<string, NationId>();
  const used = new Set<NationId>();
  for (const uid of memberUids) {
    const pick = picks[uid];
    if (!pick || used.has(pick)) continue;
    used.add(pick);
    chosen.set(uid, pick);
  }
  const undecided = memberUids.filter((uid) => !chosen.has(uid));
  if (undecided.length > 0) {
    // Deal the leftovers at random so the same countries aren't always handed out
    const pool = seatTable([], {
      size: NATIONS.length,
      rng,
    }).filter((id) => !used.has(id));
    for (const uid of undecided) {
      const free = pool.shift();
      if (!free) break;
      used.add(free);
      chosen.set(uid, free);
    }
  }

  // Emit in seating order so player slots stay stable
  const unique: Record<string, NationId> = {};
  for (const uid of memberUids) {
    const nation = chosen.get(uid);
    if (nation) unique[uid] = nation;
  }
  return unique;
}

export function buildOnlineGameState(
  assignments: Record<string, NationId>,
  playerNames: Record<string, string>,
  gameId: string,
  opts?: { lobbyId?: string; hostUid?: string },
): GameState {
  let state = createInitialState();
  const nations = { ...state.nations };
  const humanNations: NationId[] = [];
  const uidToNation: Record<string, NationId> = {};
  const slotNames: Record<number, string> = {};
  let slot = 1;

  for (const [uid, nationId] of Object.entries(assignments)) {
    humanNations.push(nationId);
    uidToNation[uid] = nationId;
    nations[nationId] = {
      ...nations[nationId],
      isHuman: true,
      playerSlot: slot,
      ownerUid: uid,
    };
    slotNames[slot] = playerNames[uid] ?? `Player ${slot}`;
    slot += 1;
  }

  for (const n of NATIONS) {
    if (!humanNations.includes(n.id)) {
      const aiNation = { ...nations[n.id], isHuman: false };
      delete aiNation.playerSlot;
      delete aiNation.ownerUid;
      nations[n.id] = aiNation;
    }
  }

  // Humans always play; AI fills the rest of the table from unpicked countries
  const seats = seatTable(humanNations);
  const humans = seats.filter((id) => nations[id].isHuman);
  const ai = seats.filter((id) => !nations[id].isHuman);

  return runOnlineAiPlanning(
    beginHumanPlanning({
      ...state,
      mode: 'online',
      phase: 'buy',
      round: 1,
      nations,
      humanNations,
      playerNames: slotNames,
      uidToNation,
      onlineGameId: gameId,
      onlineLobbyId: opts?.lobbyId ?? null,
      onlineHostUid: opts?.hostUid ?? null,
      turnOrder: [...humans, ...ai],
      currentTurnIndex: 0,
      log: [
        {
          id: 'log-online-start',
          text: `Online match begins — ${humanNations.map((id) => nationDef(id).name).join(', ')} vs AI.`,
          tone: 'neutral',
        },
      ],
    }),
  );
}

export async function startOnlineGameFromLobby(
  lobby: OnlineLobby,
): Promise<{ gameId: string; state: GameState }> {
  if (lobby.memberUids.length < 2) throw new Error('Need at least 2 players');
  if (lobby.memberUids.length > 5) throw new Error('Max 5 players');

  const assignments = assignNations(lobby.memberUids, lobbyNationPicks(lobby));
  const gameRef = doc(collection(getDb(), 'games'));
  const state = buildOnlineGameState(assignments, lobby.memberNames, gameRef.id, {
    lobbyId: lobby.id,
    hostUid: lobby.hostUid,
  });

  const game: OnlineGameDoc = {
    hostUid: lobby.hostUid,
    playerUids: lobby.memberUids,
    playerNames: lobby.memberNames,
    nationAssignments: assignments,
    status: 'active',
    state,
    sync: initialGameSync(),
    aiLock: null,
    updatedAt: Date.now(),
    lobbyId: lobby.id,
    rematchGameId: null,
  };
  await setDoc(gameRef, stripUndefined({ ...game, state: encodeGameState(game.state) }));
  // Each client updates only their own player doc (rules enforce uid match)
  await updateDoc(doc(getDb(), 'lobbies', lobby.id), {
    status: 'starting',
    gameId: gameRef.id,
  });
  await cancelPendingInvitesForLobby(lobby.hostUid, lobby.id);

  return { gameId: gameRef.id, state };
}

/**
 * Host starts another match with the same players. Peers pick up rematchGameId
 * from the finished game document.
 */
export async function rematchOnlineGame(
  finishedGameId: string,
  hostUid: string,
): Promise<{ gameId: string; state: GameState }> {
  const finished = await fetchGame(finishedGameId);
  if (!finished) throw new Error('Finished game not found');
  if (finished.hostUid !== hostUid) throw new Error('Only the host can start a rematch');

  const oldLobbyId = finished.lobbyId ?? finished.state.onlineLobbyId ?? null;
  if (oldLobbyId) {
    await updateDoc(doc(getDb(), 'lobbies', oldLobbyId), {
      status: 'closed',
    }).catch(() => undefined);
  }

  // Always a new lobby id so leftover invites/docs cannot reopen the last match
  const lobbyRef = doc(collection(getDb(), 'lobbies'));
  const lobby: OnlineLobby = {
    id: lobbyRef.id,
    hostUid: finished.hostUid,
    memberUids: finished.playerUids,
    memberNames: finished.playerNames,
    // Everyone keeps the country they just played
    nationPicks: finished.nationAssignments,
    status: 'open',
    createdAt: Date.now(),
    code: lobbyCodeFromId(lobbyRef.id),
    gameId: null,
  };
  await setDoc(lobbyRef, stripUndefined(lobby));

  const { gameId, state } = await startOnlineGameFromLobby(lobby);
  await updateDoc(doc(getDb(), 'games', finishedGameId), {
    rematchGameId: gameId,
    updatedAt: Date.now(),
  });

  // Mark everyone in-game on the new match (each client also does this on enter)
  return { gameId, state };
}

export async function fetchGame(gameId: string): Promise<OnlineGameDoc | null> {
  const snap = await getDoc(doc(getDb(), 'games', gameId));
  return readGameDoc(snap);
}

/** Guests discover the match even if they miss the lobby.gameId update. */
export function listenMyActiveGames(
  uid: string,
  cb: (games: { id: string; data: OnlineGameDoc }[]) => void,
): Unsubscribe {
  const q = query(
    collection(getDb(), 'games'),
    where('playerUids', 'array-contains', uid),
    where('status', '==', 'active'),
  );
  return onSnapshot(
    q,
    (snap) => {
      cb(
        snap.docs.flatMap((d) => {
          const data = readGameDoc(d);
          return data ? [{ id: d.id, data }] : [];
        }),
      );
    },
    (err) => {
      console.error('listenMyActiveGames', err);
      cb([]);
    },
  );
}

export function listenGame(
  gameId: string,
  cb: (game: OnlineGameDoc | null) => void,
): Unsubscribe {
  return onSnapshot(doc(getDb(), 'games', gameId), (snap) => {
    cb(readGameDoc(snap));
  });
}

export async function pushGameState(gameId: string, state: GameState, clearAiLock = false) {
  const patch: Record<string, unknown> = {
    state: encodeGameState(state),
    updatedAt: Date.now(),
    status: state.phase === 'gameOver' ? 'finished' : 'active',
  };
  if (clearAiLock) patch.aiLock = null;
  await updateDoc(doc(getDb(), 'games', gameId), patch);
}

/**
 * Publish a shared phase (aftermath / game over) and bump the table clock.
 * Later writers cannot rewind round or phase.
 */
export async function publishSharedPhase(
  gameId: string,
  local: GameState,
  kind: Extract<GameSyncKind, 'aftermath' | 'gameOver'>,
): Promise<GameState | null> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const game = readGameDoc(snap)!;
    const remote = game.state;
    if (Number(remote.round) > Number(local.round)) return remote;
    if (remote.phase === 'gameOver') return remote;
    if (
      Number(remote.round) === Number(local.round) &&
      phaseRank(remote.phase) > phaseRank(local.phase)
    ) {
      return remote;
    }
    if (
      Number(remote.round) === Number(local.round) &&
      remote.phase === local.phase &&
      (remote.aftermathEndsAt ?? 0) > (local.aftermathEndsAt ?? 0)
    ) {
      return remote;
    }
    tx.update(ref, {
      state: encodeGameState(local),
      sync: nextGameSync(game.sync, kind, local.round),
      updatedAt: Date.now(),
      aiLock: null,
      status: local.phase === 'gameOver' ? 'finished' : 'active',
    });
    return local;
  });
}

/**
 * First writer publishes the next-round event. Everyone else listens and adopts it.
 * Clients must not call nextRound locally for online games.
 */
export async function advanceOnlineRound(
  gameId: string,
  fromRound: number,
): Promise<GameState | null> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const game = readGameDoc(snap)!;
    const remote = game.state;
    const remoteRound = Number(remote.round);

    // Already past this aftermath — hand every client the authoritative state
    if (remoteRound > fromRound || remote.phase === 'gameOver') {
      return remote;
    }
    if (remote.phase !== 'roundSummary' || remoteRound !== fromRound) {
      return remote;
    }

    const next = nextRound(remote);
    const kind: GameSyncKind = next.phase === 'gameOver' ? 'gameOver' : 'roundStart';
    tx.update(ref, {
      state: encodeGameState(next),
      sync: nextGameSync(game.sync, kind, next.round),
      updatedAt: Date.now(),
      aiLock: null,
      status: next.phase === 'gameOver' ? 'finished' : 'active',
    });
    return next;
  });
}

const humanPushQueues = new Map<string, Promise<unknown>>();

/** Serialize planning writes so an older in-flight push cannot clobber a newer one. */
export function enqueueHumanPlanningPush(
  gameId: string,
  nationId: NationId,
  getLocal: () => GameState,
): Promise<GameState> {
  const prev = humanPushQueues.get(gameId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => pushHumanPlanningState(gameId, getLocal(), nationId));
  humanPushQueues.set(gameId, next);
  return next;
}

/**
 * Strikes land on the shared doc. Lock-free and idempotent like the planning
 * transition, so a player who left mid-round cannot freeze the resolution.
 * The aftermath countdown is armed in the same write, keeping every client on
 * one clock no matter who publishes first.
 */
export async function publishStrikeResolution(
  gameId: string,
  round: number,
): Promise<GameState | null> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    const game = readGameDoc(snap);
    if (!game) return null;
    const remote = game.state;

    if (Number(remote.round) !== Number(round)) return remote;
    if (remote.phase !== 'resolveStrikes') return remote;

    let next = remote.pendingStrikes.reduce(
      (s, strike) => applyQueuedStrike(s, strike),
      remote,
    );
    next = finishStrikeResolution(next);
    // Budget the cinema into the shared clock so a peer adopting this board
    // still gets a full think window after its animation finishes.
    if (next.phase === 'roundSummary') {
      next = armAftermathTimer(next, Date.now(), { includeCinema: true });
    }

    const kind: GameSyncKind = next.phase === 'gameOver' ? 'gameOver' : 'aftermath';
    tx.update(ref, {
      state: encodeGameState(next),
      sync: nextGameSync(game.sync, kind, next.round),
      updatedAt: Date.now(),
      aiLock: null,
      status: next.phase === 'gameOver' ? 'finished' : 'active',
    });
    return next;
  });
}

/**
 * Minimal "I'm done" write — a single field path, no state merge. If a full
 * state payload ever fails, the room still learns this player locked in.
 */
export async function markOnlineReady(gameId: string, nationId: NationId) {
  await updateDoc(doc(getDb(), 'games', gameId), {
    [`state.humanReady.${nationId}`]: true,
    [`state.humanLastActive.${nationId}`]: Date.now(),
    updatedAt: Date.now(),
  });
}

/**
 * Final "orders locked" write. Always sets this nation's ready flag on the
 * shared doc and publishes a playerReady clock event peers listen for.
 */
export async function lockInHumanPlanning(
  gameId: string,
  local: GameState,
  nationId: NationId,
): Promise<GameState> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    const existing = readGameDoc(snap);
    const remote = existing ? existing.state : local;
    const prevSync = existing?.sync;
    if (Number(remote.round) !== Number(local.round)) return remote;
    if (phaseRank(remote.phase) >= phaseRank('resolveStrikes') || remote.planningComplete) {
      return remote;
    }

    const locked: GameState = {
      ...local,
      humanReady: { ...local.humanReady, [nationId]: true },
    };
    let finalState = mergeHumanPlanningWrite(remote, locked, nationId);
    finalState = {
      ...finalState,
      humanReady: { ...finalState.humanReady, [nationId]: true },
    };
    if (
      (finalState.phase === 'buy' || finalState.phase === 'action') &&
      allAliveHumansReady(finalState) &&
      !finalState.planningComplete
    ) {
      finalState = finishOnlineHumanPlanning(finalState);
    }

    tx.update(ref, {
      state: encodeGameState(finalState),
      sync: nextGameSync(prevSync, 'playerReady', finalState.round, Date.now(), {
        nationId,
      }),
      updatedAt: Date.now(),
      status: finalState.phase === 'gameOver' ? 'finished' : 'active',
    });
    return finalState;
  });
}

/**
 * Everyone is ready → publish the resolve transition. Lock-free and idempotent
 * so any client can retry it; a stalled peer can never freeze the table.
 */
export async function publishPlanningComplete(
  gameId: string,
  round: number,
): Promise<GameState | null> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const game = readGameDoc(snap)!;
    const remote = game.state;

    if (Number(remote.round) !== Number(round)) return remote;
    if (remote.phase !== 'buy' && remote.phase !== 'action') return remote;
    if (remote.planningComplete) return remote;
    if (!allAliveHumansReady(remote)) return remote;

    const next = finishOnlineHumanPlanning(remote);
    if (!next.planningComplete) return remote;

    tx.update(ref, {
      state: encodeGameState(next),
      sync: nextGameSync(game.sync, 'resolve', next.round),
      updatedAt: Date.now(),
      aiLock: null,
      status: next.phase === 'gameOver' ? 'finished' : 'active',
    });
    return next;
  });
}

/**
 * Merge one human's planning into the shared game doc so parallel players
 * don't overwrite each other's nations / strikes / ready flags.
 */
export async function pushHumanPlanningState(
  gameId: string,
  local: GameState,
  nationId: NationId,
): Promise<GameState> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    const remote = readGameDoc(snap)?.state ?? local;
    const finalState = mergeHumanPlanningWrite(remote, local, nationId);
    tx.update(ref, {
      state: encodeGameState(finalState),
      updatedAt: Date.now(),
      status: finalState.phase === 'gameOver' ? 'finished' : 'active',
    });
    return finalState;
  });
}

/** Forfeit an idle/leaving human — burn cities, mark OUT, remove from membership. */
export async function kickIdleHumanFromGame(
  gameId: string,
  nationId: NationId,
): Promise<GameState | null> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const game = readGameDoc(snap)!;
    if (!game.state.nations[nationId]?.isHuman || game.state.nations[nationId]?.eliminated) {
      return game.state;
    }

    const ownerUid = game.state.nations[nationId]?.ownerUid;
    const playerName = playerDisplayName(game.state, nationId);
    const nationName = nationDef(nationId).name;
    let mergedState = forfeitNation(game.state, nationId);
    // Remaining humans may all be ready now — advance planning without AI for the leaver
    if (
      mergedState.phase !== 'gameOver' &&
      (mergedState.phase === 'buy' || mergedState.phase === 'action') &&
      !mergedState.planningComplete
    ) {
      if (!mergedState.aiPlanningComplete) {
        mergedState = runOnlineAiPlanning(mergedState);
      }
      if (allAliveHumansReady(mergedState)) {
        mergedState = finishOnlineHumanPlanning(mergedState);
      }
    }
    const playerUids = ownerUid
      ? game.playerUids.filter((u) => u !== ownerUid)
      : game.playerUids;
    const playerNames = { ...game.playerNames };
    if (ownerUid) delete playerNames[ownerUid];
    const nationAssignments = { ...game.nationAssignments };
    if (ownerUid) delete nationAssignments[ownerUid];

    tx.update(ref, {
      state: encodeGameState(mergedState),
      sync: nextGameSync(game.sync, 'dropout', mergedState.round, Date.now(), {
        nationId,
        playerName,
        nationName,
      }),
      playerUids,
      playerNames,
      nationAssignments,
      updatedAt: Date.now(),
      status: mergedState.phase === 'gameOver' ? 'finished' : game.status,
    });
    return mergedState;
  });
}

/** First writer wins AI lock for this turn key. Returns false if another uid holds it. */
export async function tryAcquireAiLock(
  gameId: string,
  uid: string,
  turnKey: string,
): Promise<boolean> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    const game = readGameDoc(snap)!;
    const mine = `${turnKey}:${uid}`;
    if (game.aiLock === mine) return true;
    if (game.aiLock && game.aiLock.startsWith(`${turnKey}:`)) {
      return false;
    }
    // Different key (or empty): take the lock for this step
    tx.update(ref, { aiLock: mine });
    return true;
  });
}

export async function finishOnlineGame(gameId: string, state: GameState, selfUid?: string) {
  await publishSharedPhase(gameId, state, 'gameOver');
  // Keep players "in_game" so rematch can start without everyone re-lobbying
  if (selfUid) await setPlayerStatus(selfUid, 'in_game', gameId);
}

export async function incrementSuperpowerWin(uid: string, displayName: string) {
  if (!isFirebaseConfigured()) return;
  const playerRef = doc(getDb(), 'players', uid);
  const boardRef = doc(getDb(), 'leaderboard', uid);
  await runTransaction(getDb(), async (tx) => {
    const p = await tx.get(playerRef);
    const wins = ((p.data() as PlayerDoc | undefined)?.superpowerWins ?? 0) + 1;
    tx.set(playerRef, { superpowerWins: wins, displayName }, { merge: true });
    tx.set(boardRef, { displayName, superpowerWins: wins }, { merge: true });
  });
}

export async function fetchLeaderboard(): Promise<{ uid: string; displayName: string; superpowerWins: number }[]> {
  if (!isFirebaseConfigured()) return [];
  const q = query(collection(getDb(), 'leaderboard'), orderBy('superpowerWins', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data() as { displayName: string; superpowerWins: number };
    return { uid: d.id, displayName: data.displayName, superpowerWins: data.superpowerWins ?? 0 };
  });
}

export function listenLeaderboard(
  cb: (rows: { uid: string; displayName: string; superpowerWins: number }[]) => void,
): Unsubscribe {
  const q = query(collection(getDb(), 'leaderboard'), orderBy('superpowerWins', 'desc'));
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs.map((d) => {
        const data = d.data() as { displayName: string; superpowerWins: number };
        return { uid: d.id, displayName: data.displayName, superpowerWins: data.superpowerWins ?? 0 };
      }),
    );
  });
}
