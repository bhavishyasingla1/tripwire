// Firebase AI Logic: hybrid inference.
//
// 1. readMessage(): PREFER_ON_DEVICE. Gemini Nano reads the raw message on this
//    device and returns warning signs, quotes and names as structured JSON.
//    Redaction-gated fallback: if Nano is not ready, the SDK would route to
//    cloud Gemini, so Tripwire blanks personal details first and only the
//    redacted copy is sent.
// 2. checkCompany(): cloud only (grounding is not available on-device). Gets
//    the company name, domains and flagged, already-redacted quotes, and checks
//    them with Google Search grounding.

import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  Schema,
  type AI,
  type GenerativeModel,
  type GroundingMetadata,
  type Part,
} from 'firebase/ai';
import { getFirebaseApp, getLiveConfig } from './firebase.ts';
import { ledger } from './ledger.ts';
import { SIGNS, SIGN_INFO, isSign, type Sign } from './core/signs.ts';
import { redactText, rehydrate, type Redaction } from './core/redact.ts';
import type { CloudCheck } from './core/score.ts';

// ---------- Device status ----------

export type DeviceState = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

const TEXT_IO = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};
const IMAGE_IO = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }, { type: 'image' as const }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};

interface LanguageModelStatic {
  availability(o?: unknown): Promise<string>;
  create(o?: unknown): Promise<{ destroy(): void }>;
}
const LM = () => (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;

export async function deviceState(kind: 'text' | 'image' = 'text'): Promise<DeviceState> {
  const lm = LM();
  if (!lm) return 'unsupported';
  try {
    return (await lm.availability(kind === 'image' ? IMAGE_IO : TEXT_IO)) as DeviceState;
  } catch {
    return 'unavailable';
  }
}

let warmSession: { destroy(): void } | null = null;
/** Load Nano into memory ahead of the first check (only when already downloaded). */
export async function warmUp() {
  const lm = LM();
  if (!lm || warmSession) return;
  if ((await deviceState('text')) !== 'available') return;
  try {
    warmSession = await lm.create(TEXT_IO);
  } catch {
    /* warm-up is best effort */
  }
}

// ---------- Models ----------

let aiInstance: AI | null = null;
const getAi = () => (aiInstance ??= getAI(getFirebaseApp(), { backend: new GoogleAIBackend() }));

// JSON Schema for the Prompt API's responseConstraint (on-device).
const NANO_SCHEMA = (withTranscript: boolean) => ({
  type: 'object',
  properties: {
    ...(withTranscript ? { transcript: { type: 'string' } } : {}),
    findings: {
      type: 'array',
      maxItems: SIGNS.length,
      items: {
        type: 'object',
        properties: { sign: { type: 'string', enum: [...SIGNS] }, quote: { type: 'string', maxLength: 90 } },
        required: ['sign', 'quote'],
      },
    },
    people: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } },
    company: { type: 'string' },
    role: { type: 'string' },
  },
  required: [...(withTranscript ? ['transcript'] : []), 'findings', 'people', 'company', 'role'],
});

// The same shape for cloud Gemini's responseSchema (used only on fallback).
const CLOUD_SCHEMA = (withTranscript: boolean) =>
  Schema.object({
    properties: {
      ...(withTranscript ? { transcript: Schema.string() } : {}),
      findings: Schema.array({
        items: Schema.object({ properties: { sign: Schema.enumString({ enum: [...SIGNS] }), quote: Schema.string() } }),
      }),
      people: Schema.array({ items: Schema.string() }),
      company: Schema.string(),
      role: Schema.string(),
    },
  });

// ---------- Cloud retries ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isBusy = (e: unknown) => /\b(500|502|503|504)\b|high demand|overloaded|unavailable|deadline/i.test(String(e));

/**
 * Run a cloud call, retrying once on a busy model and then moving down the
 * model list from Remote Config. Each re-send is written to the ledger.
 */
async function withCloudModels<T>(bytes: number, payload: string, fn: (model: string) => Promise<T>): Promise<T> {
  const { cloudModel, fallbackModels } = getLiveConfig();
  const list = [...new Set([cloudModel, ...fallbackModels])];
  let last: unknown;
  let first = true;
  for (const model of list) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!first) ledger.add({ where: 'cloud', service: `Retry on ${model}`, what: 'The previous model was busy, so the same blanked text was sent again.', bytes, payload });
      first = false;
      try {
        return await fn(model);
      } catch (e) {
        last = e;
        if (!isBusy(e)) throw e;
        await sleep(attempt === 0 ? 800 : 1800);
      }
    }
  }
  throw last;
}

