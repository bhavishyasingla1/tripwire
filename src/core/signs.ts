// The warning signs Tripwire looks for. The same enum is used by the local
// pattern engine, by Gemini Nano's structured output and by the score.

export const SIGNS = [
  'FEE_OR_DEPOSIT',
  'OFF_PLATFORM_CHAT',
  'FREE_MAIL_OR_LOOKALIKE',
  'PAY_TOO_GOOD',
  'TASK_PAYMENTS',
  'URGENCY_PRESSURE',
  'EARLY_ID_OR_BANK',
  'NO_INTERVIEW',
] as const;

export type Sign = (typeof SIGNS)[number];

export interface SignInfo {
  title: string;
  /** One sentence the job seeker reads under the title. */
  why: string;
  /** Short definition given to Gemini Nano. */
  forModel: string;
}

export const SIGN_INFO: Record<Sign, SignInfo> = {
  FEE_OR_DEPOSIT: {
    title: 'Asks you to pay',
    why: 'Real employers pay you. A "registration fee", "refundable deposit", training kit or laptop charge is the most common sign of a fake job.',
    forModel: 'asks the candidate to pay (fee, deposit, kit, prepaid task)',
  },
  OFF_PLATFORM_CHAT: {
    title: 'Moves you to Telegram or WhatsApp',
    why: 'Scammers move the chat to apps where they cannot be traced or reported. Real recruiters keep hiring on official email or the job site.',
    forModel: 'moves the chat to Telegram or WhatsApp',
  },
  FREE_MAIL_OR_LOOKALIKE: {
    title: 'Free email or look-alike website',
    why: 'Large companies write from their own domain. Gmail addresses or sites like "amazon-careers-hr.in" pretend to be them.',
    forModel: 'gmail/yahoo address or a fake company website',
  },
  PAY_TOO_GOOD: {
    title: 'Pay too good for the work',
    why: 'Very high pay for little work or no experience is bait. Compare it with what the same role pays on trusted job sites.',
    forModel: 'high pay for little work or no experience',
  },
  TASK_PAYMENTS: {
    title: 'Paid "tasks" like likes or reviews',
    why: 'Task scams pay a little at first for liking videos or rating products, then ask you to "invest" in prepaid tasks you never get back.',
    forModel: 'paid per like, review, rating or online task',
  },
  URGENCY_PRESSURE: {
    title: 'Pressure to act now',
    why: 'Deadlines like "within 24 hours" or "limited seats" are there to stop you checking.',
    forModel: 'deadline or pressure to act fast',
  },
  EARLY_ID_OR_BANK: {
    title: 'Wants ID or bank details early',
    why: 'Aadhaar, PAN, bank details or OTPs before a signed offer can be used for loans, SIM swaps or mule accounts in your name.',
    forModel: 'asks Aadhaar, PAN, bank details or OTP',
  },
  NO_INTERVIEW: {
    title: 'Hired without an interview',
    why: 'Selection with no interview or test usually means the "job" is not the real product.',
    forModel: 'hired without interview or test',
  },
};

/** Weight of each sign in the risk score (0–100, combined with noisy-OR). */
export const DEFAULT_WEIGHTS: Record<Sign, number> = {
  FEE_OR_DEPOSIT: 55,
  OFF_PLATFORM_CHAT: 25,
  FREE_MAIL_OR_LOOKALIKE: 30,
  PAY_TOO_GOOD: 25,
  TASK_PAYMENTS: 45,
  URGENCY_PRESSURE: 15,
  EARLY_ID_OR_BANK: 30,
  NO_INTERVIEW: 20,
};

export function isSign(x: unknown): x is Sign {
  return typeof x === 'string' && (SIGNS as readonly string[]).includes(x);
}
