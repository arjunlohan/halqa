// Halqa closure kernel. Pure functions, zero dependencies, zero I/O.
// Three invariants, each enforced by the compiler AND re-checked at runtime:
//   I1  A case reaches `closed` only with ClosureEvidence.
//   I2  Every open case has an accountable human owner and a deadline.
//   I3  An AI agent can neither mint ClosureEvidence nor own a case.

// ───────────────────────── 1. Nominal identifiers ─────────────────────────
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CaseId = Brand<string, "CaseId">;
export type PatientRef = Brand<string, "PatientRef">; // FHIR "Patient/<id>"
export type ResourceRef = Brand<string, "ResourceRef">; // FHIR "<Type>/<id>"
export type PathwayId = Brand<string, "PathwayId">;
export type Instant = Brand<number, "Instant">; // epoch milliseconds, UTC

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ───────────────────────────── 2. Actors ─────────────────────────────
export type Clinician = {
  readonly kind: "clinician";
  readonly practitioner: ResourceRef;
  readonly licence: string;
};
export type Navigator = { readonly kind: "navigator"; readonly practitioner: ResourceRef };
export type Agent = { readonly kind: "agent"; readonly model: string; readonly runId: string };
export type System = { readonly kind: "system" };
export type Actor = Clinician | Navigator | Agent | System;

/** I3: ownership is a human role. `Agent` is not in this union. */
export type Owner = Clinician | Navigator;

// ──────────────── 3. Closure evidence: the only key to `closed` ────────────────
export type HumanClosureReason =
  | "informed-decline"
  | "clinically-not-indicated"
  | "care-transferred-out"
  | "deceased"
  | "duplicate";

export type ClosureBasis =
  | {
      readonly kind: "care-completed";
      readonly resource: ResourceRef;
      readonly code: string;
      readonly performedAt: Instant;
    }
  | {
      readonly kind: "human-decision";
      readonly reason: HumanClosureReason;
      readonly by: Clinician;
      readonly note: string;
      readonly at: Instant;
    };

/** What the pathway accepts as proof that the required care happened. */
export type ClosingRule = { readonly acceptedCodes: ReadonlySet<string> };

/** A completed care event as read from the record (already schema-parsed). */
export type CareRecord = {
  readonly resource: ResourceRef;
  readonly subject: PatientRef;
  readonly code: string;
  readonly status: "completed" | "in-progress" | "not-done" | "entered-in-error";
  readonly performedAt: Instant;
};

export type EvidenceRejection = "wrong-patient" | "wrong-code" | "not-completed" | "predates-result";

export class ClosureEvidence {
  // A true private field: not constructible by object literal (compile time)
  // and not forgeable by JSON, spread or cast (runtime, via `#sealed in x`).
  readonly #sealed = true;
  private constructor(readonly basis: ClosureBasis) {}

  static is(x: unknown): x is ClosureEvidence {
    return typeof x === "object" && x !== null && #sealed in x;
  }

  /** Evidence from the record: a completed care event that satisfies the pathway rule. */
  static fromRecord(
    rule: ClosingRule,
    expected: { readonly patient: PatientRef; readonly resultedAt: Instant },
    care: CareRecord,
  ): Result<ClosureEvidence, EvidenceRejection> {
    if (care.subject !== expected.patient) return err("wrong-patient");
    if (care.status !== "completed") return err("not-completed");
    if (!rule.acceptedCodes.has(care.code)) return err("wrong-code");
    if (care.performedAt < expected.resultedAt) return err("predates-result");
    return ok(
      new ClosureEvidence({
        kind: "care-completed",
        resource: care.resource,
        code: care.code,
        performedAt: care.performedAt,
      }),
    );
  }

  /** Evidence from a person. The parameter type admits a Clinician and nothing else. */
  static fromDecision(
    by: Clinician,
    reason: HumanClosureReason,
    note: string,
    at: Instant,
  ): Result<ClosureEvidence, "note-required"> {
    if (note.trim().length < 20) return err("note-required");
    return ok(new ClosureEvidence({ kind: "human-decision", reason, by, note, at }));
  }
}

