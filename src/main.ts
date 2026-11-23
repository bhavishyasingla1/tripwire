import './styles.css';
import { firebaseConfigured, getLiveConfig, hasAppCheck, getFirebaseApp, loadRemoteConfig } from './firebase.ts';
import { checkCompany, deviceState, downloadNano, readMessage, readScreenshot, warmUp, type CompanyCheck, type DeviceState, type ModelFinding } from './ai.ts';
import { ledger, type LedgerEntry } from './ledger.ts';
import { hashIdentifiers, lookupReports, reportScam, senderIdentifiers, type Identifier } from './community.ts';
import { SAMPLES, drawSampleScreenshot } from './samples.ts';
import { SIGN_INFO, type Sign } from './core/signs.ts';
import { checkDomains, dedupe, extractDomains, locateQuote, runPatterns, type DomainVerdict, type Finding } from './core/rules.ts';
import { PII_LABEL, applyMap, redactText, type Redaction } from './core/redact.ts';
import { computeScore, type Score } from './core/score.ts';

// ---------- tiny DOM helper (text only; never innerHTML with user text) ----------
type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------
type StepId = 'patterns' | 'nano' | 'company' | 'community';
type StepState = 'idle' | 'running' | 'done' | 'skipped' | 'failed';
interface Step {
  id: StepId;
  name: string;
  where: 'device' | 'cloud';
  state: StepState;
  meta: string;
}

interface Run {
  id: number;
  text: string;
  imageUrl?: string;
  findings: Finding[];
  partial: Finding[];
  /** Screenshot mode: signs streamed before the text is known. */
  pending: ModelFinding[];
  dropped: number;
  verdicts: DomainVerdict[];
  redaction: Redaction;
  company: string;
  role: string;
  nanoSource?: 'on_device' | 'in_cloud';
  check?: CompanyCheck | null;
  checkError?: string;
  community: number;
  ids: Identifier[];
  reported: boolean;
  steps: Record<StepId, Step>;
  view: 'mine' | 'cloud';
}

let run: Run | null = null;
let runCounter = 0;
let mode: 'text' | 'image' = 'text';
let pendingImage: { base64: string; mimeType: 'image/png' | 'image/jpeg'; bytes: number; url: string } | null = null;
let device: DeviceState = 'unsupported';

// ---------- device status ----------
async function refreshDevice() {
  const chip = $('device-chip');
  device = await deviceState('text');
  chip.onclick = null;
  chip.classList.remove('chip-action');
  if (device === 'available') {
    chip.className = 'chip chip-device';
    chip.textContent = 'Gemini Nano ready · private mode';
    chip.title = 'Messages are read by Gemini Nano on this computer.';
    void warmUp();
  } else if (device === 'downloadable' || device === 'downloading') {
    chip.className = 'chip chip-cloud chip-action';
    chip.textContent = device === 'downloading' ? 'Downloading Gemini Nano…' : 'Turn on private mode';
    chip.title = 'One-time download of Gemini Nano to this computer (Chrome needs about 22 GB free disk space).';
    chip.onclick = startDownload;
  } else {
    chip.className = 'chip chip-cloud';
    chip.textContent = 'Cloud mode · details blanked first';
    chip.title = 'This browser cannot run Gemini Nano. Personal details are blanked on this device before anything is sent to cloud Gemini.';
  }
}

async function startDownload() {
  const chip = $('device-chip');
  chip.textContent = 'Starting download…';
  try {
    await downloadNano((p) => {
      chip.textContent = `Downloading Gemini Nano · ${Math.round(p * 100)}%`;
      if (p >= 1) setTimeout(refreshDevice, 1500);
    });
    setTimeout(refreshDevice, 3000);
  } catch (e) {
    chip.textContent = 'Download failed · using cloud mode';
    console.warn(e);
  }
}

// ---------- input ----------
function setMode(m: 'text' | 'image') {
  mode = m;
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
    const on = t.dataset.mode === m;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  (document.querySelector('.mode-text') as HTMLElement).hidden = m !== 'text';
  (document.querySelector('.mode-image') as HTMLElement).hidden = m !== 'image';
}

async function loadImage(file: Blob) {
  // Re-encode as PNG/JPEG (the formats Gemini Nano accepts) and cap the size.
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  setImage(url);
}

