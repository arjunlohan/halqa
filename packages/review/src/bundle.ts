// The chart as a model reads it: one line per record, each with a short label (R1, R2, ...) that
// the review must cite. The text carries no name and no identifier: a birth year, a sex, and what
// the records say.
import { createHash } from "node:crypto";
import type { ChartKind, ChartRecord, Patient } from "@halqa/fhir";
import { deidentify, type Deidentified, type Phi } from "@halqa/kernel";

export type BundleLine = {
  readonly label: string;
  readonly ref: string;
  readonly kind: ChartKind;
  /** ISO day, or null when the record has no date. */
  readonly date: string | null;
  readonly text: string;
};

export type Bundle = {
  /** What is sent to the model. */
  readonly text: Deidentified<string>;
  /** SHA-256 of `text`: two charts with the same hash were reviewed as the same chart. */
  readonly hash: string;
  readonly lines: readonly BundleLine[];
};

export type BundleSubject = { readonly birthYear: string | null; readonly sex: string | null; readonly language: string | null };

/** What the model is told about who the chart belongs to: a birth year, a sex and a language. No name, no identifier. */
export const bundleSubject = (patient: Patient | null): BundleSubject => ({
  birthYear: patient?.birthDate?.slice(0, 4) ?? null,
  sex: patient?.gender ?? null,
  language: patient?.communication[0]?.language.coding[0]?.code ?? null,
});

const KIND_ORDER: readonly ChartKind[] = ["result", "lab", "condition", "medication", "procedure", "family-history", "encounter", "appointment"];
const KIND_NAME: Readonly<Record<ChartKind, string>> = {
  result: "screening result",
  lab: "laboratory result",
  condition: "condition",
  medication: "medicine",
  procedure: "procedure",
  "family-history": "family history",
  encounter: "visit",
  appointment: "appointment",
};
const FLAG_NAME = { positive: "flagged positive on the record", low: "flagged low on the record", high: "flagged high on the record" } as const;
const LANGUAGE: Readonly<Record<string, string>> = { ar: "Arabic", en: "English" };

/** Record ids and free text could carry an identifier; long digit runs are the only shape one takes here. */
const scrubLongNumbers = (raw: string): string => raw.replace(/\d{6,}/g, "[number removed]");

export function chartBundle(subject: BundleSubject, records: readonly ChartRecord[]): Bundle {
  const ordered = [...records].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.at ?? 0) - (a.at ?? 0) || a.title.localeCompare(b.title) || a.ref.localeCompare(b.ref),
  );
  const lines = ordered.map((record, index): BundleLine => {
    const date = record.at === null ? null : new Date(record.at).toISOString().slice(0, 10);
    const parts = [KIND_NAME[record.kind], date ?? "no date", record.title, record.detail, record.flag === null ? "" : FLAG_NAME[record.flag]];
    return { label: `R${index + 1}`, ref: record.ref, kind: record.kind, date, text: parts.filter((part) => part !== "").join(" | ") };
  });
  const who = [
    subject.birthYear === null ? "birth year not recorded" : `born ${subject.birthYear}`,
    subject.sex ?? "sex not recorded",
    `preferred language ${LANGUAGE[subject.language ?? ""] ?? "not recorded"}`,
  ].join(", ");
  const raw = [`Patient: ${who}.`, "", "<records>", ...lines.map((line) => `${line.label} | ${line.text}`), "</records>"].join("\n");
  const text = deidentify(raw as Phi<string>, scrubLongNumbers);
  return { text, hash: createHash("sha256").update(text).digest("hex"), lines };
}
