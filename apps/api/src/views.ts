// What the board, the case view and the programme view read. Types flow to the browser through tRPC.
import { formatWhen, renderFromLog } from "@halqa/catalogue";
import { isoFromInstant, MRN } from "@halqa/fhir";
import type { Actor, CaseId, CaseState, OpenState, PatientRef } from "@halqa/kernel";
import { pathwayById } from "@halqa/pathways";
import {
  CLINICIANS,
  ESCALATION_CONTACTS,
  NAVIGATORS,
  staffName,
  type CaseRecord,
  type CaseRuntime,
  type Handoff,
  type StoredEvent,
  type TimelineRow,
} from "@halqa/runtime";
import { callView, type CallEngine, type CallView } from "@halqa/voice";
import * as z from "zod";

const HOUR = 3_600_000;
export const OPEN_STATES: readonly OpenState["kind"][] = [
  "awaiting-notification",
  "awaiting-acknowledgement",
  "awaiting-booking",
  "awaiting-attendance",
  "awaiting-resolution",
];

export const actorLabel = (actor: Actor): string => {
  switch (actor.kind) {
    case "clinician":
    case "navigator":
      return staffName(actor.practitioner);
    case "agent":
      return `AI agent (${actor.model})`;
    case "system":
      return "System";
  }
};

/** Who the patient is, as the banner and the worklist show it. Synthetic birth dates carry a year only. */
export function patientCard(runtime: CaseRuntime, ref: PatientRef) {
  const patient = runtime.patient(ref);
  const birthYear = Number(patient?.birthDate?.slice(0, 4));
  return {
    ref,
    name: patient?.name[0]?.text ?? ref,
    birthYear: Number.isFinite(birthYear) ? birthYear : null,
    age: Number.isFinite(birthYear) ? new Date(runtime.now()).getUTCFullYear() - birthYear : null,
    sex: patient?.gender ?? null,
    mrn: patient?.identifier.find((identifier) => identifier.system === MRN)?.value ?? null,
    language: patient?.communication.find((c) => c.preferred === true)?.language.coding[0]?.code ?? null,
  };
}

/** Why the agent handed a call to a person, in words a navigator would use. */
export const HANDOFF_REASON: Readonly<Record<string, string>> = {
  "patient-request": "The patient asked to speak to a person",
  "red-flag": "The patient described possible emergency symptoms",
  "failed-identity": "Identity could not be confirmed",
  "teach-back-not-passed": "The patient could not say what happens next",
  "out-of-catalogue": "The patient asked something outside the approved script",
  reschedule: "The patient wants a different appointment",
  "no-suitable-slot": "None of the offered times suited the patient",
};

/** The one thing that should happen next on a case, and whose move it is. Rules only: no model is asked. */
function nextStep(runtime: CaseRuntime, state: CaseState, waiting: readonly Handoff[]): { readonly text: string; readonly who: "navigator" | "clinician" | "provider" | "none" } {
  if (state.kind === "closed") return { text: "Nothing: the case is closed", who: "none" };
  const urgent = waiting.find((handoff) => handoff.urgent);
  if (urgent !== undefined) return { text: "Call the patient now: possible emergency symptoms were reported on the call", who: "navigator" };
  const handoff = waiting[0];
  if (handoff !== undefined) return { text: `Call the patient. ${HANDOFF_REASON[handoff.reason] ?? handoff.reason}`, who: "navigator" };
  switch (state.kind) {
    case "awaiting-notification":
      return { text: "Tell the patient the result: place the outreach call", who: "navigator" };
    case "awaiting-acknowledgement":
      return { text: "Confirm the patient understands the result and the next step", who: "navigator" };
    case "awaiting-booking":
      return { text: "Book the colonoscopy", who: "navigator" };
    case "awaiting-attendance": {
      const appointment = runtime.appointment(state.appointment);
      const start = Date.parse(appointment?.start ?? "");
      const when = Number.isFinite(start) ? formatWhen(start, "en") : "the booked time";
      return { text: `Wait for the colonoscopy record. Booked ${when}`, who: "provider" };
    }
    case "awaiting-resolution":
      return { text: "A clinician decides how this case resolves", who: "clinician" };
  }
}

