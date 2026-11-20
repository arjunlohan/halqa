// Reviews generated ahead of time and shipped with the prototype, so the console can show a real
// model's reading of each synthetic chart without an API key. A stored review is used only while
// the records it was written from are still, byte for byte, the records in the chart.
import { readFileSync } from "node:fs";
import type { ChartRecord } from "@halqa/fhir";
import * as z from "zod";
import { chartBundle, type Bundle, type BundleSubject } from "./bundle.js";
import { groundReview, zReviewDraft, type Review } from "./review.js";

const zStoredFile = z.object({
  model: z.string(),
  generatedOn: z.string(),
  /** How the reviews were produced, in one sentence shown to staff. */
  via: z.string(),
  reviews: z.record(z.string(), z.object({ bundleHash: z.string(), covers: z.array(z.string()), draft: zReviewDraft })),
});
export type StoredReviews = z.infer<typeof zStoredFile>;

export function loadStoredReviews(path: string | URL = new URL("./stored-reviews.json", import.meta.url)): StoredReviews | null {
  try {
    const parsed = zStoredFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type StoredMatch = {
  readonly review: Review;
  /** The bundle the review was written from: the covered records only. */
  readonly bundle: Bundle;
  /** Records in the chart now that the review never saw. */
  readonly notCovered: readonly ChartRecord[];
};

/** The stored review for a patient, if its records are unchanged. Null when there is none or the chart moved under it. */
export function matchStoredReview(stored: StoredReviews, patient: string, subject: BundleSubject, records: readonly ChartRecord[]): StoredMatch | null {
  const entry = stored.reviews[patient];
  if (entry === undefined) return null;
  const covers = new Set(entry.covers);
  const covered = records.filter((record) => covers.has(record.ref));
  if (covered.length !== covers.size) return null;
  const bundle = chartBundle(subject, covered);
  if (bundle.hash !== entry.bundleHash) return null;
  const grounded = groundReview(entry.draft, bundle);
  return grounded.ok ? { review: grounded.review, bundle, notCovered: records.filter((record) => !covers.has(record.ref)) } : null;
}
