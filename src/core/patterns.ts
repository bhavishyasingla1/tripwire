// The scam-pattern list. These defaults ship with the app; the live list is
// fetched from Firebase Remote Config (key `scam_patterns`) so it can be
// updated weekly without a release. Remote Config values are validated by
// parsePatternList before use.

import { DEFAULT_WEIGHTS, isSign, type Sign } from './signs.ts';

export interface PatternRule {
  sign: Sign;
  /** JavaScript regular expression source, matched case-insensitively. */
  re: string;
}

export interface Brand {
  name: string;
  /** Official registrable domains (no subdomains). */
  domains: string[];
}

export interface PatternList {
  version: string;
  weights: Record<Sign, number>;
  rules: PatternRule[];
  freeMailDomains: string[];
  brands: Brand[];
}

export const DEFAULT_PATTERNS: PatternList = {
  version: '2026-11-23',
  weights: DEFAULT_WEIGHTS,
  rules: [
    // Money asked from the candidate
    { sign: 'FEE_OR_DEPOSIT', re: '\\b(registration|joining|processing|onboarding|training|verification|security|kit|laptop|document(ation)?|interview|visa)\\s+(fee|fees|charge|charges|amount|deposit)\\b' },
    { sign: 'FEE_OR_DEPOSIT', re: '\\brefundable\\s+(fee|deposit|amount)\\b' },
    { sign: 'FEE_OR_DEPOSIT', re: '\\b(pay|deposit|transfer|send)\\s+(rs\\.?|inr|₹|\\$|usd)?\\s?[\\d,]+' },
    { sign: 'FEE_OR_DEPOSIT', re: '\\b(prepaid|pre-paid|recharge)\\s+(task|tasks|order|orders)\\b' },
    // Chat moved off the hiring platform
    { sign: 'OFF_PLATFORM_CHAT', re: '\\b(telegram|whats\\s?app|signal app|t\\.me/|wa\\.me/)' },
    // Paid micro-tasks
    { sign: 'TASK_PAYMENTS', re: '\\b(per|each)\\s+(like|review|rating|task|subscribe|follow|video)\\b' },
    { sign: 'TASK_PAYMENTS', re: '\\b(like|rate|review|subscribe to)\\s+(youtube|google|hotel|product|movie|video|map)s?\\b' },
    // Pressure
    { sign: 'URGENCY_PRESSURE', re: '\\b(within|in)\\s+(\\d+|24|48|few)\\s*(hours?|hrs?|minutes?|mins?)\\b' },
    { sign: 'URGENCY_PRESSURE', re: '\\b(limited\\s+(seats|slots|vacancies|positions)|offer\\s+(will\\s+be|is)\\s+(cancelled|canceled|withdrawn)|urgent(ly)?\\s+(joining|reply|requirement)|reply\\s+(today|immediately|asap))\\b' },
    // ID and bank details
    { sign: 'EARLY_ID_OR_BANK', re: '\\b(aadhaar|aadhar|pan\\s*card|pan\\s+number|passport\\s+(copy|number)|bank\\s+(details|account|statement|passbook)|cancel(l)?ed\\s+cheque|upi\\s+pin|otp|cvv|atm\\s+card)\\b' },
    // No interview
    { sign: 'NO_INTERVIEW', re: '\\b(no|without)\\s+(interview|test|experience\\s+and\\s+interview)\\b' },
    { sign: 'NO_INTERVIEW', re: '\\b(you\\s+(are|have\\s+been)\\s+(selected|shortlisted|hired))\\b' },
    // Pay
    { sign: 'PAY_TOO_GOOD', re: '\\b(daily|per\\s+day)\\s+(income|earning|earnings|payment|salary)\\b' },
    { sign: 'PAY_TOO_GOOD', re: '\\bearn\\s+(rs\\.?|inr|₹|\\$)?\\s?[\\d,]+\\s*(-|to)?\\s*[\\d,]*\\s*(per|a|every|daily|/)\\s*(day|hour|hr)\\b' },
  ],
  freeMailDomains: [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'outlook.com', 'hotmail.com',
    'live.com', 'msn.com', 'rediffmail.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
    'zoho.com', 'zohomail.in', 'gmx.com', 'mail.com', 'yandex.com', 'tutanota.com',
  ],
  brands: [
    { name: 'Amazon', domains: ['amazon.com', 'amazon.in', 'amazon.jobs'] },
    { name: 'Flipkart', domains: ['flipkart.com'] },
    { name: 'Google', domains: ['google.com'] },
    { name: 'Microsoft', domains: ['microsoft.com'] },
    { name: 'Tata Consultancy Services', domains: ['tcs.com'] },
    { name: 'Infosys', domains: ['infosys.com'] },
    { name: 'Wipro', domains: ['wipro.com'] },
    { name: 'HCLTech', domains: ['hcltech.com', 'hcl.com'] },
    { name: 'Tech Mahindra', domains: ['techmahindra.com'] },
    { name: 'Accenture', domains: ['accenture.com'] },
    { name: 'Deloitte', domains: ['deloitte.com'] },
    { name: 'Cognizant', domains: ['cognizant.com'] },
    { name: 'Capgemini', domains: ['capgemini.com'] },
    { name: 'IBM', domains: ['ibm.com'] },
    { name: 'Reliance', domains: ['ril.com', 'jio.com'] },
    { name: 'Swiggy', domains: ['swiggy.in', 'swiggy.com'] },
    { name: 'Zomato', domains: ['zomato.com'] },
    { name: 'Meesho', domains: ['meesho.com'] },
    { name: 'Paytm', domains: ['paytm.com'] },
    { name: 'Airtel', domains: ['airtel.com', 'airtel.in'] },
    { name: 'LinkedIn', domains: ['linkedin.com'] },
    { name: 'Naukri', domains: ['naukri.com', 'infoedge.in'] },
  ],
};

/**
 * Validate a pattern list fetched from Remote Config. Anything malformed falls
 * back to the defaults, so a bad publish can never break the app.
 */
export function parsePatternList(raw: string | null | undefined): PatternList {
  if (!raw) return DEFAULT_PATTERNS;
  try {
    const p = JSON.parse(raw) as Partial<PatternList>;
    const rules = Array.isArray(p.rules)
      ? p.rules.filter((r): r is PatternRule => {
          if (!r || !isSign(r.sign) || typeof r.re !== 'string' || r.re.length > 400) return false;
          try {
            new RegExp(r.re, 'i');
            return true;
          } catch {
            return false;
          }
        })
      : [];
    const weights = { ...DEFAULT_WEIGHTS };
    if (p.weights && typeof p.weights === 'object') {
      for (const [k, v] of Object.entries(p.weights)) {
        if (isSign(k) && typeof v === 'number' && v >= 0 && v <= 95) weights[k] = v;
      }
    }
    const strings = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : []);
    const brands = Array.isArray(p.brands)
      ? p.brands
          .filter((b): b is Brand => !!b && typeof b.name === 'string' && Array.isArray(b.domains))
          .map((b) => ({ name: b.name, domains: strings(b.domains) }))
      : [];
    if (!rules.length) return DEFAULT_PATTERNS;
    return {
      version: typeof p.version === 'string' ? p.version.slice(0, 40) : 'remote',
      weights,
      rules,
      freeMailDomains: strings(p.freeMailDomains).length ? strings(p.freeMailDomains) : DEFAULT_PATTERNS.freeMailDomains,
      brands: brands.length ? brands : DEFAULT_PATTERNS.brands,
    };
  } catch {
    return DEFAULT_PATTERNS;
  }
}
