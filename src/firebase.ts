// Firebase setup: App Check, Anonymous Auth, Remote Config and Firestore.
// Firebase AI Logic lives in ai.ts.

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, signInAnonymously, type User } from 'firebase/auth';
import { getRemoteConfig, fetchAndActivate, getValue, type RemoteConfig } from 'firebase/remote-config';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { DEFAULT_PATTERNS, parsePatternList, type PatternList } from './core/patterns.ts';
import { ledger } from './ledger.ts';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

export const DEFAULT_CLOUD_MODEL = 'gemini-3.5-flash-lite';
/** Tried in order when the main model is busy (free-tier 500/503). */
export const DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-flash-lite-latest'];

let app: FirebaseApp | null = null;
let appCheck: AppCheck | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (app) return app;
  app = initializeApp(config);
  // App Check guards every Firebase AI Logic call. In local development a debug
  // token is used (set VITE_APPCHECK_DEBUG=true and register the token printed
  // in the console under App Check > Manage debug tokens).
  if (import.meta.env.VITE_APPCHECK_DEBUG === 'true') {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
  }
  const siteKey = import.meta.env.VITE_RECAPTCHA_ENTERPRISE_KEY;
  if (siteKey || import.meta.env.VITE_APPCHECK_DEBUG === 'true') {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey || 'debug'),
      isTokenAutoRefreshEnabled: true,
    });
  }
  return app;
}

export function hasAppCheck() {
  return appCheck !== null;
}

// ---------- Anonymous Auth ----------

let userPromise: Promise<User> | null = null;

/** Signs in anonymously once; needed for Firestore community reports. */
export function ensureUser(): Promise<User> {
  if (!userPromise) {
    const auth = getAuth(getFirebaseApp());
    userPromise = (auth.currentUser ? Promise.resolve(auth.currentUser) : signInAnonymously(auth).then((c) => c.user)).then((u) => {
      ledger.add({
        where: 'cloud',
        service: 'Firebase Auth',
        what: 'Anonymous sign-in. No name, email or phone.',
        bytes: 0,
        payload: `uid: ${u.uid.slice(0, 6)}… (random, anonymous)`,
      });
      return u;
    });
    userPromise.catch(() => (userPromise = null));
  }
  return userPromise;
}

// ---------- Remote Config ----------

let rc: RemoteConfig | null = null;

export interface LiveConfig {
  patterns: PatternList;
  cloudModel: string;
  fallbackModels: string[];
  /** Google Search grounding needs a billing-enabled project; switched on in Remote Config. */
  grounding: boolean;
  source: 'remote' | 'default';
}

let live: LiveConfig = { patterns: DEFAULT_PATTERNS, cloudModel: DEFAULT_CLOUD_MODEL, fallbackModels: DEFAULT_FALLBACK_MODELS, grounding: false, source: 'default' };

export function getLiveConfig(): LiveConfig {
  return live;
}

/** Fetch the weekly scam-pattern list and the cloud model name. */
export async function loadRemoteConfig(): Promise<LiveConfig> {
  if (!firebaseConfigured) return live;
  try {
    rc = getRemoteConfig(getFirebaseApp());
    rc.settings.minimumFetchIntervalMillis = import.meta.env.DEV ? 60_000 : 3_600_000;
    rc.defaultConfig = {
      scam_patterns: JSON.stringify(DEFAULT_PATTERNS),
      cloud_model: DEFAULT_CLOUD_MODEL,
      search_grounding: false,
      cloud_fallback_models: JSON.stringify(DEFAULT_FALLBACK_MODELS),
    };
    await fetchAndActivate(rc);
    const patternsValue = getValue(rc, 'scam_patterns');
    const patterns = parsePatternList(patternsValue.asString());
    const cloudModel = getValue(rc, 'cloud_model').asString() || DEFAULT_CLOUD_MODEL;
    const grounding = getValue(rc, 'search_grounding').asBoolean();
    let fallbackModels = DEFAULT_FALLBACK_MODELS;
    try {
      const f = JSON.parse(getValue(rc, 'cloud_fallback_models').asString()) as unknown;
      if (Array.isArray(f) && f.every((x) => typeof x === 'string')) fallbackModels = f.slice(0, 4);
    } catch {
      /* keep defaults */
    }
    live = { patterns, cloudModel, fallbackModels, grounding, source: patternsValue.getSource() === 'remote' ? 'remote' : 'default' };
    ledger.add({
      where: 'cloud',
      service: 'Remote Config',
      what: `Downloaded scam-pattern list ${patterns.version}. Nothing about you was sent.`,
      bytes: 0,
      payload: '(download only)',
      direction: 'in',
    });
  } catch (e) {
    console.warn('Remote Config unavailable, using built-in patterns', e);
  }
  return live;
}

// ---------- Firestore ----------

let db: Firestore | null = null;
export function getDb(): Firestore {
  if (!db) db = getFirestore(getFirebaseApp());
  return db;
}
