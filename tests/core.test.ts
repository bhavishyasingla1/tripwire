import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, rehydrate, detectPii } from '../src/core/redact.ts';
import { runPatterns, checkDomains, locateQuote } from '../src/core/rules.ts';
import { computeScore } from '../src/core/score.ts';
import { DEFAULT_PATTERNS, parsePatternList } from '../src/core/patterns.ts';

const FEE = `Dear Asha, Congratulations! You are selected for Data Entry Executive (Work From Home) at Amazon India. Salary Rs 45,000/month for 2 hours daily. No interview required. To confirm your joining kindly pay refundable registration fee Rs 2,500 to HR Priya Sharma, UPI priya.hr@okaxis within 24 hours or the offer will be cancelled. Send Aadhaar and PAN copy on WhatsApp +91 98765 43210. Contact: amazonhr.careers@gmail.com`;

test('redaction blanks names, phone, UPI, email local part and keeps domains', () => {
  const r = redactText(FEE);
  assert.ok(!r.text.includes('Asha'), r.text);
  assert.ok(!r.text.includes('Priya'), r.text);
  assert.ok(!r.text.includes('98765'), r.text);
  assert.ok(!r.text.includes('priya.hr'), r.text);
  assert.ok(!r.text.includes('amazonhr.careers'), r.text);
  assert.ok(r.text.includes('@gmail.com'), 'keeps email domain');
  assert.ok(r.text.includes('@okaxis'), 'keeps UPI bank handle');
  assert.ok(r.text.includes('+91'), 'keeps country code');
  assert.ok(r.text.includes('Amazon India'), 'keeps company');
  assert.ok(r.text.includes('Rs 2,500'), 'keeps amounts');
});

test('same value gets the same token, and rehydrate restores it', () => {
  const t = 'Call Rohan on 9876543210. Rohan will add you. Again: 9876543210. I am Rohan';
  const r = redactText(t);
  const phoneTokens = r.spans.filter((s) => s.kind === 'PHONE').map((s) => s.token);
  assert.equal(new Set(phoneTokens).size, 1);
  assert.equal(rehydrate(r.text, r.map), t);
  assert.equal(rehydrate('PERSON_1 asked for money', r.map), 'Rohan asked for money');
});

test('Aadhaar, PAN, IFSC, card, link path are blanked', () => {
  const t = 'Aadhaar 2345 6789 0123, PAN ABCDE1234F, IFSC SBIN0001234, card 4111 1111 1111 1111, form https://forms.example.in/apply?id=88812&u=asha';
  const r = redactText(t);
  for (const v of ['2345 6789 0123', 'ABCDE1234F', 'SBIN0001234', '4111 1111 1111 1111', 'id=88812']) assert.ok(!r.text.includes(v), v + ' in ' + r.text);
  assert.ok(r.text.includes('https://forms.example.in'), 'keeps link host');
});

test('Nano names only count when they appear in the text', () => {
  const t = 'Message from Kavya regarding the role.';
  assert.ok(detectPii(t, ['Kavya', 'Imaginary Person']).some((s) => s.value === 'Kavya' && s.kind === 'PERSON'));
  assert.ok(!detectPii(t, ['Imaginary Person']).some((s) => s.kind === 'PERSON'));
});

test('patterns find fee, pressure, off-platform, ID, no interview', () => {
  const signs = new Set(runPatterns(FEE, DEFAULT_PATTERNS).map((f) => f.sign));
  for (const s of ['FEE_OR_DEPOSIT', 'URGENCY_PRESSURE', 'OFF_PLATFORM_CHAT', 'EARLY_ID_OR_BANK', 'NO_INTERVIEW']) assert.ok(signs.has(s as never), s);
});

test('domain checks: free mail claiming a brand, look-alike, official', () => {
  const a = checkDomains(FEE, DEFAULT_PATTERNS);
  assert.equal(a.verdicts[0].kind, 'free-mail');
  assert.equal(a.verdicts[0].brand, 'Amazon');
  const b = checkDomains('Apply at https://amazon-careers-hr.in/form today', DEFAULT_PATTERNS);
  assert.equal(b.verdicts[0].kind, 'look-alike');
  const c = checkDomains('Write to talent@infosyss.com', DEFAULT_PATTERNS);
  assert.equal(c.verdicts[0].kind, 'look-alike');
  const d = checkDomains('Your interview link: https://careers.tcs.com/x', DEFAULT_PATTERNS);
  assert.equal(d.verdicts[0].kind, 'official');
});

test('locateQuote accepts real quotes and rejects invented ones', () => {
  assert.ok(locateQuote(FEE, 'pay refundable registration fee Rs 2,500'));
  assert.ok(locateQuote(FEE, 'Kindly pay refundable registration fee'));
  assert.equal(locateQuote(FEE, 'transfer bitcoin to our wallet'), null);
});

test('score: scam is high, plain recruiter message is low', () => {
  const findings = [...runPatterns(FEE, DEFAULT_PATTERNS), ...checkDomains(FEE, DEFAULT_PATTERNS).findings];
  const s = computeScore({ findings, weights: DEFAULT_PATTERNS.weights });
  assert.equal(s.level, 'high');
  const ok = `Hi Asha, thanks for applying to the Backend Engineer role at Infosys. Your first-round interview is on 2 Dec at 11:00 IST on Microsoft Teams. Details are in the invite from talent@infosys.com.`;
  const f2 = [...runPatterns(ok, DEFAULT_PATTERNS), ...checkDomains(ok, DEFAULT_PATTERNS).findings];
  const s2 = computeScore({ findings: f2, weights: DEFAULT_PATTERNS.weights, officialDomain: true });
  assert.equal(s2.level, 'low', JSON.stringify(f2));
});

test('bad Remote Config falls back to defaults', () => {
  assert.equal(parsePatternList('not json'), DEFAULT_PATTERNS);
  assert.equal(parsePatternList(JSON.stringify({ rules: [{ sign: 'NOPE', re: 'x' }] })), DEFAULT_PATTERNS);
  const p = parsePatternList(JSON.stringify({ version: 'v2', rules: [{ sign: 'FEE_OR_DEPOSIT', re: 'pay now' }] }));
  assert.equal(p.version, 'v2');
  assert.equal(p.rules.length, 1);
});
