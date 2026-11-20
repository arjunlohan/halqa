// The FHIR R4 subset Halqa reads and writes. Every resource entering the system is parsed here
// into a typed value or rejected. Branded kernel identifiers are minted only by these schemas.
import type { CareRecord, CaseId, Instant, PathwayId, PatientRef, ResourceRef } from "@halqa/kernel";
import * as z from "zod";

// ───────────────────────── Branded identifiers ─────────────────────────
const ID = "[A-Za-z0-9\\-.]{1,64}";
export const zResourceRef = z
  .string()
  .regex(new RegExp(`^[A-Z][A-Za-z]+/${ID}$`))
  .transform((s) => s as ResourceRef);
export const zPatientRef = z
  .string()
  .regex(new RegExp(`^Patient/${ID}$`))
  .transform((s) => s as PatientRef);
export const zInstant = z
  .number()
  .int()
  .nonnegative()
  .transform((n) => n as Instant);
export const zCaseId = z
  .string()
  .regex(/^case-[a-f0-9]{12}$/)
  .transform((s) => s as CaseId);
export const zPathwayId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .transform((s) => s as PathwayId);

/** Epoch milliseconds from a FHIR dateTime or instant, or null when it does not parse. */
export const instantFromIso = (iso: string | undefined): Instant | null => {
  if (iso === undefined) return null;
  const parsed = zInstant.safeParse(Date.parse(iso));
  return parsed.success ? parsed.data : null;
};
export const isoFromInstant = (at: Instant): string => new Date(at).toISOString();

// ───────────────────────── Resource schemas ─────────────────────────
const zId = z.string().regex(new RegExp(`^${ID}$`));
const zMeta = z.object({ versionId: z.string().optional(), lastUpdated: z.string().optional() }).optional();
const zCoding = z.object({ system: z.string().optional(), code: z.string(), display: z.string().optional() });
const zConcept = z.object({ coding: z.array(zCoding).default([]), text: z.string().optional() });
const zReference = z.object({ reference: z.string(), display: z.string().optional() });

export const zObservation = z.object({
  resourceType: z.literal("Observation"),
  id: zId,
  meta: zMeta,
  status: z.enum(["registered", "preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error", "unknown"]),
  code: zConcept,
  subject: zReference,
  effectiveDateTime: z.string().optional(),
  issued: z.string().optional(),
  interpretation: z.array(zConcept).default([]),
  valueQuantity: z.object({ value: z.number(), unit: z.string().optional() }).optional(),
  valueString: z.string().optional(),
  referenceRange: z.array(z.object({ text: z.string().optional() })).default([]),
});

export const zProcedure = z.object({
  resourceType: z.literal("Procedure"),
  id: zId,
  meta: zMeta,
  status: z.enum(["preparation", "in-progress", "not-done", "on-hold", "stopped", "completed", "entered-in-error", "unknown"]),
  code: zConcept,
  subject: zReference,
  performedDateTime: z.string().optional(),
  basedOn: z.array(zReference).default([]),
});

export const zAppointment = z.object({
  resourceType: z.literal("Appointment"),
  id: zId,
  meta: zMeta,
  status: z.enum([
    "proposed",
    "pending",
    "booked",
    "arrived",
    "fulfilled",
    "cancelled",
    "noshow",
    "entered-in-error",
    "checked-in",
    "waitlist",
  ]),
  start: z.string().optional(),
  end: z.string().optional(),
  slot: z.array(zReference).default([]),
  serviceType: z.array(zConcept).default([]),
  participant: z.array(z.object({ actor: zReference.optional(), status: z.string() })).default([]),
});

export const zSlot = z.object({
  resourceType: z.literal("Slot"),
  id: zId,
  meta: zMeta,
  status: z.enum(["busy", "free", "busy-unavailable", "busy-tentative", "entered-in-error"]),
  start: z.string(),
  end: z.string(),
  schedule: zReference,
});

export const zPatient = z.object({
  resourceType: z.literal("Patient"),
  id: zId,
  meta: zMeta,
  name: z.array(z.object({ text: z.string().optional(), given: z.array(z.string()).default([]), family: z.string().optional() })).default([]),
  birthDate: z.string().optional(),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  identifier: z.array(z.object({ system: z.string().optional(), value: z.string() })).default([]),
  communication: z.array(z.object({ language: zConcept, preferred: z.boolean().optional() })).default([]),
});

export const zCondition = z.object({
  resourceType: z.literal("Condition"),
  id: zId,
  meta: zMeta,
  clinicalStatus: zConcept.optional(),
  code: zConcept,
  subject: zReference,
  onsetDateTime: z.string().optional(),
  recordedDate: z.string().optional(),
});

