// Finds personal details in a message and blanks them out with stable tokens
// like [PERSON_1] or [PHONE_2]. Runs entirely in the browser. The token map
// never leaves the device; cloud answers are put back together with
// rehydrate().

export type PiiKind =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'UPI'
  | 'AADHAAR'
  | 'PAN'
  | 'IFSC'
  | 'ACCOUNT'
  | 'CARD'
  | 'LINK'
  | 'HANDLE'
  | 'PIN'
  | 'DOB';

export const PII_LABEL: Record<PiiKind, string> = {
  PERSON: 'Name',
  EMAIL: 'Email',
  PHONE: 'Phone',
  UPI: 'UPI ID',
  AADHAAR: 'Aadhaar',
  PAN: 'PAN',
  IFSC: 'IFSC',
  ACCOUNT: 'Account number',
  CARD: 'Card number',
  LINK: 'Link path',
  HANDLE: 'Chat handle',
  PIN: 'PIN code',
  DOB: 'Date of birth',
};

export interface PiiSpan {
  start: number;
  end: number;
  kind: PiiKind;
  value: string;
  /** Where the span came from: a local pattern or Gemini Nano. */
  by: 'pattern' | 'nano';
}

export interface Redaction {
  text: string;
  /** token → original value. Stays on the device. */
  map: Record<string, string>;
  spans: (PiiSpan & { token: string })[];
}

const NAME_STOP = new Set(
  [
    'candidate', 'applicant', 'sir', 'madam', 'maam', 'team', 'all', 'hiring', 'hr', 'recruiter', 'there', 'friend', 'dear',
    'user', 'customer', 'congratulations', 'greetings', 'good', 'morning', 'evening', 'afternoon', 'regards', 'thanks',
    'manager', 'department', 'officer', 'executive', 'the', 'we', 'you', 'your', 'our', 'job', 'jobs', 'work', 'home',
    'amazon', 'google', 'telegram', 'whatsapp', 'linkedin', 'naukri', 'india', 'pvt', 'ltd', 'limited', 'private',
  ],
);

const NAME = "([A-Z][a-z]+(?:[ ][A-Z][a-z]+){0,2})";
const NAME_CUES: RegExp[] = [
  new RegExp(`\\b(?:Dear|Hi|Hello|Hey|Mr\\.?|Mrs\\.?|Ms\\.?|Miss|Dr\\.?|Shri|Smt\\.?)\\s+${NAME}`, 'g'),
  new RegExp(`\\b(?:I am|I'm|my name is|My name is)\\s+${NAME}`, 'g'),
  new RegExp(`\\b(?:HR|Recruiter|Manager|Coordinator)[:\\s-]+${NAME}`, 'g'),
  new RegExp(`(?:Regards|Thanks|Thank you|Sincerely|Best|Warm regards)[,.!]?\\s*\\n\\s*${NAME}`, 'g'),
  new RegExp(`(?:Name)\\s*[:\\-]\\s*${NAME}`, 'g'),
];

interface Finder {
  kind: PiiKind;
  re: RegExp;
  /** Which capture group is the personal part (default: whole match). */
  group?: number;
}