function setImage(dataUrl: string) {
  const [head, base64] = dataUrl.split(',');
  const mimeType = head.includes('jpeg') ? 'image/jpeg' : 'image/png';
  pendingImage = { base64, mimeType, bytes: Math.round((base64.length * 3) / 4), url: dataUrl };
  const img = $<HTMLImageElement>('preview');
  img.src = dataUrl;
  img.hidden = false;
  $('drop-hint').hidden = true;
  setMode('image');
}

function wireInput() {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode as 'text' | 'image')));
  const sampleBox = $('sample-buttons');
  for (const s of SAMPLES) {
    sampleBox.append(
      h('button', {
        class: 'sample-btn',
        type: 'button',
        title: `Fictional sample. Based on: ${s.basis}`,
        onclick: () => {
          setMode('text');
          $<HTMLTextAreaElement>('message').value = s.text;
          void analyse();
        },
      }, s.label),
    );
  }
  sampleBox.append(
    h('button', {
      class: 'sample-btn',
      type: 'button',
      title: 'A fictional chat screenshot drawn by Tripwire',
      onclick: () => {
        setImage(drawSampleScreenshot());
        void analyse();
      },
    }, 'Chat screenshot'),
  );
  $('check').addEventListener('click', () => void analyse());
  $<HTMLTextAreaElement>('message').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void analyse();
  });
  const file = $<HTMLInputElement>('file');
  file.addEventListener('change', () => file.files?.[0] && void loadImage(file.files[0]));
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('image/')) void loadImage(f);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const f = item?.getAsFile();
    if (f) {
      e.preventDefault();
      void loadImage(f);
    }
  });
  document.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      if (!run) return;
      run.view = b.dataset.view as 'mine' | 'cloud';
      document.querySelectorAll('.seg-btn').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      renderMessage();
    }),
  );
}

// ---------- analysis ----------
function newSteps(): Record<StepId, Step> {
  return {
    patterns: { id: 'patterns', name: 'Pattern check', where: 'device', state: 'idle', meta: '' },
    nano: { id: 'nano', name: 'Gemini Nano', where: 'device', state: 'idle', meta: '' },
    company: { id: 'company', name: 'Company check', where: 'cloud', state: 'idle', meta: '' },
    community: { id: 'community', name: 'Community reports', where: 'cloud', state: 'idle', meta: '' },
  };
}

function setStep(id: StepId, state: StepState, meta = '') {
  if (!run) return;
  run.steps[id] = { ...run.steps[id], state, meta };
  renderSteps();
}

function modelFindingsToSpans(text: string, mf: ModelFinding[]): { kept: Finding[]; dropped: number } {
  const kept: Finding[] = [];
  let dropped = 0;
  for (const f of mf) {
    const loc = locateQuote(text, f.quote);
    if (!loc) {
      dropped++;
      continue;
    }
    kept.push({ sign: f.sign, quote: text.slice(loc.start, loc.end), start: loc.start, end: loc.end, by: 'nano' });
  }
  return { kept, dropped };
}

function localPass(r: Run) {
  const t0 = performance.now();
  const { patterns } = getLiveConfig();
  const pf = runPatterns(r.text, patterns);
  const dc = checkDomains(r.text, patterns);
  r.findings = dedupe([...pf, ...dc.findings]);
  r.verdicts = dc.verdicts;
  r.redaction = redactText(r.text);
  const ms = Math.max(1, Math.round(performance.now() - t0));
  ledger.add({
    where: 'device',
    service: 'Pattern check (on this device)',
    what: `Checked ${patterns.rules.length} patterns from list ${patterns.version}: ${new Set(r.findings.map((f) => f.sign)).size} sign(s), ${r.redaction.spans.length} personal detail(s) found.`,
    bytes: r.text.length,
    payload: 'Runs in your browser. Nothing is sent.',
    kept: Object.keys(r.redaction.map).length,
  });
  setStep('patterns', 'done', `${ms} ms · ${patterns.version}`);
}

