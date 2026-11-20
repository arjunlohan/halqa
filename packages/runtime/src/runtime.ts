// The case runtime. One append-only, hash-chained event log; one in-memory projection rebuilt
// from it; and the only code path that changes a case: kernel `decide`, then append.
//
// Durable timers need no timer table. Invariant I2 puts `due` on every open state, so the
// deadline of every open case is recoverable from the log alone. `tick` fires whatever is overdue,
// whenever it runs, including the first tick after a crash.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  actionableResult,
  careRecord,
  chartRecord,
  instant,
  isoFromInstant,
  refOf,
  SNOMED,
  subjectOf,
  versionOf,
  zAppointment,
  zCaseId,
  zPatient,
  zProcedure,
  zResource,
  zSlot,
  type Appointment,
  type ChartRecord,
  type Observation,
  type Patient,
  type Procedure,
  type Resource,
  type Slot,
} from "@halqa/fhir";
import {
  ClosureEvidence,
  decide,
  decideForAgent,
  type Actor,
  type AgentEvent,
  type CareRecord,
  type CaseEvent,
  type CaseId,
  type CaseState,
  type Clinician,
  type EvidenceRejection,
  type HumanClosureReason,
  type Instant,
  type Navigator,
  type OpenState,
  type Owner,
  type PatientRef,
  type Rejection,
  type ResourceRef,
  type Result,
  type Sla,
} from "@halqa/kernel";
import { closingRule, pathwayById, pathways } from "@halqa/pathways";
import * as z from "zod";
import { NAVIGATORS, PROVIDERS, type Provider } from "./directory.js";
import { chainHash, canonicalJson, GENESIS_HASH, toStored, zStoredEvent, type OpenedEvent, type StoredEvent } from "./events.js";
import { err, ok } from "./result.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GST_OFFSET = 4 * HOUR; // Gulf Standard Time, no daylight saving

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fhir_resources (
  type TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, json TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (type, id, version)
);
CREATE TABLE IF NOT EXISTS case_events (
  case_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL,
  payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (case_id, seq)
);
CREATE TRIGGER IF NOT EXISTS case_events_no_update BEFORE UPDATE ON case_events
  BEGIN SELECT RAISE(ABORT, 'case_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS case_events_no_delete BEFORE DELETE ON case_events
  BEGIN SELECT RAISE(ABORT, 'case_events is append-only'); END;
CREATE TABLE IF NOT EXISTS utterance_log (
  case_id TEXT NOT NULL, at INTEGER NOT NULL, act TEXT NOT NULL, catalogue_id TEXT NOT NULL,
  catalogue_version INTEGER NOT NULL, lang TEXT NOT NULL, params TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patient_snippets (
  case_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL,
  urgent INTEGER NOT NULL, picked_up_at INTEGER, picked_up_by TEXT
);
CREATE TABLE IF NOT EXISTS evidence_attempts (
  case_id TEXT NOT NULL, at INTEGER NOT NULL, resource TEXT NOT NULL, outcome TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_calls (
  at INTEGER NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, residency TEXT NOT NULL,
  prompt_hash TEXT NOT NULL, tool TEXT, latency_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  channel TEXT NOT NULL, lang TEXT NOT NULL, policy TEXT NOT NULL, identity TEXT NOT NULL, end_reason TEXT
);
CREATE TABLE IF NOT EXISTS call_turns (
  call_id TEXT NOT NULL, idx INTEGER NOT NULL, at INTEGER NOT NULL, speaker TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (call_id, idx)
);
CREATE TABLE IF NOT EXISTS review_marks (
  patient TEXT NOT NULL, bundle_hash TEXT NOT NULL, kind TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS speech_events (
  call_id TEXT NOT NULL, idx INTEGER NOT NULL, at INTEGER NOT NULL, cached INTEGER NOT NULL,
  ms INTEGER NOT NULL, characters INTEGER NOT NULL, voice TEXT NOT NULL
);
`;

// Rows are parsed on the way out, like every other boundary.
const zEventRow = z.object({
  case_id: z.string(),
  seq: z.number().int(),
  at: z.number().int(),
  type: z.string(),
  payload: z.string(),
  prev_hash: z.string(),
  hash: z.string(),
});
const zJsonRow = z.object({ json: z.string() });
const zHandoffRow = z.object({
  id: z.number().int(),
  case_id: zCaseId,
  at: z.number().int(),
  reason: z.string(),
  urgent: z.number().int(),
  picked_up_at: z.number().int().nullable(),
  picked_up_by: z.string().nullable(),
});
const zUtteranceRow = z.object({
  case_id: z.string(),
  at: z.number().int(),
  act: z.string(),
  catalogue_id: z.string(),
  catalogue_version: z.number().int(),
  lang: z.string(),
  params: z.string(),
});
const zSnippetRow = z.object({ case_id: z.string(), at: z.number().int(), kind: z.string(), text: z.string() });
const zAttemptRow = z.object({ case_id: z.string(), at: z.number().int(), resource: z.string(), outcome: z.string() });
const zModelCallRow = z.object({
  at: z.number().int(),
  role: z.string(),
  model: z.string(),
  residency: z.string(),
  prompt_hash: z.string(),
  tool: z.string().nullable(),
  latency_ms: z.number().int(),
});

const zCallRow = z.object({
  id: z.string(),
  case_id: zCaseId,
  started_at: z.number().int(),
  ended_at: z.number().int().nullable(),
  channel: z.string(),
  lang: z.string(),
  policy: z.string(),
  identity: z.string(),
  end_reason: z.string().nullable(),
});
const zCallTurnRow = z.object({ call_id: z.string(), idx: z.number().int(), at: z.number().int(), speaker: z.string(), payload: z.string() });
const zSpeechRow = z.object({
  call_id: z.string(),
  idx: z.number().int(),
  at: z.number().int(),
  cached: z.number().int(),
  ms: z.number().int(),
  characters: z.number().int(),
  voice: z.string(),
});

const zReviewMarkRow = z.object({ patient: z.string(), bundle_hash: z.string(), kind: z.string(), by: z.string(), at: z.number().int() });

/** A person's response to a chart review: they checked it against the chart, or reported it as wrong. */
export type ReviewMark = { readonly bundleHash: string; readonly kind: "checked" | "reported-inaccurate"; readonly by: string; readonly at: number };

export type CallRecord = {
  readonly id: string;
  readonly caseId: CaseId;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** How the call was carried: "web" for a browser session, "scripted" for seeded history. */
  readonly channel: string;
  readonly lang: string;
  /** The act-selection policy that ran the call. */
  readonly policy: string;
  readonly identity: string;
  readonly endReason: string | null;
};

export type CallTurnRecord = { readonly idx: number; readonly at: number; readonly speaker: string; readonly payload: unknown };

export type SpeechRecord = { readonly idx: number; readonly at: number; readonly cached: boolean; readonly ms: number; readonly characters: number; readonly voice: string };

export type CaseIntegrity = { readonly ok: true } | { readonly ok: false; readonly atSeq: number; readonly why: string };

export type CaseRecord = {
  readonly state: CaseState;
  readonly openedAt: Instant;
  /** Sequence number and hash of the newest event. */
  readonly seq: number;
  readonly head: string;
  readonly integrity: CaseIntegrity;
};

export type Commit = { readonly state: CaseState; readonly seq: number; readonly hash: string };
export type CommitError = Rejection | { readonly reason: "unknown-case" } | { readonly reason: "integrity-hold" };

export type TimelineRow = {
  readonly seq: number;
  readonly at: number;
  readonly event: StoredEvent;
  readonly hash: string;
  readonly prevHash: string;
};

export type ChainCheck = { readonly ok: true; readonly length: number } | { readonly ok: false; readonly atSeq: number };

export type IngestEffect =
  | { readonly kind: "case-opened"; readonly caseId: CaseId }
  | { readonly kind: "case-exists"; readonly caseId: CaseId }
  | { readonly kind: "case-closed"; readonly caseId: CaseId }
  | { readonly kind: "evidence-rejected"; readonly caseId: CaseId; readonly reason: EvidenceRejection | "unusable-record" }
  | { readonly kind: "appointment-missed"; readonly caseId: CaseId }
  | { readonly kind: "care-attended"; readonly caseId: CaseId };

export type IngestOutcome =
  | { readonly status: "rejected"; readonly issues: string }
  | { readonly status: "duplicate"; readonly ref: ResourceRef }
  | { readonly status: "stored"; readonly ref: ResourceRef; readonly effects: readonly IngestEffect[] };

export type SlotOffer = { readonly slotId: string; readonly at: Instant; readonly provider: Provider };

export type BookingError =
  | CommitError
  | { readonly reason: "slot-unavailable" }
  | { readonly reason: "not-awaiting-booking"; readonly from: CaseState["kind"] };

export type HandoffReason =
  | "patient-request"
  | "red-flag"
  | "failed-identity"
  | "teach-back-not-passed"
  | "out-of-catalogue"
  | "reschedule"
  | "no-suitable-slot";

export type Handoff = {
  readonly id: number;
  readonly caseId: CaseId;
  readonly at: number;
  readonly reason: string;
  readonly urgent: boolean;
  readonly pickedUpAt: number | null;
  readonly pickedUpBy: string | null;
};

export type RuntimeOptions = {
  /** SQLite file path, or ":memory:". */
  readonly path: string;
  /** Wall clock in epoch milliseconds. Tests inject a fixed one. */
  readonly wallClock?: () => number;
};

type Decider = (state: CaseState, sla: Sla) => Result<CaseState, Rejection>;

const caseIdFor = (result: ResourceRef): CaseId =>
  zCaseId.parse(`case-${createHash("sha256").update(result).digest("hex").slice(0, 12)}`);

const isOpen = (state: CaseState): state is OpenState => state.kind !== "closed";

const SLOT_ID = /^slot-([ab])-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/;

export class CaseRuntime {
  readonly #db: DatabaseSync;
  readonly #wall: () => number;
  #offsetMs = 0;
  readonly #cases = new Map<CaseId, CaseRecord>();
  #unreadableCases = 0;

  constructor(options: RuntimeOptions) {
    this.#wall = options.wallClock ?? Date.now;
    this.#db = new DatabaseSync(options.path);
    this.#db.exec(SCHEMA);
    const offset = this.#db.prepare("SELECT value FROM meta WHERE key = 'clock_offset_ms'").get();
    const parsed = z.object({ value: z.coerce.number() }).safeParse(offset);
    if (parsed.success) this.#offsetMs = parsed.data.value;
    this.#replay();
  }

  close(): void {
    this.#db.close();
  }

  // ───────────────────────────── Clock ─────────────────────────────
  now(): Instant {
    return instant(this.#wall() + this.#offsetMs);
  }

  /** How far the case clock runs ahead of the wall clock, in milliseconds. Zero unless the sandbox skipped time. */
  clockOffsetMs(): number {
    return this.#offsetMs;
  }

  /** Demo time travel. The offset is persisted, so a restart keeps the travelled time. */
  advanceClock(hours: number): readonly CaseId[] {
    if (!Number.isFinite(hours) || hours <= 0) return [];
    this.#offsetMs += hours * HOUR;
    this.#db
      .prepare("INSERT INTO meta (key, value) VALUES ('clock_offset_ms', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(String(this.#offsetMs));
    return this.tick();
  }

  // ───────────────────────────── Queries ─────────────────────────────
  list(): readonly (CaseRecord & { readonly id: CaseId })[] {
    return [...this.#cases.entries()].map(([id, record]) => ({ id, ...record }));
  }

  get(caseId: CaseId): CaseRecord | undefined {
    return this.#cases.get(caseId);
  }

  health(): { readonly cases: number; readonly unreadableCases: number } {
    return { cases: this.#cases.size, unreadableCases: this.#unreadableCases };
  }

  timeline(caseId: CaseId): readonly TimelineRow[] {
    return this.#eventRows(caseId).flatMap((row) => {
      const event = parseStored(row.payload);
      return event === null ? [] : [{ seq: row.seq, at: row.at, event, hash: row.hash, prevHash: row.prev_hash }];
    });
  }

  /** Recompute the chain from the stored bytes. A changed, removed or reordered row breaks it. */
  verifyChain(caseId: CaseId): ChainCheck {
    let previous = GENESIS_HASH;
    let expectedSeq = 0;
    for (const row of this.#eventRows(caseId)) {
      const intact =
        row.seq === expectedSeq && row.prev_hash === previous && row.hash === chainHash(previous, row.case_id, row.seq, row.payload);
      if (!intact) return { ok: false, atSeq: row.seq };
      previous = row.hash;
      expectedSeq += 1;
    }
    return { ok: true, length: expectedSeq };
  }

  resource(ref: ResourceRef | PatientRef): unknown {
    const [type, id] = ref.split("/");
    const row = this.#db
      .prepare("SELECT json FROM fhir_resources WHERE type = ? AND id = ? ORDER BY rowid DESC LIMIT 1")
      .get(type ?? "", id ?? "");
    const parsed = zJsonRow.safeParse(row);
    return parsed.success ? safeJson(parsed.data.json) : null;
  }

  patient(ref: PatientRef): Patient | null {
    const parsed = zPatient.safeParse(this.resource(ref));
    return parsed.success ? parsed.data : null;
  }

  /** Every record held about one patient, newest version of each, newest first. Undated records come last. */
  chart(patient: PatientRef): readonly ChartRecord[] {
    const rows = z
      .array(zJsonRow)
      .parse(this.#db.prepare("SELECT json FROM fhir_resources WHERE type NOT IN ('Patient', 'Slot') ORDER BY rowid").all());
    const latest = new Map<string, ChartRecord>();
    for (const row of rows) {
      const resource = zResource.safeParse(safeJson(row.json));
      if (!resource.success || subjectOf(resource.data) !== patient) continue;
      const record = chartRecord(resource.data);
      // Rows arrive oldest first, so a later version of the same record replaces the earlier one.
      if (record !== null) latest.set(record.ref, record);
    }
    return [...latest.values()].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  }

  // ───────────────────────────── The one write path ─────────────────────────────
  /** For people and for the system. Accepts any kernel event. */
  apply(caseId: CaseId, event: CaseEvent): Result<Commit, CommitError> {
    return this.#commit(caseId, event, (state, sla) => decide(state, event, sla));
  }

  /** For agent tool handlers. The parameter type admits an AgentEvent and nothing else. */
  applyAgent(caseId: CaseId, event: AgentEvent): Result<Commit, CommitError> {
    return this.#commit(caseId, event, (state, sla) => decideForAgent(state, event, sla));
  }

  /** A clinician closes a case by decision. The evidence is minted here, from a Clinician, or not at all. */
  closeByDecision(
    caseId: CaseId,
    by: Clinician,
    reason: HumanClosureReason,
    note: string,
  ): Result<Commit, CommitError | { readonly reason: "note-required" }> {
    const at = this.now();
    const evidence = ClosureEvidence.fromDecision(by, reason, note, at);
    if (!evidence.ok) return err({ reason: evidence.error });
    return this.apply(caseId, { type: "closed", at, evidence: evidence.value });
  }

  reassign(caseId: CaseId, to: Owner, by: Owner): Result<Commit, CommitError> {
    return this.apply(caseId, { type: "owner-reassigned", at: this.now(), to, by });
  }

  #commit(caseId: CaseId, event: CaseEvent, decider: Decider): Result<Commit, CommitError> {
    const record = this.#cases.get(caseId);
    if (record === undefined) return err({ reason: "unknown-case" });
    if (!record.integrity.ok) return err({ reason: "integrity-hold" });
    const pathway = pathwayById(record.state.pathway);
    if (pathway === undefined) return err({ reason: "unknown-case" });
    const decided = decider(record.state, pathway.sla);
    if (!decided.ok) return decided;
    const hash = this.#append(caseId, record.seq + 1, record.head, toStored(event));
    this.#cases.set(caseId, { ...record, state: decided.value, seq: record.seq + 1, head: hash });
    return ok({ state: decided.value, seq: record.seq + 1, hash });
  }

  #append(caseId: CaseId, seq: number, previous: string, event: StoredEvent): string {
    const payload = canonicalJson(event);
    const hash = chainHash(previous, caseId, seq, payload);
    this.#db
      .prepare("INSERT INTO case_events (case_id, seq, at, type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(caseId, seq, event.at, event.type, payload, previous, hash);
    return hash;
  }

  // ───────────────────────────── Durable timers ─────────────────────────────
  /** Fire `deadline-passed` for every open case whose deadline is behind the clock. Safe to call at any time. */
  tick(): readonly CaseId[] {
    const now = this.now();
    const fired: CaseId[] = [];
    for (const [caseId, record] of this.#cases) {
      let state = record.state;
      // Each deadline restarts the clock from the moment it passed, so a long outage fires each one in order.
      for (let guard = 0; guard < 1000 && isOpen(state) && state.due <= now; guard++) {
        const result = this.apply(caseId, { type: "deadline-passed", at: state.due });
        if (!result.ok) break;
        state = result.value.state;
        if (fired.at(-1) !== caseId) fired.push(caseId);
      }
    }
    return fired;
  }

  // ───────────────────────────── Ingest ─────────────────────────────
  /** Every FHIR resource enters here: parsed, stored once per version, then matched against open work. */
  ingest(raw: unknown): IngestOutcome {
    const parsed = zResource.safeParse(raw);
    if (!parsed.success) return { status: "rejected", issues: z.prettifyError(parsed.error) };
    const resource = parsed.data;
    const ref = refOf(resource);
    if (ref === null) return { status: "rejected", issues: "resource id is not a valid FHIR id" };

    const version = versionOf(resource);
    const inserted = this.#db
      .prepare("INSERT OR IGNORE INTO fhir_resources (type, id, version, json, received_at) VALUES (?, ?, ?, ?, ?)")
      .run(resource.resourceType, resource.id, version, JSON.stringify(raw), this.now());
    if (inserted.changes === 0) return { status: "duplicate", ref };

    return { status: "stored", ref, effects: this.#react(resource) };
  }

  #react(resource: Resource): readonly IngestEffect[] {
    switch (resource.resourceType) {
      case "Observation":
        return this.#onObservation(resource);
      case "Procedure":
        return this.#onProcedure(resource);
      case "Appointment":
        return this.#onAppointment(resource);
      // Chart records change no case: they are stored and read back when someone opens the chart.
      case "Slot":
      case "Patient":
      case "Condition":
      case "MedicationStatement":
      case "Encounter":
      case "FamilyMemberHistory":
        return [];
    }
  }

  #onObservation(observation: Observation): readonly IngestEffect[] {
    const effects: IngestEffect[] = [];
    for (const pathway of pathways) {
      if (pathway.trigger.resource !== "Observation") continue;
      const actionable = actionableResult(observation, {
        codes: pathway.trigger.codes,
        interpretation: pathway.trigger.actionableWhen.interpretation,
      });
      if (actionable === null) continue;

      // One case per result, whatever version of it arrives: the case id is derived from the result.
      const caseId = caseIdFor(actionable.result);
      if (this.#cases.has(caseId)) {
        effects.push({ kind: "case-exists", caseId });
        continue;
      }
      const at = this.now();
      const opened: OpenedEvent = {
        type: "case-opened",
        at,
        patient: actionable.patient,
        result: actionable.result,
        resultedAt: actionable.resultedAt,
        pathway: pathway.id,
        owner: this.#leastLoadedNavigator(),
        due: instant(at + pathway.sla["awaiting-notification"] * HOUR),
      };
      const hash = this.#append(caseId, 0, GENESIS_HASH, opened);
      this.#cases.set(caseId, { state: initialState(caseId, opened), openedAt: at, seq: 0, head: hash, integrity: { ok: true } });
      effects.push({ kind: "case-opened", caseId });
    }
    return effects;
  }

  /** The closure listener. Evidence is checked by the kernel; this only finds the cases a record might close. */
  #onProcedure(procedure: Procedure): readonly IngestEffect[] {
    const care = careRecord(procedure);
    const claimed = new Set(procedure.basedOn.map((r) => r.reference));
    const effects: IngestEffect[] = [];
    for (const [caseId, record] of this.#cases) {
      const state = record.state;
      if (!isOpen(state)) continue;
      const aboutThisPatient = care !== null && care.subject === state.patient;
      const claimsThisCase = claimed.has(`ServiceRequest/${caseId}`);
      if (!aboutThisPatient && !claimsThisCase) continue;

      const resource = refOf(procedure);
      if (care === null || resource === null) {
        this.#recordAttempt(caseId, `Procedure/${procedure.id}`, "unusable-record");
        effects.push({ kind: "evidence-rejected", caseId, reason: "unusable-record" });
        continue;
      }
      const evidence = this.#evidenceFromCare(state, care);
      if (!evidence.ok) {
        this.#recordAttempt(caseId, resource, evidence.error);
        effects.push({ kind: "evidence-rejected", caseId, reason: evidence.error });
        continue;
      }
      const closed = this.apply(caseId, { type: "closed", at: this.now(), evidence: evidence.value });
      if (closed.ok) {
        this.#recordAttempt(caseId, resource, "accepted");
        effects.push({ kind: "case-closed", caseId });
      }
    }
    return effects;
  }

  #onAppointment(appointment: Appointment): readonly IngestEffect[] {
    const ref = refOf(appointment);
    const effects: IngestEffect[] = [];
    for (const [caseId, record] of this.#cases) {
      const state = record.state;
      if (state.kind !== "awaiting-attendance" || state.appointment !== ref) continue;
      if (appointment.status === "noshow") {
        if (this.apply(caseId, { type: "appointment-missed", at: this.now() }).ok) effects.push({ kind: "appointment-missed", caseId });
      } else if (appointment.status === "fulfilled" || appointment.status === "arrived") {
        if (this.apply(caseId, { type: "care-attended", at: this.now() }).ok) effects.push({ kind: "care-attended", caseId });
      }
    }
    return effects;
  }

  #evidenceFromCare(state: OpenState, care: CareRecord): Result<ClosureEvidence, EvidenceRejection | "unusable-record"> {
    const pathway = pathwayById(state.pathway);
    if (pathway === undefined) return err("unusable-record");
    return ClosureEvidence.fromRecord(closingRule(pathway), { patient: state.patient, resultedAt: state.resultedAt }, care);
  }

  #leastLoadedNavigator(): Navigator {
    const load = new Map<string, number>();
    for (const { state } of this.#cases.values()) {
      if (isOpen(state)) load.set(state.owner.practitioner, (load.get(state.owner.practitioner) ?? 0) + 1);
    }
    let best = NAVIGATORS[0];
    if (best === undefined) throw new Error("the directory has no navigator to own a case");
    for (const candidate of NAVIGATORS) {
      if ((load.get(candidate.actor.practitioner) ?? 0) < (load.get(best.actor.practitioner) ?? 0)) best = candidate;
    }
    return best.actor;
  }

  // ───────────────────────────── Replay ─────────────────────────────
  /**
   * Rebuild every case from its events. A closed state is never read back from storage:
   * its evidence is minted again from the record or the clinician's decision, by the kernel.
   */
  #replay(): void {
    this.#cases.clear();
    this.#unreadableCases = 0;
    const rows = z.array(zEventRow).parse(this.#db.prepare("SELECT * FROM case_events ORDER BY case_id, seq").all());
    const byCase = new Map<string, z.infer<typeof zEventRow>[]>();
    for (const row of rows) byCase.set(row.case_id, [...(byCase.get(row.case_id) ?? []), row]);

    for (const [rawId, caseRows] of byCase) {
      const caseId = zCaseId.safeParse(rawId);
      const rebuilt = caseId.success ? this.#rebuild(caseId.data, caseRows) : null;
      if (caseId.success && rebuilt !== null) this.#cases.set(caseId.data, rebuilt);
      else this.#unreadableCases += 1;
    }
  }

  #rebuild(caseId: CaseId, rows: readonly z.infer<typeof zEventRow>[]): CaseRecord | null {
    let record: CaseRecord | null = null;
    let previous = GENESIS_HASH;
    for (const row of rows) {
      const hold = (why: string): CaseRecord | null =>
        record === null ? null : { ...record, integrity: { ok: false, atSeq: row.seq, why } };

      const expectedSeq: number = record === null ? 0 : record.seq + 1;
      const chained = row.seq === expectedSeq && row.prev_hash === previous && row.hash === chainHash(previous, caseId, row.seq, row.payload);
      if (!chained) return hold("hash chain broken");
      const event = parseStored(row.payload);
      if (event === null) return hold("unreadable event");

      if (event.type === "case-opened") {
        if (record !== null) return hold("case opened twice");
        record = { state: initialState(caseId, event), openedAt: event.at, seq: 0, head: row.hash, integrity: { ok: true } };
      } else {
        if (record === null) return null;
        const current: CaseRecord = record;
        const pathway = pathwayById(current.state.pathway);
        if (pathway === undefined) return hold("unknown pathway");
        const kernelEvent = this.#rehydrate(current.state, event);
        if (!kernelEvent.ok) return hold(kernelEvent.error);
        const next = decide(current.state, kernelEvent.value, pathway.sla);
        if (!next.ok) return hold(`event rejected on replay: ${next.error.reason}`);
        record = { ...current, state: next.value, seq: row.seq, head: row.hash };
      }
      previous = row.hash;
    }
    return record;
  }

  #rehydrate(state: CaseState, event: Exclude<StoredEvent, OpenedEvent>): Result<CaseEvent, string> {
    if (event.type !== "closed") return ok(event);
    if (!isOpen(state)) return err("closed twice");
    if (event.basis.kind === "human-decision") {
      const evidence = ClosureEvidence.fromDecision(event.basis.by, event.basis.reason, event.basis.note, event.at);
      return evidence.ok ? ok({ type: "closed", at: event.at, evidence: evidence.value }) : err("closure note no longer valid");
    }
    const procedure = zProcedure.safeParse(this.resource(event.basis.resource));
    const care = procedure.success ? careRecord(procedure.data) : null;
    if (care === null) return err("closing record is missing or unreadable");
    const evidence = this.#evidenceFromCare(state, care);
    return evidence.ok
      ? ok({ type: "closed", at: event.at, evidence: evidence.value })
      : err(`closing record no longer proves care: ${evidence.error}`);
  }

  // ───────────────────────────── Scheduling ─────────────────────────────
  /** The next free colonoscopy slots across both providers, earliest first, at least two days out. */
  freeSlots(count: number, skip = 0): readonly SlotOffer[] {
    const offers: SlotOffer[] = [];
    let skipped = 0;
    const firstDay = Math.floor((this.now() + 2 * DAY + GST_OFFSET) / DAY);
    for (let day = firstDay; day < firstDay + 120 && offers.length < count; day++) {
      const weekday = new Date(day * DAY).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const daySlots = PROVIDERS.flatMap((provider) => provider.starts.map((minutes) => ({ provider, minutes }))).sort(
        (a, b) => a.minutes - b.minutes,
      );
      for (const { provider, minutes } of daySlots) {
        const at = instant(day * DAY - GST_OFFSET + minutes * 60_000);
        const slotId = slotIdFor(provider, at);
        if (this.#slotBusy(slotId)) continue;
        if (skipped < skip) skipped += 1;
        else if (offers.length < count) offers.push({ slotId, at, provider });
      }
    }
    return offers;
  }

  slot(slotId: string): SlotOffer | null {
    const match = SLOT_ID.exec(slotId);
    if (match === null) return null;
    const [, key, y, m, d, hh, mm] = match;
    const provider = PROVIDERS.find((p) => p.key === key);
    const minutes = Number(hh) * 60 + Number(mm);
    if (provider === undefined || !provider.starts.includes(minutes)) return null;
    const at = Date.UTC(Number(y), Number(m) - 1, Number(d)) - GST_OFFSET + minutes * 60_000;
    const weekday = new Date(at + GST_OFFSET).getUTCDay();
    if (!Number.isFinite(at) || weekday === 0 || weekday === 6) return null;
    return { slotId, at: instant(at), provider };
  }

  /** Book a slot: write the Slot and Appointment to the record, then advance the case. */
  book(caseId: CaseId, slotId: string, by: Actor): Result<Commit & { readonly appointment: ResourceRef }, BookingError> {
    const record = this.#cases.get(caseId);
    if (record === undefined) return err({ reason: "unknown-case" });
    if (record.state.kind !== "awaiting-booking") return err({ reason: "not-awaiting-booking", from: record.state.kind });
    const offer = this.slot(slotId);
    if (offer === null || offer.at <= this.now() || this.#slotBusy(slotId)) return err({ reason: "slot-unavailable" });

    const appointmentId = `appt-${createHash("sha256").update(`${caseId}:${slotId}:${record.seq}`).digest("hex").slice(0, 12)}`;
    const start = isoFromInstant(offer.at);
    const end = isoFromInstant(instant(offer.at + HOUR));
    const slot: Slot = {
      resourceType: "Slot",
      id: slotId,
      meta: { versionId: "1" },
      status: "busy",
      start,
      end,
      schedule: { reference: `Schedule/endoscopy-${offer.provider.key}`, display: offer.provider.name.en },
    };
    const appointment: Appointment = {
      resourceType: "Appointment",
      id: appointmentId,
      meta: { versionId: "1" },
      status: "booked",
      start,
      end,
      slot: [{ reference: `Slot/${slotId}` }],
      serviceType: [{ coding: [{ system: SNOMED, code: "73761001", display: "Colonoscopy" }] }],
      participant: [
        { actor: { reference: record.state.patient }, status: "accepted" },
        { actor: { reference: `Location/endoscopy-${offer.provider.key}`, display: offer.provider.name.en }, status: "accepted" },
      ],
    };
    const ref = refOf(appointment);
    if (ref === null) return err({ reason: "slot-unavailable" });
    this.ingest(slot);
    this.ingest(appointment);

    const at = this.now();
    const committed =
      by.kind === "agent"
        ? this.applyAgent(caseId, { type: "appointment-booked", at, appointment: ref, by })
        : this.apply(caseId, { type: "appointment-booked", at, appointment: ref, by });
    return committed.ok ? ok({ ...committed.value, appointment: ref }) : committed;
  }

  appointment(ref: ResourceRef): Appointment | null {
    const parsed = zAppointment.safeParse(this.resource(ref));
    return parsed.success ? parsed.data : null;
  }

  #slotBusy(slotId: string): boolean {
    const row = this.#db
      .prepare("SELECT json FROM fhir_resources WHERE type = 'Slot' AND id = ? ORDER BY rowid DESC LIMIT 1")
      .get(slotId);
    const json = zJsonRow.safeParse(row);
    if (!json.success) return false;
    const slot = zSlot.safeParse(safeJson(json.data.json));
    return slot.success && slot.data.status !== "free";
  }

  // ───────────────────────────── Hand-offs and logs ─────────────────────────────
  raiseHandoff(caseId: CaseId, reason: HandoffReason, urgent: boolean): void {
    this.#db.prepare("INSERT INTO handoffs (case_id, at, reason, urgent) VALUES (?, ?, ?, ?)").run(caseId, this.now(), reason, urgent ? 1 : 0);
  }

  pickUpHandoff(id: number, by: Owner): boolean {
    const result = this.#db
      .prepare("UPDATE handoffs SET picked_up_at = ?, picked_up_by = ? WHERE id = ? AND picked_up_at IS NULL")
      .run(this.now(), by.practitioner, id);
    return result.changes === 1;
  }

  handoffs(): readonly Handoff[] {
    return z
      .array(zHandoffRow)
      .parse(this.#db.prepare("SELECT * FROM handoffs ORDER BY id").all())
      .map((row) => ({
        id: row.id,
        caseId: row.case_id,
        at: row.at,
        reason: row.reason,
        urgent: row.urgent === 1,
        pickedUpAt: row.picked_up_at,
        pickedUpBy: row.picked_up_by,
      }));
  }

  /** The exact record of system speech: act, catalogue version, language and slot values. No audio, no free text. */
  logUtterance(caseId: CaseId, utterance: { act: string; lang: string; params: unknown; catalogueId: string; catalogueVersion: number }): void {
    this.#db
      .prepare("INSERT INTO utterance_log (case_id, at, act, catalogue_id, catalogue_version, lang, params) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(caseId, this.now(), utterance.act, utterance.catalogueId, utterance.catalogueVersion, utterance.lang, canonicalJson(utterance.params));
  }

  utterances(caseId: CaseId): readonly z.infer<typeof zUtteranceRow>[] {
    return z.array(zUtteranceRow).parse(this.#db.prepare("SELECT * FROM utterance_log WHERE case_id = ? ORDER BY rowid").all(caseId));
  }

  /** Patient words are kept only for teach-back answers and red-flag snippets. */
  logSnippet(caseId: CaseId, kind: "teach-back-answer" | "red-flag", text: string): void {
    this.#db.prepare("INSERT INTO patient_snippets (case_id, at, kind, text) VALUES (?, ?, ?, ?)").run(caseId, this.now(), kind, text.slice(0, 500));
  }

  snippets(caseId: CaseId): readonly z.infer<typeof zSnippetRow>[] {
    return z.array(zSnippetRow).parse(this.#db.prepare("SELECT * FROM patient_snippets WHERE case_id = ? ORDER BY rowid").all(caseId));
  }

  evidenceAttempts(caseId: CaseId): readonly z.infer<typeof zAttemptRow>[] {
    return z.array(zAttemptRow).parse(this.#db.prepare("SELECT * FROM evidence_attempts WHERE case_id = ? ORDER BY rowid").all(caseId));
  }

  #recordAttempt(caseId: CaseId, resource: string, outcome: string): void {
    this.#db.prepare("INSERT INTO evidence_attempts (case_id, at, resource, outcome) VALUES (?, ?, ?, ?)").run(caseId, this.now(), resource, outcome);
  }

  /** Model calls are logged by hash. Raw prompt text is not stored. */
  logModelCall(call: { role: string; model: string; residency: "in-region" | "out-of-region"; prompt: string; tool: string | null; latencyMs: number }): void {
    this.#db
      .prepare("INSERT INTO model_calls (at, role, model, residency, prompt_hash, tool, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.now(), call.role, call.model, call.residency, createHash("sha256").update(call.prompt).digest("hex"), call.tool, Math.round(call.latencyMs));
  }

  modelCalls(): readonly z.infer<typeof zModelCallRow>[] {
    return z.array(zModelCallRow).parse(this.#db.prepare("SELECT * FROM model_calls ORDER BY rowid").all());
  }

  // ───────────────────────────── Chart reviews ─────────────────────────────
  /** A member of staff records that they checked a review against the chart, or that it is wrong. */
  markReview(patient: PatientRef, bundleHash: string, kind: ReviewMark["kind"], by: Owner): void {
    this.#db
      .prepare("INSERT INTO review_marks (patient, bundle_hash, kind, by, at) VALUES (?, ?, ?, ?, ?)")
      .run(patient, bundleHash, kind, by.practitioner, this.now());
  }

  reviewMarks(patient: PatientRef): readonly ReviewMark[] {
    return z
      .array(zReviewMarkRow)
      .parse(this.#db.prepare("SELECT * FROM review_marks WHERE patient = ? ORDER BY rowid").all(patient))
      .map((row) => ({ bundleHash: row.bundle_hash, kind: row.kind === "checked" ? "checked" : "reported-inaccurate", by: row.by, at: row.at }));
  }

  /** How many records of each type the store holds, counting each version once. */
  resourceCounts(): readonly { readonly type: string; readonly count: number }[] {
    return z
      .array(z.object({ type: z.string(), count: z.number().int() }))
      .parse(this.#db.prepare("SELECT type, COUNT(*) AS count FROM fhir_resources GROUP BY type ORDER BY type").all());
  }

  // ───────────────────────────── The call log ─────────────────────────────
  // What was said on each call, turn by turn. The engine decides what a turn's payload holds;
  // this only stores it and reads it back.
  openCall(call: { id: string; caseId: CaseId; channel: string; lang: string; policy: string }): void {
    this.#db
      .prepare("INSERT INTO calls (id, case_id, started_at, channel, lang, policy, identity) VALUES (?, ?, ?, ?, ?, ?, 'unverified')")
      .run(call.id, call.caseId, this.now(), call.channel, call.lang, call.policy);
  }

  updateCall(id: string, change: { lang: string; identity: string; endReason: string | null }): void {
    // `ended_at` is set once, by the update that first carries an end reason.
    this.#db
      .prepare(
        "UPDATE calls SET lang = ?, identity = ?, end_reason = ?, ended_at = CASE WHEN ended_at IS NULL AND ? IS NOT NULL THEN ? ELSE ended_at END WHERE id = ?",
      )
      .run(change.lang, change.identity, change.endReason, change.endReason, this.now(), id);
  }

  logCallTurn(callId: string, speaker: "agent" | "patient", payload: unknown): number {
    const next = z
      .object({ next: z.number().int() })
      .parse(this.#db.prepare("SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM call_turns WHERE call_id = ?").get(callId)).next;
    this.#db
      .prepare("INSERT INTO call_turns (call_id, idx, at, speaker, payload) VALUES (?, ?, ?, ?, ?)")
      .run(callId, next, this.now(), speaker, canonicalJson(payload));
    return next;
  }

  calls(): readonly CallRecord[] {
    return z
      .array(zCallRow)
      .parse(this.#db.prepare("SELECT * FROM calls ORDER BY started_at DESC, rowid DESC").all())
      .map(toCallRecord);
  }

  call(id: string): CallRecord | null {
    const row = zCallRow.safeParse(this.#db.prepare("SELECT * FROM calls WHERE id = ?").get(id));
    return row.success ? toCallRecord(row.data) : null;
  }

  callTurns(callId: string): readonly CallTurnRecord[] {
    return z
      .array(zCallTurnRow)
      .parse(this.#db.prepare("SELECT * FROM call_turns WHERE call_id = ? ORDER BY idx").all(callId))
      .map((row) => ({ idx: row.idx, at: row.at, speaker: row.speaker, payload: safeJson(row.payload) }));
  }

  /** One synthesis of one agent turn, as this server saw it. False when the turn does not exist. */
  logSpeech(callId: string, idx: number, speech: { cached: boolean; ms: number; characters: number; voice: string }): boolean {
    const turn = this.#db.prepare("SELECT 1 AS found FROM call_turns WHERE call_id = ? AND idx = ? AND speaker = 'agent'").get(callId, idx);
    if (turn === undefined) return false;
    this.#db
      .prepare("INSERT INTO speech_events (call_id, idx, at, cached, ms, characters, voice) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(callId, idx, this.now(), speech.cached ? 1 : 0, Math.round(speech.ms), speech.characters, speech.voice);
    return true;
  }

  speech(callId: string): readonly SpeechRecord[] {
    return z
      .array(zSpeechRow)
      .parse(this.#db.prepare("SELECT * FROM speech_events WHERE call_id = ? ORDER BY rowid").all(callId))
      .map((row) => ({ idx: row.idx, at: row.at, cached: row.cached === 1, ms: row.ms, characters: row.characters, voice: row.voice }));
  }

  #eventRows(caseId: CaseId): readonly z.infer<typeof zEventRow>[] {
    return z.array(zEventRow).parse(this.#db.prepare("SELECT * FROM case_events WHERE case_id = ? ORDER BY seq").all(caseId));
  }
}

const toCallRecord = (row: z.infer<typeof zCallRow>): CallRecord => ({
  id: row.id,
  caseId: row.case_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  channel: row.channel,
  lang: row.lang,
  policy: row.policy,
  identity: row.identity,
  endReason: row.end_reason,
});

const initialState = (id: CaseId, opened: OpenedEvent): OpenState => ({
  kind: "awaiting-notification",
  id,
  patient: opened.patient,
  result: opened.result,
  resultedAt: opened.resultedAt,
  pathway: opened.pathway,
  owner: opened.owner,
  due: opened.due,
  escalation: 0,
});

const slotIdFor = (provider: Provider, at: Instant): string => {
  const local = new Date(at + GST_OFFSET);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}`;
  return `slot-${provider.key}-${date}-${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}`;
};

/** Parsed JSON, or null when the text is not JSON. */
export const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const parseStored = (payload: string): StoredEvent | null => {
  const parsed = zStoredEvent.safeParse(safeJson(payload));
  return parsed.success ? parsed.data : null;
};
