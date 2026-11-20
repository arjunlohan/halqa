// tRPC procedures. Every input is parsed by Zod into branded kernel types before a handler sees it,
// and every output type reaches the browser by inference: there is no hand-written API type.
import { runSimulation, type SimResult } from "@halqa/evals";
import { zCaseId, zPatientRef, zResourceRef } from "@halqa/fhir";
import type { Clinician, Owner } from "@halqa/kernel";
import { appointmentUpdate, CLINICIANS, colonoscopyProcedure, fitObservation, NAVIGATORS, SYNTHETIC_PATIENT_IDS, zHumanClosureReason } from "@halqa/runtime";
import { callView, expectedIdentity } from "@halqa/voice";
import { initTRPC, TRPCError } from "@trpc/server";
import * as z from "zod";
import { agentCloseAttack } from "./attack.js";
import { configuration } from "./config.js";
import type { HalqaHost } from "./halqa.js";
import type { ReviewService } from "./review.js";
import { voiceLabel } from "./tts.js";
import { callDetail, callsFor, caseDetail, liveMeasures, patientCard, staffDirectory, summarise } from "./views.js";

export type Context = { readonly host: HalqaHost; readonly reviews: ReviewService };

const t = initTRPC.context<Context>().create();
const HOUR = 3_600_000;

// The prototype has no sign-in. Whoever is "acting as" a member of staff is looked up in the directory,
// so an unknown or agent identity can never be passed off as a navigator or a clinician.
const staff = (ref: string): Owner => {
  const found = [...NAVIGATORS, ...CLINICIANS].find((s) => s.actor.practitioner === ref);
  if (found === undefined) throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of staff in the directory." });
  return found.actor;
};
const clinician = (ref: string): Clinician => {
  const found = CLINICIANS.find((s) => s.actor.practitioner === ref);
  if (found === undefined) throw new TRPCError({ code: "FORBIDDEN", message: "Only a clinician can close a case by decision." });
  return found.actor;
};

const refuse = (reason: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message: reason });
};