export const zMedicationStatement = z.object({
  resourceType: z.literal("MedicationStatement"),
  id: zId,
  meta: zMeta,
  status: z.enum(["active", "completed", "entered-in-error", "intended", "stopped", "on-hold", "unknown", "not-taken"]),
  medicationCodeableConcept: zConcept,
  subject: zReference,
  effectiveDateTime: z.string().optional(),
  dosage: z.array(z.object({ text: z.string().optional() })).default([]),
});

export const zEncounter = z.object({
  resourceType: z.literal("Encounter"),
  id: zId,
  meta: zMeta,
  status: z.string(),
  type: z.array(zConcept).default([]),
  subject: zReference,
  period: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
  serviceProvider: zReference.optional(),
});

export const zFamilyMemberHistory = z.object({
  resourceType: z.literal("FamilyMemberHistory"),
  id: zId,
  meta: zMeta,
  status: z.string(),
  patient: zReference,
  date: z.string().optional(),
  relationship: zConcept,
  condition: z.array(z.object({ code: zConcept, onsetAge: z.object({ value: z.number(), unit: z.string().optional() }).optional() })).default([]),
});

export const zResource = z.discriminatedUnion("resourceType", [
  zObservation,
  zProcedure,
  zAppointment,
  zSlot,
  zPatient,
  zCondition,
  zMedicationStatement,
  zEncounter,
  zFamilyMemberHistory,
]);

export type Observation = z.infer<typeof zObservation>;
export type Procedure = z.infer<typeof zProcedure>;
export type Appointment = z.infer<typeof zAppointment>;
export type Slot = z.infer<typeof zSlot>;
export type Patient = z.infer<typeof zPatient>;
export type Condition = z.infer<typeof zCondition>;
export type MedicationStatement = z.infer<typeof zMedicationStatement>;
export type Encounter = z.infer<typeof zEncounter>;
export type FamilyMemberHistory = z.infer<typeof zFamilyMemberHistory>;
export type Resource = z.infer<typeof zResource>;
export type ResourceType = Resource["resourceType"];

export const SNOMED = "http://snomed.info/sct";
export const LOINC = "http://loinc.org";
export const EMIRATES_ID = "urn:halqa:synthetic:emirates-id";
export const MRN = "urn:halqa:synthetic:mrn";

export const refOf = (resource: { readonly resourceType: string; readonly id: string }): ResourceRef | null => {
  const parsed = zResourceRef.safeParse(`${resource.resourceType}/${resource.id}`);
  return parsed.success ? parsed.data : null;
};

export const versionOf = (resource: { readonly meta?: { readonly versionId?: string | undefined } | undefined }): string =>
  resource.meta?.versionId ?? "1";

// ───────────────────────── Mappers to kernel types ─────────────────────────
export type ActionableTrigger = {
  readonly codes: readonly { readonly system: string; readonly code: string }[];
  readonly interpretation: readonly string[];
};

export type ActionableResult = { readonly result: ResourceRef; readonly patient: PatientRef; readonly resultedAt: Instant };

/** A final Observation whose code and interpretation match the trigger, as kernel-typed facts. */
export function actionableResult(observation: Observation, trigger: ActionableTrigger): ActionableResult | null {
  if (observation.status !== "final") return null;
  const coded = observation.code.coding.some((c) => trigger.codes.some((t) => t.system === c.system && t.code === c.code));
  if (!coded) return null;
  const flagged = observation.interpretation.some((i) => i.coding.some((c) => trigger.interpretation.includes(c.code)));
  if (!flagged) return null;
  const result = refOf(observation);
  const patient = zPatientRef.safeParse(observation.subject.reference);
  const resultedAt = instantFromIso(observation.issued ?? observation.effectiveDateTime);
  if (result === null || !patient.success || resultedAt === null) return null;
  return { result, patient: patient.data, resultedAt };
}

const CARE_STATUS: Readonly<Record<Procedure["status"], CareRecord["status"]>> = {
  completed: "completed",
  "in-progress": "in-progress",
  preparation: "in-progress",
  "on-hold": "in-progress",
  unknown: "in-progress",
  "not-done": "not-done",
  stopped: "not-done",
  "entered-in-error": "entered-in-error",
};

/** A Procedure as the kernel's CareRecord. Null when it lacks a subject, a code or a performed time. */
export function careRecord(procedure: Procedure): CareRecord | null {
  const resource = refOf(procedure);
  const subject = zPatientRef.safeParse(procedure.subject.reference);
  const coding = procedure.code.coding.find((c) => c.system === SNOMED) ?? procedure.code.coding[0];
  const performedAt = instantFromIso(procedure.performedDateTime);
  if (resource === null || !subject.success || coding === undefined || performedAt === null) return null;
  return { resource, subject: subject.data, code: coding.code, status: CARE_STATUS[procedure.status], performedAt };
}

