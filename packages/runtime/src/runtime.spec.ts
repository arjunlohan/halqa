import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ClosureEvidence, decide, type Agent, type CaseEvent, type CaseId } from "@halqa/kernel";
import { crcFitPositive } from "@halqa/pathways";
import { afterEach, describe, expect, it } from "vitest";
import { CLINICIANS, NAVIGATORS } from "./directory.js";
import { zAgentEvent } from "./events.js";
import { CaseRuntime, type IngestOutcome } from "./runtime.js";
import { appointmentUpdate, colonoscopyProcedure, fitObservation } from "./synthetic.js";

const T0 = Date.UTC(2026, 10, 19, 6, 0, 0); // Thursday 19 November 2026, 10:00 in Abu Dhabi
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PATIENT = "Patient/syn-ahmed";
const agent: Agent = { kind: "agent", model: "test-model", runId: "run-1" };

const dirs: string[] = [];
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "halqa-"));
  dirs.push(dir);
  return join(dir, "halqa.db");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fresh = (path = ":memory:", wall = T0) => new CaseRuntime({ path, wallClock: () => wall });

const onlyCase = (outcome: IngestOutcome): CaseId => {
  if (outcome.status !== "stored") throw new Error(`expected stored, got ${outcome.status}`);
  const [effect] = outcome.effects;
  if (effect === undefined || effect.kind !== "case-opened") throw new Error("expected one case-opened effect");
  return effect.caseId;
};

const openCase = (runtime: CaseRuntime, id = "fit-1"): CaseId =>
  onlyCase(runtime.ingest(fitObservation({ id, patient: PATIENT, issuedAt: T0 - HOUR })));

/** Walk a case to awaiting-attendance the way the agent would. */
const bookedCase = (runtime: CaseRuntime): CaseId => {
  const caseId = openCase(runtime);
  expect(runtime.applyAgent(caseId, { type: "patient-notified", at: runtime.now(), channel: "voice", by: agent }).ok).toBe(true);
  expect(runtime.applyAgent(caseId, { type: "patient-acknowledged", at: runtime.now(), teachBack: "passed", by: agent }).ok).toBe(true);
  const [slot] = runtime.freeSlots(1);
  if (slot === undefined) throw new Error("no slot");
  expect(runtime.book(caseId, slot.slotId, agent).ok).toBe(true);
  return caseId;
};

describe("ingest", () => {
  it("opens exactly one case for a positive FIT, with a human owner and a deadline", () => {
    const runtime = fresh();
    const caseId = openCase(runtime);
    const record = runtime.get(caseId);
    expect(runtime.list()).toHaveLength(1);
    expect(record?.state.kind).toBe("awaiting-notification");
    if (record?.state.kind !== "awaiting-notification") throw new Error("unreachable");
    expect(record.state.owner.kind).toBe("navigator");
    expect(record.state.due).toBe(T0 + crcFitPositive.sla["awaiting-notification"] * HOUR);
  });

  it("is idempotent: the same result twice, or a new version of it, still opens one case", () => {
    const runtime = fresh();
    const fit = fitObservation({ id: "fit-1", patient: PATIENT, issuedAt: T0 - HOUR });
    onlyCase(runtime.ingest(fit));
    expect(runtime.ingest(fit).status).toBe("duplicate");
    const amended = runtime.ingest({ ...fit, meta: { versionId: "2" } });
    expect(amended).toMatchObject({ status: "stored", effects: [{ kind: "case-exists" }] });
    expect(runtime.list()).toHaveLength(1);
    expect(runtime.timeline(runtime.list()[0]?.id ?? ("" as CaseId))).toHaveLength(1);
  });

  it("negative controls: results that are not actionable open nothing", () => {
    const runtime = fresh();
    const base = { patient: PATIENT, issuedAt: T0 - HOUR };
    expect(runtime.ingest(fitObservation({ ...base, id: "neg", positive: false }))).toMatchObject({ status: "stored", effects: [] });
    expect(runtime.ingest(fitObservation({ ...base, id: "hba1c", code: "4548-4" }))).toMatchObject({ status: "stored", effects: [] });
    expect(runtime.ingest(fitObservation({ ...base, id: "prelim", status: "preliminary" }))).toMatchObject({ status: "stored", effects: [] });
    expect(runtime.ingest({ resourceType: "Observation", id: "bad id!", status: "final" }).status).toBe("rejected");
    expect(runtime.ingest({ resourceType: "MedicationRequest", id: "x" }).status).toBe("rejected");
    expect(runtime.list()).toHaveLength(0);
  });

  it("shares new cases across navigators", () => {
    const runtime = fresh();
    const owners = ["a", "b", "c"].map((id) => {
      const state = runtime.get(openCase(runtime, `fit-${id}`))?.state;
      return state !== undefined && state.kind !== "closed" ? state.owner.practitioner : "";
    });
    expect(new Set(owners).size).toBe(NAVIGATORS.length);
  });
});

