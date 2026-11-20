// The call engine: ear text in, one legal act out, approved wording spoken.
//
// Three things never depend on the brain, whichever one is plugged in:
//   1. Red flags. Rules read every utterance first and force emergency guidance.
//   2. Identity. Identifiers are checked here and never shown to a model.
//   3. Legality. The brain chooses from `legalActs(state)` narrowed by the guards below, and its
//      choice is parsed against that same list before anything is said.
import { randomUUID } from "node:crypto";
import { render, renderFromLog, type ActParams, type Lang, type SlotOption, type Utterance } from "@halqa/catalogue";
import { parseActChoice, zLang } from "@halqa/contracts";
import { EMIRATES_ID, type Patient } from "@halqa/fhir";
import { legalActs, type ActId, type Agent, type CaseId, type OpenState, type Phi } from "@halqa/kernel";
import type { CaseRuntime, HandoffReason, SlotOffer } from "@halqa/runtime";
import * as z from "zod";
import { RulesBrain, type Brain, type BrainInput, type BrainOutput, type SessionFacts } from "./brain.js";
import { asksForHuman, checkIdentity, detectLang, isRedFlag, redactForRecord, wantsOtherSlots } from "./rules.js";

// ───────────────────────── The call record ─────────────────────────
// A call is stored turn by turn as it happens, and every view of a call, live or old, is read back
// from that record. Agent turns hold the act and its slot values, never text: the words are
// rendered from the catalogue again on every read.
const zTrace = z.object({
  state: z.enum(["awaiting-notification", "awaiting-acknowledgement", "awaiting-booking", "awaiting-attendance", "awaiting-resolution"]),
  /** Every act the kernel allows in this state. */
  legal: z.array(z.string()),
  /** The legal acts that also pass the call's guards. The choice came from this list. */
  offered: z.array(z.string()),
  chosen: z.string(),
  /** A policy id, or "engine" when the engine forced the act. */
  by: z.string(),
  note: z.string().nullable(),
  /** How long the policy took to choose, in milliseconds. Null when the engine forced the act. */
  decideMs: z.number().nullable(),
});
const zAgentPayload = z.object({
  act: z.string(),
  lang: zLang,
  params: z.unknown(),
  catalogueId: z.string(),
  catalogueVersion: z.number(),
  trace: zTrace,
});
const zPatientPayload = z.object({ text: z.string().nullable(), lang: zLang });

/** Why the agent said what it said. */
export type Trace = z.infer<typeof zTrace>;

/** One synthesis of an agent turn, as the server measured it. */
export type Speech = { readonly cached: boolean; readonly ms: number; readonly characters: number; readonly voice: string };

export type Turn =
  /** `text` is null for the answer to the identity question, which is checked and never stored. */
  | { readonly speaker: "patient"; readonly idx: number; readonly at: number; readonly text: string | null; readonly lang: Lang }
  | {
      readonly speaker: "agent";
      readonly idx: number;
      readonly at: number;
      readonly act: string;
      readonly lang: Lang;
      readonly text: string;
      readonly params: unknown;
      readonly catalogue: string;
      readonly trace: Trace;
      readonly speech: Speech | null;
    };

export type CallEnd = "completed" | "handed-off" | "emergency" | "hung-up";
const CALL_ENDS: readonly CallEnd[] = ["completed", "handed-off", "emergency", "hung-up"];

export type CallView = {
  readonly id: string;
  readonly caseId: CaseId;
  /** The act-selection policy that ran the call. */
  readonly policy: string;
  readonly channel: string;
  readonly lang: Lang;
  readonly identity: "unverified" | "verified";
  readonly ended: CallEnd | null;
  /** For a hand-off, the reason it was raised. */
  readonly endDetail: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly turns: readonly Turn[];
};

/** A call as its record shows it. Null when there is no such call. */
export function callView(runtime: CaseRuntime, callId: string): CallView | null {
  const call = runtime.call(callId);
  if (call === null) return null;
  const speech = new Map(runtime.speech(callId).map((event) => [event.idx, event]));
  const turns = runtime.callTurns(callId).flatMap((row): Turn[] => {
    if (row.speaker === "patient") {
      const patient = zPatientPayload.safeParse(row.payload);
      return patient.success ? [{ speaker: "patient", idx: row.idx, at: row.at, text: patient.data.text, lang: patient.data.lang }] : [];
    }
    const agent = zAgentPayload.safeParse(row.payload);
    if (!agent.success) return [];
    const said = speech.get(row.idx);
    return [
      {
        speaker: "agent",
        idx: row.idx,
        at: row.at,
        act: agent.data.act,
        lang: agent.data.lang,
        text: renderFromLog(agent.data.act, agent.data.lang, agent.data.params) ?? "",
        params: agent.data.params,
        catalogue: `${agent.data.catalogueId} v${agent.data.catalogueVersion}`,
        trace: agent.data.trace,
        speech: said === undefined ? null : { cached: said.cached, ms: said.ms, characters: said.characters, voice: said.voice },
      },
    ];
  });
  const [end, detail] = (call.endReason ?? "").split(":");
  return {
    id: call.id,
    caseId: call.caseId,
    policy: call.policy,
    channel: call.channel,
    lang: call.lang === "en" ? "en" : "ar",
    identity: call.identity === "verified" ? "verified" : "unverified",
    ended: CALL_ENDS.find((candidate) => candidate === end) ?? null,
    endDetail: detail ?? null,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    turns,
  };
}

