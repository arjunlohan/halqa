// The synthetic cohort: six invented patients and a small chart for each. Hand-written for the
// prototype. No record here describes a real person, and the identifiers are not real formats.
//
// The charts exist so that a case sits on top of a believable record: conditions, medicines,
// laboratory results, earlier procedures and family history, each a plain FHIR R4 resource.
import { EMIRATES_ID, LOINC, MRN, SNOMED, type Patient, type Resource } from "@halqa/fhir";

const INTERPRETATION = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";
const CLINIC = { reference: "Organization/syn-clinic", display: "Al Bateen Family Clinic" };

type Person = {
  readonly id: string;
  readonly name: string;
  readonly sex: "male" | "female";
  readonly birthYear: number;
  readonly idLast4: string;
  readonly mrn: string;
  readonly language: "ar" | "en";
};

const PEOPLE: readonly Person[] = [
  { id: "syn-ahmed", name: "Ahmed M.", sex: "male", birthYear: 1968, idLast4: "4471", mrn: "SYN-104471", language: "ar" },
  { id: "syn-fatima", name: "Fatima K.", sex: "female", birthYear: 1971, idLast4: "2093", mrn: "SYN-102093", language: "ar" },
  { id: "syn-john", name: "John D.", sex: "male", birthYear: 1965, idLast4: "8810", mrn: "SYN-108810", language: "en" },
  { id: "syn-priya", name: "Priya N.", sex: "female", birthYear: 1974, idLast4: "3356", mrn: "SYN-103356", language: "en" },
  { id: "syn-khalid", name: "Khalid S.", sex: "male", birthYear: 1959, idLast4: "7024", mrn: "SYN-107024", language: "ar" },
  { id: "syn-sara", name: "Sara T.", sex: "female", birthYear: 1980, idLast4: "1648", mrn: "SYN-101648", language: "ar" },
  { id: "syn-yusuf", name: "Yusuf A.", sex: "male", birthYear: 1962, idLast4: "5512", mrn: "SYN-105512", language: "ar" },
  { id: "syn-mona", name: "Mona H.", sex: "female", birthYear: 1969, idLast4: "3907", mrn: "SYN-103907", language: "en" },
  { id: "syn-omar", name: "Omar B.", sex: "male", birthYear: 1972, idLast4: "6630", mrn: "SYN-106630", language: "ar" },
];

export const SYNTHETIC_PATIENT_IDS: readonly string[] = PEOPLE.map((p) => p.id);

export const SYNTHETIC_PATIENTS: readonly Patient[] = PEOPLE.map((p) => ({
  resourceType: "Patient",
  id: p.id,
  meta: { versionId: "1" },
  name: [{ text: p.name, given: [], family: undefined }],
  birthDate: `${p.birthYear}-01-01`,
  gender: p.sex,
  identifier: [
    { system: EMIRATES_ID, value: `SYN-000-${p.birthYear}-000${p.idLast4}` },
    { system: MRN, value: p.mrn },
  ],
  communication: [{ language: { coding: [{ system: "urn:ietf:bcp:47", code: p.language }], text: undefined }, preferred: true }],
}));

// ───────────────────────── Record builders ─────────────────────────
const meta = { versionId: "1" };
const subject = (who: string) => ({ reference: `Patient/${who}` });

const condition = (who: string, key: string, code: string, display: string, onset: string): Resource => ({
  resourceType: "Condition",
  id: `cond-${key}-${who.slice(4)}`,
  meta,
  clinicalStatus: { coding: [{ code: "active", display: "Active" }] },
  code: { coding: [{ system: SNOMED, code, display }] },
  subject: subject(who),
  onsetDateTime: onset,
});

const medicine = (who: string, key: string, name: string, dose: string, since: string): Resource => ({
  resourceType: "MedicationStatement",
  id: `med-${key}-${who.slice(4)}`,
  meta,
  status: "active",
  medicationCodeableConcept: { coding: [], text: name },
  subject: subject(who),
  effectiveDateTime: since,
  dosage: [{ text: dose }],
});

const lab = (who: string, key: string, loinc: string, display: string, value: number, unit: string, range: string, on: string, flag?: "L" | "H"): Resource => ({
  resourceType: "Observation",
  id: `lab-${key}-${who.slice(4)}`,
  meta,
  status: "final",
  code: { coding: [{ system: LOINC, code: loinc, display }] },
  subject: subject(who),
  issued: on,
  interpretation: flag === undefined ? [] : [{ coding: [{ system: INTERPRETATION, code: flag, display: flag === "L" ? "Low" : "High" }] }],
  valueQuantity: { value, unit },
  referenceRange: [{ text: range }],
});

