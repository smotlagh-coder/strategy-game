import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  signOut,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getDb, getFirebaseAuth, isFirebaseConfigured } from './firebase';
import type { PlayerDoc, PlayerStatus } from '../types';

const NAME_KEY = 'nw_display_name';
const CLIENT_ID_KEY = 'nw_client_id';
const AUTH_UID_KEY = 'nw_auth_uid';

function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `nw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Stable per-browser-profile id (not shared across Chrome vs Safari, etc.). */
export function getOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const id = randomUuid();
    localStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return randomUuid();
  }
}

/** Short tag from Firebase uid — unique even when display names match. */
export function shortPlayerId(uid: string): string {
  const cleaned = uid.replace(/[^a-zA-Z0-9]/g, '');
  return (cleaned.slice(-6) || uid.slice(0, 6)).toUpperCase();
}

/** UI / lobby label: "Kian · A1B2C3" */
export function formatPlayerLabel(displayName: string, uid: string): string {
  const base = displayName.trim() || 'Commander';
  return `${base} · ${shortPlayerId(uid)}`;
}

export function getStoredDisplayName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function storeDisplayName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

/**
 * Anonymous Firebase Auth is the network identity (Firestore rules use auth.uid).
 * Persistence is local-only so each browser profile keeps its own user.
 */
export async function ensureAuthSession(): Promise<User | null> {
  if (!isFirebaseConfigured()) return null;
  const auth = getFirebaseAuth();
  const clientId = getOrCreateClientId();

  await setPersistence(auth, browserLocalPersistence);

  const user = await new Promise<User | null>((resolve, reject) => {
    if (auth.currentUser) {
      resolve(auth.currentUser);
      return;
    }
    const unsub = onAuthStateChanged(
      auth,
      async (u) => {
        unsub();
        try {
          if (u) {
            resolve(u);
            return;
          }
          const cred = await signInAnonymously(auth);
          resolve(cred.user);
        } catch (err) {
          reject(err);
        }
      },
      reject,
    );
  });

  if (!user) return null;

  try {
    const boundUid = localStorage.getItem(AUTH_UID_KEY);
    // First bind for this browser profile
    if (!boundUid) {
      localStorage.setItem(AUTH_UID_KEY, user.uid);
      localStorage.setItem(CLIENT_ID_KEY, clientId);
      return user;
    }
    // Same profile should keep the same auth user
    if (boundUid === user.uid) return user;

    // Auth drifted (cleared IndexedDB, etc.) — re-bind to current user
    localStorage.setItem(AUTH_UID_KEY, user.uid);
  } catch {
    /* ignore */
  }

  return user;
}

/** Sign out and create a fresh anonymous identity (new uid) for this browser. */
export async function resetPlayerIdentity(): Promise<User | null> {
  if (!isFirebaseConfigured()) return null;
  const auth = getFirebaseAuth();
  await setPersistence(auth, browserLocalPersistence);
  try {
    await signOut(auth);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(AUTH_UID_KEY);
    localStorage.setItem(CLIENT_ID_KEY, randomUuid());
  } catch {
    /* ignore */
  }
  const cred = await signInAnonymously(auth);
  try {
    localStorage.setItem(AUTH_UID_KEY, cred.user.uid);
  } catch {
    /* ignore */
  }
  return cred.user;
}

export async function loadOrCreatePlayer(uid: string, displayName: string): Promise<PlayerDoc> {
  const ref = doc(getDb(), 'players', uid);
  const snap = await getDoc(ref);
  const now = Date.now();
  const clientId = getOrCreateClientId();
  if (snap.exists()) {
    const data = snap.data() as PlayerDoc;
    const next: PlayerDoc = {
      ...data,
      displayName: displayName || data.displayName,
      clientId,
      status: data.status === 'in_game' ? 'in_game' : 'available',
      lastSeen: now,
    };
    await updateDoc(ref, {
      displayName: next.displayName,
      clientId,
      status: next.status,
      lastSeen: next.lastSeen,
    });
    storeDisplayName(next.displayName);
    return next;
  }

  const created: PlayerDoc = {
    displayName,
    clientId,
    status: 'available',
    lastSeen: now,
    currentGameId: null,
    superpowerWins: 0,
  };
  await setDoc(ref, { ...created, createdAt: serverTimestamp() });
  storeDisplayName(displayName);
  return created;
}

export async function setPlayerStatus(
  uid: string,
  status: PlayerStatus,
  currentGameId: string | null = null,
) {
  if (!isFirebaseConfigured()) return;
  const ref = doc(getDb(), 'players', uid);
  await updateDoc(ref, {
    status,
    currentGameId,
    lastSeen: Date.now(),
  });
}

export async function heartbeat(uid: string, status: PlayerStatus) {
  if (!isFirebaseConfigured()) return;
  const ref = doc(getDb(), 'players', uid);
  await updateDoc(ref, { lastSeen: Date.now(), status });
}
