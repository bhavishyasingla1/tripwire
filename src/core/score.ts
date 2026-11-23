// The risk score is computed in code from the signs that were found, not
// asked from a model, so it is stable, explainable and the same on every
// device. Each sign adds its weight with a noisy-OR:
//   risk = 1 - Π (1 - w_i)
// A sign confirmed by two independent checks (pattern + Gemini Nano) counts in
// full; a sign seen by only one counts at 80%.

import type { Finding } from './rules.ts';
import { SIGNS, type Sign } from './signs.ts';

export type Level = 'high' | 'caution' | 'low';

export interface CloudCheck {
  /** Does the sender's domain belong to the company? */
  domainMatch: 'yes' | 'no' | 'unknown';
  /** Public reports of scams using this company's name or this domain. */
  scamReports: 'yes' | 'no' | 'unknown';
  /** Does the company say publicly that it never charges candidates? */
  neverCharges: 'yes' | 'no' | 'unknown';
}

export interface ScoreInput {
  findings: Finding[];
  weights: Record<Sign, number>;
  cloud?: CloudCheck | null;
  communityReports?: number;
  officialDomain?: boolean;
}

export interface ScoreLine {
  label: string;
  weight: number;
}

export interface Score {
  risk: number;
  level: Level;
  signs: Sign[];
  lines: ScoreLine[];
}

export function signStrength(findings: Finding[], sign: Sign): number {
  const by = new Set(findings.filter((f) => f.sign === sign).map((f) => (f.by === 'nano' ? 'nano' : 'local')));
  if (by.size === 0) return 0;
  return by.size >= 2 ? 1 : 0.8;
}

export function computeScore(input: ScoreInput): Score {
  const lines: ScoreLine[] = [];
  const signs: Sign[] = [];
  for (const s of SIGNS) {
    const k = signStrength(input.findings, s);
    if (k > 0) {
      signs.push(s);
      lines.push({ label: s, weight: Math.round(input.weights[s] * k) });
    }
  }
  const c = input.cloud;
  if (c?.domainMatch === 'no') lines.push({ label: 'CLOUD_DOMAIN_MISMATCH', weight: 35 });
  if (c?.scamReports === 'yes') lines.push({ label: 'CLOUD_SCAM_REPORTS', weight: 30 });
  if (c?.neverCharges === 'yes' && signs.includes('FEE_OR_DEPOSIT')) lines.push({ label: 'CLOUD_NEVER_CHARGES', weight: 30 });
  if ((input.communityReports ?? 0) > 0) lines.push({ label: 'COMMUNITY_REPORTS', weight: Math.min(40, 15 + 5 * (input.communityReports ?? 0)) });

  let keep = 1;
  for (const l of lines) keep *= 1 - Math.min(95, Math.max(0, l.weight)) / 100;
  let risk = 1 - keep;
  // A sender on the company's own domain lowers risk, but never hides a fee request.
  if ((input.officialDomain || c?.domainMatch === 'yes') && !signs.includes('FEE_OR_DEPOSIT')) risk *= 0.6;
  const pct = Math.round(risk * 100);
  return { risk: pct, level: levelFor(pct), signs, lines };
}

export function levelFor(risk: number): Level {
  if (risk >= 60) return 'high';
  if (risk >= 25) return 'caution';
  return 'low';
}
