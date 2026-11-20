// Claude's review of a patient's chart, as the console reads it. Two sources, in order:
//   1. a live review of exactly this chart, made with an API key and kept on disk;
//   2. a review generated ahead of time and shipped with the prototype, used while the records
//      it was written from are unchanged.
// Either way the statements shown are the ones that cite records in the chart.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChartRecord } from "@halqa/fhir";
import type { PatientRef } from "@halqa/kernel";
import {
  bundleSubject,
  chartBundle,
  groundReview,
  loadStoredReviews,
  matchStoredReview,
  requestReviewFromEnv,
  REVIEW_MODEL,
  reviewWithModel,
  zReviewDraft,
  type Bundle,
  type RequestReview,
  type Review,
  type StoredReviews,
} from "@halqa/review";
import { staffName, type CaseRuntime } from "@halqa/runtime";
import * as z from "zod";

const zCached = z.object({ model: z.string(), at: z.number(), ms: z.number(), draft: zReviewDraft });

export type ReviewSource =
  | { readonly kind: "live"; readonly model: string; readonly at: number; readonly ms: number }
  | { readonly kind: "stored"; readonly model: string; readonly generatedOn: string; readonly via: string };

const describe = (record: ChartRecord) => ({ ref: record.ref, kind: record.kind, title: record.title, at: record.at });

function present(runtime: CaseRuntime, patient: PatientRef, review: Review, bundle: Bundle, source: ReviewSource, notCovered: readonly ChartRecord[]) {
  return {
    ...review,
    source,
    hash: bundle.hash,
    /** Label to record, for every record the review read. */
    lines: bundle.lines.map((line) => ({ label: line.label, ref: line.ref })),
    notCovered: notCovered.map(describe),
    marks: runtime
      .reviewMarks(patient)
      .filter((mark) => mark.bundleHash === bundle.hash)
      .map((mark) => ({ kind: mark.kind, by: staffName(mark.by), at: mark.at })),
  };
}

export type ChartReview = ReturnType<typeof present>;

export class ReviewService {
  readonly #cacheDir: string;
  readonly #stored: StoredReviews | null;
  readonly #request: RequestReview | null;

  constructor(cacheDir: string, options: { stored?: StoredReviews | null; request?: RequestReview | null } = {}) {
    this.#cacheDir = cacheDir;
    this.#stored = options.stored === undefined ? loadStoredReviews() : options.stored;
    this.#request = options.request === undefined ? requestFromEnv() : options.request;
  }

  /** Which model wrote the shipped reviews, and when. Null when none are shipped. */
  get storedInfo(): { readonly model: string; readonly generatedOn: string } | null {
    return this.#stored === null ? null : { model: this.#stored.model, generatedOn: this.#stored.generatedOn };
  }

  /** True when a live review can be requested: an API key is configured. */
  get live(): boolean {
    return this.#request !== null;
  }

  /** The review to show for this chart now, or null when there is none. Never calls a model. */
  current(runtime: CaseRuntime, patient: PatientRef, records: readonly ChartRecord[] = runtime.chart(patient)): ChartReview | null {
    const subject = bundleSubject(runtime.patient(patient));
    const whole = chartBundle(subject, records);
    const cached = this.#readCache(whole.hash);
    if (cached !== null) {
      const grounded = groundReview(cached.draft, whole);
      if (grounded.ok) return present(runtime, patient, grounded.review, whole, { kind: "live", model: cached.model, at: cached.at, ms: cached.ms }, []);
    }
    if (this.#stored === null) return null;
    const match = matchStoredReview(this.#stored, patient, subject, records);
    if (match === null) return null;
    const source: ReviewSource = { kind: "stored", model: this.#stored.model, generatedOn: this.#stored.generatedOn, via: this.#stored.via };
    return present(runtime, patient, match.review, match.bundle, source, match.notCovered);
  }

  /** Ask the model to review the whole chart as it stands. The answer is kept on disk under the chart's hash. */
  async run(runtime: CaseRuntime, patient: PatientRef): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    if (this.#request === null) return { ok: false, reason: "No API key is configured, so a live review cannot be requested." };
    const bundle = chartBundle(bundleSubject(runtime.patient(patient)), runtime.chart(patient));
    const result = await reviewWithModel(this.#request, bundle);
    runtime.logModelCall({ role: "record-review", model: REVIEW_MODEL, residency: "out-of-region", prompt: bundle.text, tool: null, latencyMs: result.ok ? result.ms : 0 });
    if (!result.ok) return { ok: false, reason: REASON[result.error] + (result.detail === null ? "" : ` (${result.detail})`) };
    const { summary, relevant, toCheck, notFound } = result.review;
    mkdirSync(this.#cacheDir, { recursive: true });
    writeFileSync(
      join(this.#cacheDir, `${bundle.hash}.json`),
      JSON.stringify({ model: REVIEW_MODEL, at: runtime.now(), ms: result.ms, draft: { summary, relevant, toCheck, notFound } }),
    );
    return { ok: true };
  }

  #readCache(hash: string): z.infer<typeof zCached> | null {
    const file = join(this.#cacheDir, `${hash}.json`);
    if (!existsSync(file)) return null;
    try {
      const parsed = zCached.safeParse(JSON.parse(readFileSync(file, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

const REASON = {
  "request-failed": "The model could not be reached.",
  "no-usable-answer": "The model returned nothing usable.",
  "summary-cites-no-record": "The model's summary cited no record in the chart, so the review was discarded.",
} as const;

function requestFromEnv(): RequestReview | null {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.trim() === "") return null;
  try {
    return requestReviewFromEnv();
  } catch {
    return null;
  }
}
