// Compile-time proofs. Each `@ts-expect-error` line must FAIL to type-check;
// if any of them ever compiles, tsc reports "Unused '@ts-expect-error' directive"
// and the build breaks. A green build therefore means every attack below is rejected.
import {
  ClosureEvidence,
  decideForAgent,
  legalActs,
  type ActsFor,
  type Agent,
  type CaseId,
  type CaseState,
  type ClosedState,
  type Clinician,
  type Instant,
  type OpenState,
  type OutOfRegionModel,
  type Owner,
  type PathwayId,
  type PatientRef,
  type Phi,
  type ResourceRef,
  type Sla,
} from "./kernel.js";

declare const id: CaseId;
declare const patient: PatientRef;
declare const result: ResourceRef;
declare const pathway: PathwayId;
declare const now: Instant;
declare const sla: Sla;
declare const agent: Agent;
declare const clinician: Clinician;
declare const open: Extract<OpenState, { kind: "awaiting-notification" }>;
declare const booking: Extract<OpenState, { kind: "awaiting-booking" }>;

const base = { id, patient, result, resultedAt: now, pathway };

// A1. Close a case with no evidence.
// @ts-expect-error  Property 'evidence' is missing
export const a1: ClosedState = { ...base, kind: "closed", closedAt: now };

// A2. Forge evidence with a look-alike object literal.
export const a2: ClosedState = {
  ...base,
  kind: "closed",
  closedAt: now,
  // @ts-expect-error  an object literal has no #sealed private field
  evidence: { basis: { kind: "care-completed", resource: result, code: "73761001", performedAt: now } },
};

// A3. Construct evidence directly, bypassing the two factories.
// @ts-expect-error  constructor of class 'ClosureEvidence' is private
export const a3 = new ClosureEvidence({ kind: "care-completed", resource: result, code: "x", performedAt: now });

// A4. An agent signs a human closure decision.
// @ts-expect-error  'Agent' is not assignable to 'Clinician'
export const a4 = ClosureEvidence.fromDecision(agent, "informed-decline", "patient declined after discussion", now);

// A5. An agent submits a `closed` event through the agent entry point.
// The payload carries a valid `by: agent`, so the only thing left to reject is the event type itself.
declare const evidence: ClosureEvidence;
// @ts-expect-error  '"closed"' is not an AgentEvent
export const a5 = decideForAgent(open, { type: "closed", at: now, evidence, by: agent }, sla);

// A6. An agent reassigns a case.
// @ts-expect-error  '"owner-reassigned"' is not an AgentEvent
export const a6 = decideForAgent(open, { type: "owner-reassigned", at: now, to: clinician, by: agent }, sla);

// A7. An agent owns a case.
// @ts-expect-error  'Agent' is not assignable to 'Owner'
export const a7: Owner = agent;

// A8. An open case with no owner.
// @ts-expect-error  Property 'owner' is missing
export const a8: CaseState = { ...base, kind: "awaiting-notification", due: now, escalation: 0 };

// A9. An open case with no deadline.
// @ts-expect-error  Property 'due' is missing
export const a9: CaseState = { ...base, kind: "awaiting-notification", owner: clinician, escalation: 0 };

// A10. The agent delivers a result while the case is in the booking state.
// @ts-expect-error  '"deliver-result"' is not a legal act in 'awaiting-booking'
export const a10: ActsFor<"awaiting-booking"> = "deliver-result";

// A11. Identified text sent to a model outside the residency boundary.
declare const model: OutOfRegionModel;
declare const note: Phi<string>;
// @ts-expect-error  Phi<string> is not Deidentified<string>
export const a11 = model(note);

// A12. A plain string sent to a model outside the residency boundary.
// @ts-expect-error  string is not Deidentified<string>
export const a12 = model("Patient Ahmed, MRN 12345, FIT positive");

// Positive controls: the legal versions compile.
export const p1 = decideForAgent(open, { type: "patient-notified", at: now, channel: "voice", by: agent }, sla);
export const p2: readonly ActsFor<"awaiting-booking">[] = legalActs(booking);
export const p3 = ClosureEvidence.fromDecision(clinician, "informed-decline", "declined after shared decision", now);
