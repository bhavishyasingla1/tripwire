// Community reports, stored as hashes only.
//
// When someone reports a scam, Tripwire hashes the sender's identifiers
// (domain, email, phone, UPI ID, chat handle) on the device with SHA-256 and
// stores only the hashes in Firestore with a count. When the next person
// checks a message, their identifiers are hashed the same way and looked up.
// Firestore never sees a phone number or email in plain text.
//
// Honest limit: phone numbers are a small space, so a determined attacker who
// already has a list of numbers could test them against the hashes. Tripwire
// only stores the scam sender's identifiers, never the job seeker's.

import { doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { ensureUser, getDb } from './firebase.ts';
import { ledger } from './ledger.ts';
import { extractDomains } from './core/rules.ts';
import type { PatternList } from './core/patterns.ts';

export type IdKind = 'domain' | 'email' | 'phone' | 'upi' | 'handle';

export interface Identifier {
  kind: IdKind;
  value: string;
  hash: string;
}

const SALT = 'tripwire/v1';

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The sender-side identifiers in a message, normalised. */
export function senderIdentifiers(text: string, list: PatternList): { kind: IdKind; value: string }[] {
  const out = new Map<string, { kind: IdKind; value: string }>();
  const add = (kind: IdKind, value: string) => out.set(`${kind}|${value}`, { kind, value });
  for (const d of extractDomains(text)) {
    if (d.from === 'email' && d.local) add('email', `${d.local}@${d.domain}`);
    if (!list.freeMailDomains.includes(d.domain)) add('domain', d.domain);
  }
  for (const m of text.matchAll(/(?:\+91[\s-]?|\b0)?\b([6-9]\d{4}[\s-]?\d{5})\b/g)) add('phone', m[1].replace(/\D/g, ''));
  for (const m of text.matchAll(/\b([A-Za-z0-9._-]{2,}@(?:ok[a-z]+|ybl|ibl|axl|paytm|upi|apl|[a-z]{2,12}))\b(?!\.)/g)) add('upi', m[1].toLowerCase());
  for (const m of text.matchAll(/(?:^|[\s(])@([A-Za-z0-9_]{4,32})\b|\b(?:t\.me|telegram\.me|wa\.me)\/([A-Za-z0-9_+]{3,40})/g)) add('handle', (m[1] ?? m[2]).toLowerCase());
  return [...out.values()];
}

export async function hashIdentifiers(ids: { kind: IdKind; value: string }[]): Promise<Identifier[]> {
  return Promise.all(ids.map(async (i) => ({ ...i, hash: await sha256(`${SALT}|${i.kind}|${i.value}`) })));
}

export interface Lookup {
  /** Highest report count among this message's identifiers. */
  max: number;
  hits: { kind: IdKind; count: number }[];
}

export async function lookupReports(ids: Identifier[]): Promise<Lookup> {
  if (!ids.length) return { max: 0, hits: [] };
  await ensureUser();
  ledger.add({
    where: 'cloud',
    service: 'Firestore (community reports)',
    what: `Looked up ${ids.length} fingerprint(s). Only SHA-256 hashes were sent, not the numbers or addresses.`,
    bytes: ids.length * 64,
    payload: ids.map((i) => `${i.kind}: ${i.hash}`).join('\n'),
  });
  const db = getDb();
  const snaps = await Promise.all(ids.map((i) => getDoc(doc(db, 'reports', i.hash)).catch(() => null)));
  const hits = snaps
    .map((s, idx) => ({ kind: ids[idx].kind, count: s?.exists() ? Number(s.data().count) || 0 : 0 }))
    .filter((h) => h.count > 0);
  return { max: Math.max(0, ...hits.map((h) => h.count)), hits };
}

/** Add one report per identifier, at most once per anonymous user. */
export async function reportScam(ids: Identifier[]): Promise<number> {
  if (!ids.length) return 0;
  const user = await ensureUser();
  const db = getDb();
  ledger.add({
    where: 'cloud',
    service: 'Firestore (community reports)',
    what: `Reported ${ids.length} fingerprint(s) as a scam. Hashes only.`,
    bytes: ids.length * 64,
    payload: ids.map((i) => `${i.kind}: ${i.hash}`).join('\n'),
  });
  let added = 0;
  for (const id of ids) {
    const ref = doc(db, 'reports', id.hash);
    const mine = doc(db, 'reports', id.hash, 'by', user.uid);
    try {
      await runTransaction(db, async (tx) => {
        const already = await tx.get(mine);
        if (already.exists()) return;
        const cur = await tx.get(ref);
        tx.set(mine, { at: serverTimestamp() });
        if (cur.exists()) tx.update(ref, { count: (Number(cur.data().count) || 0) + 1, lastAt: serverTimestamp() });
        else tx.set(ref, { count: 1, kind: id.kind, lastAt: serverTimestamp() });
        added++;
      });
    } catch (e) {
      console.warn('report failed', e);
    }
  }
  return added;
}