/** `all` lets a caller that summarises many cases read the hand-off and call tables once. */
export function summarise(runtime: CaseRuntime, id: CaseId, record: CaseRecord, all = { handoffs: runtime.handoffs(), calls: runtime.calls() }) {
  const { state } = record;
  const pathway = pathwayById(state.pathway);
  const handoffs = all.handoffs.filter((h) => h.caseId === id && h.pickedUpAt === null);
  const open = state.kind === "closed" ? null : state;
  const calls = all.calls.filter((call) => call.caseId === id);
  const level = open?.escalation ?? 0;
  const escalationRole = level === 0 ? null : (pathway?.escalation[level - 1] ?? null);
  return {
    id,
    kind: state.kind,
    pathway: pathway?.title ?? state.pathway,
    patient: patientCard(runtime, state.patient),
    next: nextStep(runtime, state, handoffs),
    calls: calls.length,
    lastCallAt: calls[0]?.startedAt ?? null,
    result: state.result,
    resultedAt: state.resultedAt,
    openedAt: record.openedAt,
    owner: open === null ? null : { ref: open.owner.practitioner, name: staffName(open.owner.practitioner), kind: open.owner.kind },
    due: open?.due ?? null,
    slaHours: open === null ? null : (pathway?.sla[open.kind] ?? null),
    escalation: level,
    escalatedTo: escalationRole === null ? null : ESCALATION_CONTACTS[escalationRole],
    openHandoffs: handoffs.length,
    urgent: handoffs.some((h) => h.urgent),
    integrity: record.integrity,
    closed:
      state.kind !== "closed"
        ? null
        : {
            at: state.closedAt,
            basis:
              state.evidence.basis.kind === "care-completed"
                ? { kind: "care-completed" as const, resource: state.evidence.basis.resource, code: state.evidence.basis.code, performedAt: state.evidence.basis.performedAt }
                : { kind: "human-decision" as const, reason: state.evidence.basis.reason, by: staffName(state.evidence.basis.by.practitioner), note: state.evidence.basis.note },
          },
  };
}

function describeEvent(runtime: CaseRuntime, event: StoredEvent): { title: string; detail: string; actor: string } {
  switch (event.type) {
    case "case-opened":
      return {
        title: "Case opened",
        detail: `${event.result} is actionable. Owner ${staffName(event.owner.practitioner)}, first deadline ${Math.round((event.due - event.at) / HOUR)} h.`,
        actor: "Pathway engine",
      };
    case "patient-notified":
      return { title: "Patient notified", detail: `Result delivered by ${event.channel}, after a two-identifier check.`, actor: actorLabel(event.by) };
    case "patient-acknowledged":
      return {
        title: "Understanding confirmed",
        detail: event.teachBack === "passed" ? "Teach-back passed unaided." : "Teach-back passed after the result was repeated.",
        actor: actorLabel(event.by),
      };
    case "appointment-booked": {
      const appointment = runtime.appointment(event.appointment);
      const start = Date.parse(appointment?.start ?? "");
      const where = appointment?.participant[1]?.actor?.display ?? "provider";
      return {
        title: "Colonoscopy booked",
        detail: Number.isFinite(start) ? `${formatWhen(start, "en")} at ${where}. ${event.appointment}` : event.appointment,
        actor: actorLabel(event.by),
      };
    }
    case "appointment-missed":
      return { title: "Appointment missed", detail: "The record shows a no-show. Back to booking, one level louder.", actor: "Record feed" };
    case "care-attended":
      return { title: "Attended", detail: "The record shows the patient arrived.", actor: "Record feed" };
    case "deadline-passed":
      return { title: "Deadline passed", detail: "Escalated one level. The clock restarted; the case stays open.", actor: "Durable timer" };
    case "owner-reassigned":
      return { title: "Owner reassigned", detail: `Now owned by ${staffName(event.to.practitioner)}.`, actor: actorLabel(event.by) };
    case "closed":
      return event.basis.kind === "care-completed"
        ? { title: "Closed on evidence", detail: `${event.basis.resource} is a completed colonoscopy for this patient, after the result.`, actor: "Closure listener" }
        : { title: "Closed by clinician decision", detail: `${event.basis.reason.replaceAll("-", " ")}: ${event.basis.note}`, actor: staffName(event.basis.by.practitioner) };
  }
}

export const timelineItem = (runtime: CaseRuntime, row: TimelineRow) => ({
  seq: row.seq,
  at: row.at,
  type: row.event.type,
  hash: row.hash,
  prevHash: row.prevHash,
  ...describeEvent(runtime, row.event),
});