const haemoglobin = (who: string, value: number, range: string, on: string, flag?: "L") => lab(who, "hb", "718-7", "Haemoglobin", value, "g/dL", range, on, flag);
const ferritin = (who: string, value: number, on: string, flag?: "L") => lab(who, "ferritin", "2276-4", "Ferritin", value, "µg/L", "30 to 400", on, flag);

const pastProcedure = (who: string, key: string, code: string, display: string, on: string): Resource => ({
  resourceType: "Procedure",
  id: `proc-${key}-${who.slice(4)}`,
  meta,
  status: "completed",
  code: { coding: [{ system: SNOMED, code, display }] },
  subject: subject(who),
  performedDateTime: on,
  basedOn: [],
});

const visit = (who: string, key: string, kind: string, on: string): Resource => ({
  resourceType: "Encounter",
  id: `enc-${key}-${who.slice(4)}`,
  meta,
  status: "finished",
  type: [{ coding: [], text: kind }],
  subject: subject(who),
  period: { start: on, end: on },
  serviceProvider: CLINIC,
});

const family = (who: string, relative: string, what: string, onsetAge: number, recorded: string): Resource => ({
  resourceType: "FamilyMemberHistory",
  id: `fam-${who.slice(4)}`,
  meta,
  status: "completed",
  patient: subject(who),
  date: recorded,
  relationship: { coding: [], text: relative },
  condition: [{ code: { coding: [], text: what }, onsetAge: { value: onsetAge, unit: "years" } }],
});

