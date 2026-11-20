// Discrete-event simulation of the follow-up pathway after a positive stool test (FIT).
// It shows mechanism and capacity. It is not evidence of outcomes.
//
// Shape of the model:
//   1. One synthetic cohort is drawn once and sent through every arm, so arms differ only in parameters.
//   2. Each patient walks notification, acknowledgement and referral on their own.
//   3. Booking requests from all patients are then served in request-day order against a weekly slot pool.
//      Uncounted patients referred before and after the cohort take slots too, so the cohort meets the
//      queue a clinic at this capacity already has, not an empty diary.
//   4. One stage (the share of acknowledged patients who proceed to a referral) is solved per calibrated
//      arm so that completion lands on a published rate. For Halqa this is the cap.

import type {
  ArmId,
  ArmResult,
  DropOffReason,
  LanguageSlice,
  SimAssumption,
  SimConfig,
  SimLanguage,
  SimResult,
} from "./sim.types.js";

export const defaultSimConfig: SimConfig = {
  seed: 20261119,
  patientsPerArm: 10_000,
  intakeDays: 364,
  horizonDays: 365,
  slotsPerWeekAmple: 400,
  slotsPerWeekBound: 80,
  navigators: 6,
};

// ---------------------------------------------------------------------------
// Published figures. Everything below this block is an assumption.
// ---------------------------------------------------------------------------

const ABU_DHABI_COMPLETION = 0.305;
const POOLED_CONTROL_COMPLETION = 0.478;
const POOLED_INTERVENTION_COMPLETION = 0.691;
const PUBLISHED_RISK_RATIOS = "navigation 1.24, patient reminders 1.32, clinician reminders 1.36, automatic referral 1.68";
const PUBLISHED_MEDIAN_DAYS_TO_COLONOSCOPY = 72;

// ---------------------------------------------------------------------------
// Assumed parameters
// ---------------------------------------------------------------------------

type Lognormal = { readonly medianDays: number; readonly sigma: number };

type CareModel = {
  readonly name: string;
  readonly usesHalqa: boolean;
  readonly reachProbability: number;
  readonly declineProbability: number;
  readonly referralRejectedProbability: number;
  readonly transferredProbability: number;
  readonly attendProbability: number;
  /** Chance that a missed appointment leads to a new booking request. */
  readonly rebookProbability: number;
  readonly notificationDelay: Lognormal;
  readonly acknowledgementDelay: Lognormal;
  readonly bookingRequestDelay: Lognormal;
};

const USUAL_CARE: CareModel = {
  name: "Usual care",
  usesHalqa: false,
  reachProbability: 0.88,
  declineProbability: 0.12,
  referralRejectedProbability: 0.03,
  transferredProbability: 0.04,
  attendProbability: 0.82,
  rebookProbability: 0,
  notificationDelay: { medianDays: 12, sigma: 1.1 },
  acknowledgementDelay: { medianDays: 6, sigma: 1.2 },
  bookingRequestDelay: { medianDays: 21, sigma: 1.0 },
};

const HALQA: CareModel = {
  name: "Halqa",
  usesHalqa: true,
  reachProbability: 0.95,
  declineProbability: 0.12,
  referralRejectedProbability: 0.03,
  transferredProbability: 0.04,
  attendProbability: 0.88,
  rebookProbability: 0.6,
  notificationDelay: { medianDays: 0.5, sigma: 1.0 },
  acknowledgementDelay: { medianDays: 2, sigma: 1.2 },
  bookingRequestDelay: { medianDays: 1.5, sigma: 1.0 },
};

// Endoscopy-side parameters are the same in every arm: Halqa does not change the unit.
const LEAD_TIME_MIN_DAYS = 3;
const LEAD_TIME: Lognormal = { medianDays: 14, sigma: 0.6 };
const REBOOK_DELAY: Lognormal = { medianDays: 7, sigma: 0.8 };
const MAX_REBOOKS = 2;
const BOOKING_WINDOW_DAYS = 84;
const DAYS_PER_WEEK = 7;

const LANGUAGES: readonly SimLanguage[] = ["ar", "en", "hi", "ur"];
const LANGUAGE_SHARES: Readonly<Record<SimLanguage, number>> = { ar: 0.45, en: 0.25, hi: 0.15, ur: 0.15 };

type NavigatorTask =
  | "notification-call"
  | "failed-call-attempt"
  | "booking-call"
  | "reminder-call"
  | "hand-off"
  | "escalation";

const TASK_MINUTES: Readonly<Record<NavigatorTask, number>> = {
  "notification-call": 10,
  "failed-call-attempt": 4,
  "booking-call": 15,
  "reminder-call": 5,
  "hand-off": 10,
  escalation: 12,
};
const FAILED_CALL_ATTEMPTS = 3;
const HAND_OFF_PROBABILITY = 0.15;
const WORKING_DAYS_PER_WEEK = 5;

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

type Random = () => number;