// ───────────────────────────── 4. Case state ─────────────────────────────
type CaseCore = {
  readonly id: CaseId;
  readonly patient: PatientRef;
  readonly result: ResourceRef; // the actionable DiagnosticReport / Observation
  readonly resultedAt: Instant;
  readonly pathway: PathwayId;
};

/** I2: `owner` and `due` are required on every open state. There is no optional. */
type Open<K extends string, X = unknown> = CaseCore & {
  readonly kind: K;
  readonly owner: Owner;
  readonly due: Instant;
  readonly escalation: 0 | 1 | 2 | 3;
} & X;

export type OpenState =
  | Open<"awaiting-notification">
  | Open<"awaiting-acknowledgement", { readonly notifiedAt: Instant }>
  | Open<"awaiting-booking", { readonly acknowledgedAt: Instant }>
  | Open<"awaiting-attendance", { readonly appointment: ResourceRef }>
  | Open<"awaiting-resolution", { readonly attendedAt: Instant }>;

/** I1: `evidence` is required. No evidence, no value of this type. */
export type ClosedState = CaseCore & {
  readonly kind: "closed";
  readonly evidence: ClosureEvidence;
  readonly closedAt: Instant;
};

export type CaseState = OpenState | ClosedState;

// ───────────────────────────── 5. Events ─────────────────────────────
export type Channel = "voice" | "sms" | "whatsapp" | "app" | "in-person";

export type CaseEvent =
  | { readonly type: "patient-notified"; readonly at: Instant; readonly channel: Channel; readonly by: Actor }
  | {
      readonly type: "patient-acknowledged";
      readonly at: Instant;
      readonly teachBack: "passed" | "assisted";
      readonly by: Actor;
    }
  | { readonly type: "appointment-booked"; readonly at: Instant; readonly appointment: ResourceRef; readonly by: Actor }
  | { readonly type: "appointment-missed"; readonly at: Instant }
  | { readonly type: "care-attended"; readonly at: Instant }
  | { readonly type: "deadline-passed"; readonly at: Instant }
  | { readonly type: "owner-reassigned"; readonly at: Instant; readonly to: Owner; readonly by: Owner | System }
  | { readonly type: "closed"; readonly at: Instant; readonly evidence: ClosureEvidence };

/** I3: what an agent may submit. `closed` and `owner-reassigned` are not in it. */
export type AgentEvent = Extract<
  CaseEvent,
  { type: "patient-notified" | "patient-acknowledged" | "appointment-booked" }
> & { readonly by: Agent };

export type Rejection =
  | { readonly reason: "already-closed" }
  | { readonly reason: "illegal-transition"; readonly from: OpenState["kind"]; readonly event: CaseEvent["type"] }
  | { readonly reason: "forged-evidence" };

/** Hours allowed in each open state before the durable timer fires `deadline-passed`. */
export type Sla = Readonly<Record<OpenState["kind"], number>>;

