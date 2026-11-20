# Data declaration

The prototype uses no real patient data and no organiser data. Every source is listed here. Update this file in the same commit as any new source.

| Source | Used for | Right to use | Personal data |
| --- | --- | --- | --- |
| Team-written synthetic cohort (`packages/runtime/src/cohort.ts`, `directory.ts`) | Nine fictional patients, each with a small hand-written chart (conditions, medicines, laboratory results, earlier procedures, family history, visits); five fictional staff; two fictional endoscopy providers; appointment slots | Authored by the team | None. Names are a first name and an initial. The MRN and the national identifier are invented formats. No chart describes a real person |
| Chart reviews (`packages/review/src/stored-reviews.json`) | Claude's review of each synthetic chart, shown in the console | Generated on 20 November 2026 by `claude-fable-5-2` running as a Claude Code agent, from the synthetic chart text only | None |
| Team-written FHIR builders (`packages/runtime/src/synthetic.ts`) | Positive FIT Observations, colonoscopy Procedures, appointment updates | Authored by the team | None |
| LOINC codes 29771-3, 57905-2, 58453-2, and 718-7, 2276-4, 4548-4, 62238-1 in the synthetic charts | Recognising a FIT result; labelling synthetic laboratory results | LOINC is free under its licence. The four laboratory codes were written from memory and not checked against a LOINC release | None |
| SNOMED CT codes 73761001 (colonoscopy) and 44441009 (sigmoidoscopy, as a negative example), and ten condition and procedure codes in the synthetic charts | Recognising the closing procedure; labelling synthetic conditions | SNOMED CT needs a licence; its status for this use is unverified. The chart codes were written from memory and not checked against a SNOMED release | None |
| Published studies cited in the build spec | Three calibration targets and the time-to-care anchor in the simulation | Public literature, cited in the simulation's assumptions table | None |
| Simulated cohort (`packages/evals/src/sim.ts`) | 10,000 synthetic patients per arm | Generated from a seeded random number generator | None |
| React Bits components (`apps/web/src/reactbits/`) and the Geist, Instrument Serif and IBM Plex Sans Arabic fonts | The landing page and the guided demo | React Bits is under MIT with the Commons Clause: free to use inside an application, not to resell as components. The fonts are under the SIL Open Font Licence | None |
| shadcn/ui components (`apps/web/src/components/ui/`), Radix UI, Tailwind CSS, Lucide icons | The console | MIT (Lucide: ISC) | None |
| ElevenLabs text to speech, model `eleven_v4`, premade voices Sarah and George | Speaking the agent's catalogue wording and the scripted demo patient's lines | The team's ElevenLabs account, under its terms | None. The text sent is synthetic. No recording of any person is made or stored; generated audio is cached in `data/tts-cache/` |
| Approved-wording catalogue (`packages/catalogue/src/index.ts`) | What the agent says, in Arabic and English | Authored by the team. Marked "not clinically approved". Not reviewed by a clinician or a native-speaker linguist | None |

## Not used, though the build spec planned them

| Planned source | Status |
| --- | --- |
| Synthea synthetic patients | Not used. The cohort is six hand-written patients |
| Team voice recordings | None made. No person's voice is recorded. The only audio stored is synthetic speech generated from the catalogue |
| Mock legacy referral portal | Not built |

## Rules that hold throughout

- No scraping, and no real names, records or phone numbers.
- The landing page, the demo and the console each say that the data is synthetic.
- System speech is stored as act id, catalogue version, language and slot values, never as text or audio.
- A call's record keeps the patient's replies as text with every run of four or more digits removed. The reply to the identity question is checked in memory and never stored. Teach-back answers and replies that matched a red-flag rule are also kept in full, capped at 500 characters, for clinical review. Names a patient speaks aloud are not detected. That is acceptable for synthetic data and not for a pilot.
- A chart sent for review carries a birth year, a sex and the clinical entries, and no name, MRN or national identifier. That is pseudonymised, not anonymous: a rare combination of conditions can still point at one person.
- With the Claude brain on, patient text has all digit runs removed before it leaves the process. Every model call is logged by a hash of its prompt, never the prompt text.
