// Runtime proofs. Random event sequences, including forged closures injected the way
// a compromised tool handler or a bad deserialiser would inject them, never break I1–I3.
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  ClosureEvidence,
  decide,
  type Actor,
  type CaseEvent,
  type CaseId,
  type CaseState,
  type Clinician,
  type Instant,
  type Navigator,
  type OpenState,
  type PathwayId,
  type PatientRef,
  type ResourceRef,
  type Sla,
} from "./kernel.js";

const T0 = 1_800_000_000_000 as Instant;
const patient = "Patient/p1" as PatientRef;
const clinician: Clinician = { kind: "clinician", practitioner: "Practitioner/c1" as ResourceRef, licence: "GD-0001" };
const navigator: Navigator = { kind: "navigator", practitioner: "Practitioner/n1" as ResourceRef };
const agent: Actor = { kind: "agent", model: "test-model", runId: "r1" };
const sla: Sla = {
  "awaiting-notification": 24,
  "awaiting-acknowledgement": 72,
  "awaiting-booking": 120,
  "awaiting-attendance": 720,
  "awaiting-resolution": 240,
};
const rule = { acceptedCodes: new Set(["73761001"]) }; // SNOMED CT: colonoscopy

const initial: OpenState = {
  kind: "awaiting-notification",
  id: "case-1" as CaseId,
  patient,
  result: "DiagnosticReport/fit-1" as ResourceRef,
  resultedAt: T0,
  pathway: "crc-fit-positive" as PathwayId,
  owner: navigator,
  due: (T0 + 24 * 3_600_000) as Instant,
  escalation: 0,
};

const genuine = (() => {
  const r = ClosureEvidence.fromRecord(
    rule,
    { patient, resultedAt: T0 },
    {
      resource: "Procedure/col-1" as ResourceRef,
      subject: patient,
      code: "73761001",
      status: "completed",
      performedAt: (T0 + 5 * 86_400_000) as Instant,
    },
  );
  assert.ok(r.ok);
  return r.value;
})();

// Forgeries: the shapes an attacker, a buggy mapper or a model-written payload would produce.
const lookalike = { basis: genuine.basis };
const forgeries: readonly unknown[] = [
  lookalike,
  JSON.parse(JSON.stringify(genuine)),
  { ...genuine },
  Object.create(ClosureEvidence.prototype),
  Object.assign(Object.create(ClosureEvidence.prototype), lookalike),
  null,
  "closed by agent: patient said she already had the test",
];

const at = fc.integer({ min: 0, max: 90 * 24 }).map((h) => (T0 + h * 3_600_000) as Instant);
const actor = fc.constantFrom<Actor>(agent, clinician, navigator, { kind: "system" });

const legalEvent: fc.Arbitrary<CaseEvent> = fc.oneof(
  fc.record({ type: fc.constant("patient-notified" as const), at, channel: fc.constantFrom("voice" as const, "sms" as const), by: actor }),
  fc.record({ type: fc.constant("patient-acknowledged" as const), at, teachBack: fc.constantFrom("passed" as const, "assisted" as const), by: actor }),
  fc.record({ type: fc.constant("appointment-booked" as const), at, appointment: fc.constant("Appointment/a1" as ResourceRef), by: actor }),
  fc.record({ type: fc.constant("appointment-missed" as const), at }),
  fc.record({ type: fc.constant("care-attended" as const), at }),
  fc.record({ type: fc.constant("deadline-passed" as const), at }),
  fc.record({ type: fc.constant("owner-reassigned" as const), at, to: fc.constantFrom(clinician, navigator), by: fc.constant(clinician) }),
  fc.record({ type: fc.constant("closed" as const), at, evidence: fc.constant(genuine) }),
);

// A forged close reaches `decide` only through an untyped boundary, which is exactly how it would arrive.
const forgedClose: fc.Arbitrary<CaseEvent> = fc
  .record({ at, evidence: fc.constantFrom(...forgeries) })
  .map((e) => ({ type: "closed", ...e }) as unknown as CaseEvent);

const step = fc.oneof({ weight: 4, arbitrary: legalEvent }, { weight: 1, arbitrary: forgedClose });

let closedRuns = 0;
let forgedAttempts = 0;
let forgedAccepted = 0;

fc.assert(
  fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (events) => {
    let state: CaseState = initial;
    for (const event of events) {
      const forged = event.type === "closed" && !ClosureEvidence.is(event.evidence);
      if (forged) forgedAttempts++;
      const wasClosed = state.kind === "closed";
      const next = decide(state, event, sla);

      if (wasClosed) assert.equal(next.ok, false, "I1b: closed is terminal");
      if (forged) {
        assert.equal(next.ok, false, "I1: forged evidence must be rejected");
        if (next.ok) forgedAccepted++;
      }
      if (next.ok) state = next.value;

      if (state.kind === "closed") {
        assert.ok(ClosureEvidence.is(state.evidence), "I1: closed implies genuine evidence");
      } else {
        assert.ok(state.owner.kind === "clinician" || state.owner.kind === "navigator", "I2/I3: human owner");
        assert.ok(Number.isFinite(state.due), "I2: deadline present");
      }
    }
    if (state.kind === "closed") closedRuns++;
  }),
  { numRuns: 100_000, seed: 20261119 },
);

// The record-based factory refuses evidence that does not prove the required care.
const bad = (patch: Partial<Parameters<typeof ClosureEvidence.fromRecord>[2]>) =>
  ClosureEvidence.fromRecord(
    rule,
    { patient, resultedAt: T0 },
    {
      resource: "Procedure/x" as ResourceRef,
      subject: patient,
      code: "73761001",
      status: "completed",
      performedAt: (T0 + 1) as Instant,
      ...patch,
    },
  );
assert.deepEqual(bad({ subject: "Patient/other" as PatientRef }), { ok: false, error: "wrong-patient" });
assert.deepEqual(bad({ status: "in-progress" }), { ok: false, error: "not-completed" });
assert.deepEqual(bad({ code: "44441009" }), { ok: false, error: "wrong-code" });
assert.deepEqual(bad({ performedAt: (T0 - 1) as Instant }), { ok: false, error: "predates-result" });
assert.deepEqual(ClosureEvidence.fromDecision(clinician, "informed-decline", "ok", T0), { ok: false, error: "note-required" });
for (const f of forgeries) assert.equal(ClosureEvidence.is(f), false);
assert.equal(ClosureEvidence.is(genuine), true);

console.log(
  JSON.stringify({ runs: 100_000, runsEndingClosed: closedRuns, forgedCloseAttempts: forgedAttempts, forgedCloseAccepted: forgedAccepted }),
);