// Order matters: earlier finders win when spans overlap.
const FINDERS: Finder[] = [
  // Email: blank the local part, keep the domain (the domain is evidence).
  { kind: 'EMAIL', re: /\b([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, group: 1 },
  // UPI: handle@bank with no dot in the bank part. Keep the bank handle.
  { kind: 'UPI', re: /\b([A-Za-z0-9._-]{2,})@(?:ok[a-z]+|ybl|ibl|axl|paytm|upi|apl|yapl|ptyes|ptaxis|pthdfc|ptsbi|[a-z]{2,12})\b(?!\.)/g, group: 1 },
  // Links: keep scheme + host, blank path and query (they can carry IDs).
  { kind: 'LINK', re: /\bhttps?:\/\/[^\s/]+(\/[^\s)]+)/g, group: 1 },
  { kind: 'CARD', re: /\b(?:\d{4}[ -]){3}\d{4}\b/g },
  { kind: 'AADHAAR', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: 'IFSC', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  // Phones: Indian mobiles with or without +91, and other +CC numbers. Keep the country code.
  { kind: 'PHONE', re: /(?:\+91[\s-]?|\b0)?\b([6-9]\d{4}[\s-]?\d{5})\b/g, group: 1 },
  { kind: 'PHONE', re: /\+\d{1,3}[\s-]?(\(?\d{2,4}\)?(?:[\s-]?\d{2,4}){2,4})\b/g, group: 1 },
  { kind: 'ACCOUNT', re: /\b(?:a\/c|acct|account)(?:\s*(?:no\.?|number|#))?\s*[:\-]?\s*(\d{9,18})\b/gi, group: 1 },
  { kind: 'ACCOUNT', re: /\b\d{11,18}\b/g },
  { kind: 'HANDLE', re: /(?:^|[\s(])@([A-Za-z0-9_]{4,32})\b/g, group: 1 },
  { kind: 'HANDLE', re: /\b(?:t\.me|wa\.me|telegram\.me)\/([A-Za-z0-9_+]{3,40})/g, group: 1 },
  { kind: 'PIN', re: /\b(?:pin(?:\s*code)?|pincode)\s*[:\-]?\s*([1-9]\d{5})\b/gi, group: 1 },
  { kind: 'DOB', re: /\b(?:dob|d\.o\.b\.?|date of birth)\s*[:\-]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/gi, group: 1 },
];

function spanFromMatch(m: RegExpExecArray, f: Finder): PiiSpan | null {
  const g = f.group ?? 0;
  const value = m[g];
  if (!value) return null;
  const offset = g === 0 ? 0 : m[0].indexOf(value);
  const start = m.index + offset;
  return { start, end: start + value.length, kind: f.kind, value, by: 'pattern' };
}

/** Names found from greeting/sign-off cues ("Dear Asha", "I am Rohan"). */
export function findNameCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const re of NAME_CUES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const words = m[1].split(' ').filter((w) => !NAME_STOP.has(w.toLowerCase()));
      // Stop at the first stop word so "Rohan From" or "Priya Sharma Team" trims cleanly.
      const kept: string[] = [];
      for (const w of m[1].split(' ')) {
        if (NAME_STOP.has(w.toLowerCase())) break;
        kept.push(w);
      }
      if (kept.length && words.length) out.add(kept.join(' '));
    }
  }
  return [...out];
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Spans for every occurrence of each name, and of each part of a multi-word name. */
function nameSpans(text: string, names: string[], by: PiiSpan['by']): PiiSpan[] {
  const spans: PiiSpan[] = [];
  const variants = new Set<string>();
  for (const raw of names) {
    const n = raw.trim();
    if (n.length < 2 || NAME_STOP.has(n.toLowerCase())) continue;
    variants.add(n);
    for (const part of n.split(/\s+/)) if (part.length >= 3 && !NAME_STOP.has(part.toLowerCase())) variants.add(part);
  }
  // Longest first so "Priya Sharma" wins over "Priya".
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${escapeRe(v)}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) spans.push({ start: m.index, end: m.index + v.length, kind: 'PERSON', value: v, by });
  }
  return spans;
}

/**
 * Find personal details. `nanoNames` are names Gemini Nano spotted; only names
 * that actually appear in the text are used.
 */
export function detectPii(text: string, nanoNames: string[] = []): PiiSpan[] {
  const all: PiiSpan[] = [];
  for (const f of FINDERS) {
    f.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = f.re.exec(text))) {
      const s = spanFromMatch(m, f);
      if (s) all.push(s);
      if (m[0].length === 0) f.re.lastIndex++;
    }
  }
  all.push(...nameSpans(text, findNameCandidates(text), 'pattern'));
  const verifiedNano = nanoNames.filter((n) => typeof n === 'string' && n.trim().length >= 2 && text.includes(n.trim()));
  all.push(...nameSpans(text, verifiedNano, 'nano'));

  // Resolve overlaps: earlier start wins, then longer span.
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: PiiSpan[] = [];
  let lastEnd = -1;
  for (const s of all) {
    if (s.start >= lastEnd) {
      kept.push(s);
      lastEnd = s.end;
    }
  }
  return kept;
}

export function redact(text: string, spans: PiiSpan[]): Redaction {
  const map: Record<string, string> = {};
  const byValue = new Map<string, string>();
  const counters: Partial<Record<PiiKind, number>> = {};
  const out: Redaction['spans'] = [];
  let result = '';
  let cursor = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const key = `${s.kind}:${s.value.toLowerCase()}`;
    let token = byValue.get(key);
    if (!token) {
      counters[s.kind] = (counters[s.kind] ?? 0) + 1;
      token = `[${s.kind}_${counters[s.kind]}]`;
      byValue.set(key, token);
      map[token] = s.value;
    }
    result += text.slice(cursor, s.start) + token;
    cursor = s.end;
    out.push({ ...s, token });
  }
  result += text.slice(cursor);
  return { text: result, map, spans: out };
}

/** Put real values back into text that came from the cloud. Runs locally. */
export function rehydrate(text: string, map: Record<string, string>): string {
  let out = text;
  for (const [token, value] of Object.entries(map)) {
    const bare = token.slice(1, -1);
    out = out.split(token).join(value);
    out = out.replace(new RegExp(`\\b${escapeRe(bare)}\\b`, 'g'), value);
  }
  return out;
}

/**
 * Blank a piece of the message (e.g. a flagged quote) with the same tokens as
 * the full redaction, so the cloud sees consistent [PERSON_1] etc.
 */
export function applyMap(text: string, map: Record<string, string>): string {
  let out = text;
  const pairs = Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  for (const [token, value] of pairs) {
    if (value.length < 2) continue;
    out = out.replace(new RegExp(/^\w/.test(value) ? `\\b${escapeRe(value)}\\b` : escapeRe(value), 'g'), token);
  }
  // Anything a pattern still catches (e.g. a number not in the full map) is blanked too.
  const left = detectPii(out).sort((a, b) => b.start - a.start);
  for (const s of left) out = out.slice(0, s.start) + `[${s.kind}]` + out.slice(s.end);
  return out;
}

/** Convenience: detect + redact in one call. */
export function redactText(text: string, nanoNames: string[] = []): Redaction {
  return redact(text, detectPii(text, nanoNames));
}
