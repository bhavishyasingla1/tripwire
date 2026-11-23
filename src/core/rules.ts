// Local, instant checks that need no model: the Remote Config pattern list,
// sender-domain checks and quote verification for Gemini Nano's answers.

import type { PatternList } from './patterns.ts';
import type { Sign } from './signs.ts';

export interface Finding {
  sign: Sign;
  quote: string;
  start: number;
  end: number;
  by: 'pattern' | 'nano' | 'domain';
  /** Extra explanation, e.g. which brand a domain imitates. */
  note?: string;
}

export function runPatterns(text: string, list: PatternList): Finding[] {
  const out: Finding[] = [];
  for (const rule of list.rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.re, 'gi');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 20) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({ sign: rule.sign, quote: m[0], start: m.index, end: m.index + m[0].length, by: 'pattern' });
    }
  }
  return dedupe(out);
}

/** Domains the message points to: email domains and link hosts. */
export function extractDomains(text: string): { domain: string; from: 'email' | 'link'; local?: string; start: number; end: number }[] {
  const out: { domain: string; from: 'email' | 'link'; local?: string; start: number; end: number }[] = [];
  const email = /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = email.exec(text))) out.push({ domain: m[2].toLowerCase(), from: 'email', local: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length });
  const link = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[\/\s,)]|$)/gi;
  while ((m = link.exec(text))) {
    const before = text[m.index - 1];
    if (before === '@' || before === '.') continue;
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (/^(rs|no|e\.g|i\.e|pvt|ltd)\./.test(host) || /^\d/.test(host)) continue;
    out.push({ domain: host, from: 'link', start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** example.co.in → example; careers.example.com → example */
export function registrableLabel(domain: string): string {
  const parts = domain.toLowerCase().split('.');
  const twoPartTlds = new Set(['co.in', 'org.in', 'net.in', 'gov.in', 'ac.in', 'co.uk', 'org.uk', 'com.au', 'co.jp']);
  const lastTwo = parts.slice(-2).join('.');
  const idx = twoPartTlds.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  return parts[Math.max(0, idx)] ?? domain;
}

export function isSubdomainOf(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith('.' + parent);
}

export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

function brandToken(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface DomainVerdict {
  domain: string;
  kind: 'free-mail' | 'look-alike' | 'official' | 'unknown';
  brand?: string;
}

/** Check every domain in the message against free-mail and brand lists. */
export function checkDomains(text: string, list: PatternList): { findings: Finding[]; verdicts: DomainVerdict[] } {
  const findings: Finding[] = [];
  const verdicts: DomainVerdict[] = [];
  const seen = new Set<string>();
  const lower = text.toLowerCase();
  const mentioned = list.brands.filter((b) => lower.includes(b.name.toLowerCase()) || b.domains.some((d) => lower.includes(registrableLabel(d))));
  for (const d of extractDomains(text)) {
    const official = list.brands.find((b) => b.domains.some((od) => isSubdomainOf(d.domain, od)));
    if (official) {
      if (!seen.has(d.domain)) verdicts.push({ domain: d.domain, kind: 'official', brand: official.name });
      seen.add(d.domain);
      continue;
    }
    if (list.freeMailDomains.includes(d.domain)) {
      const imitated = list.brands.find((b) => d.local && b.domains.some((od) => d.local!.includes(registrableLabel(od))));
      const claimed = imitated ?? mentioned[0];
      findings.push({
        sign: 'FREE_MAIL_OR_LOOKALIKE',
        quote: text.slice(d.start, d.end),
        start: d.start,
        end: d.end,
        by: 'domain',
        note: claimed ? `A free ${d.domain} address, while the message claims to be ${claimed.name}.` : `A free ${d.domain} address, not a company domain.`,
      });
      if (!seen.has(d.domain)) verdicts.push({ domain: d.domain, kind: 'free-mail', brand: claimed?.name });
      seen.add(d.domain);
      continue;
    }
    const label = registrableLabel(d.domain);
    const flat = d.domain.replace(/[^a-z0-9]/g, '');
    const lookalike = list.brands.find((b) =>
      b.domains.some((od) => {
        const ol = registrableLabel(od);
        if (ol.length >= 4 && flat.includes(ol)) return true; // amazon-careers-hr.in
        if (ol.length >= 5 && editDistance(label, ol) <= 1) return true; // infosyss.com
        return brandToken(b.name).length >= 5 && flat.includes(brandToken(b.name));
      }),
    );
    if (lookalike) {
      findings.push({
        sign: 'FREE_MAIL_OR_LOOKALIKE',
        quote: text.slice(d.start, d.end),
        start: d.start,
        end: d.end,
        by: 'domain',
        note: `${d.domain} looks like ${lookalike.name}, but ${lookalike.name}'s own domains are ${lookalike.domains.join(', ')}.`,
      });
      if (!seen.has(d.domain)) verdicts.push({ domain: d.domain, kind: 'look-alike', brand: lookalike.name });
    } else if (!seen.has(d.domain)) {
      verdicts.push({ domain: d.domain, kind: 'unknown' });
    }
    seen.add(d.domain);
  }
  return { findings: dedupe(findings), verdicts };
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/**
 * Find where a model-quoted phrase sits in the text. Exact (case and
 * whitespace-insensitive) first, then a word-window match that needs at least
 * 80% of the quote's words in order. Returns null when the quote is not in the
 * text, so a hallucinated quote is dropped instead of shown.
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = norm(quote).replace(/^["'.\s]+|["'.\s]+$/g, '');
  if (q.length < 3) return null;
  // Map normalised positions back to the original text.
  const words: { w: string; start: number; end: number }[] = [];
  const wre = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = wre.exec(text))) words.push({ w: norm(m[0]).replace(/[^\p{L}\p{N}@₹$]/gu, ''), start: m.index, end: m.index + m[0].length });
  const qw = q.split(' ').map((w) => w.replace(/[^\p{L}\p{N}@₹$]/gu, '')).filter(Boolean);
  if (!qw.length) return null;
  let best: { score: number; i: number; j: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    if (words[i].w !== qw[0] && words[i].w !== qw[1]) continue;
    let qi = 0;
    let hits = 0;
    let j = i;
    for (; j < words.length && j < i + qw.length + 3 && qi < qw.length; j++) {
      if (words[j].w === qw[qi]) {
        hits++;
        qi++;
      } else if (qi + 1 < qw.length && words[j].w === qw[qi + 1]) {
        hits++;
        qi += 2;
      }
    }
    const score = hits / qw.length;
    if (!best || score > best.score) best = { score, i, j: j - 1 };
    if (score === 1) break;
  }
  if (!best || best.score < 0.8) return null;
  return { start: words[best.i].start, end: words[best.j].end };
}

/**
 * Keep one finding per sign+position per kind of check, so a sign confirmed by
 * both a local check and Gemini keeps both sources (that raises its weight).
 */
export function dedupe(findings: Finding[]): Finding[] {
  const out: Finding[] = [];
  const cls = (f: Finding) => (f.by === 'nano' ? 'nano' : 'local');
  for (const f of findings) {
    const dup = out.find((o) => o.sign === f.sign && cls(o) === cls(f) && f.start < o.end && o.start < f.end);
    if (!dup) out.push(f);
  }
  return out;
}