/** The two identifiers a caller must give before a result is released, or null when the record lacks either. */
export function expectedIdentity(patient: Patient | null): { readonly birthYear: string; readonly idLast4: string } | null {
  const id = patient?.identifier.find((identifier) => identifier.system === EMIRATES_ID)?.value;
  const birthYear = patient?.birthDate?.slice(0, 4);
  return id !== undefined && birthYear !== undefined ? { birthYear, idLast4: id.slice(-4) } : null;
}

export type StartError = "unknown-case" | "not-awaiting-notification";
export type CallChannel = "web" | "scripted";

type Session = {
  readonly id: string;
  readonly caseId: CaseId;
  readonly agent: Agent;
  readonly expected: { readonly birthYear: string; readonly idLast4: string } | null;
  lang: Lang;
  ended: CallEnd | null;
  endDetail: string | null;
  identity: "unverified" | "verified";
  identityFailures: number;
  teachBackPending: boolean;
  teachBackFailures: number;
  offered: readonly SlotOffer[];
  offerPage: number;
  lastAct: ActId | null;
  repeats: number;
  lastPatientText: string;
  /** A note to attach to the next agent turn, for decisions that produce no utterance of their own. */
  carry: string | null;
};

type Decision = { readonly output: BrainOutput; readonly by: string; readonly note: string | null; readonly ms: number | null };
type Next = "continue" | "wait";

const markPhi = (text: string): Phi<string> => text as Phi<string>;
const NOTHING_SAID = markPhi("");
export const MAX_SAME_ACT_IN_A_ROW = 2;
export const MAX_IDENTITY_FAILURES = 2;
export const MAX_TEACH_BACK_FAILURES = 2;

type ActOutput = Extract<BrainOutput, { kind: "act" }>;
const actOutput = (act: ActId): ActOutput => ({ kind: "act", act, slotId: null, faqId: null });
const toOption = (slot: SlotOffer): SlotOption => ({ at: slot.at, provider: slot.provider.name });

/** Guards that hold whatever the brain wants. They only ever remove acts from the legal list. */
function offeredActs(state: OpenState, session: Session): readonly ActId[] {
  return legalActs<OpenState["kind"]>(state).filter((act) => {
    switch (act) {
      case "greet":
        return session.lastAct === null;
      case "verify-identity":
        return session.identity === "unverified" && session.identityFailures < MAX_IDENTITY_FAILURES;
      case "deliver-result":
        // No result content before a two-identifier match.
        return session.identity === "verified";
      case "confirm-slot":
        return session.offered.length > 0;
      default:
        return true;
    }
  });
}

const factsOf = (session: Session): SessionFacts => ({
  identity: session.identity,
  identityFailures: session.identityFailures,
  teachBackPending: session.teachBackPending,
  teachBackFailures: session.teachBackFailures,
  offeredSlotIds: session.offered.map((slot) => slot.slotId),
  lastAct: session.lastAct,
  repeats: session.repeats,
});

/** Null when the brain's output may be acted on; otherwise the reason it may not. */
function problemWith(output: BrainOutput, offered: readonly ActId[], session: Session): string | null {
  if (output.kind === "teach-back") return session.teachBackPending ? null : "no teach-back answer is pending";
  const parsed = parseActChoice(offered, {
    act: output.act,
    slots: { slotId: output.slotId, faqId: output.faqId },
    patientLanguage: session.lang,
  });
  if (parsed === null) return "it is not among the acts on offer";
  if (output.act === "confirm-slot" && !session.offered.some((slot) => slot.slotId === output.slotId))
    return "that slot was not one of the options read out";
  if (output.act === "answer-approved-faq" && output.faqId === null) return "it names no approved answer";
  return null;
}

const describe = (output: BrainOutput): string => (output.kind === "act" ? output.act : `teach-back grade ${output.outcome}`);