function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Derives an independent stream seed, so each patient's draws do not depend on processing order. */
function mixSeed(seed: number, index: number): number {
  let hash = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function standardNormal(random: Random): number {
  const radius = Math.sqrt(-2 * Math.log(1 - random()));
  const angle = 2 * Math.PI * random();
  return radius * Math.cos(angle);
}

function sampleDays(delay: Lognormal, normalDraw: number): number {
  return delay.medianDays * Math.exp(delay.sigma * normalDraw);
}

// ---------------------------------------------------------------------------
// Patients: drawn once, shared by every arm
// ---------------------------------------------------------------------------

type Patient = {
  readonly language: SimLanguage;
  /** Calendar day of the positive result. Day 0 is the first day of the counted cohort's intake. */
  readonly referralDay: number;
  // Uniform draws in [0, 1), one per decision. An arm compares them with its own probabilities.
  readonly reachDraw: number;
  readonly declineDraw: number;
  readonly handOffDraw: number;
  readonly proceedDraw: number;
  readonly referralDraw: number;
  // Standard normal draws, one per delay. An arm scales them with its own delay parameters.
  readonly notificationNormal: number;
  readonly acknowledgementNormal: number;
  readonly requestNormal: number;
  /** Seeds the draws for each appointment attempt. */
  readonly attemptSeed: number;
};

function pickLanguage(draw: number): SimLanguage {
  let cumulative = 0;
  for (const language of LANGUAGES) {
    cumulative += LANGUAGE_SHARES[language];
    if (draw < cumulative) return language;
  }
  return "ur";
}

type Period = { readonly firstDay: number; readonly days: number };

function drawPatient(seed: number, index: number, period: Period): Patient {
  const random = mulberry32(mixSeed(seed, index));
  return {
    language: pickLanguage(random()),
    referralDay: period.firstDay + Math.floor(random() * period.days),
    reachDraw: random(),
    declineDraw: random(),
    handOffDraw: random(),
    proceedDraw: random(),
    referralDraw: random(),
    notificationNormal: standardNormal(random),
    acknowledgementNormal: standardNormal(random),
    requestNormal: standardNormal(random),
    attemptSeed: Math.floor(random() * 4_294_967_296),
  };
}

function drawPatients(seed: number, firstIndex: number, count: number, period: Period): Patient[] {
  return Array.from({ length: count }, (_, offset) => drawPatient(seed, firstIndex + offset, period));
}

type Clinic = {
  /** The counted patients. */
  readonly cohort: readonly Patient[];
  /** The cohort first, then the uncounted patients referred before and after it. */
  readonly everyone: readonly Patient[];
};

/**
 * Referrals keep the cohort's daily rate for one intake period before it and one horizon after it.
 * Without them the cohort would start on an empty diary and finish with no one behind it in the queue,
 * and both edges would make a capacity-bound clinic look better than it is.
 */
function drawClinic(config: SimConfig): Clinic {
  const { seed, patientsPerArm, intakeDays, horizonDays } = config;
  const laterCount = Math.round((patientsPerArm * horizonDays) / intakeDays);
  const cohort = drawPatients(seed, 0, patientsPerArm, { firstDay: 0, days: intakeDays });
  const earlier = drawPatients(seed, patientsPerArm, patientsPerArm, { firstDay: -intakeDays, days: intakeDays });
  const later = drawPatients(seed, 2 * patientsPerArm, laterCount, { firstDay: intakeDays, days: horizonDays });
  return { cohort, everyone: [...cohort, ...earlier, ...later] };
}

type AttemptDraws = {
  readonly leadNormal: number;
  readonly attendDraw: number;
  readonly rebookDraw: number;
  readonly rebookDelayNormal: number;
};

function drawAttempt(patient: Patient, attempt: number): AttemptDraws {
  const random = mulberry32(mixSeed(patient.attemptSeed, attempt));
  return {
    leadNormal: standardNormal(random),
    attendDraw: random(),
    rebookDraw: random(),
    rebookDelayNormal: standardNormal(random),
  };
}

// ---------------------------------------------------------------------------
// Stage 1: each patient alone, from referral to the first booking request
// ---------------------------------------------------------------------------

/** All offsets are days from the patient's referral. */
type CaseState = {
  notificationOffset: number | null;
  bookingOffset: number | null;
  completionOffset: number | null;
  /** When the case stopped moving: the completed colonoscopy or the recorded drop-off. */
  closedOffset: number;
  dropReason: DropOffReason | null;
  /** Navigator work this case generated. */
  readonly tasks: NavigatorTask[];
};

function openCase(horizonDays: number): CaseState {
  return {
    notificationOffset: null,
    bookingOffset: null,
    completionOffset: null,
    closedOffset: horizonDays,
    dropReason: null,
    tasks: [],
  };
}

function closeCase(state: CaseState, reason: DropOffReason, offset: number): null {
  state.dropReason = reason;
  state.closedOffset = offset;
  return null;
}

function referralTriage(patient: Patient, model: CareModel): DropOffReason | null {
  if (patient.referralDraw < model.referralRejectedProbability) return "referral-rejected";
  if (patient.referralDraw < model.referralRejectedProbability + model.transferredProbability) return "transferred";
  return null;
}

/** Returns the offset of the first booking request, or null when the case dropped before asking for a slot. */
function walkToBookingRequest(
  patient: Patient,
  state: CaseState,
  model: CareModel,
  proceedProbability: number,
  horizonDays: number,
): number | null {
  const halqa = model.usesHalqa;

  const notified = sampleDays(model.notificationDelay, patient.notificationNormal);
  if (patient.reachDraw >= model.reachProbability || notified > horizonDays) {
    if (halqa) state.tasks.push("escalation");
    else for (let attempt = 0; attempt < FAILED_CALL_ATTEMPTS; attempt += 1) state.tasks.push("failed-call-attempt");
    return closeCase(state, "unreachable", Math.min(notified, horizonDays));
  }
  state.notificationOffset = notified;
  if (!halqa) state.tasks.push("notification-call");
  if (halqa && patient.handOffDraw < HAND_OFF_PROBABILITY) state.tasks.push("hand-off");

  const acknowledged = notified + sampleDays(model.acknowledgementDelay, patient.acknowledgementNormal);
  if (acknowledged > horizonDays) return closeCase(state, "other", horizonDays);
  if (patient.declineDraw < model.declineProbability) {
    if (halqa) state.tasks.push("escalation");
    return closeCase(state, "declined", acknowledged);
  }

  const requested = acknowledged + sampleDays(model.bookingRequestDelay, patient.requestNormal);
  if (requested > horizonDays) return closeCase(state, "other", horizonDays);
  if (patient.proceedDraw >= proceedProbability) return closeCase(state, "other", requested);
  const triage = referralTriage(patient, model);
  if (triage !== null) {
    if (halqa && triage === "referral-rejected") state.tasks.push("escalation");
    return closeCase(state, triage, requested);
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Stage 2: booking requests from all patients compete for weekly slots
// ---------------------------------------------------------------------------

type BookingRequest = {
  /** Calendar day of the request, counted from the first day of intake. */
  readonly day: number;
  readonly patientIndex: number;
  /** 0 for the first appointment, 1 and 2 for re-bookings after a missed one. */
  readonly attempt: number;
};

/** First come, first served. The patient index only breaks ties, so the order never depends on the engine's sort. */
function byRequestDay(a: BookingRequest, b: BookingRequest): number {
  return a.day - b.day || a.patientIndex - b.patientIndex;
}

/** Keeps the waiting list in request-day order. Only entries from `from` onward are still waiting. */
function insertInOrder(queue: BookingRequest[], request: BookingRequest, from: number): void {
  let low = from;
  let high = queue.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const waiting = queue[middle];
    if (waiting !== undefined && byRequestDay(waiting, request) < 0) low = middle + 1;
    else high = middle;
  }
  queue.splice(low, 0, request);
}

type Slot = { readonly day: number; readonly pushedByQueue: boolean };

/**
 * Takes one slot in the first week with room, starting at the week of the patient's earliest day.
 * Returns null when every week the diary has open is full.
 */
function bookSlot(
  usedByWeek: Map<number, number>,
  slotsPerWeek: number,
  earliestDay: number,
  lastOpenDay: number,
): Slot | null {
  const firstWeek = Math.floor(earliestDay / DAYS_PER_WEEK);
  // A patient whose earliest day lies beyond the open diary may still ask for that one week.
  const lastWeek = Math.max(firstWeek, Math.floor(lastOpenDay / DAYS_PER_WEEK));
  for (let week = firstWeek; week <= lastWeek; week += 1) {
    const used = usedByWeek.get(week) ?? 0;
    if (used >= slotsPerWeek) continue;
    usedByWeek.set(week, used + 1);
    if (week === firstWeek) return { day: earliestDay, pushedByQueue: false };
    // Later weeks fill front to back, so earlier requests get earlier days in the week.
    return { day: (week + (used + 0.5) / slotsPerWeek) * DAYS_PER_WEEK, pushedByQueue: true };
  }
  return null;
}

type ArmSetup = {
  readonly model: CareModel;
  readonly proceedProbability: number;
  readonly slotsPerWeek: number;
  readonly horizonDays: number;
};

/** Serves one booking request. Returns the re-booking request when a missed appointment leads to one. */
function serveRequest(
  request: BookingRequest,
  patient: Patient,
  state: CaseState,
  setup: ArmSetup,
  usedByWeek: Map<number, number>,
): BookingRequest | null {
  const { model, horizonDays } = setup;
  const draws = drawAttempt(patient, request.attempt);
  const requestOffset = request.day - patient.referralDay;
  if (!model.usesHalqa) state.tasks.push("booking-call");

  const earliestDay = request.day + LEAD_TIME_MIN_DAYS + sampleDays(LEAD_TIME, draws.leadNormal);
  const slot = bookSlot(usedByWeek, setup.slotsPerWeek, earliestDay, request.day + BOOKING_WINDOW_DAYS);
  if (slot === null) {
    if (model.usesHalqa) state.tasks.push("escalation");
    return closeCase(state, "no-capacity", requestOffset);
  }
  state.bookingOffset ??= requestOffset;
  if (!model.usesHalqa) state.tasks.push("reminder-call");

  const appointmentOffset = slot.day - patient.referralDay;
  if (appointmentOffset > horizonDays) {
    return closeCase(state, slot.pushedByQueue ? "no-capacity" : "other", horizonDays);
  }
  if (draws.attendDraw < model.attendProbability) {
    state.completionOffset = appointmentOffset;
    state.closedOffset = appointmentOffset;
    return null;
  }

  if (model.usesHalqa) state.tasks.push("escalation");
  const rebookOffset = appointmentOffset + sampleDays(REBOOK_DELAY, draws.rebookDelayNormal);
  const rebooks =
    request.attempt < MAX_REBOOKS && draws.rebookDraw < model.rebookProbability && rebookOffset <= horizonDays;
  if (!rebooks) return closeCase(state, "did-not-attend", appointmentOffset);
  return { day: patient.referralDay + rebookOffset, patientIndex: request.patientIndex, attempt: request.attempt + 1 };
}

/** Runs every patient through one arm. Returns one case per patient, in the order given. */
function runArm(patients: readonly Patient[], setup: ArmSetup): CaseState[] {
  const cases: CaseState[] = [];
  const queue: BookingRequest[] = [];
  patients.forEach((patient, patientIndex) => {
    const state = openCase(setup.horizonDays);
    cases.push(state);
    const requestOffset = walkToBookingRequest(patient, state, setup.model, setup.proceedProbability, setup.horizonDays);
    if (requestOffset !== null) queue.push({ day: patient.referralDay + requestOffset, patientIndex, attempt: 0 });
  });
  queue.sort(byRequestDay);

  const usedByWeek = new Map<number, number>();
  for (let next = 0; next < queue.length; next += 1) {
    const request = queue[next];
    if (request === undefined) continue;
    const patient = patients[request.patientIndex];
    const state = cases[request.patientIndex];
    if (patient === undefined || state === undefined) continue;
    const rebooking = serveRequest(request, patient, state, setup, usedByWeek);
    if (rebooking !== null) insertInOrder(queue, rebooking, next + 1);
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Calibration: completion is an input, so one stage is solved to hit it
// ---------------------------------------------------------------------------

type Calibration = {
  /** Completion the stage assumptions give on their own, with everyone proceeding and no slot limit. */
  readonly unscaledCompletion: number;
  /** Share of acknowledged patients who proceed to a referral, scaled so completion lands on the target. */
  readonly proceedProbability: number;
};

function countCompleted(cases: readonly CaseState[]): number {
  return cases.filter((state) => state.completionOffset !== null).length;
}

/**
 * The proceed stage is an independent yes or no per patient, so completion scales in proportion to it.
 * One unconstrained run with everyone proceeding gives the scale. The result never exceeds 1, which is
 * what makes the Halqa target a cap: the stage assumptions can be pulled down to it, never pushed up.
 */
function calibrate(cohort: readonly Patient[], model: CareModel, target: number, horizonDays: number): Calibration {
  const everyoneProceeds = runArm(cohort, {
    model,
    proceedProbability: 1,
    slotsPerWeek: Number.POSITIVE_INFINITY,
    horizonDays,
  });
  const unscaledCompletion = countCompleted(everyoneProceeds) / cohort.length;
  const proceedProbability = unscaledCompletion > 0 ? Math.min(1, target / unscaledCompletion) : 1;
  return { unscaledCompletion, proceedProbability };
}

// ---------------------------------------------------------------------------
// Summary of one arm
// ---------------------------------------------------------------------------

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values: readonly number[]): number | null {
  const sorted = values.toSorted((a, b) => a - b);
  const upper = sorted[sorted.length >> 1];
  if (upper === undefined) return null;
  const lower = sorted[(sorted.length >> 1) - 1];
  if (sorted.length % 2 === 1 || lower === undefined) return round(upper, 1);
  return round((lower + upper) / 2, 1);
}

function present(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

function completionCurve(cases: readonly CaseState[], horizonDays: number): number[] {
  const completedOnDay = new Array<number>(horizonDays + 1).fill(0);
  for (const offset of present(cases.map((state) => state.completionOffset))) {
    const day = Math.ceil(offset);
    completedOnDay[day] = (completedOnDay[day] ?? 0) + 1;
  }
  let running = 0;
  return completedOnDay.map((count) => {
    running += count;
    return running;
  });
}

function curveAt(curve: readonly number[], day: number): number {
  return curve[Math.min(day, curve.length - 1)] ?? 0;
}

function countDropOffs(cases: readonly CaseState[]): Record<DropOffReason, number> {
  const counts: Record<DropOffReason, number> = {
    unreachable: 0,
    declined: 0,
    "no-capacity": 0,
    "did-not-attend": 0,
    "referral-rejected": 0,
    transferred: 0,
    other: 0,
  };
  for (const state of cases) {
    if (state.completionOffset === null && state.dropReason !== null) counts[state.dropReason] += 1;
  }
  return counts;
}

function languageSlice(cohort: readonly Patient[], cases: readonly CaseState[], language: SimLanguage): LanguageSlice {
  const offsets = cases.filter((_, index) => cohort[index]?.language === language).map((state) => state.completionOffset);
  const completed = present(offsets);
  return {
    patients: offsets.length,
    completedWithin31Days: completed.filter((offset) => offset <= 31).length,
    completedWithinHorizon: completed.length,
  };
}

type ArmSpec = {
  readonly id: ArmId;
  readonly label: string;
  readonly basis: string;
  readonly capacityBound: boolean;
  readonly setup: ArmSetup;
};

function summarise(spec: ArmSpec, cohort: readonly Patient[], cases: readonly CaseState[], config: SimConfig): ArmResult {
  const curve = completionCurve(cases, config.horizonDays);
  const tasks = cases.flatMap((state) => state.tasks);
  const taskMinutes = tasks.reduce((sum, task) => sum + TASK_MINUTES[task], 0);
  const navigatorDays = config.navigators * config.intakeDays * (WORKING_DAYS_PER_WEEK / DAYS_PER_WEEK);

  return {
    id: spec.id,
    label: spec.label,
    basis: spec.basis,
    usesHalqa: spec.setup.model.usesHalqa,
    capacityBound: spec.capacityBound,
    patients: cases.length,
    completedWithin31Days: curveAt(curve, 31),
    completedWithin90Days: curveAt(curve, 90),
    completedWithinHorizon: curveAt(curve, config.horizonDays),
    unresolvedAt90Days: cases.filter((state) => state.closedOffset > 90).length,
    medianDaysToNotification: median(present(cases.map((state) => state.notificationOffset))),
    medianDaysToBooking: median(present(cases.map((state) => state.bookingOffset))),
    medianDaysToCare: median(present(cases.map((state) => state.completionOffset))),
    dropOff: countDropOffs(cases),
    navigatorMinutesPerCase: round(taskMinutes / cases.length, 2),
    alertsPerNavigatorDay: round(tasks.length / navigatorDays, 2),
    byLanguage: {
      ar: languageSlice(cohort, cases, "ar"),
      en: languageSlice(cohort, cases, "en"),
      hi: languageSlice(cohort, cases, "hi"),
      ur: languageSlice(cohort, cases, "ur"),
    },
    completionCurve: curve,
  };
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

function percent(share: number, digits = 0): string {
  return `${round(share * 100, digits)}%`;
}

const ABU_DHABI_RATE = percent(ABU_DHABI_COMPLETION, 1);
const POOLED_CONTROL_RATE = percent(POOLED_CONTROL_COMPLETION, 1);
const POOLED_INTERVENTION_RATE = percent(POOLED_INTERVENTION_COMPLETION, 1);

type Calibrations = { readonly abuDhabi: Calibration; readonly pooled: Calibration; readonly halqa: Calibration };

function armSpecs(config: SimConfig, calibrations: Calibrations): readonly ArmSpec[] {
  const setup = (model: CareModel, calibration: Calibration, slotsPerWeek: number): ArmSetup => ({
    model,
    proceedProbability: calibration.proceedProbability,
    slotsPerWeek,
    horizonDays: config.horizonDays,
  });
  return [
    {
      id: "baseline-abu-dhabi",
      label: "Usual care, Abu Dhabi baseline",
      basis:
        `Usual care with ample endoscopy capacity, calibrated to the ${ABU_DHABI_RATE} colonoscopy completion reported for Abu Dhabi in 2015-16 (Almansoori et al., BMC Cancer 2021;21:897).`,
      capacityBound: false,
      setup: setup(USUAL_CARE, calibrations.abuDhabi, config.slotsPerWeekAmple),
    },
    {
      id: "baseline-pooled",
      label: "Usual care, pooled baseline",
      basis:
        `Usual care with ample endoscopy capacity, calibrated to the ${POOLED_CONTROL_RATE} pooled control rate (Chua et al., JAMA Intern Med 2026, read through a news report).`,
      capacityBound: false,
      setup: setup(USUAL_CARE, calibrations.pooled, config.slotsPerWeekAmple),
    },
    {
      id: "halqa-central",
      label: "Halqa, ample capacity",
      basis:
        `Halqa outreach with ample endoscopy capacity (faster notification and booking, automatic referral, re-booking after a missed appointment), with completion capped at the ${POOLED_INTERVENTION_RATE} pooled intervention rate from Chua et al.`,
      capacityBound: false,
      setup: setup(HALQA, calibrations.halqa, config.slotsPerWeekAmple),
    },
    {
      id: "baseline-pooled-capacity-bound",
      label: "Usual care, capacity bound",
      basis:
        "The same patient behaviour as the pooled usual-care arm, with colonoscopy slots per week set below demand so a queue forms; it has no calibration target of its own.",
      capacityBound: true,
      setup: setup(USUAL_CARE, calibrations.pooled, config.slotsPerWeekBound),
    },
    {
      id: "halqa-capacity-bound",
      label: "Halqa, capacity bound",
      basis:
        "The same patient behaviour as the Halqa ample-capacity arm, with colonoscopy slots per week set below demand so a queue forms; it has no calibration target of its own.",
      capacityBound: true,
      setup: setup(HALQA, calibrations.halqa, config.slotsPerWeekBound),
    },
  ];
}

// ---------------------------------------------------------------------------
// Assumptions table and caveats, built from the constants above so they cannot drift from the code
// ---------------------------------------------------------------------------

function describeDelay(delay: Lognormal): string {
  return `lognormal, median ${delay.medianDays} days, sigma ${delay.sigma}`;
}

function published(parameter: string, value: string, note: string): SimAssumption {
  return { parameter, value, source: "published", note };
}

function assumed(parameter: string, value: string, note: string): SimAssumption {
  return { parameter, value, source: "assumption", note };
}

function publishedRows(): SimAssumption[] {
  return [
    published(
      "Completion target, Abu Dhabi usual care",
      ABU_DHABI_RATE,
      "Almansoori et al., BMC Cancer 2021;21:897 (Abu Dhabi, 2015-16 data). The arm is calibrated to this figure.",
    ),
    published(
      "Completion target, pooled usual care",
      POOLED_CONTROL_RATE,
      "Pooled control rate, Chua et al., JAMA Intern Med 2026, read through a news report and not the paper. The arm is calibrated to this figure.",
    ),
    published(
      "Completion cap, Halqa",
      POOLED_INTERVENTION_RATE,
      "Pooled intervention rate from the same source. Used as a ceiling: the Halqa arm is scaled down to it.",
    ),
    published(
      "Risk ratios for single interventions (not used as multipliers)",
      PUBLISHED_RISK_RATIOS,
      "Multiplied together these give about 3.7, which would put completion above 100%. The model does not multiply them and uses the cap above instead.",
    ),
    published(
      "Median days to colonoscopy among completers (sanity anchor)",
      `${PUBLISHED_MEDIAN_DAYS_TO_COLONOSCOPY} days`,
      "O'Connor et al., Sci Rep 2020;10:2441 (US community clinics). The usual-care delay medians were chosen so that the usual-care median lands near this figure. It is one number, so the split between stages and the spread of each delay are assumptions.",
    ),
  ];
}

function cohortRows(config: SimConfig): SimAssumption[] {
  const shares = LANGUAGES.map((language) => `${language} ${percent(LANGUAGE_SHARES[language])}`).join(", ");
  return [
    assumed(
      "Cohort",
      `${config.patientsPerArm} synthetic patients, seed ${config.seed}`,
      "One cohort is drawn once and sent through every arm with the same random draws, so arms differ only in their parameters.",
    ),
    assumed(
      "Referral day",
      `uniform over ${config.intakeDays} days`,
      "Positive results arrive at a steady rate. No seasonality and no campaign peaks.",
    ),
    assumed(
      "Follow-up horizon",
      `${config.horizonDays} days from referral`,
      "A case still in progress at the horizon counts as not completed.",
    ),
    assumed(
      "Language shares",
      shares,
      "Invented shares, not census or clinic data. Language does not change any probability or delay.",
    ),
  ];
}

function careModelRows(model: CareModel): SimAssumption[] {
  const row = (parameter: string, value: string, note: string): SimAssumption =>
    assumed(`${model.name}: ${parameter}`, value, note);
  const halqa = model.usesHalqa;
  return [
    row(
      "result reaches the patient",
      percent(model.reachProbability),
      halqa
        ? "Automated messages in four languages with retries. The rest drop as unreachable."
        : "Staff phone the patient by hand. The rest drop as unreachable.",
    ),
    row(
      "days from referral to notification",
      describeDelay(model.notificationDelay),
      halqa ? "The agent sends the result the same day or the next." : "The result waits for a clinician to review it and for staff to call.",
    ),
    row(
      "patient declines colonoscopy",
      percent(model.declineProbability),
      "Same in usual care and Halqa: outreach is not assumed to change minds.",
    ),
    row(
      "days from notification to acknowledgement",
      describeDelay(model.acknowledgementDelay),
      halqa ? "Automated reminders shorten the wait for a reply." : "The patient replies or is reached again without automated reminders.",
    ),
    row(
      "days from acknowledgement to booking request",
      describeDelay(model.bookingRequestDelay),
      halqa ? "Referral is automatic and the agent asks for a slot in the same conversation." : "A clinician places the referral and staff then phone to book.",
    ),
    row(
      "referral rejected",
      percent(model.referralRejectedProbability),
      "Not suitable for colonoscopy or referral refused. Same in usual care and Halqa.",
    ),
    row(
      "transferred to another provider",
      percent(model.transferredProbability),
      "Counted as not completed because the outcome is no longer visible. Same in usual care and Halqa.",
    ),
    row(
      "patient attends a booked appointment",
      percent(model.attendProbability),
      halqa ? "Automated reminders before the appointment." : "One manual reminder call.",
    ),
    row(
      "re-booking after a missed appointment",
      halqa ? `${percent(model.rebookProbability)}, at most ${MAX_REBOOKS} times` : percent(model.rebookProbability),
      halqa
        ? "Each missed appointment escalates to a navigator, who gets this share to ask for a new slot."
        : "A simplification that favours Halqa on this stage: real usual care re-books some patients.",
    ),
  ];
}

function calibrationRows(calibrations: Calibrations): SimAssumption[] {
  const solved = (calibration: Calibration): string => `${percent(calibration.proceedProbability, 1)} (solved)`;
  const unscaled = percent(calibrations.pooled.unscaledCompletion, 1);
  return [
    assumed(
      "Calibration method",
      "one solved stage per calibrated arm",
      "The share of acknowledged patients who proceed to a referral is solved on the simulated cohort so that completion within the horizon lands on the published rate. Patients who do not proceed drop as other.",
    ),
    assumed(
      "Usual care, Abu Dhabi: share proceeding to referral",
      solved(calibrations.abuDhabi),
      `Solved to hit ${ABU_DHABI_RATE}. Every other usual-care parameter is shared with the pooled arm, so the whole gap between the two baselines sits in this stage and shows up as other. The other usual-care stages alone give ${unscaled}.`,
    ),
    assumed(
      "Usual care, pooled: share proceeding to referral",
      solved(calibrations.pooled),
      `Solved to hit ${POOLED_CONTROL_RATE}. It stands for referrals never placed and every loss the model does not itemise. The other usual-care stages alone give ${unscaled}.`,
    ),
    assumed(
      "Halqa: share proceeding to referral (the cap)",
      solved(calibrations.halqa),
      `The assumed Halqa stage parameters alone give ${percent(calibrations.halqa.unscaledCompletion, 1)} completion. This factor scales that down to the ${POOLED_INTERVENTION_RATE} cap. It cannot exceed 100%, so the arm can be pulled down to the cap but never pushed up to it.`,
    ),
  ];
}

function capacityRows(config: SimConfig): SimAssumption[] {
  return [
    assumed(
      "Scheduling lead time",
      `${LEAD_TIME_MIN_DAYS} days plus ${describeDelay(LEAD_TIME)}`,
      "From booking request to the earliest day the patient can attend (bowel preparation, patient choice of date). Same in every arm.",
    ),
    assumed(
      "Slot allocation",
      "weekly pool, first come first served by request day",
      "A request takes a slot in the week of its earliest day, or in the next week with room. Only FIT-positive referrals use the slots: there is no other colonoscopy demand. A missed appointment still uses its slot.",
    ),
    assumed(
      "Booking window",
      `${BOOKING_WINDOW_DAYS} days`,
      "The diary is open this many days ahead of the request day. A request that finds every open week full is refused and drops as no-capacity. When slots are below demand the diary stays full out to this window, so it sets the wait and the completion in the capacity-bound arms.",
    ),
    assumed(
      "Slots per week, ample",
      `${config.slotsPerWeekAmple}`,
      "Set well above weekly demand so that no week fills.",
    ),
    assumed(
      "Slots per week, capacity bound",
      `${config.slotsPerWeekBound}`,
      "Set below weekly booking demand in both capacity-bound arms. Slots are absolute numbers and do not scale with the cohort size.",
    ),
    assumed(
      "Referrals before and after the cohort",
      `same daily rate for ${config.intakeDays} days before and ${config.horizonDays} days after`,
      "These patients follow the same arm's rules and take slots, but are not counted. Without them the cohort would start on an empty diary and end with nobody behind it in the queue, which flatters a capacity-bound clinic. They change nothing while no week is full.",
    ),
    assumed(
      "Days from a missed appointment to the re-booking request",
      describeDelay(REBOOK_DELAY),
      "Used only where re-booking happens.",
    ),
    assumed(
      "Attendance and waiting",
      "attendance does not depend on wait length",
      "Real attendance tends to fall as waits grow, which would make the capacity-bound arms worse.",
    ),
    assumed(
      "Completed colonoscopy",
      "every attended appointment counts as completed",
      "No failed bowel preparation and no incomplete examinations.",
    ),
    assumed(
      "Day a drop-off is recorded",
      "the day the failed step would have happened",
      "Used for the count of cases still unresolved at 90 days. A case still in progress at the horizon is recorded as unreachable (not yet notified), no-capacity (pushed past the horizon by the queue) or other.",
    ),
  ];
}

function navigatorRows(config: SimConfig): SimAssumption[] {
  const minutes = (task: NavigatorTask): string => `${TASK_MINUTES[task]} minutes`;
  return [
    assumed(
      "Navigator time, usual care: notification call",
      minutes("notification-call"),
      "One per patient reached, including charting.",
    ),
    assumed(
      "Navigator time, usual care: failed call attempts",
      `${FAILED_CALL_ATTEMPTS} attempts of ${TASK_MINUTES["failed-call-attempt"]} minutes`,
      "Per patient who is never reached.",
    ),
    assumed(
      "Navigator time, usual care: booking call",
      minutes("booking-call"),
      "One per booking request, covering referral paperwork and the scheduling call.",
    ),
    assumed("Navigator time, usual care: reminder call", minutes("reminder-call"), "One per booked appointment."),
    assumed(
      "Navigator time, Halqa: hand-off",
      `${minutes("hand-off")}, for ${percent(HAND_OFF_PROBABILITY)} of notified patients`,
      "The agent passes the conversation to a navigator, for example for a clinical question.",
    ),
    assumed(
      "Navigator time, Halqa: escalation",
      minutes("escalation"),
      "One per unreachable patient, decline, rejected referral, refused booking and missed appointment.",
    ),
    assumed(
      "Navigator working days",
      `${config.navigators} navigators, ${WORKING_DAYS_PER_WEEK} days a week over the ${config.intakeDays} intake days`,
      "Alerts per navigator day is every counted navigator task divided by these days. In usual care every manual call counts as a task.",
    ),
  ];
}

function listAssumptions(config: SimConfig, calibrations: Calibrations): SimAssumption[] {
  return [
    ...publishedRows(),
    ...cohortRows(config),
    ...careModelRows(USUAL_CARE),
    ...careModelRows(HALQA),
    ...calibrationRows(calibrations),
    ...capacityRows(config),
    ...navigatorRows(config),
  ];
}

const CAVEATS: readonly string[] = [
  "This is a simulation of mechanism and capacity. It is not evidence that Halqa improves outcomes.",
  `The Halqa arm is calibrated to a published pooled intervention rate (${POOLED_INTERVENTION_RATE}), so its headline completion is an input, not a finding.`,
  `The two usual-care completion rates (${ABU_DHABI_RATE} and ${POOLED_CONTROL_RATE}) are inputs in the same way.`,
  "Stage-level parameters (reach, decline, attendance, re-booking, delays) are assumptions, and one stage per arm is solved so the arm hits its calibration target. None was measured.",
  "Language slices use the same behaviour model for every language, so they show sampling noise only and say nothing about real differences between groups.",
  "The pooled rates come from Chua et al. as described in a news report, not from the paper itself.",
  "The capacity-bound arms depend on the assumed slots per week and booking window. They show what a full diary does to waiting time, not a forecast for any clinic.",
  "Navigator workload is counted events multiplied by assumed minutes per event. The minutes were not timed in a clinic.",
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function assertValidConfig(config: SimConfig): void {
  const wholeNumbers: readonly (readonly [string, number])[] = [
    ["patientsPerArm", config.patientsPerArm],
    ["intakeDays", config.intakeDays],
    ["horizonDays", config.horizonDays],
    ["slotsPerWeekAmple", config.slotsPerWeekAmple],
    ["slotsPerWeekBound", config.slotsPerWeekBound],
    ["navigators", config.navigators],
  ];
  for (const [name, value] of wholeNumbers) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number of at least 1`);
  }
  if (!Number.isInteger(config.seed)) throw new RangeError("seed must be a whole number");
}

export function runSimulation(overrides?: Partial<SimConfig>): SimResult {
  const config: SimConfig = { ...defaultSimConfig, ...overrides };
  assertValidConfig(config);

  const { cohort, everyone } = drawClinic(config);
  const calibrations: Calibrations = {
    abuDhabi: calibrate(cohort, USUAL_CARE, ABU_DHABI_COMPLETION, config.horizonDays),
    pooled: calibrate(cohort, USUAL_CARE, POOLED_CONTROL_COMPLETION, config.horizonDays),
    halqa: calibrate(cohort, HALQA, POOLED_INTERVENTION_COMPLETION, config.horizonDays),
  };
  const arms = armSpecs(config, calibrations).map((spec) => {
    const countedCases = runArm(everyone, spec.setup).slice(0, cohort.length);
    return summarise(spec, cohort, countedCases, config);
  });

  return { config, arms, assumptions: listAssumptions(config, calibrations), caveats: CAVEATS };
}
