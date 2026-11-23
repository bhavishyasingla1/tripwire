# Tripwire

**Check a job offer without sending it anywhere.**

Tripwire is a fake-job-offer shield for job seekers. Paste a recruiter message, an offer letter or a chat screenshot. Gemini Nano reads it **on your own computer** through Firebase AI Logic, finds the warning signs, quotes the exact words and blanks out every personal detail. Only flagged, already-blanked lines go to cloud Gemini to check the company. A **"What left your device"** panel shows every request with the exact text that was sent.

- Live demo: **https://tripwire-shield.web.app**
- Built for #BuildHybridAI 2026 (Firebase AI Logic hybrid inference), Web/Chrome
- License: Apache-2.0

## Why on-device is the point

Job scam messages are full of the job seeker's own details: name, phone number, Aadhaar, PAN, bank details, the scammer's UPI ID. People hesitate to paste that into a cloud chatbot, and they should. Tripwire keeps the raw message on the device and lets the cloud see only what it needs.

The problem is large and growing:

- The FBI's IC3 logged **24,688 employment-scam complaints with $362,934,762 lost in 2025**, up from $264.2M in 2024 ([2025 Internet Crime Report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf), pp. 25–26).
- In India, reports to the government's Chakshu service in the category "Online job / lottery / gifts / loan offers" rose from **23,634 in 2024 to 58,560 in 2025** ([PIB, 5 Feb 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2223779)).
- LinkedIn says **90%** of reported scam messages try to move the chat to private messaging, and in its 2026 survey across five countries including India, **21%** of professionals said they had been victims of a job scam ([LinkedIn, 6 May 2026](https://news.linkedin.com/2026/LinkedIn-Job-Search-Safety-Pulse)).

All sources, and what each warning sign is based on, are in [`docs/sources.md`](docs/sources.md).

## How the hybrid split works

```
                      ┌──────────────────────── YOUR DEVICE ────────────────────────┐
 message / screenshot │ 1. Pattern list (Remote Config)  → instant first verdict     │
 ───────────────────▶ │ 2. Gemini Nano (Firebase AI Logic, PREFER_ON_DEVICE)         │
                      │    → warning signs (enum) + exact quotes + names (JSON)      │
                      │    → every quote is checked against the text; invented ones  │
                      │      are dropped                                             │
                      │ 3. Redaction: names, phones, UPI, Aadhaar, PAN, IFSC, bank,  │
                      │    card, link paths, chat handles → [PERSON_1], [PHONE_1]…   │
                      │    The token map never leaves the tab.                       │
                      │ 6. Real names put back into the cloud's answer, locally      │
                      └───────────────┬──────────────────────────────▲──────────────┘
                                      │ only company, domains,       │
                                      │ flagged blanked lines        │
                      ┌───────────────▼──────────────────────────────┴──────────────┐
                      │ 4. Cloud Gemini via Firebase AI Logic: is the domain really  │
                      │    the company's? public scam warnings? does it charge?      │
                      │    (Google Search grounding when the project has billing)    │
                      │ 5. Firestore: community reports stored as SHA-256 hashes     │
                      └─────────────────────────────────── CLOUD ────────────────────┘
```

**Redaction-gated fallback.** With `PREFER_ON_DEVICE`, the Firebase SDK sends a request to the cloud when Gemini Nano isn't ready. For a privacy tool that would leak the raw message. So Tripwire runs the same availability check first: raw text goes to the model only when Nano is ready on the device. Otherwise the message is blanked locally and only the blanked copy is sent. Screenshots can't be blanked, so without Nano they are sent only after the user says yes in a dialog.

**The score is computed in code, not by the model.** Each warning sign has a weight (from Remote Config) and they combine with a noisy-OR. A sign found by both a local check and Gemini counts in full; a sign found by only one counts at 80%. A sender on the company's own domain lowers risk but never hides a fee request. The result is stable and explainable, and the same on every device.

## Firebase products used

| Product | What Tripwire uses it for | Code |
|---|---|---|
| **Firebase AI Logic** (Gemini Developer API) | Hybrid model with `InferenceMode.PREFER_ON_DEVICE`: on-device JSON structured output with an enum of signs (`responseConstraint`), text and image input, streaming; `initializeDeviceModel()` from a click; `inferenceSource` decides what the ledger records. Cloud model for the company check, with Google Search grounding when enabled. | [`src/ai.ts`](src/ai.ts) |
| **App Check** (reCAPTCHA Enterprise) | Protects every AI Logic call (enforced). | [`src/firebase.ts`](src/firebase.ts) |
| **Remote Config** | Weekly scam-pattern list (rules, weights, free-mail domains, brand domains), cloud model and fallback models, and the Search grounding switch. Bad values fall back to built-in defaults. | [`src/firebase.ts`](src/firebase.ts), [`remoteconfig.template.json`](remoteconfig.template.json) |
| **Cloud Firestore** | Community reports as SHA-256 hashes of the sender's details, one report per anonymous user, enforced in rules. | [`src/community.ts`](src/community.ts), [`firestore.rules`](firestore.rules) |
| **Authentication** (Anonymous) | Lets Firestore rules allow one report per user without collecting any identity. | [`src/firebase.ts`](src/firebase.ts) |
| **Hosting** | Serves the demo with security headers. | [`firebase.json`](firebase.json) |

## Features

- **Paste text or a screenshot.** Screenshots are read by Gemini Nano's multimodal input on the device.
- **Instant first verdict** from the pattern list, then Nano's findings stream in.
- **Eight warning signs**: asks you to pay; moves you to Telegram or WhatsApp; free email or look-alike website; pay too good for the work; paid "tasks" like likes or reviews; pressure to act now; wants ID or bank details early; hired without an interview.
- **Domain checks** on the device: free-mail senders claiming to be a big company, look-alike domains (`amazon-careers-hr.in`, one letter off `infosys.com`).
- **"What you see" / "What the cloud saw"** toggle on the message, and a ledger with the exact payload of every request.
- **Company check** in the cloud with only blanked text.
- **Community reports** as hashes: "3 other people reported this UPI ID".
- **What to do now**, with real reporting routes: Chakshu (Sanchar Saathi) for suspicious messages, 1930 or cybercrime.gov.in if money was lost, reportfraud.ftc.gov in the US.
- **Chrome extension**: select a message in Gmail, LinkedIn or WhatsApp Web, right-click, **Check with Tripwire**. See [`extension/`](extension/).
- Works without Gemini Nano too (cloud mode, blanked first), and on phones.

## Try it (judges)

1. Open **https://tripwire-shield.web.app** in desktop **Chrome 139 or later**.
2. The chip at the top says **"Gemini Nano ready · private mode"** if Nano is on your machine. If it says **"Turn on private mode"**, click it to start the one-time download (Chrome needs about 22 GB of free disk and either a GPU with more than 4 GB of VRAM, or 16 GB of RAM and 4 CPU cores). For screenshots on older Chrome versions, enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`.
3. Click a sample: **"Registration fee" offer**, **Telegram "task" job**, **Normal interview invite** or **Chat screenshot**. All samples are fictional and are based on public cases listed in `docs/sources.md`.
4. Open entries in **What left your device** to see the exact text each request carried. Switch the message to **What the cloud saw**.

Without Nano (another browser, or a phone), Tripwire switches to cloud mode: it blanks details first and the ledger shows the blanked payload.

On-device timing on an Apple M4 with 16 GB of RAM: the pattern verdict takes a few milliseconds, and Gemini Nano takes about 25–45 s for a full message.

## Run it yourself

```bash
git clone https://github.com/Bhavishyasingla1/tripwire && cd tripwire
npm install
cp .env.example .env.local   # fill in your Firebase web app config
npm run dev
npm test
```

Firebase setup: create a project, enable **Firebase AI Logic** (Gemini Developer API), **Anonymous Auth** and **Firestore**, register the web app in **App Check** with a reCAPTCHA Enterprise key for your domain, then:

```bash
npx firebase deploy --only hosting,firestore:rules,remoteconfig
```

For local development, App Check needs a debug token: set `VITE_APPCHECK_DEBUG=true` in `.env.development.local`, copy the token printed in the console, and register it under App Check → Manage debug tokens.

Google Search grounding needs a billing-enabled (Blaze) project. On the free plan, Tripwire's company check uses Gemini without live Search and says so in the UI. Set the Remote Config parameter `search_grounding` to `true` once billing is on.

## Privacy and honest limits

- The raw message never leaves the device when Gemini Nano is available. The ledger is built from the same code paths that send requests, so it can't drift from what actually happened.
- The token map that links `[PERSON_1]` to a real name exists only in the open tab.
- Pattern-based redaction can miss unusual formats. Names are found from greetings and sign-offs plus Gemini Nano. Review the "What the cloud saw" view.
- Community hashes are not anonymous against someone who already has a list of phone numbers to try. Tripwire only stores the scam sender's details, never the job seeker's.
- Tripwire gives a second opinion, not a guarantee. "No common scam signs found" never means "safe".
- No analytics, no tracking, no accounts.

## Project layout

```
src/core/       pure logic, unit-tested: signs, patterns, redaction, rules, score
src/ai.ts       Firebase AI Logic: hybrid reader + company check
src/firebase.ts App Check, Anonymous Auth, Remote Config, Firestore
src/community.ts hashed community reports
src/ledger.ts   "What left your device"
src/main.ts     UI
extension/      Chrome extension (Manifest V3)
tests/          node --test unit tests
```

## What was built during the hackathon

Everything in this repository was written from scratch between 23 and 29 November 2026, during the submission period. No earlier code was reused. Tools: Firebase JS SDK 13.4, Vite and TypeScript, with an AI coding assistant (Claude Code). The demo samples are fictional messages modelled on public cases, which are cited in `docs/sources.md`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