/** The case as a FHIR R4 Task, so any FHIR client can read its status without Halqa's own API. */
export function fhirTask(id: CaseId, record: CaseRecord) {
  const { state } = record;
  const open = state.kind === "closed" ? null : state;
  return {
    resourceType: "Task",
    id,
    status: open === null ? "completed" : "in-progress",
    intent: "order",
    businessStatus: { text: state.kind },
    focus: { reference: state.result },
    for: { reference: state.patient },
    authoredOn: isoFromInstant(record.openedAt),
    ...(open === null ? {} : { owner: { reference: open.owner.practitioner }, restriction: { period: { end: isoFromInstant(open.due) } } }),
    ...(state.kind === "closed" && state.evidence.basis.kind === "care-completed"
      ? { output: [{ type: { text: "closure-evidence" }, valueReference: { reference: state.evidence.basis.resource } }] }
      : {}),
  };
}

export function caseDetail(runtime: CaseRuntime, id: CaseId, record: CaseRecord) {
  const { state } = record;
  const appointment = state.kind === "awaiting-attendance" ? runtime.appointment(state.appointment) : null;
  return {
    summary: summarise(runtime, id, record),
    timeline: runtime.timeline(id).map((row) => timelineItem(runtime, row)),
    chain: runtime.verifyChain(id),
    appointment:
      appointment === null
        ? null
        : { ref: `Appointment/${appointment.id}`, start: Date.parse(appointment.start ?? ""), provider: appointment.participant[1]?.actor?.display ?? "" },
    slots: state.kind === "awaiting-booking" ? runtime.freeSlots(3).map((slot) => ({ slotId: slot.slotId, at: slot.at, provider: slot.provider.name.en })) : [],
    evidenceAttempts: runtime.evidenceAttempts(id),
    handoffs: runtime
      .handoffs()
      .filter((h) => h.caseId === id)
      .map((h) => ({ ...h, reasonText: HANDOFF_REASON[h.reason] ?? h.reason, pickedUpBy: h.pickedUpBy === null ? null : staffName(h.pickedUpBy) })),
    task: fhirTask(id, record),
  };
}

export const staffDirectory = () => ({
  navigators: NAVIGATORS.map((s) => ({ ref: s.actor.practitioner, name: s.name, role: s.role })),
  clinicians: CLINICIANS.map((s) => ({ ref: s.actor.practitioner, name: s.name, role: s.role })),
});

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  const lower = sorted[mid - 1];
  if (upper === undefined) return null;
  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2;
};

/** The measures the challenge statement asks for, computed from the event log of the cases on the board. */
export function liveMeasures(runtime: CaseRuntime) {
  const toNotification: number[] = [];
  const toConfirmation: number[] = [];
  const toBooking: number[] = [];
  const toCare: number[] = [];
  const teachBack = { passed: 0, assisted: 0 };
  const closure = { byRecord: 0, byDecision: 0, within31Days: 0 };
  let open = 0;
  let pastAllowance = 0;
  const now = runtime.now();

  for (const record of runtime.list()) {
    const rows = runtime.timeline(record.id);
    const first = (type: StoredEvent["type"]) => rows.find((row) => row.event.type === type);
    const notified = first("patient-notified");
    const acknowledged = first("patient-acknowledged");
    const booked = first("appointment-booked");
    if (notified !== undefined) toNotification.push((notified.at - record.state.resultedAt) / HOUR);
    if (notified !== undefined && acknowledged !== undefined) toConfirmation.push((acknowledged.at - notified.at) / HOUR);
    if (booked !== undefined) toBooking.push((booked.at - record.state.resultedAt) / HOUR);
    if (acknowledged?.event.type === "patient-acknowledged") teachBack[acknowledged.event.teachBack] += 1;

    if (record.state.kind === "closed") {
      const { basis } = record.state.evidence;
      if (basis.kind === "care-completed") {
        closure.byRecord += 1;
        toCare.push((basis.performedAt - record.state.resultedAt) / HOUR);
        // "Referral" is the moment the case opened: in Halqa the referral is automatic.
        if (basis.performedAt - record.openedAt <= 31 * 24 * HOUR) closure.within31Days += 1;
      } else closure.byDecision += 1;
    } else {
      open += 1;
      const pathway = pathwayById(record.state.pathway);
      const allowance = pathway === undefined ? 0 : Object.values(pathway.sla).reduce((sum, hours) => sum + hours, 0);
      if (now - record.openedAt > allowance * HOUR) pastAllowance += 1;
    }
  }

  const handoffs = runtime.handoffs();
  const reasons: Record<string, number> = {};
  for (const handoff of handoffs) reasons[handoff.reason] = (reasons[handoff.reason] ?? 0) + 1;

  return {
    cases: runtime.list().length,
    open,
    pastAllowance,
    closure,
    teachBack,
    medianHours: { toNotification: median(toNotification), toConfirmation: median(toConfirmation), toBooking: median(toBooking), toCare: median(toCare) },
    handoffs: { total: handoffs.length, waiting: handoffs.filter((h) => h.pickedUpAt === null).length, reasons },
    modelCalls: runtime.modelCalls().length,
  };
}

