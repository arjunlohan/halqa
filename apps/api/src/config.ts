// Where the rules are set. Everything on the console's configuration pages is read from the same
// typed definitions the engine runs on, so the page cannot drift from the behaviour.
import { CATALOGUE, FAQ_IDS, render, type Lang } from "@halqa/catalogue";
import { legalActs, type ActId, type OpenState } from "@halqa/kernel";
import { crcFitPositive } from "@halqa/pathways";
import { REVIEW_MODEL } from "@halqa/review";
import { ESCALATION_CONTACTS, PROVIDERS, type CaseRuntime } from "@halqa/runtime";
import { CLAUDE_MODEL, MAX_IDENTITY_FAILURES, MAX_SAME_ACT_IN_A_ROW, MAX_TEACH_BACK_FAILURES, RED_FLAG_RULE } from "@halqa/voice";
import { OPEN_STATES, staffDirectory } from "./views.js";

const LANGS: readonly Lang[] = ["en", "ar"];

// The kernel's table is read through `legalActs`, its only door. The fields besides `kind` are not consulted.
const actsIn = (kind: OpenState["kind"]): readonly ActId[] => legalActs<OpenState["kind"]>({ kind } as OpenState);

/** Example appointment values for wordings that take a time and a place. */
const exampleOptions = (now: number) =>
  PROVIDERS.slice(0, 2).map((provider, index) => ({ at: now + (3 + index) * 24 * 3_600_000, provider: provider.name }));

function script(now: number) {
  const options = exampleOptions(now);
  const first = options[0] ?? { at: now, provider: { en: "", ar: "" } };
  const both = <A extends ActId>(variant: string | null, say: (lang: Lang) => { readonly act: A; readonly text: string }, example = false) => {
    const lines = LANGS.map((lang) => say(lang));
    return { act: lines[0]?.act ?? "", variant, example, en: lines[0]?.text ?? "", ar: lines[1]?.text ?? "" };
  };
  return [
    both(null, (lang) => render("greet", lang, {})),
    both(null, (lang) => render("verify-identity", lang, {})),
    both(null, (lang) => render("deliver-result", lang, {})),
    both(null, (lang) => render("teach-back", lang, {})),
    both(null, (lang) => render("repeat-result", lang, {})),
    ...FAQ_IDS.map((faq) => both(faq, (lang) => render("answer-approved-faq", lang, { faq }))),
    both("example times", (lang) => render("offer-slots", lang, { options }), true),
    both("example time", (lang) => render("confirm-slot", lang, { option: first }), true),
    both(null, (lang) => render("send-prep-instructions", lang, {})),
    both("example time", (lang) => render("remind", lang, { option: first }), true),
    both(null, (lang) => render("reschedule", lang, {})),
    both("transfer", (lang) => render("hand-off-to-human", lang, { style: "transfer" })),
    both("call back", (lang) => render("hand-off-to-human", lang, { style: "call-back" })),
    both(null, (lang) => render("emergency-guidance", lang, {})),
  ];
}

export function configuration(runtime: CaseRuntime, runtimeInfo: { policy: string; voice: string; liveReview: boolean; storedReviews: { model: string; generatedOn: string } | null }) {
  const pathway = crcFitPositive;
  const cases = runtime.list();
  const chains = cases.map((record) => runtime.verifyChain(record.id));
  return {
    pathway: {
      id: pathway.id,
      title: pathway.title,
      trigger: { resource: pathway.trigger.resource, codes: pathway.trigger.codes, interpretation: pathway.trigger.actionableWhen.interpretation },
      next: pathway.next,
      closing: pathway.closing.acceptedCodes,
      stages: OPEN_STATES.map((state, index) => ({
        state,
        hours: pathway.sla[state],
        source: pathway.slaSource[state],
        // A stage's deadline passing raises the case one level; the level decides who is told.
        acts: actsIn(state),
        order: index + 1,
      })),
      escalation: pathway.escalation.map((role, index) => ({ level: index + 1, role, contact: ESCALATION_CONTACTS[role] })),
      outreach: pathway.outreach,
    },
    script: {
      id: CATALOGUE.id,
      version: CATALOGUE.version,
      status: CATALOGUE.status,
      lines: script(runtime.now()),
    },
    guardrails: {
      limits: { identityAttempts: MAX_IDENTITY_FAILURES, teachBackAttempts: MAX_TEACH_BACK_FAILURES, sameActInARow: MAX_SAME_ACT_IN_A_ROW },
      redFlags: RED_FLAG_RULE,
    },
    models: {
      policy: runtimeInfo.policy,
      policyModel: CLAUDE_MODEL,
      voice: runtimeInfo.voice,
      reviewModel: REVIEW_MODEL,
      liveReview: runtimeInfo.liveReview,
      storedReviews: runtimeInfo.storedReviews,
      modelCalls: runtime.modelCalls().length,
    },
    data: {
      resources: runtime.resourceCounts(),
      cases: cases.length,
      chainsIntact: chains.filter((chain) => chain.ok).length,
      events: chains.reduce((sum, chain) => sum + (chain.ok ? chain.length : 0), 0),
      clockOffsetMs: runtime.clockOffsetMs(),
    },
    staff: {
      ...staffDirectory(),
      providers: PROVIDERS.map((p) => ({ key: p.key, name: p.name.en, starts: p.starts })),
    },
  };
}