async function analyse() {
  const btn = $<HTMLButtonElement>('check');
  if (btn.disabled) return;
  let text = $<HTMLTextAreaElement>('message').value.trim();
  if (mode === 'text' && text.length < 12) {
    $<HTMLTextAreaElement>('message').focus();
    return;
  }
  if (mode === 'image' && !pendingImage) return;

  btn.disabled = true;
  btn.textContent = 'Checking…';
  ledger.newRun();
  const id = ++runCounter;
  run = {
    id, text: mode === 'text' ? text : '', imageUrl: mode === 'image' ? pendingImage!.url : undefined,
    findings: [], partial: [], pending: [], dropped: 0, verdicts: [], redaction: { text: '', map: {}, spans: [] },
    company: '', role: '', community: 0, ids: [], reported: false, steps: newSteps(), view: 'mine',
  };
  $('results').hidden = false;
  render();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const r = run;
  const alive = () => run?.id === id;

  try {
    if (mode === 'image') {
      // Screenshot: Nano reads pixels on the device, then the text goes through the same pipeline.
      setStep('patterns', 'idle', 'waits for text');
      setStep('nano', 'running', 'reading screenshot…');
      render();
      let allowCloud = false;
      if ((await deviceState('image')) !== 'available') {
        allowCloud = await askConsent();
        if (!allowCloud) {
          setStep('nano', 'skipped', 'not sent');
          setMode('text');
          finish();
          return;
        }
      }
      const res = await readScreenshot(pendingImage!, allowCloud, (pf) => {
        if (!alive()) return;
        r.pending = pf;
        setStep('nano', 'running', `reading · ${pf.length} sign(s) so far`);
        renderVerdict();
      });
      r.pending = [];
      if (!alive()) return;
      text = (res.transcript ?? '').trim();
      r.text = text;
      r.nanoSource = res.source;
      r.company = res.company;
      r.role = res.role;
      localPass(r);
      const { kept, dropped } = modelFindingsToSpans(text, res.findings);
      r.findings = dedupe([...r.findings, ...kept]);
      r.dropped = dropped;
      r.redaction = redactText(text, res.people);
      ledger.add({ where: 'device', service: 'Redaction (on this device)', what: `${Object.keys(r.redaction.map).length} personal detail(s) in the screenshot text blanked as tokens.`, bytes: 0, payload: 'Token map stays in this tab.', kept: Object.keys(r.redaction.map).length });
      setStep('nano', 'done', `${(res.ms / 1000).toFixed(1)} s · ${res.source === 'on_device' ? 'on device' : 'cloud, with consent'}`);
      render();
    } else {
      localPass(r);
      if (device !== 'available') r.steps.nano = { ...r.steps.nano, name: 'Gemini (blanked)', where: 'cloud' };
      render();
      setStep('nano', 'running', device === 'available' ? 'reading on this device…' : 'Nano not available · cloud with blanked text…');
      const res = await readMessage(text, (pf) => {
        if (!alive()) return;
        r.partial = modelFindingsToSpans(text, pf).kept;
        setStep('nano', 'running', `reading · ${pf.length} sign(s) so far`);
        render();
      });
      if (!alive()) return;
      r.nanoSource = res.source;
      r.company = res.company;
      r.role = res.role;
      const { kept, dropped } = modelFindingsToSpans(text, res.findings);
      r.partial = [];
      r.findings = dedupe([...r.findings, ...kept]);
      r.dropped = dropped;
      r.redaction = redactText(text, res.people);
      ledger.add({ where: 'device', service: 'Redaction (on this device)', what: `${Object.keys(r.redaction.map).length} personal detail(s) blanked as tokens; the token map stays in this tab.`, bytes: 0, payload: Object.entries(r.redaction.map).map(([t, v]) => `${t} = ${'•'.repeat(Math.min(12, v.length))} (${v.length} chars)`).join('\n') || 'none', kept: Object.keys(r.redaction.map).length });
      setStep('nano', 'done', `${(res.ms / 1000).toFixed(1)} s · ${res.source === 'on_device' ? 'on this device' : 'cloud, blanked'}`);
      render();
    }

    // Cloud steps run together.
    await Promise.all([communityStep(r, alive), companyStep(r, alive)]);
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    for (const s of Object.values(r.steps)) if (s.state === 'running') setStep(s.id, 'failed', shortError(msg));
  } finally {
    if (alive()) finish();
  }
}

