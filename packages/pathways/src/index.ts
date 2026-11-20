import type { ActId, ClosingRule, OpenState, PathwayId, Sla } from "@halqa/kernel";

export type Coding<S extends string> = { readonly system: S; readonly code: string; readonly display: string };
const loinc = (code: string, display: string): Coding<"http://loinc.org"> => ({ system: "http://loinc.org", code, display });
const snomed = (code: string, display: string): Coding<"http://snomed.info/sct"> => ({
  system: "http://snomed.info/sct",
  code,
  display,
});
const pathwayId = (id: string): PathwayId => id as PathwayId;

export type EscalationRole = "owner" | "team-lead" | "programme-lead";

export type Pathway = {
  readonly id: PathwayId;
  readonly title: string;
  /** What opens a case. */
  readonly trigger: {
    readonly resource: "Observation" | "DiagnosticReport";
    readonly codes: readonly Coding<"http://loinc.org">[];
    readonly actionableWhen: { readonly interpretation: readonly ("POS" | "A" | "H" | "HH")[] };
  };
  /** The care the result calls for. */
  readonly next: { readonly service: Coding<"http://snomed.info/sct">; readonly specialty: string };
  /** What the record must show before the case can close on evidence. */
  readonly closing: { readonly acceptedCodes: readonly Coding<"http://snomed.info/sct">[] };
  /** Hours allowed in each open state. Every state must be listed. */
  readonly sla: Sla;
  readonly slaSource: Readonly<Record<OpenState["kind"], "doh-standard" | "assumption">>;
  /** Who is told at escalation levels 1, 2 and 3. */
  readonly escalation: readonly [EscalationRole, EscalationRole, EscalationRole];
  /** Caps that protect the patient from being chased. */
  readonly outreach: { readonly maxAttempts: number; readonly quietHours: readonly [number, number] };
  /** Approved-wording catalogue and the acts it must cover. */
  readonly catalogue: { readonly id: string; readonly version: number; readonly covers: readonly ActId[] };
};

export const crcFitPositive = {
  id: pathwayId("crc-fit-positive"),
  title: "Positive FIT to colonoscopy",
  trigger: {
    resource: "Observation",
    codes: [
      loinc("29771-3", "Hemoglobin.gastrointestinal.lower [Presence] in Stool by Immunoassay"),
      loinc("57905-2", "Hemoglobin.gastrointestinal.lower [Presence] in Stool by Immunoassay --1st specimen"),
      loinc("58453-2", "Hemoglobin.gastrointestinal.lower [Mass/volume] in Stool by Immunoassay"),
    ],
    actionableWhen: { interpretation: ["POS", "A"] },
  },
  next: { service: snomed("73761001", "Colonoscopy"), specialty: "gastroenterology" },
  closing: { acceptedCodes: [snomed("73761001", "Colonoscopy")] },
  sla: {
    "awaiting-notification": 24,
    "awaiting-acknowledgement": 72,
    "awaiting-booking": 120,
    "awaiting-attendance": 744, // 31 days: the Abu Dhabi standard from referral to colonoscopy
    "awaiting-resolution": 240,
  },
  slaSource: {
    "awaiting-notification": "assumption",
    "awaiting-acknowledgement": "assumption",
    "awaiting-booking": "assumption",
    "awaiting-attendance": "doh-standard",
    "awaiting-resolution": "assumption",
  },
  escalation: ["owner", "team-lead", "programme-lead"],
  outreach: { maxAttempts: 4, quietHours: [21, 8] },
  catalogue: {
    id: "crc-fit-positive",
    version: 1,
    covers: [
      "greet",
      "verify-identity",
      "deliver-result",
      "teach-back",
      "repeat-result",
      "answer-approved-faq",
      "offer-slots",
      "confirm-slot",
      "send-prep-instructions",
      "remind",
      "reschedule",
      "hand-off-to-human",
      "emergency-guidance",
    ],
  },
} as const satisfies Pathway;

/** Every pathway the engine knows. Adding one means adding one typed file and one line here. */
export const pathways: readonly Pathway[] = [crcFitPositive];

export const pathwayById = (id: PathwayId): Pathway | undefined => pathways.find((p) => p.id === id);

/** The kernel's view of a pathway's closing rule. */
export const closingRule = (pathway: Pathway): ClosingRule => ({
  acceptedCodes: new Set(pathway.closing.acceptedCodes.map((c) => c.code)),
});