const models = new Map<string, GenerativeModel>();
function readerModel(kind: 'text' | 'image', cloudModel = getLiveConfig().cloudModel): GenerativeModel {
  const key = `${kind}:${cloudModel}`;
  let m = models.get(key);
  if (!m) {
    m = getGenerativeModel(getAi(), {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: {
        createOptions: kind === 'image' ? IMAGE_IO : TEXT_IO,
        promptOptions: { responseConstraint: NANO_SCHEMA(kind === 'image') },
      },
      inCloudParams: {
        model: cloudModel,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: CLOUD_SCHEMA(kind === 'image'),
        },
      },
    });
    models.set(key, m);
  }
  return m;
}

/** Start the one-time Gemini Nano download. Must be called from a click. */
export async function downloadNano(onProgress: (p: number) => void) {
  await readerModel('text').initializeDeviceModel(onProgress);
}

// ---------- 1. Read the message (hybrid) ----------

export interface ModelFinding {
  sign: Sign;
  quote: string;
}

export interface ReadResult {
  source: 'on_device' | 'in_cloud';
  findings: ModelFinding[];
  people: string[];
  company: string;
  role: string;
  /** For screenshots: the text Nano read from the image. */
  transcript?: string;
  ms: number;
}

// Kept short on purpose: Gemini Nano's time grows with prompt and output length.
export function readerPrompt(text: string | null) {
  const defs = SIGNS.map((s) => `${s}: ${SIGN_INFO[s].forModel}`).join('\n');
  return [
    text === null
      ? 'Copy all text in this screenshot into "transcript". Then find job-scam warning signs in that text.'
      : 'Find job-scam warning signs in the message.',
    'One finding per sign that is present, with a short exact quote (under 10 words) from the message. Signs:',
    defs,
    'No sign present: empty list. Also give people\'s names, the company it claims to be from, and the job title ("" if none).',
    'Keep tokens like [PERSON_1] as they are.',
    text === null ? '' : `\nMESSAGE:\n${text}`,
  ].join('\n');
}

/** Pull complete findings out of a partial JSON stream so the UI can show them live. */
export function partialFindings(raw: string): ModelFinding[] {
  const out: ModelFinding[] = [];
  const body = raw.slice(raw.indexOf('"findings"'));
  for (const m of body.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as { sign?: unknown; quote?: unknown };
      if (isSign(o.sign) && typeof o.quote === 'string') out.push({ sign: o.sign, quote: o.quote });
    } catch {
      /* object not complete yet */
    }
  }
  return out;
}

function parseReader(raw: string) {
  const j = JSON.parse(raw) as Partial<ReadResult>;
  return {
    findings: (Array.isArray(j.findings) ? j.findings : []).filter((f): f is ModelFinding => !!f && isSign(f.sign) && typeof f.quote === 'string'),
    people: (Array.isArray(j.people) ? j.people : []).filter((p): p is string => typeof p === 'string'),
    company: typeof j.company === 'string' ? j.company : '',
    role: typeof j.role === 'string' ? j.role : '',
    transcript: typeof j.transcript === 'string' ? j.transcript : undefined,
  };
}

/**
 * Read a text message. Raw text goes to the model only when Gemini Nano is
 * ready on this device; otherwise a redacted copy goes to cloud Gemini.
 */
