# Halqa (حلقة)

A screening-to-care closure engine. Every actionable screening result becomes an owned, clocked case that AI agents can advance, and that only a record of the care or a clinician's decision can close.

This is a prototype for Challenge 05 of the Future Health Digital Innovation Challenge. **All data is synthetic. Patient wording is not clinically approved.**

## Run it

Needs Node 24 or newer (the event log uses `node:sqlite`) and pnpm 9.

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173. The API runs on port 8787 and, on first start, loads nine synthetic patients with their charts and seeds seven cases at different stages. No keys, containers or network access are needed.

| Screen | Address | What it is |
| --- | --- | --- |
| Landing | `#/` | What Halqa is, the numbers behind it, the three invariants, and what is real today |
| Live demo | `#/demo` | One button runs the whole story hands-free, with both sides of the call spoken aloud. Each step can also be run on its own, or you can take the call yourself |
| Console | `#/console` | The application a provider's staff would use: worklist, cases, calls, programme measures, configuration, and a simulator |

Use Chrome. Speaking as the patient uses the browser's speech recognition.

## The console

The console is laid out as it would be for an institution's follow-up team. It has its own navigation and every page scrolls inside the window.

| Page | What it shows |
| --- | --- |
| Worklist | Every case with its stage, the one next step, its owner and its deadline. Queues: needs action, booked, closed |
| A case | The patient pinned at the top, then four tabs. **Overview**: the next step with its action, hand-offs waiting for a person, the chart in brief. **Records**: the patient's chart beside Claude's review of it. **Calls**: every call on the case, and the button that places one. **Activity**: the event record, the tamper check, records offered as proof of care, and the case as a FHIR Task |
| Calls | Every call the agent has placed. Picking one opens its record: what it achieved, what the server measured, and the transcript with the reason for every line |
| Programme | The pathway simulation and the live measures |
| Configuration | Six pages that show where each rule is set and what it is right now: pathway rules, the agent's script, guardrails (with a self-test that tries to make an agent close a case), voice and models, data and integrations, team |
| Simulator | Plays the parts the sandbox is not connected to: it skips the clock, and posts the records a laboratory or an endoscopy unit would send. Nothing on it exists in a deployment |

### Placing a call

Open a case whose result has not been given and press **Place the outreach call**. There is no phone line in the sandbox, so you are the patient: speak, or type a reply, or pick one from **Replies to try**. A strip at the top shows what the agent is doing (hear, choose, speak, wait). Under each agent line, **Why this line** shows the stage the case was in, the lines allowed there, what chose this one, how long the choice took, the script entry, and whether the audio came from the cache.

Every call is stored turn by turn. The agent's side is kept as script entry, version, language and appointment values, and the words are rebuilt from those. The patient's replies are kept as text with runs of four or more digits removed, and the answer to the identity question is never stored.

### Claude's chart review

The Records tab shows the chart on the left and, on the right, Claude's reading of it for the navigator and the clinician: a brief summary, what matters for arranging and safely doing the colonoscopy, points for a clinician to check, and what it looked for and did not find. It is a pointer to records, not a diagnosis.

- The chart is sent as a list of labelled records (R1, R2, ...) with a birth year and a sex, and no name, MRN or national ID.
- Every sentence must cite the records it rests on. `groundReview` in `packages/review` removes any sentence whose citations do not match a record in the chart, and refuses the whole review if the summary rests on nothing. The "clinician should look" line is set by code from the surviving points, never by the model.
- Pressing a record label in the review scrolls to that record in the chart.
- A clinician can record that they checked the review against the chart; anyone can report it as inaccurate. Both are stored with a name and a time.

The reviews shipped in `packages/review/src/stored-reviews.json` were written by Claude (`claude-fable-5-2`) running as a Claude Code agent that was given the same system prompt and chart text the API call sends. They are not API responses, and the console says so. A stored review is shown only while the records it was written from are unchanged; if one changes, it is withdrawn. With `ANTHROPIC_API_KEY` set, **Review again** makes a live call (`messages.parse` with a Zod output schema) and keeps the result on disk under a hash of the chart text.

To regenerate the stored reviews after changing a synthetic chart:

