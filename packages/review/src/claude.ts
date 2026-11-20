// The model call. One request, structured output, no tools: the model reads the chart text and
// fills the review schema. Its answer is grounded against the chart before it is returned.
import AnthropicClient from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Deidentified } from "@halqa/kernel";
import type { Bundle } from "./bundle.js";
import { groundReview, zReviewDraft, type GroundingError, type Review } from "./review.js";

export const REVIEW_MODEL = "claude-fable-5-2";

export const REVIEW_SYSTEM = `You are reading one patient's chart for the staff of a bowel cancer screening follow-up programme.

Why the chart is being read: the patient's stool test (FIT) came back positive, which opened a follow-up case. The next step in the pathway is a colonoscopy. Two people will read your review. A care navigator, who is not a clinician, arranges the appointment and speaks to the patient. A screening clinician decides anything clinical. Your review tells them what the chart holds that matters for arranging the colonoscopy and carrying it out safely, so they know where to look. They will open the records themselves; you are pointing, they are deciding.

The chart is a list of records. Each has a label (R1, R2, ...). The list is all you know about this patient.

What to write:
- summary: the chart in at most 30 words.
- relevant: what a colonoscopy team would want to know from this chart. Think about medicines that affect bleeding, conditions that affect sedation or bowel preparation, blood results that bear on the positive test, earlier bowel investigations, and family history of bowel cancer. Include an item only when a record shows it.
- toCheck: points a clinician should look at before the procedure goes ahead, phrased as what to look at and why it matters to the procedure, not as an instruction to the patient or a change to treatment. Leave it empty when the chart holds no such point; an empty list is a useful answer.
- notFound: things from the list above that you looked for and the records do not mention (for example "allergies", "previous colonoscopy"). Staff read this as "not in these records", which is different from "not true of the patient".

How every statement is checked: each sentence in summary, relevant and toCheck must cite the labels of the records it rests on. After you answer, software removes any sentence whose citations do not match a record in the chart, so a sentence without a correct citation is never shown. Write only what a cited record states. Give values and dates as the record gives them. Where a record carries a flag such as "flagged low on the record", you may report the flag; do not apply reference ranges or thresholds of your own.

Stay on the side of description. Say what the record shows and why a colonoscopy team would care; leave diagnosis, risk estimates, and decisions about medicines or timing to the clinician. Do not address the patient.

Write in plain English that a non-clinician can follow, one sentence per item, no abbreviations a navigator would have to look up.`;

export const reviewUserMessage = (chart: Deidentified<string>): string =>
  `${chart}\n\nReview this chart for the navigator and the screening clinician. Cite a record label for every sentence.`;

/** The one SDK call, as a port, so tests can stand in for the API. Null means the model declined or returned nothing usable. */
export type RequestReview = (system: string, user: string) => Promise<unknown>;

export type LiveReviewError = GroundingError | "no-usable-answer" | "request-failed";

export async function reviewWithModel(
  request: RequestReview,
  bundle: Bundle,
): Promise<{ readonly ok: true; readonly review: Review; readonly ms: number } | { readonly ok: false; readonly error: LiveReviewError; readonly detail: string | null }> {
  const started = performance.now();
  let answer: unknown;
  try {
    answer = await request(REVIEW_SYSTEM, reviewUserMessage(bundle.text));
  } catch (error) {
    return { ok: false, error: "request-failed", detail: error instanceof Error ? error.message : null };
  }
  const draft = zReviewDraft.safeParse(answer);
  if (!draft.success) return { ok: false, error: "no-usable-answer", detail: null };
  const grounded = groundReview(draft.data, bundle);
  return grounded.ok ? { ok: true, review: grounded.review, ms: Math.round(performance.now() - started) } : { ok: false, error: grounded.error, detail: null };
}

/** The request against the real API. The SDK reads the key from the environment. */
export function requestReviewFromEnv(): RequestReview {
  const client = new AnthropicClient();
  return async (system, user) => {
    const response = await client.messages.parse({
      model: REVIEW_MODEL,
      max_tokens: 8000,
      // Thinking is always on for this model; effort is the depth control.
      output_config: { effort: "medium", format: zodOutputFormat(zReviewDraft) },
      system,
      messages: [{ role: "user", content: user }],
    });
    return response.stop_reason === "refusal" ? null : response.parsed_output;
  };
}