export class CallEngine {
  readonly #runtime: CaseRuntime;
  readonly #brain: Brain;
  readonly #rules = new RulesBrain();
  readonly #sessions = new Map<string, Session>();

  constructor(runtime: CaseRuntime, brain: Brain = new RulesBrain()) {
    this.#runtime = runtime;
    this.#brain = brain;
  }

  get brainId(): string {
    return this.#brain.id;
  }

  /** Place the outreach call. The agent greets, then the brain takes its first turn. */
  async start(caseId: CaseId, channel: CallChannel = "web"): Promise<CallView | { readonly error: StartError }> {
    const record = this.#runtime.get(caseId);
    if (record === undefined) return { error: "unknown-case" };
    // The kernel's legal-move table has greeting and identity acts only in this state.
    if (record.state.kind !== "awaiting-notification") return { error: "not-awaiting-notification" };

    const patient = this.#runtime.patient(record.state.patient);
    const preferred = patient?.communication.find((c) => c.preferred === true)?.language.coding[0]?.code;
    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      caseId,
      agent: { kind: "agent", model: this.#brain.id, runId: sessionId },
      expected: expectedIdentity(patient),
      lang: preferred === "en" ? "en" : "ar",
      ended: null,
      endDetail: null,
      identity: "unverified",
      identityFailures: 0,
      teachBackPending: false,
      teachBackFailures: 0,
      offered: [],
      offerPage: 0,
      lastAct: null,
      repeats: 0,
      lastPatientText: "",
      carry: null,
    };
    this.#sessions.set(sessionId, session);
    this.#runtime.openCall({ id: sessionId, caseId, channel, lang: session.lang, policy: this.#brain.id });
    this.#perform(session, record.state, offeredActs(record.state, session), actOutput("greet"), "engine", "every call opens with the greeting", null);
    await this.#advance(session, NOTHING_SAID);
    return this.#view(session);
  }

  /** The patient said something. Text comes from the ear: speech recognition or the keyboard. */
  async say(sessionId: string, raw: string): Promise<CallView | null> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    const text = raw.trim().slice(0, 500);
    if (session.ended !== null || text.length === 0) return this.#view(session);

    session.lang = detectLang(text, session.lang);
    session.lastPatientText = text;
    const state = this.#openState(session);
    const answersIdentity = state?.kind === "awaiting-notification" && session.identity === "unverified" && session.lastAct === "verify-identity";
    // The answer to the identity question is checked below and never stored. Other replies are
    // stored with long digit runs removed.
    this.#runtime.logCallTurn(session.id, "patient", { text: answersIdentity ? null : redactForRecord(text), lang: session.lang });
    if (state === null) {
      session.ended = "completed";
      return this.#view(session);
    }

    if (isRedFlag(text)) {
      this.#runtime.logSnippet(session.caseId, "red-flag", text);
      this.#perform(session, state, offeredActs(state, session), actOutput("emergency-guidance"), "engine", "red-flag rule matched; the policy was not consulted", null);
      return this.#view(session);
    }

    if (answersIdentity) {
      const check = session.expected === null ? "mismatch" : checkIdentity(text, session.expected);
      if (check === "match") session.identity = "verified";
      else if (check === "mismatch") session.identityFailures += 1;
      session.carry = `identity check: ${check}`;
    }

