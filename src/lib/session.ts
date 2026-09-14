import {
  onAuthStateChanged,
  signInAnonymously,
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
const UID_KEY = 'nw_uid';

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

export async function ensureAuthSession(): Promise<User | null> {
  if (!isFirebaseConfigured()) return null;
  const auth = getFirebaseAuth();
  if (auth.currentUser) return auth.currentUser;

  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      async (user) => {
        unsub();
        try {
          if (user) {
            resolve(user);
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
}

export async function loadOrCreatePlayer(uid: string, displayName: string): Promise<PlayerDoc> {
  const ref = doc(getDb(), 'players', uid);
  const snap = await getDoc(ref);
  const now = Date.now();
  if (snap.exists()) {
    const data = snap.data() as PlayerDoc;
    const next: PlayerDoc = {
      ...data,
      displayName: displayName || data.displayName,
      status: data.status === 'in_game' ? 'in_game' : 'available',
      lastSeen: now,
    };
    await updateDoc(ref, {
      displayName: next.displayName,
      status: next.status,
      lastSeen: next.lastSeen,
    });
    storeDisplayName(next.displayName);
    try {
      localStorage.setItem(UID_KEY, uid);
    } catch {
      /* ignore */
    }
    return next;
  }

  const created: PlayerDoc = {
    displayName,
    status: 'available',
    lastSeen: now,
    currentGameId: null,
    superpowerWins: 0,
  };
  await setDoc(ref, { ...created, createdAt: serverTimestamp() });
  storeDisplayName(displayName);
  try {
    localStorage.setItem(UID_KEY, uid);
  } catch {
    /* ignore */
  }
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