function shortError(m: string) {
  console.warn('Tripwire step failed:', m);
  if (/app.?check/i.test(m)) return 'App Check failed';
  if (/quota|429|exhausted/i.test(m)) return 'Quota reached, try later';
  if (/\b50\d\b|high demand|overloaded/i.test(m)) return 'Model busy, try again';
  if (/Failed to fetch|NetworkError|offline/i.test(m)) return 'Offline?';
  return 'Failed';
}

function finish() {
  const btn = $<HTMLButtonElement>('check');
  btn.disabled = false;
  btn.textContent = 'Check it';
  render();
}

async function communityStep(r: Run, alive: () => boolean) {
  if (!firebaseConfigured) return setStep('community', 'skipped', 'offline build');
  const raw = senderIdentifiers(r.text, getLiveConfig().patterns);
  if (!raw.length) return setStep('community', 'skipped', 'no sender details');
  setStep('community', 'running', `${raw.length} fingerprint(s)`);
  try {
    r.ids = await hashIdentifiers(raw);
    const res = await lookupReports(r.ids);
    if (!alive()) return;
    r.community = res.max;
    setStep('community', 'done', res.max ? `${res.max} earlier report(s)` : 'no earlier reports');
  } catch (e) {
    console.warn(e);
    setStep('community', 'failed', 'unavailable');
  }
  render();
}

async function companyStep(r: Run, alive: () => boolean) {
  const domains = [...new Set(extractDomains(r.text).map((d) => d.domain))];
  const pre = score(r);
  if (!firebaseConfigured) return setStep('company', 'skipped', 'offline build');
  if (!r.company && !domains.length) return setStep('company', 'skipped', 'no company named');
  if (pre.signs.length === 0) {
    setStep('company', 'skipped', 'nothing flagged');
    renderCompany();
    return;
  }
  await runCompanyCheck(r, domains, alive);
}

async function runCompanyCheck(r: Run, domains: string[], alive: () => boolean) {
  setStep('company', 'running', 'Google Search…');
  r.check = null;
  renderCompany();
  try {
    const quotes = [...new Map(r.findings.map((f) => [f.quote, f])).keys()].slice(0, 6).map((q) => applyMap(q, r.redaction.map));
    const res = await checkCompany(
      { company: applyMap(r.company, r.redaction.map), role: applyMap(r.role, r.redaction.map), domains, quotes },
      r.redaction.map,
    );
    if (!alive()) return;
    r.check = res;
    setStep('company', 'done', `${(res.ms / 1000).toFixed(1)} s · ${res.sources.length} source(s)`);
  } catch (e) {
    console.warn(e);
    r.check = undefined;
    r.checkError = e instanceof Error ? e.message : String(e);
    setStep('company', 'failed', shortError(r.checkError));
  }
  render();
}

function askConsent(): Promise<boolean> {
  const d = $<HTMLDialogElement>('consent');
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
    d.showModal();
  });
}

function score(r: Run): Score {
  return computeScore({
    findings: [...r.findings, ...r.partial],
    weights: getLiveConfig().patterns.weights,
    cloud: r.check ?? null,
    communityReports: r.community,
    officialDomain: r.verdicts.some((v) => v.kind === 'official'),
  });
}

// ---------- render ----------
function render() {
  if (!run) return;
  renderSteps();
  renderVerdict();
  renderMessage();
  renderCompany();
  renderNext();
}

function renderSteps() {
  if (!run) return;
  const ol = $('steps');
  ol.replaceChildren(
    ...Object.values(run.steps).map((s) =>
      h('li', { class: `step ${s.state} where-${s.where}` },
        h('div', { class: 'step-top' }, h('span', { class: 'step-name' }, s.name), h('span', { class: 'dot' })),
        h('div', { class: 'step-meta' }, h('span', { class: `tag ${s.where === 'device' ? 'tag-device' : 'tag-cloud'}` }, s.where === 'device' ? 'Device' : 'Cloud'), ' ', s.meta || (s.state === 'idle' ? 'waiting' : '')),
      ),
    ),
  );
}

const LEVEL_TEXT = {
  high: { title: 'This looks like a job scam', sub: 'Do not pay, and do not send ID or bank details.' },
  caution: { title: 'Be careful with this one', sub: 'Some warning signs. Check the company yourself before you reply.' },
  low: { title: 'No common scam signs found', sub: 'That is not a guarantee. Never pay to get a job.' },
};