// ───────────────────────── Calls ─────────────────────────
const zBookedOption = z.object({ option: z.object({ at: z.number(), provider: z.object({ en: z.string() }) }) });

/** What a call achieved, read from its record and the case's events. Each line is a fact, not a model's judgement. */
export function callOutcome(runtime: CaseRuntime, view: CallView) {
  const agent = view.turns.flatMap((turn) => (turn.speaker === "agent" ? [turn] : []));
  const did = (act: string): boolean => agent.some((turn) => turn.act === act);
  const booked = zBookedOption.safeParse(agent.find((turn) => turn.act === "confirm-slot")?.params);
  // The event this call's agent committed says how the understanding check went. The call id is the agent's run id.
  const acknowledged = runtime
    .timeline(view.caseId)
    .flatMap((row) => (row.event.type === "patient-acknowledged" && row.event.by.kind === "agent" && row.event.by.runId === view.id ? [row.event.teachBack] : []))[0];
  return {
    identity: view.identity,
    resultDelivered: did("deliver-result"),
    understanding:
      acknowledged === "passed"
        ? ("confirmed" as const)
        : acknowledged === "assisted"
          ? ("confirmed-after-repeat" as const)
          : did("teach-back")
            ? ("not-confirmed" as const)
            : ("not-asked" as const),
    booked: booked.success ? { at: booked.data.option.at, provider: booked.data.option.provider.en } : null,
  };
}


/** One row of the call list. */
export function callSummary(runtime: CaseRuntime, engine: CallEngine, view: CallView) {
  const record = runtime.get(view.caseId);
  return {
    id: view.id,
    caseId: view.caseId,
    patient: record === undefined ? null : patientCard(runtime, record.state.patient),
    startedAt: view.startedAt,
    endedAt: view.endedAt,
    channel: view.channel,
    lang: view.lang,
    policy: view.policy,
    ended: view.ended,
    endDetail: view.endDetail,
    endText: view.endDetail === null ? null : (HANDOFF_REASON[view.endDetail] ?? view.endDetail),
    live: engine.isLive(view.id),
    turns: view.turns.length,
    outcome: callOutcome(runtime, view),
  };
}

/** A call in full: its turns, what it achieved, and what the server measured while it ran. */
export function callDetail(runtime: CaseRuntime, engine: CallEngine, view: CallView) {
  const agent = view.turns.flatMap((turn) => (turn.speaker === "agent" ? [turn] : []));
  const decide = agent.flatMap((turn) => (turn.trace.decideMs === null ? [] : [turn.trace.decideMs]));
  const spoken = agent.flatMap((turn) => (turn.speech === null ? [] : [turn.speech]));
  return {
    ...callSummary(runtime, engine, view),
    identity: view.identity,
    // An Arabic line carries its English wording from the same script entry, for a reader who has no Arabic.
    turnList: view.turns.map((turn) => (turn.speaker === "agent" ? { ...turn, gloss: turn.lang === "ar" ? renderFromLog(turn.act, "en", turn.params) : null } : turn)),
    measures: {
      agentTurns: agent.length,
      forcedByEngine: agent.filter((turn) => turn.trace.by === "engine").length,
      decideMedianMs: median(decide),
      decideCount: decide.length,
      spokenTurns: spoken.length,
      cacheHits: spoken.filter((speech) => speech.cached).length,
      synthMedianMs: median(spoken.filter((speech) => !speech.cached).map((speech) => speech.ms)),
      characters: agent.reduce((sum, turn) => sum + turn.text.length, 0),
    },
  };
}

export const callsFor = (runtime: CaseRuntime, engine: CallEngine, caseId: CaseId | null) =>
  runtime
    .calls()
    .filter((call) => caseId === null || call.caseId === caseId)
    .flatMap((call) => {
      const view = callView(runtime, call.id);
      return view === null ? [] : [callSummary(runtime, engine, view)];
    });