describe("durable timers", () => {
  it("a missed deadline escalates and restarts the clock, and never closes the case", () => {
    const runtime = fresh();
    const caseId = openCase(runtime);
    expect(runtime.advanceClock(23)).toEqual([]);
    expect(runtime.advanceClock(2)).toEqual([caseId]);
    const once = runtime.get(caseId)?.state;
    expect(once).toMatchObject({ kind: "awaiting-notification", escalation: 1, due: T0 + 48 * HOUR });

    runtime.advanceClock(24 * 30);
    const later = runtime.get(caseId)?.state;
    expect(later).toMatchObject({ kind: "awaiting-notification", escalation: 3 });
    expect(runtime.verifyChain(caseId).ok).toBe(true);
  });

  it("survives a restart: a deadline that passed while the process was down fires on the next tick", () => {
    const path = tempDb();
    const first = fresh(path, T0);
    const caseId = openCase(first);
    first.close();

    const second = fresh(path, T0 + 30 * HOUR);
    expect(second.get(caseId)?.state).toMatchObject({ kind: "awaiting-notification", escalation: 0 });
    expect(second.tick()).toEqual([caseId]);
    expect(second.get(caseId)?.state).toMatchObject({ escalation: 1 });
    second.close();
  });

  it("survives kill -9: the event and the pending deadline are both still there", () => {
    const path = tempDb();
    const fixture = fileURLToPath(new URL("./kill.fixture.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", fixture, path, String(T0)], {
      encoding: "utf8",
    });
    expect(child.signal).toBe("SIGKILL");
    const caseId = onlyCase(JSON.parse(child.stdout.trim()));

    const survivor = fresh(path, T0 + 25 * HOUR);
    expect(survivor.get(caseId)?.state.kind).toBe("awaiting-notification");
    expect(survivor.verifyChain(caseId)).toEqual({ ok: true, length: 1 });
    expect(survivor.tick()).toEqual([caseId]);
    expect(survivor.timeline(caseId).map((row) => row.event.type)).toEqual(["case-opened", "deadline-passed"]);
    survivor.close();
  });

  it("time travel is persisted across restarts", () => {
    const path = tempDb();
    const first = fresh(path, T0);
    first.advanceClock(5);
    first.close();
    const second = fresh(path, T0);
    expect(second.now()).toBe(T0 + 5 * HOUR);
    second.close();
  });
});

describe("scheduling", () => {
  it("offers weekday slots at least two days out, across both providers", () => {
    const runtime = fresh();
    const slots = runtime.freeSlots(6);
    expect(slots).toHaveLength(6);
    expect(new Set(slots.map((s) => s.provider.key))).toEqual(new Set(["a", "b"]));
    for (const slot of slots) {
      expect(slot.at).toBeGreaterThanOrEqual(T0 + 2 * DAY);
      const weekday = new Date(slot.at + 4 * HOUR).getUTCDay();
      expect([1, 2, 3, 4, 5]).toContain(weekday);
      expect(runtime.slot(slot.slotId)).toEqual(slot);
    }
    expect([...slots].sort((a, b) => a.at - b.at)).toEqual(slots);
  });

  it("booking writes an Appointment to the record and takes the slot off the list", () => {
    const runtime = fresh();
    const caseId = bookedCase(runtime);
    const state = runtime.get(caseId)?.state;
    if (state?.kind !== "awaiting-attendance") throw new Error("expected awaiting-attendance");
    const appointment = runtime.appointment(state.appointment);
    expect(appointment).toMatchObject({ status: "booked", participant: [{ actor: { reference: PATIENT } }, {}] });
    const taken = appointment?.slot[0]?.reference.replace("Slot/", "");
    expect(runtime.freeSlots(20).map((s) => s.slotId)).not.toContain(taken);
  });

  it("negative controls: a made-up slot, a taken slot and the wrong state are all refused", () => {
    const runtime = fresh();
    const booked = bookedCase(runtime);
    expect(runtime.book(booked, "slot-a-20991231-0830", agent)).toMatchObject({ ok: false, error: { reason: "not-awaiting-booking" } });

    const other = openCase(runtime, "fit-2");
    runtime.applyAgent(other, { type: "patient-notified", at: runtime.now(), channel: "voice", by: agent });
    runtime.applyAgent(other, { type: "patient-acknowledged", at: runtime.now(), teachBack: "passed", by: agent });
    const state = runtime.get(booked)?.state;
    const takenSlot = state?.kind === "awaiting-attendance" ? runtime.appointment(state.appointment)?.slot[0]?.reference.replace("Slot/", "") : undefined;
    expect(runtime.book(other, takenSlot ?? "", agent)).toMatchObject({ ok: false, error: { reason: "slot-unavailable" } });
    expect(runtime.book(other, "slot-z-20261123-0830", agent)).toMatchObject({ ok: false, error: { reason: "slot-unavailable" } });
    expect(runtime.book(other, "slot-a-20261121-0830", agent)).toMatchObject({ ok: false, error: { reason: "slot-unavailable" } }); // a Saturday
    expect(runtime.get(other)?.state.kind).toBe("awaiting-booking");
  });

  it("a no-show in the record sends the case back to booking, one level louder", () => {
    const runtime = fresh();
    const caseId = bookedCase(runtime);
    const state = runtime.get(caseId)?.state;
    if (state?.kind !== "awaiting-attendance") throw new Error("expected awaiting-attendance");
    const appointment = runtime.appointment(state.appointment);
    if (appointment === null) throw new Error("appointment missing");
    expect(runtime.ingest(appointmentUpdate(appointment, "noshow"))).toMatchObject({ effects: [{ kind: "appointment-missed", caseId }] });
    expect(runtime.get(caseId)?.state).toMatchObject({ kind: "awaiting-booking", escalation: 1 });
  });
});

