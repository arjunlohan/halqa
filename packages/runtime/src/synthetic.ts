// Builders for the synthetic record feed: the FHIR resources a laboratory or an endoscopy unit would post.
// The demo controls and the tests both post these through the same ingest path as any other resource.
import { LOINC, SNOMED, type Appointment, type Observation, type Procedure } from "@halqa/fhir";

const iso = (ms: number): string => new Date(ms).toISOString();

export function fitObservation(o: {
  readonly id: string;
  readonly patient: string;
  readonly issuedAt: number;
  readonly positive?: boolean;
  readonly code?: string;
  readonly status?: Observation["status"];
  readonly version?: string;
}): Observation {
  const positive = o.positive ?? true;
  return {
    resourceType: "Observation",
    id: o.id,
    meta: { versionId: o.version ?? "1" },
    status: o.status ?? "final",
    code: {
      coding: [{ system: LOINC, code: o.code ?? "57905-2", display: "Hemoglobin.gastrointestinal.lower [Presence] in Stool by Immunoassay --1st specimen" }],
      text: "Faecal immunochemical test (FIT)",
    },
    subject: { reference: o.patient },
    issued: iso(o.issuedAt),
    interpretation: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
            code: positive ? "POS" : "NEG",
            display: positive ? "Positive" : "Negative",
          },
        ],
      },
    ],
    referenceRange: [],
  };
}

export function colonoscopyProcedure(o: {
  readonly id: string;
  readonly patient: string;
  readonly performedAt: number;
  readonly status?: Procedure["status"];
  readonly code?: string;
  readonly display?: string;
  /** Claim that this Procedure answers a case's referral, whatever its subject says. */
  readonly basedOnCase?: string;
  readonly version?: string;
}): Procedure {
  return {
    resourceType: "Procedure",
    id: o.id,
    meta: { versionId: o.version ?? "1" },
    status: o.status ?? "completed",
    code: { coding: [{ system: SNOMED, code: o.code ?? "73761001", display: o.display ?? "Colonoscopy" }] },
    subject: { reference: o.patient },
    performedDateTime: iso(o.performedAt),
    basedOn: o.basedOnCase === undefined ? [] : [{ reference: `ServiceRequest/${o.basedOnCase}` }],
  };
}

/** The next version of an appointment with a new status, as the provider's system would send it. */
export function appointmentUpdate(current: Appointment, status: Appointment["status"]): Appointment {
  const version = Number(current.meta?.versionId ?? "1");
  return { ...current, meta: { versionId: String(Number.isFinite(version) ? version + 1 : 2) }, status };
}