const seenSigns = new Set<string>();
function renderVerdict() {
  if (!run) return;
  const s = score(run);
  const busy = Object.values(run.steps).some((x) => x.state === 'running');
  const v = $('verdict');
  if (!run.text && busy) {
    // Screenshot still being read: no score yet, show what Nano has spotted so far.
    v.dataset.level = 'reading';
    $('verdict-eyebrow').textContent = 'Risk · reading';
    $('verdict-title').textContent = 'Gemini Nano is reading the screenshot';
    $('verdict-sub').textContent = run.nanoSource === 'in_cloud' ? 'Sent to cloud Gemini with your permission.' : 'On this device. Nothing has been sent.';
    $('score-num').textContent = '–';
    $('wire-fill').style.width = '0%';
    $('wire-mark').style.left = '0';
    $('signs').replaceChildren(...run.pending.map((f, i) => h('li', { class: 'sign sign-new' }, h('span', { class: 'sign-n' }, String(i + 1)), h('span', { class: 'sign-title' }, SIGN_INFO[f.sign].title), h('span', { class: 'sign-quote' }, `“${f.quote}”`))));
    $('dropped').hidden = true;
    return;
  }
  v.dataset.level = s.level;
  $('verdict-eyebrow').textContent = busy ? 'Risk · still checking' : 'Risk';
  $('verdict-title').textContent = LEVEL_TEXT[s.level].title;
  $('verdict-sub').textContent = LEVEL_TEXT[s.level].sub;
  $('score-num').textContent = String(s.risk);
  $('wire-fill').style.width = `${s.risk}%`;
  $('wire-mark').style.left = `calc(${s.risk}% - 1px)`;

  const all = [...run.findings, ...run.partial];
  const bySign = new Map<Sign, Finding[]>();
  for (const f of all) bySign.set(f.sign, [...(bySign.get(f.sign) ?? []), f]);
  const list = $('signs');
  const items: HTMLElement[] = [];
  let n = 0;
  for (const sign of s.signs) {
    const fs = bySign.get(sign) ?? [];
    n++;
    const sources = new Set(fs.map((f) => f.by));
    const note = fs.find((f) => f.note)?.note;
    const key = `${run.id}:${sign}`;
    const fresh = !seenSigns.has(key);
    seenSigns.add(key);
    items.push(
      h('li', { class: fresh ? 'sign sign-new' : 'sign' },
        h('span', { class: 'sign-n' }, String(n)),
        h('span', { class: 'sign-title' }, SIGN_INFO[sign].title),
        h('span', { class: 'sign-quote' }, `“${fs[0]?.quote ?? ''}”`),
        h('span', { class: 'sign-why' }, note ? `${note} ${SIGN_INFO[sign].why}` : SIGN_INFO[sign].why),
        h('span', { class: 'sign-by' },
          sources.has('nano') ? (run.nanoSource === 'in_cloud' ? h('span', { class: 'tag tag-cloud' }, 'Gemini (cloud, blanked)') : h('span', { class: 'tag tag-device' }, 'Gemini Nano')) : null,
          sources.has('pattern') ? h('span', { class: 'tag tag-plain' }, 'Pattern list') : null,
          sources.has('domain') ? h('span', { class: 'tag tag-plain' }, 'Domain check') : null,
        ),
      ),
    );
  }
  const extra: HTMLElement[] = [];
  const via = run.check?.grounded ? 'Google Search' : 'Cloud Gemini';
  if (run.check?.domainMatch === 'no') extra.push(cloudLine('Domain does not belong to the company', `${via}: the company’s own site is ${run.check.officialSite && !/unknown/i.test(run.check.officialSite) ? run.check.officialSite : 'elsewhere'}.`));
  if (run.check?.scamReports === 'yes') extra.push(cloudLine('Public scam warnings found', `${via}: there are public warnings about scams using this name or domain.`));
  if (run.community > 0) extra.push(cloudLine(`Reported by ${run.community} Tripwire user(s)`, 'Others reported the same phone, UPI ID, email or domain.'));
  if (!items.length && !busy) items.push(h('li', { class: 'sign-none' }, 'No warning signs found in this message.'));
  list.replaceChildren(...items, ...extra);
  const dropped = $('dropped');
  dropped.hidden = !run.dropped;
  dropped.textContent = run.dropped ? `Gemini suggested ${run.dropped} more sign(s) with quotes that are not in the message, so Tripwire ignored them.` : '';
}