describe("closure listener", () => {
  it("a completed colonoscopy for the right patient closes the case on evidence", () => {
    const runtime = fresh();
    const caseId = bookedCase(runtime);
    const outcome = runtime.ingest(colonoscopyProcedure({ id: "col-1", patient: PATIENT, performedAt: T0 + 5 * DAY }));
    expect(outcome).toMatchObject({ status: "stored", effects: [{ kind: "case-closed", caseId }] });
    const state = runtime.get(caseId)?.state;
    if (state?.kind !== "closed") throw new Error("expected closed");
    expect(ClosureEvidence.is(state.evidence)).toBe(true);
    expect(state.evidence.basis).toMatchObject({ kind: "care-completed", resource: "Procedure/col-1", code: "73761001" });
  });

  it("negative controls: records that do not prove the care leave the case open, and say why", () => {
    const runtime = fresh();
    const caseId = bookedCase(runtime);
    const attempt = (id: string, patch: Partial<Parameters<typeof colonoscopyProcedure>[0]>) =>
      runtime.ingest(colonoscopyProcedure({ id, patient: PATIENT, performedAt: T0 + 5 * DAY, ...patch }));

    // Someone else's colonoscopy that claims to answer this case's referral.
    expect(attempt("wrong-patient", { patient: "Patient/syn-john", basedOnCase: caseId })).toMatchObject({
      effects: [{ kind: "evidence-rejected", reason: "wrong-patient" }],
    });
    // Someone else's colonoscopy with no claim on this case touches nothing.
    expect(attempt("unrelated", { patient: "Patient/syn-john" })).toMatchObject({ effects: [] });
    expect(attempt("wrong-code", { code: "44441009", display: "Flexible sigmoidoscopy" })).toMatchObject({
      effects: [{ kind: "evidence-rejected", reason: "wrong-code" }],
    });
    expect(attempt("not-done", { status: "in-progress" })).toMatchObject({ effects: [{ kind: "evidence-rejected", reason: "not-completed" }] });
    expect(attempt("old", { performedAt: T0 - 30 * DAY })).toMatchObject({ effects: [{ kind: "evidence-rejected", reason: "predates-result" }] });

    expect(runtime.get(caseId)?.state.kind).toBe("awaiting-attendance");
    expect(runtime.evidenceAttempts(caseId).map((a) => a.outcome)).toEqual(["wrong-patient", "wrong-code", "not-completed", "predates-result"]);
  });

  it("a clinician can close by decision, with a reason and a real note; nobody else can", () => {
    const runtime = fresh();
    const caseId = openCase(runtime);
    const clinician = CLINICIANS[0]?.actor;
    if (clinician === undefined) throw new Error("no clinician");
    expect(runtime.closeByDecision(caseId, clinician, "informed-decline", "declined")).toMatchObject({ ok: false, error: { reason: "note-required" } });
    expect(runtime.get(caseId)?.state.kind).toBe("awaiting-notification");
    const closed = runtime.closeByDecision(caseId, clinician, "informed-decline", "Patient declined colonoscopy after a full discussion of the risks.");
    expect(closed.ok).toBe(true);
    expect(runtime.get(caseId)?.state).toMatchObject({ kind: "closed" });
    expect(runtime.apply(caseId, { type: "deadline-passed", at: runtime.now() })).toMatchObject({ ok: false, error: { reason: "already-closed" } });
  });
});