```bash
pnpm --filter @halqa/api exec tsx src/tools/review-bundles.ts
```

That prints each chart exactly as the model receives it. Feed each one to the model with the system prompt (`--prompt` prints it), collect the answers in a JSON file keyed by patient reference, then run `src/tools/store-reviews.ts` on that file. It grounds every answer against its chart and refuses to write the file if any sentence cites nothing.

### Voice

With `ELEVENLABS_API_KEY` in `.env`, the call is spoken by ElevenLabs (`eleven_v4` by default; the agent is the premade voice Sarah, the scripted patient is George). Without a key, the browser's own speech synthesis is used, which needs an Arabic and an English voice installed, as on macOS. The console's Voice and models page names the voice in use.

- The key stays in the API process. The browser asks `POST /tts` and gets audio back.
- The agent's audio is requested by act, language and slot values. The server re-renders the words from the catalogue, so the endpoint cannot be made to voice anything else as the agent.
- Every line is cached on disk in `data/tts-cache/`, keyed by model, voice and exact text. A line is paid for once; a repeat demo replays from disk. One full run measured 2,177 characters on a cold cache. Lines that contain appointment dates are new each day.
- If ElevenLabs refuses a line (quota, plan, network), that line falls back to the browser's voice and the call carries on.

## Prove it

| Command | What it shows | Result on 20 November 2026 |
| --- | --- | --- |
| `pnpm proof` | The compiler rejects 12 illegal constructions; then 100,000 random event sequences with forged closures injected | 126,957 forged closes, 0 accepted; 45,575 runs closed, all on genuine evidence |
| `pnpm test` | Runtime, call engine, call record, simulation, speech-cache and chart-review suites | 78 tests pass |
| `pnpm mutations` | Twelve deliberate breaks of a safety property, each of which a check must notice. Three cover the console: storing the identity answer, keeping an uncited sentence in a chart review, and sending record ids to the model | 12 of 12 caught |
| `pnpm lint` | No `any`, no `@ts-ignore`, no non-null `!` | Clean |
| `pnpm check` | Type check, lint, proof and tests together | Passes |
| `pnpm sim` | The pathway simulation, 10,000 synthetic patients per arm | Table printed; `--json` for everything |

`packages/kernel/src/kernel.ts` is byte-identical to the kernel proven in the build spec.

## The demo, beat by beat

Open `#/demo` and press **Run the whole demo**. It resets the demo data, then plays six steps in about three minutes.

| Step | What happens |
| --- | --- |
| A result lands | A positive FIT is posted to the FHIR endpoint. A case opens with a named owner and a 24-hour deadline. |
| The call | The agent calls in Arabic, checks two identifiers, delivers the result, asks for a teach-back, offers three slots across two providers and books one. The scripted patient switches to English mid-call and the agent follows. Every agent turn shows the tool call and a trace of why that act was chosen. |
| Try to break it | A second patient tries a jailbreak, then reports heavy bleeding. Emergency guidance is forced and an urgent hand-off is raised. Then an agent tool handler tries to close the case, and the real compiler, the real schema and the real kernel each refuse. |
| Time passes | The clock skips a week. The appointment is missed, the case goes back to booking one level louder, and the navigator re-books. |
| Closure on evidence | A colonoscopy for another patient and a sigmoidoscopy are refused. A completed colonoscopy closes the case, and the evidence chip links to the Procedure. |
| The programme view | Three headline numbers from the simulation, labelled as a simulation. |

What is scripted in that run is the patient: the lines the patient says are fixed, and are spoken by a second synthetic voice. Everything the system does in response is live: the engine, the guards, the kernel, the event log, the timers and the closure listener. Then run `pnpm proof` in a terminal for the compiler and property proofs.

## Layout