export async function readMessage(text: string, onPartial: (f: ModelFinding[]) => void): Promise<ReadResult & { redaction?: Redaction }> {
  const t0 = performance.now();
  const onDevice = (await deviceState('text')) === 'available';
  const redaction = onDevice ? undefined : redactText(text);
  const sentText = onDevice ? text : redaction!.text;
  const prompt = readerPrompt(sentText);

  if (!onDevice) {
    // Log before sending, so the ledger shows it even if the call fails.
    ledger.add({
      where: 'cloud',
      service: 'Gemini (cloud) via Firebase AI Logic',
      what: `Gemini Nano is not available in this browser, so ${redaction!.spans.length} personal detail(s) were blanked first.`,
      bytes: prompt.length,
      payload: prompt,
      blanked: redaction!.spans.length,
    });
  }
  let acc = '';
  let response;
  if (onDevice) {
    // On device: stream, so warning signs appear while Nano is still writing.
    const result = await readerModel('text').generateContentStream(prompt);
    for await (const chunk of result.stream) {
      acc += chunk.text();
      onPartial(partialFindings(acc));
    }
    response = await result.response;
  } else {
    // Cloud answers in a few seconds; a single call is simpler and more robust.
    response = await withCloudModels(prompt.length, prompt, async (model) => (await readerModel('text', model).generateContent(prompt)).response);
  }
  const source = response.inferenceSource === InferenceSource.ON_DEVICE ? 'on_device' : 'in_cloud';
  const parsed = parseReader(acc || response.text());

  if (source === 'on_device') {
    ledger.add({
      where: 'device',
      service: 'Gemini Nano (on this device)',
      what: `Read the full message (${text.length} characters) and found ${parsed.findings.length} warning sign(s). Nothing was sent.`,
      bytes: text.length,
      payload: 'Full message, read locally by Gemini Nano via Firebase AI Logic (PREFER_ON_DEVICE).',
    });
  } else if (onDevice) {
    // Should not happen (the SDK routes by the same availability check), but if it does, say so.
    ledger.add({ where: 'cloud', service: 'Gemini (cloud) via Firebase AI Logic', what: 'Unexpected: Gemini Nano became unavailable and the SDK used the cloud.', bytes: prompt.length, payload: prompt });
  }

  // Map cloud answers on redacted text back to real values, locally.
  if (redaction) {
    parsed.findings = parsed.findings.map((f) => ({ ...f, quote: rehydrate(f.quote, redaction.map) }));
    parsed.company = rehydrate(parsed.company, redaction.map);
    parsed.people = parsed.people.map((p) => rehydrate(p, redaction.map));
  }
  return { ...parsed, source, ms: Math.round(performance.now() - t0), redaction };
}

/**
 * Read a screenshot. Only on-device unless the user agreed to send the image
 * to the cloud (images cannot be redacted before they are read).
 */
export async function readScreenshot(
  image: { base64: string; mimeType: 'image/png' | 'image/jpeg'; bytes: number },
  allowCloud: boolean,
  onPartial: (f: ModelFinding[]) => void,
): Promise<ReadResult> {
  const t0 = performance.now();
  const onDevice = (await deviceState('image')) === 'available';
  if (!onDevice && !allowCloud) throw new Error('NEEDS_CONSENT');
  const parts: Part[] = [{ type: 'text', text: readerPrompt(null) }, { type: 'inlineData', inlineData: { data: image.base64, mimeType: image.mimeType } }];
  let acc = '';
  let response;
  if (onDevice) {
    const result = await readerModel('image').generateContentStream(parts);
    for await (const chunk of result.stream) {
      acc += chunk.text();
      onPartial(partialFindings(acc));
    }
    response = await result.response;
  } else {
    response = await withCloudModels(image.bytes, '[same screenshot]', async (model) => (await readerModel('image', model).generateContent(parts)).response);
  }
  const source = response.inferenceSource === InferenceSource.ON_DEVICE ? 'on_device' : 'in_cloud';
  const parsed = parseReader(acc || response.text());
  ledger.add(
    source === 'on_device'
      ? {
          where: 'device',
          service: 'Gemini Nano (on this device)',
          what: `Read the screenshot (${Math.round(image.bytes / 1024)} KB) and its ${parsed.transcript?.length ?? 0} characters of text locally.`,
          bytes: parsed.transcript?.length ?? 0,
          payload: 'Screenshot pixels, read locally by Gemini Nano (multimodal input).',
        }
      : {
          where: 'cloud',
          service: 'Gemini (cloud) via Firebase AI Logic',
          what: `Screenshot sent with your permission (${Math.round(image.bytes / 1024)} KB). Images cannot be blanked before reading.`,
          bytes: image.bytes,
          payload: `[image ${image.mimeType}, ${Math.round(image.bytes / 1024)} KB]\n\n${readerPrompt(null)}`,
        },
  );
  return { ...parsed, source, ms: Math.round(performance.now() - t0) };
}

// ---------- 2. Check the company with Google Search (cloud only) ----------

export interface CompanyCheck extends CloudCheck {
  /** True when Google Search grounding was used; false when it was unavailable. */
  grounded: boolean;
  company: string;
  officialSite: string;
  summary: string;
  sources: { title: string; uri: string }[];
  searchEntryPoint?: string;
  prompt: string;
  ms: number;
}

function field(text: string, name: string): string {
  const m = new RegExp(`^\\s*\\**${name}\\**\\s*:\\s*(.+)$`, 'im').exec(text);
  return m ? m[1].trim().replace(/^\*+|\*+$/g, '') : '';
}
function yn(v: string): 'yes' | 'no' | 'unknown' {
  const s = v.toLowerCase();
  if (s.startsWith('yes')) return 'yes';
  if (s.startsWith('no')) return 'no';
  return 'unknown';
}

