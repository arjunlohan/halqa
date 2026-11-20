// The tool the model sees is generated from the acts on offer: the kernel's legal acts for the
// case's current state, narrowed by the call's guards. The JSON Schema enum handed to the model
// IS the set of acts it may choose.
import type Anthropic from "@anthropic-ai/sdk";
import type { ActId } from "@halqa/kernel";
import * as z from "zod";

export const zFaqId = z.enum(["is-this-cancer", "what-is-colonoscopy", "who-are-you"]);
export const zLang = z.enum(["ar", "en"]);

const zSlots = z.object({
  slotId: z.string().nullable(),
  faqId: zFaqId.nullable(),
});
export type SelectedSlots = z.infer<typeof zSlots>;

/** Schema for a choice among `acts`. Callers pass a list that is the legal acts or a subset of them. */
export function actChoiceSchema<A extends ActId>(acts: readonly A[]) {
  const [first, ...rest] = acts;
  if (first === undefined) throw new Error("an act choice needs at least one act");
  return z.object({
    act: z.enum([first, ...rest]),
    slots: zSlots,
    patientLanguage: zLang,
  });
}

export type ActChoice<A extends ActId = ActId> = {
  readonly act: A;
  readonly slots: SelectedSlots;
  readonly patientLanguage: z.infer<typeof zLang>;
};

export const SELECT_ACT = "select_act";

export function selectActTool(acts: readonly ActId[]): Anthropic.Tool {
  const schema = z.toJSONSchema(actChoiceSchema(acts));
  return {
    name: SELECT_ACT,
    description:
      "Choose the next approved utterance for this call. You cannot speak free text; " +
      "the patient hears only the approved wording for the act you choose.",
    input_schema: { ...schema, type: "object" },
    strict: true,
  };
}

/** Decode the model's tool input back into a typed act. Parse, don't trust. */
export function parseActChoice<A extends ActId>(acts: readonly A[], input: unknown): ActChoice<A> | null {
  const parsed = actChoiceSchema(acts).safeParse(input);
  return parsed.success ? parsed.data : null;
}

// The teach-back grade is a second, separate tool: the model reports what it heard, the engine decides what follows.
export const zTeachBackGrade = z.object({
  outcome: z.enum(["names-next-step", "does-not-name-next-step"]),
});
export type TeachBackGrade = z.infer<typeof zTeachBackGrade>;
export const RECORD_TEACH_BACK = "record_teach_back";

export function recordTeachBackTool(): Anthropic.Tool {
  return {
    name: RECORD_TEACH_BACK,
    description:
      "Grade the patient's teach-back answer. Use names-next-step only if the patient said, in any words or language, " +
      "that the next step is a colonoscopy or camera test of the bowel.",
    input_schema: { ...z.toJSONSchema(zTeachBackGrade), type: "object" },
    strict: true,
  };
}