/** Each patient's chart as it stood before any screening result arrived. */
export const SYNTHETIC_CHARTS: readonly Resource[] = [
  // Ahmed M.: diabetes, an antiplatelet, borderline-low haemoglobin and low ferritin.
  condition("syn-ahmed", "t2dm", "44054006", "Type 2 diabetes mellitus", "2016-03-10T00:00:00Z"),
  condition("syn-ahmed", "htn", "59621000", "Essential hypertension", "2018-09-02T00:00:00Z"),
  medicine("syn-ahmed", "metformin", "Metformin 1 g tablet", "one tablet twice a day", "2016-03-10T00:00:00Z"),
  medicine("syn-ahmed", "amlodipine", "Amlodipine 5 mg tablet", "one tablet daily", "2018-09-02T00:00:00Z"),
  medicine("syn-ahmed", "aspirin", "Aspirin 81 mg tablet", "one tablet daily", "2019-01-15T00:00:00Z"),
  haemoglobin("syn-ahmed", 12.1, "13.0 to 17.0", "2026-10-28T06:30:00Z", "L"),
  ferritin("syn-ahmed", 18, "2026-10-28T06:30:00Z", "L"),
  lab("syn-ahmed", "hba1c", "4548-4", "HbA1c", 7.4, "%", "below 6.5", "2026-10-28T06:30:00Z", "H"),
  visit("syn-ahmed", "screen", "Periodic health screening visit", "2026-10-27T05:00:00Z"),

  // Fatima K.: a first-degree relative with bowel cancer.
  condition("syn-fatima", "hypothyroid", "40930008", "Hypothyroidism", "2012-05-20T00:00:00Z"),
  medicine("syn-fatima", "levothyroxine", "Levothyroxine 75 microgram tablet", "one tablet daily", "2012-05-20T00:00:00Z"),
  haemoglobin("syn-fatima", 12.8, "12.0 to 15.5", "2026-10-19T07:10:00Z"),
  family("syn-fatima", "Father", "Colorectal cancer", 62, "2024-02-11T00:00:00Z"),
  visit("syn-fatima", "screen", "Periodic health screening visit", "2026-10-19T06:00:00Z"),

  // John D.: an anticoagulant, and a colonoscopy eleven years ago.
  condition("syn-john", "af", "49436004", "Atrial fibrillation", "2021-07-04T00:00:00Z"),
  medicine("syn-john", "apixaban", "Apixaban 5 mg tablet", "one tablet twice a day", "2021-07-04T00:00:00Z"),
  medicine("syn-john", "bisoprolol", "Bisoprolol 2.5 mg tablet", "one tablet daily", "2021-07-04T00:00:00Z"),
  haemoglobin("syn-john", 14.2, "13.0 to 17.0", "2026-11-02T08:00:00Z"),
  pastProcedure("syn-john", "col2015", "73761001", "Colonoscopy", "2015-04-22T09:00:00Z"),
  visit("syn-john", "screen", "Periodic health screening visit", "2026-11-02T07:00:00Z"),

  // Priya N.: iron-deficiency anaemia under treatment.
  condition("syn-priya", "ida", "87522002", "Iron deficiency anaemia", "2026-09-08T00:00:00Z"),
  medicine("syn-priya", "iron", "Ferrous sulfate 200 mg tablet", "one tablet daily", "2026-09-08T00:00:00Z"),
  haemoglobin("syn-priya", 10.4, "12.0 to 15.5", "2026-11-10T06:45:00Z", "L"),
  ferritin("syn-priya", 9, "2026-11-10T06:45:00Z", "L"),
  visit("syn-priya", "screen", "Periodic health screening visit", "2026-11-10T06:00:00Z"),

  // Khalid S.: reduced kidney function, and a colonoscopy five years ago.
  condition("syn-khalid", "ckd3", "433144002", "Chronic kidney disease stage 3", "2022-11-30T00:00:00Z"),
  condition("syn-khalid", "htn", "59621000", "Essential hypertension", "2010-01-18T00:00:00Z"),
  medicine("syn-khalid", "ramipril", "Ramipril 5 mg capsule", "one capsule daily", "2010-01-18T00:00:00Z"),
  medicine("syn-khalid", "atorvastatin", "Atorvastatin 20 mg tablet", "one tablet at night", "2015-06-01T00:00:00Z"),
  lab("syn-khalid", "egfr", "62238-1", "Estimated glomerular filtration rate", 48, "mL/min/1.73 m²", "above 60", "2026-10-12T06:20:00Z", "L"),
  haemoglobin("syn-khalid", 13.4, "13.0 to 17.0", "2026-10-12T06:20:00Z"),
  pastProcedure("syn-khalid", "col2021", "73761001", "Colonoscopy", "2021-03-16T08:30:00Z"),
  visit("syn-khalid", "screen", "Periodic health screening visit", "2026-10-12T05:30:00Z"),

  // Sara T.: nothing of note on record.
  haemoglobin("syn-sara", 13.1, "12.0 to 15.5", "2026-10-30T07:00:00Z"),
  visit("syn-sara", "screen", "Periodic health screening visit", "2026-10-30T06:00:00Z"),

  // Yusuf A.: long-standing lung disease on an inhaler.
  condition("syn-yusuf", "copd", "13645005", "Chronic obstructive pulmonary disease", "2019-02-14T00:00:00Z"),
  medicine("syn-yusuf", "tiotropium", "Tiotropium 18 microgram inhaler", "one inhalation daily", "2019-02-14T00:00:00Z"),
  haemoglobin("syn-yusuf", 14.8, "13.0 to 17.0", "2026-11-05T06:40:00Z"),
  visit("syn-yusuf", "screen", "Periodic health screening visit", "2026-11-05T06:00:00Z"),

  // Mona H.: diabetes on a tablet that matters when fasting.
  condition("syn-mona", "t2dm", "44054006", "Type 2 diabetes mellitus", "2020-08-21T00:00:00Z"),
  medicine("syn-mona", "empagliflozin", "Empagliflozin 10 mg tablet", "one tablet daily", "2022-03-09T00:00:00Z"),
  lab("syn-mona", "hba1c", "4548-4", "HbA1c", 6.9, "%", "below 6.5", "2026-11-08T06:15:00Z", "H"),
  haemoglobin("syn-mona", 12.9, "12.0 to 15.5", "2026-11-08T06:15:00Z"),
  visit("syn-mona", "screen", "Periodic health screening visit", "2026-11-08T06:00:00Z"),

  // Omar B.: a coronary stent three years ago, on an antiplatelet since.
  condition("syn-omar", "cad", "53741008", "Coronary arteriosclerosis", "2023-06-02T00:00:00Z"),
  pastProcedure("syn-omar", "stent2023", "36969009", "Placement of stent in coronary artery", "2023-06-04T10:00:00Z"),
  medicine("syn-omar", "clopidogrel", "Clopidogrel 75 mg tablet", "one tablet daily", "2023-06-04T00:00:00Z"),
  medicine("syn-omar", "rosuvastatin", "Rosuvastatin 10 mg tablet", "one tablet at night", "2023-06-04T00:00:00Z"),
  haemoglobin("syn-omar", 15.1, "13.0 to 17.0", "2026-11-11T07:20:00Z"),
  visit("syn-omar", "screen", "Periodic health screening visit", "2026-11-11T06:00:00Z"),
];