function cloudLine(title: string, why: string) {
  return h('li', { class: 'sign' },
    h('span', { class: 'sign-n', style: 'background: var(--cloud-soft); color: var(--cloud)' }, '!'),
    h('span', { class: 'sign-title' }, title),
    h('span', { class: 'sign-why' }, why),
    h('span', { class: 'sign-by' }, h('span', { class: 'tag tag-cloud' }, 'Cloud')),
  );
}

function renderMessage() {
  if (!run) return;
  const view = $('message-view');
  view.classList.toggle('cloud', run.view === 'cloud');
  if (!run.text) {
    view.replaceChildren(run.imageUrl ? h('img', { src: run.imageUrl, alt: 'Screenshot being checked', style: 'max-width:100%;border-radius:8px' }) : '');
    return;
  }
  if (run.view === 'cloud') {
    // Exactly what this run sent to cloud Gemini, from the ledger, tokens highlighted.
    const sent = ledger.all().filter((e) => e.where === 'cloud' && e.service.startsWith('Gemini') && e.direction !== 'in');
    if (!sent.length) {
      view.replaceChildren(h('span', { class: 'muted' }, 'Nothing from this message has been sent to cloud Gemini.'));
      return;
    }
    const tokenize = (t: string) => t.split(/(\[[A-Z]+(?:_\d+)?\])/g).map((p) => (/^\[[A-Z]+(?:_\d+)?\]$/.test(p) ? h('span', { class: 'tok' }, p) : p));
    view.replaceChildren(...sent.flatMap((e, i) => [h('div', { class: 'sent-head' }, `${i + 1}. ${e.service} · ${e.bytes.toLocaleString('en-IN')} characters`), ...tokenize(e.payload), '\n\n']));
    return;
  }
  // Mine: original text with sign highlights and personal details underlined.
  const s = score(run);
  const signIndex = new Map(s.signs.map((sg, i) => [sg, i + 1]));
  type Mark = { start: number; end: number; kind: 'sign' | 'pii'; label: string };
  const marks: Mark[] = [];
  for (const f of [...run.findings, ...run.partial]) marks.push({ start: f.start, end: f.end, kind: 'sign', label: String(signIndex.get(f.sign) ?? '') });
  for (const p of run.redaction.spans) marks.push({ start: p.start, end: p.end, kind: 'pii', label: PII_LABEL[p.kind] });
  // Build boundaries and render non-overlapping segments with the active marks.
  const cuts = new Set<number>([0, run.text.length]);
  for (const m of marks) {
    cuts.add(m.start);
    cuts.add(m.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const nodes: Node[] = [];
  const labelled = new Set<string>();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const seg = run.text.slice(a, b);
    const active = marks.filter((m) => m.start <= a && m.end >= b);
    const sign = active.find((m) => m.kind === 'sign');
    const pii = active.find((m) => m.kind === 'pii');
    let node: Node = document.createTextNode(seg);
    if (pii) node = h('span', { class: 'hl-pii', title: `${pii.label}: blanked before anything leaves your device` }, node);
    if (sign) {
      const endsHere = marks.some((m) => m.kind === 'sign' && m.end === b && m.label === sign.label);
      const sup = endsHere && sign.label && !labelled.has(sign.label);
      if (sup) labelled.add(sign.label);
      node = h('mark', { class: 'hl-sign' }, node, sup ? h('sup', {}, sign.label) : null);
    }
    nodes.push(node);
  }
  view.replaceChildren(...nodes);
}

function renderCompany() {
  if (!run) return;
  const card = $('company-card');
  const body = $('company-body');
  const st = run.steps.company;
  card.hidden = st.state === 'idle' || (st.state === 'skipped' && !(run.company || extractDomains(run.text).length));
  if (card.hidden) return;
  $('company-time').textContent = st.state === 'done' ? st.meta : '';
  $('company-tag').textContent = run.check && !run.check.grounded ? 'Cloud · Gemini, no live Search' : 'Cloud · Google Search';
  if (st.state === 'running') {
    body.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Checking the company and domains with cloud Gemini. Only blanked text is sent.'));
    return;
  }
  if (st.state === 'skipped') {
    body.replaceChildren(
      h('p', { class: 'muted' }, 'Nothing was flagged, so nothing was sent to the cloud.'),
      h('button', {
        class: 'btn-ghost',
        type: 'button',
        onclick: () => {
          if (!run) return;
          const r = run;
          void runCompanyCheck(r, [...new Set(extractDomains(r.text).map((d) => d.domain))], () => run?.id === r.id);
        },
      }, 'Check the company anyway'),
    );
    return;
  }
  if (st.state === 'failed' || !run.check) {
    body.replaceChildren(h('p', { class: 'muted' }, 'The company check could not run just now. The on-device result above still stands.'));
    return;
  }
  const c = run.check;
  const fact = (k: string, v: string, cls = '') => h('div', { class: 'fact' }, h('div', { class: 'fact-k' }, k), h('div', { class: `fact-v ${cls}` }, v));
  const yn = (v: 'yes' | 'no' | 'unknown', goodWhen: 'yes' | 'no') => (v === 'unknown' ? ['Not found', ''] : [v === 'yes' ? 'Yes' : 'No', v === goodWhen ? 'good' : 'bad']);
  const [dm, dmc] = yn(c.domainMatch, 'yes');
  const [sr, src] = yn(c.scamReports, 'no');
  const [nc, ncc] = c.neverCharges === 'yes' ? ['Yes, never charges', 'good'] : c.neverCharges === 'no' ? ['Charges a fee', 'bad'] : ['Not found', ''];
  const nodes: Node[] = [
    h('div', { class: 'facts' },
      fact('Sender’s domain is the company’s', dm, dmc),
      fact('Public scam warnings', sr, src),
      fact('Company says it never charges', nc, ncc),
    ),
    h('p', { class: 'summary' }, c.summary),
  ];
  if (!c.grounded) nodes.push(h('p', { class: 'muted small' }, 'Live Google Search is not enabled for this demo project, so this check uses Gemini’s own knowledge. Treat “Not found” as unknown, not as safe.'));
  if (c.officialSite && !/unknown/i.test(c.officialSite)) nodes.push(h('p', { class: 'small' }, c.grounded ? 'Official site per Google Search: ' : 'Official site per Gemini: ', h('strong', {}, c.officialSite)));
  if (c.sources.length) nodes.push(h('ul', { class: 'sources' }, ...c.sources.slice(0, 6).map((s) => h('li', {}, h('a', { href: s.uri, target: '_blank', rel: 'noopener', title: s.title }, s.title)))));
  if (c.searchEntryPoint) {
    // Google requires showing the Search suggestions; they are rendered in a sandbox.
    const frame = h('iframe', { class: 'search-entry', sandbox: 'allow-popups allow-popups-to-escape-sandbox', title: 'Google Search suggestions' }) as HTMLIFrameElement;
    frame.srcdoc = `<base target="_blank"><style>body{margin:0;background:transparent}</style>${c.searchEntryPoint}`;
    nodes.push(frame);
  }
  body.replaceChildren(...nodes);
}

function renderNext() {
  if (!run) return;
  const s = score(run);
  const body = $('next-body');
  const items: (string | Node)[][] = [];
  if (s.level !== 'low') {
    items.push(['Do not pay any fee, deposit or “refundable” amount. Real employers pay you.']);
    items.push(['Do not send Aadhaar, PAN, bank details or OTPs to this contact.']);
  }
  const site = run.check?.officialSite && !/unknown/i.test(run.check.officialSite) ? run.check.officialSite : '';
  items.push([site ? `Find the job on the company’s own careers page (${site}) and apply there.` : 'Find the job on the company’s own careers page and apply there, not through this contact.']);
  if (s.level !== 'low') {
    items.push(['In India: report the message on ', h('a', { href: 'https://sancharsaathi.gov.in/sfc/', target: '_blank', rel: 'noopener' }, 'Chakshu (Sanchar Saathi)'), '. If you already paid, call ', h('strong', {}, '1930'), ' or file at ', h('a', { href: 'https://cybercrime.gov.in', target: '_blank', rel: 'noopener' }, 'cybercrime.gov.in'), ' quickly so the money can be frozen.']);
    items.push(['Elsewhere: ', h('a', { href: 'https://reportfraud.ftc.gov', target: '_blank', rel: 'noopener' }, 'reportfraud.ftc.gov'), ' (US) or your national cybercrime portal.']);
  }
  const nodes: Node[] = [h('ol', { class: 'next-list' }, ...items.map((parts) => h('li', {}, ...parts)))];
  if (run.community > 0) nodes.push(h('div', { class: 'community-note' }, `${run.community} other Tripwire user(s) reported the same contact details as a scam.`));
  const busy = Object.values(run.steps).some((x) => x.state === 'running');
  if (firebaseConfigured && run.ids.length && s.level !== 'low' && !busy) {
    nodes.push(
      h('div', { class: 'next-actions' },
        h('button', {
          class: run.reported ? 'btn-ghost' : 'btn-primary',
          type: 'button',
          disabled: run.reported,
          onclick: async (e: Event) => {
            const r = run;
            if (!r) return;
            (e.currentTarget as HTMLButtonElement).disabled = true;
            await reportScam(r.ids);
            r.reported = true;
            renderNext();
          },
        }, run.reported ? 'Reported. Thank you.' : 'Warn others: report as scam'),
        h('span', { class: 'muted small' }, `Sends ${run.ids.length} SHA-256 fingerprint(s) of the sender’s details. No text, no names.`),
      ),
    );
  }
  body.replaceChildren(...nodes);
}

// ---------- ledger ----------
function renderLedger(entries: LedgerEntry[]) {
  const list = $('ledger-list');
  const dev = entries.filter((e) => e.where === 'device').reduce((a, e) => Math.max(a, e.bytes), 0);
  const cloud = entries.filter((e) => e.where === 'cloud' && e.direction !== 'in').reduce((a, e) => a + e.bytes, 0);
  const blank = entries.reduce((a, e) => Math.max(a, e.kept ?? 0), 0);
  $('tot-device').textContent = dev.toLocaleString('en-IN');
  $('tot-cloud').textContent = cloud.toLocaleString('en-IN');
  $('tot-blank').textContent = String(blank);
  if (!entries.length) {
    list.replaceChildren(h('li', { class: 'ledger-empty' }, 'Nothing yet. Check a message and every step will appear here.'));
    return;
  }
  list.replaceChildren(
    ...[...entries].reverse().map((e) =>
      h('li', { class: `entry ${e.where}` },
        h('details', {},
          h('summary', {},
            h('div', { class: 'entry-top' },
              h('span', { class: 'entry-service' }, e.service),
              h('span', { class: 'entry-time' }, e.at.toLocaleTimeString('en-GB')),
            ),
            h('div', { class: 'entry-what' }, e.what),
            h('div', { class: 'entry-more' },
              h('span', { class: `tag ${e.where === 'device' ? 'tag-device' : 'tag-cloud'}` }, e.where === 'device' ? 'Stayed on device' : e.rejected ? 'Refused' : e.direction === 'in' ? 'Downloaded' : 'Left device'),
              e.where === 'cloud' && e.direction !== 'in' && !e.rejected ? ` · ${e.bytes.toLocaleString('en-IN')} chars · show exact payload` : ' · details',
            ),
          ),
          h('pre', {}, e.payload),
        ),
      ),
    ),
  );
}

// ---------- boot ----------
async function boot() {
  wireInput();
  ledger.subscribe(renderLedger);
  if (firebaseConfigured) {
    getFirebaseApp();
    if (!hasAppCheck()) console.warn('App Check is not configured; Firebase AI Logic calls will be rejected.');
    void loadRemoteConfig();
  }
  await refreshDevice();
  const repo = import.meta.env.VITE_REPO_URL;
  if (repo) $<HTMLAnchorElement>('repo-link').href = repo;
  // Text from the Tripwire Chrome extension arrives by postMessage from its
  // content script (same window, same origin), never in the URL.
  if (new URLSearchParams(location.search).get('from') === 'extension') {
    history.replaceState(null, '', location.pathname);
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.origin !== location.origin) return;
      const d = e.data as { type?: string; text?: unknown };
      if (d?.type !== 'tripwire-text' || typeof d.text !== 'string' || !d.text.trim()) return;
      setMode('text');
      $<HTMLTextAreaElement>('message').value = d.text.slice(0, 20000);
      void analyse();
    });
  }
}

void boot();
