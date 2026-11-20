// A review is a model's reading of a chart, kept only as far as the chart supports it. Every
// statement names the records it rests on; a statement that names none, or names records that
// are not in the chart, is dropped here before anyone sees it.
import * as z from "zod";
import type { Bundle } from "./bundle.js";

const zCited = z.object({
  text: z.string().describe("One plain sentence saying what the records show."),
  cites: z.array(z.string()).describe("Labels of the records the sentence rests on, for example R3."),
});

/** What the model returns. Field descriptions are part of the prompt. */
export const zReviewDraft = z.object({
  summary: zCited.describe("The chart in at most 30 words, for someone deciding whether to read further."),
  relevant: z.array(zCited).describe("What in the chart matters for arranging the colonoscopy and carrying it out safely. Most important first."),
  toCheck: z.array(zCited).describe("Points a clinician should look at before the colonoscopy goes ahead. Empty when the chart holds none."),
  notFound: z.array(z.string()).describe("Things you looked for that the records do not mention, each as a short noun phrase."),
});
export type ReviewDraft = z.infer<typeof zReviewDraft>;

export type Statement = { readonly text: string; readonly cites: readonly string[] };

export type Review = {
  readonly summary: Statement;
  readonly relevant: readonly Statement[];
  readonly toCheck: readonly Statement[];
  readonly notFound: readonly string[];
  /** Set from `toCheck`, so the flag can never disagree with the points listed under it. */
  readonly flag: "clinician-should-review" | "nothing-flagged";
  /** Statements removed because they cited no record in this chart. */
  readonly dropped: number;
};

export type GroundingError = "summary-cites-no-record";

const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Keep what the chart supports. Returns an error when even the summary rests on nothing. */
export function groundReview(draft: ReviewDraft, bundle: Bundle): { readonly ok: true; readonly review: Review } | { readonly ok: false; readonly error: GroundingError } {
  const known = new Set(bundle.lines.map((line) => line.label));
  let dropped = 0;
  const ground = (statement: z.infer<typeof zCited>): Statement | null => {
    const cites = [...new Set(statement.cites.map((cite) => cite.trim().toUpperCase()))].filter((cite) => known.has(cite));
    const text = clean(statement.text);
    if (cites.length === 0 || text === "") {
      dropped += 1;
      return null;
    }
    return { text, cites };
  };
  const keep = (statements: readonly z.infer<typeof zCited>[]): Statement[] => statements.flatMap((statement) => ground(statement) ?? []);

  const summary = ground(draft.summary);
  if (summary === null) return { ok: false, error: "summary-cites-no-record" };
  const relevant = keep(draft.relevant);
  const toCheck = keep(draft.toCheck);
  return {
    ok: true,
    review: {
      summary,
      relevant,
      toCheck,
      notFound: draft.notFound.map(clean).filter((item) => item !== ""),
      flag: toCheck.length > 0 ? "clinician-should-review" : "nothing-flagged",
      dropped,
    },
  };
}
