import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { initializeFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

/** Named Native-mode DB — required when project default DB is Datastore mode */
const firestoreDatabaseId =
  (import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE as string | undefined) || 'nuclear-war';

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured. Set VITE_FIREBASE_* env vars.');
  }
  if (!app) app = initializeApp(firebaseConfig);
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!auth) auth = getAuth(getFirebaseApp());
  return auth;
}

export function getDb(): Firestore {
  if (!db) {
    // Streaming connections get buffered by some proxies, VPNs and Safari, which
    // delays live updates (like invites) by many seconds. Auto-detect falls back
    // to long polling on those networks and stays on streaming everywhere else.
    db = initializeFirestore(
      getFirebaseApp(),
      { experimentalAutoDetectLongPolling: true },
      firestoreDatabaseId,
    );
  }
  return db;
}