describe("replay", () => {
  it("rebuilds a closed case by re-earning its evidence from the record", () => {
    const path = tempDb();
    const first = fresh(path);
    const caseId = bookedCase(first);
    first.ingest(colonoscopyProcedure({ id: "col-1", patient: PATIENT, performedAt: T0 + 5 * DAY }));
    const before = first.timeline(caseId);
    first.close();

    const second = fresh(path);
    const record = second.get(caseId);
    expect(record?.integrity).toEqual({ ok: true });
    expect(second.timeline(caseId)).toEqual(before);
    if (record?.state.kind !== "closed") throw new Error("expected closed");
    expect(ClosureEvidence.is(record.state.evidence)).toBe(true);
    // The stored `closed` event holds a reference, not the evidence.
    expect(before.at(-1)?.event).toEqual({ type: "closed", at: T0, basis: { kind: "care-completed", resource: "Procedure/col-1" } });
    second.close();
  });

  it("negative control: if the closing record is later withdrawn, replay refuses to call the case closed", () => {
    const path = tempDb();
    const first = fresh(path);
    const caseId = bookedCase(first);
    first.ingest(colonoscopyProcedure({ id: "col-1", patient: PATIENT, performedAt: T0 + 5 * DAY }));
    first.ingest(colonoscopyProcedure({ id: "col-1", patient: PATIENT, performedAt: T0 + 5 * DAY, status: "entered-in-error", version: "2" }));
    first.close();

    const second = fresh(path);
    const record = second.get(caseId);
    expect(record?.state.kind).toBe("awaiting-attendance");
    expect(record?.integrity).toMatchObject({ ok: false, why: "closing record no longer proves care: not-completed" });
    expect(second.apply(caseId, { type: "deadline-passed", at: second.now() })).toMatchObject({ ok: false, error: { reason: "integrity-hold" } });
    second.close();
  });
});

describe("audit chain", () => {
  it("verifies, and the log refuses updates and deletes", () => {
    const path = tempDb();
    const runtime = fresh(path);
    const caseId = bookedCase(runtime);
    expect(runtime.verifyChain(caseId)).toEqual({ ok: true, length: 4 });

    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE case_events SET payload = '{}' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM case_events WHERE seq = 1")).toThrow(/append-only/);
    raw.close();
    runtime.close();
  });

  it("negative control: with the triggers removed, a rewritten event is detected and the case is held", () => {
    const path = tempDb();
    const runtime = fresh(path);
    const caseId = bookedCase(runtime);

    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER case_events_no_update");
    // An attacker with database access rewrites history so that the agent appears to have closed the case.
    raw.prepare("UPDATE case_events SET payload = replace(payload, '\"passed\"', '\"assisted\"') WHERE case_id = ? AND seq = 2").run(caseId);
    raw.close();

    expect(runtime.verifyChain(caseId)).toEqual({ ok: false, atSeq: 2 });
    runtime.close();
    const rebooted = fresh(path);
    expect(rebooted.get(caseId)?.integrity).toMatchObject({ ok: false, atSeq: 2, why: "hash chain broken" });
    expect(rebooted.get(caseId)?.state.kind).toBe("awaiting-acknowledgement");
    rebooted.close();
  });
});

describe("the agent boundary", () => {
  it("the runtime schema for agent events rejects a close and a reassignment", () => {
    const at = T0;
    expect(zAgentEvent.safeParse({ type: "patient-notified", at, channel: "voice", by: agent }).success).toBe(true);
    expect(zAgentEvent.safeParse({ type: "closed", at, evidence: { basis: { kind: "care-completed" } } }).success).toBe(false);
    expect(zAgentEvent.safeParse({ type: "owner-reassigned", at, to: NAVIGATORS[0]?.actor, by: agent }).success).toBe(false);
    expect(zAgentEvent.safeParse({ type: "patient-notified", at, channel: "voice", by: NAVIGATORS[0]?.actor }).success).toBe(false);
  });

  it("past the schema, the kernel still rejects forged evidence", () => {
    const runtime = fresh();
    const caseId = openCase(runtime);
    const record = runtime.get(caseId);
    if (record === undefined) throw new Error("case missing");
    const forged = { type: "closed", at: T0, evidence: { basis: { kind: "care-completed", resource: "Procedure/fake", code: "73761001", performedAt: T0 } } };
    const verdict = decide(record.state, forged as unknown as CaseEvent, crcFitPositive.sla);
    expect(verdict).toEqual({ ok: false, error: { reason: "forged-evidence" } });
  });
});
