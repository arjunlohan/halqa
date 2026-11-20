// The brain port: given the acts on offer and what the patient just said, choose one.
// A brain never produces words. Whatever it returns is re-validated by the engine.
import type { FaqId, Lang } from "@halqa/catalogue";
import type { ActId, OpenState, Phi } from "@halqa/kernel";
import { chosenOption, classify, faqFor, namesNextStep } from "./rules.js";

/** What a brain may know about the call. It contains no identifiers and no patient words. */
export type SessionFacts = {
  readonly identity: "unverified" | "verified";
  readonly identityFailures: number;
  readonly teachBackPending: boolean;
  readonly teachBackFailures: number;
  /** Slots already read out, in spoken order: index 0 is "option one". */
  readonly offeredSlotIds: readonly string[];
  readonly lastAct: ActId | null;
  /** How many times in a row the agent has now spoken `lastAct`. */
  readonly repeats: number;
};

export type BrainInput = {
  readonly state: OpenState["kind"];
  /** Legal acts for the state, narrowed by the engine's guards. The choice must come from this list. */
  readonly offered: readonly ActId[];
  readonly facts: SessionFacts;
  /** The patient's latest words, or an empty string when the agent is continuing its own turn. */
  readonly utterance: Phi<string>;
  readonly lang: Lang;
};

export type BrainOutput =
  | { readonly kind: "act"; readonly act: ActId; readonly slotId: string | null; readonly faqId: FaqId | null }
  | { readonly kind: "teach-back"; readonly outcome: "names-next-step" | "does-not-name-next-step" };

export interface Brain {
  /** Recorded on every event and utterance the brain causes. */
  readonly id: string;
  /** Null means "no usable choice": the engine then asks the rules brain. */
  respond(input: BrainInput): Promise<BrainOutput | null>;
}

const act = (id: ActId, extra: { slotId?: string; faqId?: FaqId } = {}): BrainOutput => ({
  kind: "act",
  act: id,
  slotId: extra.slotId ?? null,
  faqId: extra.faqId ?? null,
});

/** A fixed dialogue policy. It is the default brain, the fallback for any other brain, and the reference in evals. */
export class RulesBrain implements Brain {
  readonly id = "rules-v1";

  respond(input: BrainInput): Promise<BrainOutput | null> {
    return Promise.resolve(this.decide(input));
  }

  decide({ state, offered, facts, utterance }: BrainInput): BrainOutput {
    const said = utterance.trim().length > 0;
    const intent = said ? classify(utterance) : "other";
    const can = (id: ActId): boolean => offered.includes(id);
    const faq = faqFor(intent);

    if (intent === "ask-human") return act("hand-off-to-human");

    switch (state) {
      case "awaiting-notification":
        if (can("deliver-result")) return act("deliver-result");
        if (can("verify-identity")) return act("verify-identity");
        return act("hand-off-to-human");

      case "awaiting-acknowledgement":
        if (facts.teachBackPending && said) {
          if (namesNextStep(utterance)) return { kind: "teach-back", outcome: "names-next-step" };
          if (faq !== null) return act("answer-approved-faq", { faqId: faq });
          return { kind: "teach-back", outcome: "does-not-name-next-step" };
        }
        if (faq !== null) return act("answer-approved-faq", { faqId: faq });
        return act("teach-back");

      case "awaiting-booking": {
        if (faq !== null) return act("answer-approved-faq", { faqId: faq });
        const option = said ? chosenOption(utterance) : null;
        const slotId = option === null ? undefined : facts.offeredSlotIds[option - 1];
        if (slotId !== undefined && can("confirm-slot")) return act("confirm-slot", { slotId });
        return act("offer-slots");
      }

      case "awaiting-attendance":
        if (facts.lastAct === "confirm-slot") return act("send-prep-instructions");
        if (faq !== null) return act("answer-approved-faq", { faqId: faq });
        if (intent === "none-suitable") return act("reschedule");
        return act("hand-off-to-human");

      case "awaiting-resolution":
        return act("hand-off-to-human");
    }
  }
}