const HOUR = 3_600_000;
const plus = (at: Instant, hours: number): Instant => (at + hours * HOUR) as Instant;
const bump = (e: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 => (e === 0 ? 1 : e === 1 ? 2 : 3);
const core = (s: CaseState): CaseCore => ({
  id: s.id,
  patient: s.patient,
  result: s.result,
  resultedAt: s.resultedAt,
  pathway: s.pathway,
});
const absurd = (x: never): never => {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
};

// ───────────────────────────── 6. The decider ─────────────────────────────
export function decide(state: CaseState, event: CaseEvent, sla: Sla): Result<CaseState, Rejection> {
  if (state.kind === "closed") return err({ reason: "already-closed" });
  const illegal = (): Result<never, Rejection> =>
    err({ reason: "illegal-transition", from: state.kind, event: event.type });
  const carry = { owner: state.owner, escalation: state.escalation } as const;

  switch (event.type) {
    case "patient-notified":
      if (state.kind !== "awaiting-notification") return illegal();
      return ok({
        ...core(state),
        ...carry,
        kind: "awaiting-acknowledgement",
        notifiedAt: event.at,
        due: plus(event.at, sla["awaiting-acknowledgement"]),
      });

    case "patient-acknowledged":
      if (state.kind !== "awaiting-acknowledgement") return illegal();
      return ok({
        ...core(state),
        ...carry,
        kind: "awaiting-booking",
        acknowledgedAt: event.at,
        due: plus(event.at, sla["awaiting-booking"]),
      });

    case "appointment-booked":
      if (state.kind !== "awaiting-booking") return illegal();
      return ok({
        ...core(state),
        ...carry,
        kind: "awaiting-attendance",
        appointment: event.appointment,
        due: plus(event.at, sla["awaiting-attendance"]),
      });

    case "appointment-missed":
      if (state.kind !== "awaiting-attendance") return illegal();
      return ok({
        ...core(state),
        owner: state.owner,
        escalation: bump(state.escalation),
        kind: "awaiting-booking",
        acknowledgedAt: event.at,
        due: plus(event.at, sla["awaiting-booking"]),
      });

    case "care-attended":
      if (state.kind !== "awaiting-attendance") return illegal();
      return ok({
        ...core(state),
        ...carry,
        kind: "awaiting-resolution",
        attendedAt: event.at,
        due: plus(event.at, sla["awaiting-resolution"]),
      });

    case "deadline-passed":
      // The case stays where it is; it gets louder, and the clock restarts.
      return ok({ ...state, escalation: bump(state.escalation), due: plus(event.at, sla[state.kind]) });

    case "owner-reassigned":
      return ok({ ...state, owner: event.to, due: plus(event.at, sla[state.kind]) });

    case "closed":
      // Types vanish at runtime, so the boundary re-earns the guarantee.
      if (!ClosureEvidence.is(event.evidence)) return err({ reason: "forged-evidence" });
      return ok({ ...core(state), kind: "closed", evidence: event.evidence, closedAt: event.at });

    default:
      return absurd(event);
  }
}

/** The only entry point exposed to agent tool handlers. */
export const decideForAgent = (state: CaseState, event: AgentEvent, sla: Sla) => decide(state, event, sla);

// ───────────────── 7. What an agent may say: the legal-move table ─────────────────
export type ActId =
  | "greet"
  | "verify-identity"
  | "deliver-result"
  | "teach-back"
  | "repeat-result"
  | "answer-approved-faq"
  | "offer-slots"
  | "confirm-slot"
  | "send-prep-instructions"
  | "remind"
  | "reschedule"
  | "hand-off-to-human"
  | "emergency-guidance";

const ACTS = {
  "awaiting-notification": ["greet", "verify-identity", "deliver-result", "hand-off-to-human", "emergency-guidance"],
  "awaiting-acknowledgement": [
    "teach-back",
    "repeat-result",
    "answer-approved-faq",
    "hand-off-to-human",
    "emergency-guidance",
  ],
  "awaiting-booking": [
    "offer-slots",
    "confirm-slot",
    "answer-approved-faq",
    "hand-off-to-human",
    "emergency-guidance",
  ],
  "awaiting-attendance": [
    "remind",
    "send-prep-instructions",
    "reschedule",
    "answer-approved-faq",
    "hand-off-to-human",
    "emergency-guidance",
  ],
  "awaiting-resolution": ["hand-off-to-human", "emergency-guidance"],
} as const satisfies Record<OpenState["kind"], readonly ActId[]>;

export type ActsFor<K extends OpenState["kind"]> = (typeof ACTS)[K][number];

/** The agent picks from this list. It does not get to extend it. */
export const legalActs = <K extends OpenState["kind"]>(state: Extract<OpenState, { kind: K }>): readonly ActsFor<K>[] =>
  ACTS[state.kind];

// ───────────────────── 8. The residency boundary for text ─────────────────────
export type Phi<T> = Brand<T, "Phi">;
export type Deidentified<T> = Brand<T, "Deidentified">;

/** The only function that turns identified text into text allowed out of region. */
export const deidentify = (text: Phi<string>, scrub: (raw: string) => string): Deidentified<string> =>
  scrub(text) as Deidentified<string>;

/** Signature of any model client hosted outside the residency boundary. */
export type OutOfRegionModel = (prompt: Deidentified<string>) => Promise<string>;