let simulation: SimResult | null = null;
let serial = 0;
/** Ids for resources posted from the demo's record feed. */
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(serial++).toString(36)}`;

export const appRouter = t.router({
  board: t.procedure.query(({ ctx }) => {
    const { runtime } = ctx.host.current;
    const order = (kind: string): number => (kind === "closed" ? 1 : 0);
    const all = { handoffs: runtime.handoffs(), calls: runtime.calls() };
    const cases = runtime
      .list()
      .map((record) => summarise(runtime, record.id, record, all))
      .sort((a, b) => order(a.kind) - order(b.kind) || Number(b.urgent) - Number(a.urgent) || b.escalation - a.escalation || (a.due ?? 0) - (b.due ?? 0));
    const withCases = new Set(runtime.list().filter((r) => r.state.kind !== "closed").map((r) => r.state.patient));
    return {
      now: runtime.now(),
      /** How far the sandbox clock has been skipped ahead of real time. */
      clockOffsetMs: runtime.clockOffsetMs(),
      cases,
      staff: staffDirectory(),
      // Synthetic patients who have no open case: the sandbox can post a positive FIT for any of them.
      idlePatients: SYNTHETIC_PATIENT_IDS.flatMap((id) => {
        const ref = zPatientRef.parse(`Patient/${id}`);
        return runtime.patient(ref) === null || withCases.has(ref) ? [] : [patientCard(runtime, ref)];
      }),
    };
  }),

  case: t.procedure.input(z.object({ caseId: zCaseId })).query(({ ctx, input }) => {
    const { runtime, engine } = ctx.host.current;
    const record = runtime.get(input.caseId);
    if (record === undefined) throw new TRPCError({ code: "NOT_FOUND", message: "No such case." });
    const chart = runtime.chart(record.state.patient);
    return {
      ...caseDetail(runtime, input.caseId, record),
      now: runtime.now(),
      chart,
      review: ctx.reviews.current(runtime, record.state.patient, chart),
      liveReview: ctx.reviews.live,
      calls: callsFor(runtime, engine, input.caseId),
      // The sandbox has no real patient on the line, so whoever plays the patient needs the answers
      // to the identity question. A real patient knows their own.
      sandboxIdentity: expectedIdentity(runtime.patient(record.state.patient)) ?? { birthYear: "", idLast4: "" },
    };
  }),

  // ───────────── Calls ─────────────
  calls: t.procedure.query(({ ctx }) => {
    const { runtime, engine } = ctx.host.current;
    return { now: runtime.now(), calls: callsFor(runtime, engine, null) };
  }),

  callRecord: t.procedure.input(z.object({ callId: z.string().uuid() })).query(({ ctx, input }) => {
    const { runtime, engine } = ctx.host.current;
    const view = callView(runtime, input.callId);
    if (view === null) throw new TRPCError({ code: "NOT_FOUND", message: "No such call." });
    return callDetail(runtime, engine, view);
  }),

  callStart: t.procedure.input(z.object({ caseId: zCaseId })).mutation(async ({ ctx, input }) => {
    const { runtime, engine } = ctx.host.current;
    const started = await engine.start(input.caseId);
    if ("error" in started) return refuse(started.error === "unknown-case" ? "No such case." : "The outreach call can only be placed while the case is awaiting notification.");
    return callDetail(runtime, engine, started);
  }),

  callSay: t.procedure.input(z.object({ sessionId: z.string().uuid(), text: z.string().min(1).max(500) })).mutation(async ({ ctx, input }) => {
    const { runtime, engine } = ctx.host.current;
    const view = await engine.say(input.sessionId, input.text);
    return view === null ? refuse("That call is no longer running: the server restarted since it began.") : callDetail(runtime, engine, view);
  }),

  callHangUp: t.procedure.input(z.object({ sessionId: z.string().uuid() })).mutation(({ ctx, input }) => {
    const { runtime, engine } = ctx.host.current;
    const view = engine.hangUp(input.sessionId);
    return view === null ? refuse("No such call.") : callDetail(runtime, engine, view);
  }),

  // ───────────── Chart review ─────────────
  runReview: t.procedure.input(z.object({ caseId: zCaseId })).mutation(async ({ ctx, input }) => {
    const { runtime } = ctx.host.current;
    const record = runtime.get(input.caseId);
    if (record === undefined) return refuse("No such case.");
    const result = await ctx.reviews.run(runtime, record.state.patient);
    return result.ok ? { ok: true as const } : refuse(result.reason);
  }),

  /** A member of staff records that they checked the review against the chart, or reports it as wrong. */
  markReview: t.procedure
    .input(z.object({ caseId: zCaseId, hash: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["checked", "reported-inaccurate"]), by: z.string() }))
    .mutation(({ ctx, input }) => {
      const { runtime } = ctx.host.current;
      const record = runtime.get(input.caseId);
      if (record === undefined) return refuse("No such case.");
      runtime.markReview(record.state.patient, input.hash, input.kind, staff(input.by));
      return { ok: true as const };
    }),

  // ───────────── Configuration ─────────────
  config: t.procedure.query(({ ctx }) => {
    const { runtime, engine } = ctx.host.current;
    return configuration(runtime, { policy: engine.brainId, voice: voiceLabel(), liveReview: ctx.reviews.live, storedReviews: ctx.reviews.storedInfo });
  }),

  // ───────────── People ─────────────
  pickUpHandoff: t.procedure.input(z.object({ handoffId: z.number().int(), by: z.string() })).mutation(({ ctx, input }) => {
    return { pickedUp: ctx.host.current.runtime.pickUpHandoff(input.handoffId, staff(input.by)) };
  }),

  reassign: t.procedure.input(z.object({ caseId: zCaseId, to: z.string(), by: z.string() })).mutation(({ ctx, input }) => {
    const result = ctx.host.current.runtime.reassign(input.caseId, staff(input.to), staff(input.by));
    return result.ok ? { ok: true as const } : refuse(result.error.reason);
  }),

  /** A person did by phone or in person what the agent would have done. */
  recordStep: t.procedure
    .input(z.object({ caseId: zCaseId, by: z.string(), step: z.enum(["notified", "acknowledged"]) }))
    .mutation(({ ctx, input }) => {
      const { runtime } = ctx.host.current;
      const by = staff(input.by);
      const at = runtime.now();
      const result =
        input.step === "notified"
          ? runtime.apply(input.caseId, { type: "patient-notified", at, channel: "voice", by })
          : runtime.apply(input.caseId, { type: "patient-acknowledged", at, teachBack: "assisted", by });
      return result.ok ? { ok: true as const } : refuse(result.error.reason);
    }),

  book: t.procedure.input(z.object({ caseId: zCaseId, slotId: z.string(), by: z.string() })).mutation(({ ctx, input }) => {
    const result = ctx.host.current.runtime.book(input.caseId, input.slotId, staff(input.by));
    return result.ok ? { appointment: result.value.appointment } : refuse(result.error.reason);
  }),

  closeByDecision: t.procedure
    .input(z.object({ caseId: zCaseId, by: z.string(), reason: zHumanClosureReason, note: z.string().max(2000) }))
    .mutation(({ ctx, input }) => {
      const result = ctx.host.current.runtime.closeByDecision(input.caseId, clinician(input.by), input.reason, input.note);
      if (result.ok) return { ok: true as const };
      return refuse(result.error.reason === "note-required" ? "A closure by decision needs a note of at least 20 characters." : result.error.reason);
    }),

  // ───────────── Break it ─────────────
  attackAgentClose: t.procedure.input(z.object({ caseId: zCaseId })).mutation(async ({ ctx, input }) => {
    const result = await agentCloseAttack(ctx.host.current.runtime, input.caseId);
    return result ?? refuse("No such case.");
  }),

  // ───────────── The synthetic record feed (demo controls) ─────────────
  // Each of these posts a FHIR resource through the same ingest path as POST /fhir.
  postFit: t.procedure.input(z.object({ patient: zPatientRef })).mutation(({ ctx, input }) => {
    const { runtime } = ctx.host.current;
    return runtime.ingest(fitObservation({ id: nextId("fit"), patient: input.patient, issuedAt: runtime.now() - HOUR }));
  }),

  postProcedure: t.procedure
    .input(z.object({ caseId: zCaseId, variant: z.enum(["completed", "wrong-patient", "wrong-code", "not-completed"]) }))
    .mutation(({ ctx, input }) => {
      const { runtime } = ctx.host.current;
      const record = runtime.get(input.caseId);
      if (record === undefined) return refuse("No such case.");
      const appointment = record.state.kind === "awaiting-attendance" ? runtime.appointment(record.state.appointment) : null;
      const scheduled = Date.parse(appointment?.start ?? "");
      // A colonoscopy performed at the booked time if that has passed, otherwise an hour ago.
      const performedAt = Number.isFinite(scheduled) && scheduled < runtime.now() ? scheduled : runtime.now() - HOUR;
      // Someone with no case of their own: a completed colonoscopy for a patient who has an open
      // case would, correctly, close that case.
      const someoneElse = "Patient/syn-bystander";
      const base = { id: nextId("col"), patient: record.state.patient, performedAt };
      switch (input.variant) {
        case "completed":
          return runtime.ingest(colonoscopyProcedure(base));
        case "wrong-patient":
          return runtime.ingest(colonoscopyProcedure({ ...base, patient: someoneElse, basedOnCase: input.caseId }));
        case "wrong-code":
          return runtime.ingest(colonoscopyProcedure({ ...base, code: "44441009", display: "Flexible fiberoptic sigmoidoscopy" }));
        case "not-completed":
          return runtime.ingest(colonoscopyProcedure({ ...base, status: "in-progress" }));
      }
    }),

  postAppointmentStatus: t.procedure.input(z.object({ appointment: zResourceRef, status: z.enum(["noshow", "fulfilled"]) })).mutation(({ ctx, input }) => {
    const { runtime } = ctx.host.current;
    const current = runtime.appointment(input.appointment);
    return current === null ? refuse("No such appointment.") : runtime.ingest(appointmentUpdate(current, input.status));
  }),

  advanceClock: t.procedure.input(z.object({ hours: z.number().positive().max(24 * 120) })).mutation(({ ctx, input }) => {
    const { runtime } = ctx.host.current;
    const fired = runtime.advanceClock(input.hours);
    return { now: runtime.now(), deadlinesFired: fired.length };
  }),

  reset: t.procedure.mutation(async ({ ctx }) => {
    await ctx.host.reset();
    return { ok: true as const };
  }),

  // ───────────── Programme view ─────────────
  programme: t.procedure.query(({ ctx }) => {
    simulation ??= runSimulation();
    return { simulation, live: liveMeasures(ctx.host.current.runtime) };
  }),
});

export type AppRouter = typeof appRouter;