/** The one place a number becomes an Instant outside a parsed resource. Throws on a non-finite or negative value. */
export const instant = (ms: number): Instant => zInstant.parse(Math.trunc(ms));

// ───────────────────────── A chart, record by record ─────────────────────────
export type ChartKind = "result" | "lab" | "condition" | "medication" | "procedure" | "encounter" | "family-history" | "appointment";

export type ChartRecord = {
  readonly ref: ResourceRef;
  readonly kind: ChartKind;
  /** Epoch milliseconds, or null when the record carries no date. */
  readonly at: number | null;
  readonly title: string;
  readonly detail: string;
  /** Set when the record itself carries an abnormal flag. Never computed here. */
  readonly flag: "positive" | "low" | "high" | null;
};

const text = (concept: { readonly coding: readonly { readonly display?: string | undefined; readonly code: string }[]; readonly text?: string | undefined }): string =>
  concept.text ?? concept.coding[0]?.display ?? concept.coding[0]?.code ?? "Unspecified";

const stamp = (iso: string | undefined): number | null => {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? ms : null;
};

const FLAGS: Readonly<Record<string, ChartRecord["flag"]>> = { POS: "positive", A: "positive", L: "low", LL: "low", H: "high", HH: "high" };

/** The patient a resource is about, or null for resources that are not part of anyone's chart. */
export function subjectOf(resource: Resource): string | null {
  switch (resource.resourceType) {
    case "Observation":
    case "Procedure":
    case "Condition":
    case "MedicationStatement":
    case "Encounter":
      return resource.subject.reference;
    case "FamilyMemberHistory":
      return resource.patient.reference;
    case "Appointment":
      return resource.participant.find((p) => p.actor?.reference.startsWith("Patient/"))?.actor?.reference ?? null;
    case "Patient":
    case "Slot":
      return null;
  }
}

/** A record as one line of a chart. The wording is fixed by this function, not by a model. */
export function chartRecord(resource: Resource): ChartRecord | null {
  const ref = refOf(resource);
  if (ref === null) return null;
  switch (resource.resourceType) {
    case "Observation": {
      const flag = resource.interpretation.flatMap((i) => i.coding.map((c) => FLAGS[c.code] ?? null)).find((f) => f !== null) ?? null;
      const isLab = resource.valueQuantity !== undefined;
      // A result with no number is described by its flag alone; repeating the interpretation's wording beside it adds nothing.
      const value = isLab ? `${resource.valueQuantity?.value} ${resource.valueQuantity?.unit ?? ""}`.trim() : (resource.valueString ?? (flag === null ? (resource.interpretation[0]?.coding[0]?.display ?? "") : ""));
      const range = resource.referenceRange[0]?.text;
      return {
        ref,
        kind: isLab ? "lab" : "result",
        at: stamp(resource.issued ?? resource.effectiveDateTime),
        title: text(resource.code),
        detail: [value, range === undefined ? null : `reference ${range}`].filter((part) => part !== null && part !== "").join(" · "),
        flag,
      };
    }
    case "Procedure":
      return { ref, kind: "procedure", at: stamp(resource.performedDateTime), title: text(resource.code), detail: resource.status, flag: null };
    case "Condition":
      return { ref, kind: "condition", at: stamp(resource.onsetDateTime ?? resource.recordedDate), title: text(resource.code), detail: resource.clinicalStatus === undefined ? "" : text(resource.clinicalStatus), flag: null };
    case "MedicationStatement":
      return { ref, kind: "medication", at: stamp(resource.effectiveDateTime), title: text(resource.medicationCodeableConcept), detail: [resource.dosage[0]?.text, resource.status].filter((part) => part !== undefined).join(" · "), flag: null };
    case "Encounter":
      return { ref, kind: "encounter", at: stamp(resource.period?.start), title: resource.type[0] === undefined ? "Encounter" : text(resource.type[0]), detail: resource.serviceProvider?.display ?? resource.status, flag: null };
    case "FamilyMemberHistory": {
      const condition = resource.condition[0];
      const onset = condition?.onsetAge === undefined ? "" : ` at ${condition.onsetAge.value}`;
      return { ref, kind: "family-history", at: stamp(resource.date), title: `${text(resource.relationship)}: ${condition === undefined ? "history recorded" : text(condition.code)}${onset}`, detail: "Family history", flag: null };
    }
    case "Appointment":
      return { ref, kind: "appointment", at: stamp(resource.start), title: resource.serviceType[0] === undefined ? "Appointment" : text(resource.serviceType[0]), detail: [resource.participant[1]?.actor?.display, resource.status].filter((part) => part !== undefined).join(" · "), flag: null };
    case "Patient":
    case "Slot":
      return null;
  }
}