export interface CompanyCheckInput {
  company: string;
  role: string;
  domains: string[];
  /** Flagged quotes, already redacted. */
  quotes: string[];
}

export function companyPrompt(i: CompanyCheckInput, grounded = true): string {
  return [
    grounded
      ? 'A job seeker received a job offer and wants to know if it is genuine. Use Google Search.'
      : 'A job seeker received a job offer and wants to know if it is genuine. You cannot search the web: answer only from what you reliably know and say UNKNOWN when unsure.',
    `Company the message claims: ${i.company || 'not stated'}`,
    `Job title: ${i.role || 'not stated'}`,
    `Domains in the message: ${i.domains.length ? i.domains.join(', ') : 'none'}`,
    i.quotes.length ? `Flagged lines (personal details blanked):\n${i.quotes.map((q) => `- ${q}`).join('\n')}` : '',
    '',
    'Answer in exactly this format, one line each:',
    'COMPANY: the company\'s full official name, or UNKNOWN',
    'OFFICIAL_SITE: the company\'s official website or careers domain, or UNKNOWN',
    'DOMAIN_MATCH: YES if the domains in the message belong to that company, NO if they do not (free email counts as NO), UNKNOWN if no domain',
    'SCAM_REPORTS: YES if there are public warnings about job scams using this company\'s name or these domains, NO if none found',
    'NEVER_CHARGES: YES if the company says publicly that it never asks candidates for money, NO if it does charge, UNKNOWN if not found',
    'SUMMARY: two or three plain sentences for the job seeker. Do not invent facts.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Grounding needs a billing-enabled project; on the free plan it answers 429. */
let groundingUnavailable = false;
const isQuotaError = (e: unknown) => /\b(429|403)\b|quota|billing|permission/i.test(String(e));

export async function checkCompany(input: CompanyCheckInput, map: Record<string, string>): Promise<CompanyCheck> {
  const t0 = performance.now();
  const ask = async (grounded: boolean) => {
    const prompt = companyPrompt(input, grounded);
    const modelFor = (name: string) =>
      getGenerativeModel(getAi(), {
        model: name,
        ...(grounded ? { tools: [{ googleSearch: {} }] } : {}),
        generationConfig: { temperature: 0.2 },
      });
    ledger.add({
      where: 'cloud',
      service: grounded ? 'Gemini (cloud) + Google Search grounding' : 'Gemini (cloud), no live Search',
      what: 'Company name, domains and flagged lines only, with personal details blanked.',
      bytes: prompt.length,
      payload: prompt,
      blanked: Object.keys(map).filter((t) => prompt.includes(t)).length,
    });
    return { prompt, res: await withCloudModels(prompt.length, prompt, (name) => modelFor(name).generateContent(prompt)) };
  };
  let grounded = getLiveConfig().grounding && !groundingUnavailable;
  let out: Awaited<ReturnType<typeof ask>>;
  try {
    out = await ask(grounded);
  } catch (e) {
    if (!grounded || !isQuotaError(e)) throw e;
    // Free (Spark) projects cannot use Search grounding: fall back, and say so in the UI.
    groundingUnavailable = true;
    grounded = false;
    ledger.add({
      where: 'cloud',
      service: 'Gemini (cloud) + Google Search grounding',
      what: 'Rejected: Search grounding needs a billing-enabled project. Retrying without live Search.',
      bytes: 0,
      payload: String(e).slice(0, 200),
      rejected: true,
    });
    out = await ask(false);
  }
  const { prompt, res } = out;
  const text = res.response.text();
  const meta: GroundingMetadata | undefined = res.response.candidates?.[0]?.groundingMetadata;
  const sources = (meta?.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w): w is { uri: string; title?: string } => !!w?.uri)
    .map((w) => ({ title: w.title || w.uri, uri: w.uri }));
  return {
    company: rehydrate(field(text, 'COMPANY'), map) || input.company,
    officialSite: field(text, 'OFFICIAL_SITE'),
    domainMatch: input.domains.length ? yn(field(text, 'DOMAIN_MATCH')) : 'unknown',
    scamReports: yn(field(text, 'SCAM_REPORTS')),
    neverCharges: yn(field(text, 'NEVER_CHARGES')),
    // Put real names back in, on this device.
    summary: rehydrate(field(text, 'SUMMARY') || text, map),
    sources,
    searchEntryPoint: meta?.searchEntryPoint?.renderedContent,
    grounded,
    prompt,
    ms: Math.round(performance.now() - t0),
  };
}

