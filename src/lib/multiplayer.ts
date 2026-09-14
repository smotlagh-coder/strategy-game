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
import { createInitialState } from '../game/engine';
import { NATIONS, nationDef } from '../data/nations';
import type {
  GameState,
  InviteDoc,
  NationId,
  OnlineGameDoc,
  OnlineLobby,
  PlayerDoc,
} from '../types';

const ONLINE_MS = 60_000;

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

export function isPlayerOnline(p: PlayerDoc, now = Date.now()): boolean {
  return now - p.lastSeen < ONLINE_MS && p.status !== 'offline';
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
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, data: d.data() as InviteDoc })));
  });
}

export async function sendInvite(fromUid: string, fromName: string, toUid: string, lobbyId: string) {
  const payload: InviteDoc = {
    fromUid,
    toUid,
    fromName,
    status: 'pending',
    createdAt: Date.now(),
    lobbyId,
  };
  await addDoc(collection(getDb(), 'invites'), payload);
}

export async function respondInvite(inviteId: string, accept: boolean) {
  await updateDoc(doc(getDb(), 'invites', inviteId), {
    status: accept ? 'accepted' : 'declined',
  });
}

export async function createLobby(hostUid: string, hostName: string): Promise<string> {
  const ref = doc(collection(getDb(), 'lobbies'));
  const lobby: OnlineLobby = {
    id: ref.id,
    hostUid,
    memberUids: [hostUid],
    memberNames: { [hostUid]: hostName },
    status: 'open',
    createdAt: Date.now(),
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
    if (lobby.status !== 'open') throw new Error('Lobby closed');
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
    if (memberUids.length === 0 || lobby.hostUid === uid) {
      tx.update(ref, { status: 'closed', memberUids, memberNames });
    } else {
      tx.update(ref, { memberUids, memberNames });
    }
  });
}

/** Assign unique nations to members in order; rest remain AI. */
export function assignNations(memberUids: string[]): Record<string, NationId> {
  const unique: Record<string, NationId> = {};
  const used = new Set<NationId>();
  for (const uid of memberUids) {
    const free = NATIONS.find((n) => !used.has(n.id));
    if (!free) break;
    used.add(free.id);
    unique[uid] = free.id;
  }
  return unique;
}

export function buildOnlineGameState(
  assignments: Record<string, NationId>,
  playerNames: Record<string, string>,
  gameId: string,
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

  const humans = state.turnOrder.filter((id) => nations[id].isHuman);
  const ai = state.turnOrder.filter((id) => !nations[id].isHuman);

  return {
    ...state,
    mode: 'online',
    phase: 'buy',
    round: 1,
    nations,
    humanNations,
    playerNames: slotNames,
    uidToNation,
    onlineGameId: gameId,
    turnOrder: [...humans, ...ai],
    currentTurnIndex: 0,
    log: [
      {
        id: 'log-online-start',
        text: `Online match begins — ${humanNations.map((id) => nationDef(id).name).join(', ')} vs AI.`,
        tone: 'neutral',
      },
    ],
  };
}

export async function startOnlineGameFromLobby(
  lobby: OnlineLobby,
): Promise<{ gameId: string; state: GameState }> {
  if (lobby.memberUids.length < 2) throw new Error('Need at least 2 players');
  if (lobby.memberUids.length > 5) throw new Error('Max 5 players');

  const assignments = assignNations(lobby.memberUids);
  const gameRef = doc(collection(getDb(), 'games'));
  const state = buildOnlineGameState(assignments, lobby.memberNames, gameRef.id);

  const game: OnlineGameDoc = {
    hostUid: lobby.hostUid,
    playerUids: lobby.memberUids,
    playerNames: lobby.memberNames,
    nationAssignments: assignments,
    status: 'active',
    state,
    aiLock: null,
    updatedAt: Date.now(),
  };
  await setDoc(gameRef, stripUndefined(game));
  // Each client updates only their own player doc (rules enforce uid match)
  await updateDoc(doc(getDb(), 'lobbies', lobby.id), {
    status: 'starting',
    gameId: gameRef.id,
  });

  return { gameId: gameRef.id, state };
}

export async function fetchGame(gameId: string): Promise<OnlineGameDoc | null> {
  const snap = await getDoc(doc(getDb(), 'games', gameId));
  return snap.exists() ? (snap.data() as OnlineGameDoc) : null;
}

export function listenGame(
  gameId: string,
  cb: (game: OnlineGameDoc | null) => void,
): Unsubscribe {
  return onSnapshot(doc(getDb(), 'games', gameId), (snap) => {
    cb(snap.exists() ? (snap.data() as OnlineGameDoc) : null);
  });
}

export async function pushGameState(gameId: string, state: GameState, clearAiLock = false) {
  const patch: Record<string, unknown> = {
    state: stripUndefined(state),
    updatedAt: Date.now(),
    status: state.phase === 'gameOver' ? 'finished' : 'active',
  };
  if (clearAiLock) patch.aiLock = null;
  await updateDoc(doc(getDb(), 'games', gameId), patch);
}

/** First writer wins AI lock for this turn index. */
export async function tryAcquireAiLock(
  gameId: string,
  uid: string,
  turnKey: string,
): Promise<boolean> {
  const ref = doc(getDb(), 'games', gameId);
  return runTransaction(getDb(), async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    const game = snap.data() as OnlineGameDoc;
    if (game.aiLock && game.aiLock !== `${turnKey}:${uid}`) {
      // Another client holds a lock for a different key or same
      if (game.aiLock.startsWith(`${turnKey}:`)) return game.aiLock === `${turnKey}:${uid}`;
    }
    tx.update(ref, { aiLock: `${turnKey}:${uid}` });
    return true;
  });
}

export async function finishOnlineGame(gameId: string, state: GameState, selfUid?: string) {
  await pushGameState(gameId, state, true);
  if (selfUid) await setPlayerStatus(selfUid, 'available', null);
  // Leaderboard wins are credited on the GameOver screen by the winner's client
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