```text
packages/
  kernel/      states, events, decide, ClosureEvidence. Zero dependencies. Proofs live beside it.
  pathways/    the colorectal pathway as typed data
  catalogue/   every word the system can say, in Arabic and English, and the renderer
  fhir/        Zod schemas for the FHIR R4 subset; the only place branded identifiers are minted
  contracts/   the model tool, whose schema is generated from the acts on offer
  runtime/     hash-chained event log, replay, durable timers, ingest, closure listener, scheduling
  voice/       the call engine, the rules brain, the Claude brain, the listening rules, the call record
  review/      Claude's chart review: the chart as the model reads it, citation grounding, the stored reviews
  evals/       the pathway simulation
apps/
  api/         Hono server: tRPC procedures, FHIR endpoints, the in-process worker and its timer loop
  web/         React: landing page, guided demo, console
               src/console/ is the console, built from shadcn/ui components in src/components/ui/
               src/reactbits/ holds components vendored from React Bits (reactbits.dev)
scripts/       mutations.py, the negative controls
docs/          data declaration; assumptions, dependencies and limitations; maturity statement
```

## How one result moves

1. A FHIR Observation is posted to `POST /fhir/Observation`. It is parsed by Zod or rejected.
2. The pathway file decides whether it is actionable. If so a case opens: owner assigned, deadline set, first event hashed into the log.
3. The call engine asks the kernel which acts are legal, narrows them with its guards, and offers that list to the brain. The brain's choice is parsed against the same list. The catalogue supplies the words.
4. What happened returns as events through `decideForAgent`. Each is appended with a SHA-256 over the previous hash.
5. A timer loop fires `deadline-passed` for any case whose `due` is behind the clock. Deadlines live in the log, so a restart loses none.
6. A Procedure arrives. `ClosureEvidence.fromRecord` checks patient, code, status and date. If it passes, the case closes.

## Where this differs from the build spec

| Spec | This build | Why |
| --- | --- | --- |
| Temporal workflows | An in-process timer loop over deadlines stored in the event log | No Docker or Temporal on the build machine; invariant I2 puts `due` on every open state, so timers are recoverable from the log. Verified by a kill -9 test |
| Medplum | A FHIR R4 subset served by the API: Observation, Procedure, Appointment, Slot, Patient, Condition, MedicationStatement, Encounter and FamilyMemberHistory in; Task out | Same reason |
| Postgres and Drizzle | One SQLite file, rows parsed by Zod on the way out | Same reason |
| `gpt-realtime-2.1` ear, phone call | Typed text, or the browser's speech recognition and synthesis | No key; the brain and catalogue are the same either way |
| `claude-fable-5-2` selects acts | Rules brain by default. The Claude brain is built and tested against a stand-in for the API, and is off until `HALQA_BRAIN=claude` | No key in the build environment, so it has never called the real service |
| Next.js | Vite and React | One fewer server in a one-day build |
| A phone call | A voice stage in the browser: an orb that moves with the audio, live captions, voices from ElevenLabs (or the browser's speech synthesis without a key), microphone input through speech recognition | No telephony or realtime speech model was available |

See `docs/assumptions-dependencies-limitations.md` for everything not built and not verified.

## Turning on the Claude brain

Copy `.env.example` to `.env` in the repository root, set `HALQA_BRAIN=claude` and `ANTHROPIC_API_KEY`, and restart `pnpm dev`. The console's Voice and models page then names the model policy, every "Why this line" in a call names the model as what chose the line, and live chart reviews are switched on.

The engine keeps every guard. If the model returns nothing usable, refuses, errors, or picks an act that is not on offer, the rules brain decides that turn and the trace says so. Server-side model fallback on refusal is deliberately not enabled: a refusal here should end in the deterministic policy or a person, not in a different model.

## Interface components

The console is built from [shadcn/ui](https://ui.shadcn.com) components (Tailwind v4, Radix), installed into `apps/web/src/components/ui/`: sidebar, table, tabs, select, sheet, dialog, accordion, collapsible, dropdown menu, tooltip. It has no native form controls. Add another with `cd apps/web && npx shadcn@latest add <name>`.

The landing page and the guided demo use [React Bits](https://reactbits.dev) components, installed through the shadcn registry into `apps/web/src/reactbits/`. The registry is declared in `apps/web/components.json`, so more can be added the same way:

```bash
cd apps/web && npx shadcn@latest add @react-bits/Orb-TS-CSS
```

```bash
pnpm reactbits:prep
```

The second command marks newly added files as unchecked: they are third-party source written for looser compiler settings than this repository's, and they are excluded from the lint bans for the same reason. Their exported prop types still reach the code that uses them.