    await this.#advance(session, markPhi(text));
    return this.#view(session);
  }

  /** The line dropped, or someone ended the call from the console. The case stays where it was. */
  hangUp(sessionId: string): CallView | null {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return callView(this.#runtime, sessionId);
    if (session.ended === null) session.ended = "hung-up";
    return this.#view(session);
  }

  /** True while this process holds the call and it has not ended. A call cut short by a restart is not live. */
  isLive(callId: string): boolean {
    return this.#sessions.get(callId)?.ended === null;
  }

  /** Save where the session stands, then read the call back from its record. */
  #view(session: Session): CallView {
    const endReason = session.ended === null ? null : session.endDetail === null ? session.ended : `${session.ended}:${session.endDetail}`;
    this.#runtime.updateCall(session.id, { lang: session.lang, identity: session.identity, endReason });
    const view = callView(this.#runtime, session.id);
    if (view === null) throw new Error(`call ${session.id} has no record`);
    return view;
  }

  #openState(session: Session): OpenState | null {
    const state = this.#runtime.get(session.caseId)?.state;
    return state === undefined || state.kind === "closed" ? null : state;
  }

  /** Let the agent act until it needs the patient to speak, the call ends, or a step limit is hit. */
  async #advance(session: Session, first: Phi<string>): Promise<void> {
    let utterance = first;
    for (let step = 0; step < 5 && session.ended === null; step++) {
      const state = this.#openState(session);
      if (state === null) {
        session.ended = "completed";
        return;
      }
      const offered = offeredActs(state, session);
      const decision = await this.#decide(session, state, offered, utterance);
      const next =
        decision.output.kind === "teach-back"
          ? this.#gradeTeachBack(session, state, offered, decision, decision.output.outcome, utterance)
          : this.#perform(session, state, offered, decision.output, decision.by, decision.note, decision.ms);
      if (next === "wait") return;
      utterance = NOTHING_SAID;
    }
  }

  /** Ask the brain; if its answer is missing or not allowed, ask the rules; if that fails, hand off. */
  async #decide(session: Session, state: OpenState, offered: readonly ActId[], utterance: Phi<string>): Promise<Decision> {
    const input: BrainInput = { state: state.kind, offered, facts: factsOf(session), utterance, lang: session.lang };
    const began = performance.now();
    const elapsed = (): number => Math.round((performance.now() - began) * 10) / 10;
    const settle = (output: BrainOutput, by: string, note: string | null): Decision => {
      const stuck =
        output.kind === "act" && output.act === session.lastAct && session.repeats >= MAX_SAME_ACT_IN_A_ROW && output.act !== "hand-off-to-human";
      return stuck
        ? { output: actOutput("hand-off-to-human"), by: "engine", note: `${output.act} was already said ${session.repeats} times in a row; handing off`, ms: elapsed() }
        : { output, by, note, ms: elapsed() };
    };

    let note: string | null = null;
    try {
      const output = await this.#brain.respond(input);
      if (output === null) note = `${this.#brain.id} gave no usable choice`;
      else {
        const problem = problemWith(output, offered, session);
        if (problem === null) return settle(output, this.#brain.id, null);
        note = `${this.#brain.id} chose ${describe(output)}, but ${problem}`;
      }
    } catch (error) {
      note = `${this.#brain.id} failed (${error instanceof Error ? error.message : "unknown error"})`;
    }

    if (this.#brain.id !== this.#rules.id) {
      const fallback = this.#rules.decide(input);
      if (problemWith(fallback, offered, session) === null) return settle(fallback, this.#rules.id, `${note}; the rules brain decided instead`);
    }
    return { output: actOutput("hand-off-to-human"), by: "engine", note: `${note}; handing off`, ms: elapsed() };
  }

  #gradeTeachBack(
    session: Session,
    state: OpenState,
    offered: readonly ActId[],
    decision: Decision,
    outcome: "names-next-step" | "does-not-name-next-step",
    utterance: Phi<string>,
  ): Next {
    this.#runtime.logSnippet(session.caseId, "teach-back-answer", utterance);
    if (outcome === "names-next-step") {
      const teachBack = session.teachBackFailures === 0 ? "passed" : "assisted";
      const committed = this.#runtime.applyAgent(session.caseId, { type: "patient-acknowledged", at: this.#runtime.now(), teachBack, by: session.agent });
      session.teachBackPending = false;
      if (!committed.ok) return this.#handOff(session, state, offered, "engine", `the kernel rejected patient-acknowledged: ${committed.error.reason}`, decision.ms);
      session.carry = `${decision.by} graded the teach-back answer: ${teachBack}`;
      return "continue";
    }
    session.teachBackFailures += 1;
    const graded = `${decision.by} graded the teach-back answer: does not name the next step`;
    if (session.teachBackFailures >= MAX_TEACH_BACK_FAILURES) return this.#handOff(session, state, offered, "engine", `${graded}, twice; handing off`, decision.ms);
    return this.#perform(session, state, offered, actOutput("repeat-result"), "engine", `${graded}; repeating the result more simply`, decision.ms);
  }

  /** Carry out one act: check it with the kernel where it moves the case, then speak its approved wording. */
  #perform(session: Session, state: OpenState, offered: readonly ActId[], output: ActOutput, by: string, note: string | null, ms: number | null): Next {
    const say = <A extends ActId>(act: A, params: ActParams[A]): void => {
      this.#speak(session, state, offered, render(act, session.lang, params), by, [session.carry, note], ms);
      session.repeats = session.lastAct === act ? session.repeats + 1 : 1;
      session.lastAct = act;
    };
    const handOff = (why: string): Next => this.#handOff(session, state, offered, "engine", why, ms);

    switch (output.act) {
      case "greet":
        say("greet", {});
        return "continue";

      case "verify-identity":
        say("verify-identity", {});
        return "wait";

      case "deliver-result": {
        const committed = this.#runtime.applyAgent(session.caseId, { type: "patient-notified", at: this.#runtime.now(), channel: "voice", by: session.agent });
        if (!committed.ok) return handOff(`the kernel rejected patient-notified: ${committed.error.reason}`);
        say("deliver-result", {});
        return "continue";
      }

      case "teach-back":
        say("teach-back", {});
        session.teachBackPending = true;
        return "wait";

      case "repeat-result":
        say("repeat-result", {});
        session.teachBackPending = true;
        return "wait";

      case "answer-approved-faq":
        say("answer-approved-faq", { faq: output.faqId ?? "who-are-you" });
        // While the teach-back question is open, the agent comes back to it after the answer.
        return state.kind === "awaiting-acknowledgement" ? "continue" : "wait";

      case "offer-slots": {
        if (session.offered.length > 0 && wantsOtherSlots(session.lastPatientText)) session.offerPage += 1;
        const slots = this.#runtime.freeSlots(3, session.offerPage * 3);
        if (slots.length === 0) return handOff("no free slots to offer");
        session.offered = slots;
        say("offer-slots", { options: slots.map(toOption) });
        return "wait";
      }

      case "confirm-slot": {
        const slot = session.offered.find((candidate) => candidate.slotId === output.slotId);
        if (slot === undefined) return handOff("the chosen slot was not on offer");
        const booked = this.#runtime.book(session.caseId, slot.slotId, session.agent);
        if (!booked.ok) return handOff(`booking failed: ${booked.error.reason}`);
        say("confirm-slot", { option: toOption(slot) });
        return "continue";
      }

      case "send-prep-instructions":
        say("send-prep-instructions", {});
        session.ended = "completed";
        return "wait";

      case "remind": {
        const appointment = state.kind === "awaiting-attendance" ? this.#runtime.appointment(state.appointment) : null;
        const slot = this.#runtime.slot(appointment?.slot[0]?.reference.replace("Slot/", "") ?? "");
        if (slot === null) return handOff("no appointment to remind about");
        say("remind", { option: toOption(slot) });
        return "wait";
      }

      case "reschedule":
        say("reschedule", {});
        this.#runtime.raiseHandoff(session.caseId, "reschedule", false);
        session.ended = "handed-off";
        session.endDetail = "reschedule";
        return "wait";

      case "hand-off-to-human":
        return this.#handOff(session, state, offered, by, note, ms);

      case "emergency-guidance":
        say("emergency-guidance", {});
        this.#runtime.raiseHandoff(session.caseId, "red-flag", true);
        session.ended = "emergency";
        session.endDetail = "red-flag";
        return "wait";
    }
  }

  /** Store one agent turn: the act, its slot values and why it was chosen. The words are not stored. */
  #speak(session: Session, state: OpenState, offered: readonly ActId[], utterance: Utterance, by: string, notes: readonly (string | null)[], ms: number | null): void {
    this.#runtime.logUtterance(session.caseId, utterance);
    const kept = notes.filter((n): n is string => n !== null);
    session.carry = null;
    const trace: Trace = {
      state: state.kind,
      legal: [...legalActs<OpenState["kind"]>(state)],
      offered: [...offered],
      chosen: utterance.act,
      by,
      note: kept.length > 0 ? kept.join("; ") : null,
      decideMs: by === "engine" ? null : ms,
    };
    this.#runtime.logCallTurn(session.id, "agent", {
      act: utterance.act,
      lang: utterance.lang,
      params: utterance.params,
      catalogueId: utterance.catalogueId,
      catalogueVersion: utterance.catalogueVersion,
      trace,
    });
  }

  #handOff(session: Session, state: OpenState, offered: readonly ActId[], by: string, note: string | null, ms: number | null): Next {
    const reason: HandoffReason =
      session.identity === "unverified" && session.identityFailures >= MAX_IDENTITY_FAILURES
        ? "failed-identity"
        : session.teachBackFailures >= MAX_TEACH_BACK_FAILURES
          ? "teach-back-not-passed"
          : asksForHuman(session.lastPatientText)
            ? "patient-request"
            : session.lastAct === "offer-slots"
              ? "no-suitable-slot"
              : "out-of-catalogue";
    const utterance = render("hand-off-to-human", session.lang, { style: reason === "failed-identity" ? "call-back" : "transfer" });
    this.#speak(session, state, offered, utterance, by, [session.carry, note, `hand-off reason: ${reason}`], ms);
    session.lastAct = "hand-off-to-human";
    session.repeats = 1;
    this.#runtime.raiseHandoff(session.caseId, reason, false);
    session.ended = "handed-off";
    session.endDetail = reason;
    return "wait";
  }
}
