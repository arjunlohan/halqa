# Assumptions, dependencies and limitations

As of 20 November 2026. The rule for this file: nothing specified is described as built, and nothing built is described as verified unless a check listed in the README exercises it.

## Maturity statement

- **Existed before the challenge:** nothing.
- **Built and verified** by tests, by mutation, and by hand in a browser: the closure kernel and its proofs; the colorectal pathway file; the Arabic and English catalogue and renderer; FHIR ingest; the case runtime (hash-chained event log, replay, timers that survive kill -9); the closure listener; scheduling across two synthetic providers; the call engine with the rules brain; the stored call record; the console (worklist, case, calls, configuration pages, simulator); patient charts; citation grounding for chart reviews; clinician closure by decision; the FHIR Task mirror; the pathway simulation and programme view.
- **Built, never run against the real service:** the Claude brain and the live chart review (each tested only against a stand-in for the API). No model key was available in the build environment, so this prototype has never called the model API.
- **Produced by a model, outside the API:** the nine chart reviews shipped with the prototype. Claude (`claude-fable-5-2`) wrote them while running as a Claude Code agent, given the same system prompt and chart text the API call sends. The grounding code accepted every sentence. They show what the feature returns; they are not evidence that the API path works.
- **Built and exercised, with limits:** the voice stage. With a key, both voices come from ElevenLabs `eleven_v4` through a server endpoint with a disk cache; without one, from the browser's speech synthesis. Both paths were run end to end in the build environment. I checked that audio played and that the orb tracked its level; nobody has listened to the Arabic for quality. Microphone input uses the browser's speech recognition and could not be exercised there, because the embedded browser blocks microphone access.
- **Specified, not built:** Temporal, Medplum and Postgres; a realtime speech model and telephony; the text channel; e-consult packets; the portal adapter; the diabetes and breast pathways; the HL7 v2 adapter; a second model listening for red flags; the full agent eval suites; sign-in, consent records, audit events and FHIR Provenance.

## Assumptions

| Assumption | Where it lives |
| --- | --- |
| A FHIR R4 feed of results and procedures is available, with standard codes and an interpretation flag | `packages/fhir`, `packages/pathways` |
| Four of the five deadlines are placeholders. Only 744 hours (31 days) for awaiting attendance has a source | `slaSource` in the pathway file, shown on every case |
| A provider can name a human owner for every case. New cases go to the least-loaded navigator | `CaseRuntime` |
| Two identifiers, year of birth and the last four digits of an ID, are enough to release a result by phone | The call engine. A clinical and legal decision, not an engineering one |
| "Referral" in the 31-day measure means the moment the case opened | Programme view, live measures |
| The simulation's 43 stage-level parameters | Listed in the programme view; five figures are published, the rest are assumptions |

## Dependencies for a pilot

- A data-sharing agreement and read access to results, appointments and procedures.
- A named clinical owner, and a clinician and a native-speaker linguist to approve the wording.
- Speech recognition with usable Gulf Arabic, running inside the UAE or under a regulator's approval.
- A licensed telephony route.
- A model endpoint inside the residency boundary. No UAE-region hosting of `claude-fable-5-2` was confirmed, and the model is not available under zero data retention unless Anthropic expressly authorises it. Both rule it out for identified health data as wired here.
- A SNOMED CT licence.

## Limitations

### Clinical and safety

- **No outcome evidence.** The simulation shows mechanism and capacity. Its three completion rates are inputs.
- **Wording is not approved.** The Arabic is Modern Standard Arabic with masculine address forms throughout.
- **Red flags are caught by keyword rules only**, in English and Modern Standard Arabic. The tested set is 11 urgent lines and 7 calm ones. Dialect, slang and anything the rules do not list will be missed. The spec's second, model-based listener is not built.
- **Teach-back is graded by keywords.** A patient who describes the test without a listed word fails and is offered a person after two tries.
- **Halqa trusts the record.** A miscoded Procedure would close a case. Requiring two concordant records is not implemented.
- **Attempt caps and quiet hours** are in the pathway file and are not enforced.

### Chart review

- **A citation proves the record exists, not that the sentence is right.** Grounding removes a sentence that cites no record in the chart. It does not check that the record says what the sentence claims; in the nine stored reviews that was checked by a script comparing values and dates, and by reading them.
- **The reason a point matters is the model's general knowledge.** "Aspirin affects bleeding" is not in any record. That is the part a clinician is asked to check, and the console says so.
- **The review reads a tiny chart.** Two to nine records per patient. Nothing here shows how it behaves on a real chart with hundreds of entries, free-text notes or conflicting records.
- **A stored review can lag the chart.** It is shown with a note naming newer records it never saw, such as the FIT result itself. Without an API key it cannot be redone.
- **Marking a review as checked needs only the "acting as" selector to name a clinician.** There is no sign-in.

### Configuration

- **The configuration pages are read-only.** They show the typed definitions the engine runs on and where each lives in the code. Changing a rule is a code change; there is no rule editor, versioning screen or approval workflow.

### Design gaps found while building

- **A resumed call cannot greet or verify identity.** The kernel's legal-move table has those acts only while a case awaits notification, so the agent can place one continuous outreach call and nothing after. Later steps are done by a navigator. Fixing it means changing the kernel and re-running its proofs.
- **A red flag raises an urgent hand-off, not a kernel escalation.** The kernel has no event for it, and adding one would change the proven file.
- **Two type proofs tested the wrong thing.** Attacks A5 and A6 omitted or mistyped `by`, so they would have been rejected even if the kernel allowed an agent to close a case. A mutation that added `closed` to `AgentEvent` passed unnoticed. Both attacks now carry `by: agent`, and `pnpm mutations` covers the case.
- **The hash chain detects edits and reordering, not truncation.** Deleting the newest events leaves a shorter chain that still verifies. Detecting that needs an anchor outside the database.
- **Evidence is re-checked only on replay.** If a closing Procedure is later withdrawn, the case shows an integrity hold after the next restart, not at the moment the correction arrives.

### Engineering

- **One process, one SQLite file.** No high availability, no horizontal scaling. The timer loop and the API share a process.
- **No sign-in.** "Acting as" is a selector. The server checks only that the identity is in the staff directory and that closures are signed by a clinician.
- **FHIR coverage is narrow.** Nine resource types in, Task out. Communication, QuestionnaireResponse, ServiceRequest, Consent, Provenance and AuditEvent from the spec's mapping are not written. Chart records are stored and displayed; nothing reasons over them except the chart review.
- **A call cannot be continued after a restart.** The call's record survives, but the engine's place in the conversation is held in memory. Such a call shows as "Interrupted".
- **Call timings are partial.** The server measures how long the policy took to choose a line and how long each line took to synthesise or read from cache. The browser measures reply-to-first-audio for the live call only, and that figure is not stored. There is no phone line, so there is no ring time, answer detection, interruption handling or audio recording.
- **De-identification removes digits only.** In stored call text, runs of four or more digits; in text sent to the model policy, all digits. A chart sent for review is stripped of name and identifiers by construction, and still carries a birth year, a sex and clinical detail.
- **ElevenLabs is outside the residency boundary.** It receives the agent's catalogue wording, including appointment times and provider names, and in the guided demo the scripted patient's lines, which include that synthetic patient's identifiers. What a person types or says as the patient is never sent to it. A pilot needs speech synthesis inside the region, or pre-rendered audio for the fixed wording.
- **The speech endpoint has no sign-in.** Anyone who can reach the API can spend the account's characters on catalogue lines or on patient-role text up to 300 characters.
- **CI has run once.** The repository's first push ran the `check` workflow on GitHub and it passed (type check, lint, kernel proof, tests). The mutation controls are not part of CI; run `pnpm mutations` locally.
- **The guided demo's patient is scripted.** The lines the patient says in the hands-free run are fixed and spoken by a synthetic voice. The system's responses are live.
- **Vendored interface components are not type-checked or linted here.** `apps/web/src/reactbits/` holds React Bits source, marked `@ts-nocheck` and excluded from the lint bans.
- **Agent evals are a smoke subset**: ten attack prompts at three stages, the red-flag lists, and scripted dialogues in the test suite. The spec's 200-per-language suites and human-rated teach-back set do not exist.
