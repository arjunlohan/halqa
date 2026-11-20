// Contract for the pathway simulation. The dashboard renders exactly this shape.
// The simulation shows mechanism and capacity. It is not evidence of outcomes.

export type SimLanguage = "ar" | "en" | "hi" | "ur";

/** Fixed list from the build spec: the reason recorded when a case stops moving. */
export type DropOffReason =
  | "unreachable"
  | "declined"
  | "no-capacity"
  | "did-not-attend"
  | "referral-rejected"
  | "transferred"
  | "other";

export type ArmId =
  | "baseline-abu-dhabi" // calibrated to 30.5% completion (Almansoori et al., 2015-16 data)
  | "baseline-pooled" // calibrated to 47.8% completion (Chua et al. pooled control rate)
  | "halqa-central" // capped at the pooled intervention rate of 69.1%
  | "baseline-pooled-capacity-bound" // endoscopy slots below demand, usual care
  | "halqa-capacity-bound"; // endoscopy slots below demand, Halqa outreach

export type SimConfig = {
  readonly seed: number;
  readonly patientsPerArm: number;
  /** Positive results arrive uniformly over this many days. */
  readonly intakeDays: number;
  /** Follow-up horizon per patient, in days from referral. */
  readonly horizonDays: number;
  /** Colonoscopy slots per week when capacity is ample, and when it binds. */
  readonly slotsPerWeekAmple: number;
  readonly slotsPerWeekBound: number;
  readonly navigators: number;
};

export type LanguageSlice = {
  readonly patients: number;
  readonly completedWithin31Days: number;
  readonly completedWithinHorizon: number;
};

export type ArmResult = {
  readonly id: ArmId;
  readonly label: string;
  /** One sentence: what the arm assumes and where its calibration target comes from. */
  readonly basis: string;
  readonly usesHalqa: boolean;
  readonly capacityBound: boolean;
  readonly patients: number;
  /** Counts of patients, not shares. Days are measured from referral. */
  readonly completedWithin31Days: number;
  readonly completedWithin90Days: number;
  readonly completedWithinHorizon: number;
  readonly unresolvedAt90Days: number;
  /** Medians in days among patients who reached the step; null when nobody did. */
  readonly medianDaysToNotification: number | null;
  readonly medianDaysToBooking: number | null;
  readonly medianDaysToCare: number | null;
  /** One reason per patient who did not complete within the horizon. Sums to patients minus completed. */
  readonly dropOff: Readonly<Record<DropOffReason, number>>;
  readonly navigatorMinutesPerCase: number;
  readonly alertsPerNavigatorDay: number;
  readonly byLanguage: Readonly<Record<SimLanguage, LanguageSlice>>;
  /** Cumulative completions by day from referral, index 0..horizonDays inclusive. */
  readonly completionCurve: readonly number[];
};

export type SimAssumption = {
  readonly parameter: string;
  readonly value: string;
  readonly source: "published" | "assumption";
  readonly note: string;
};

export type SimResult = {
  readonly config: SimConfig;
  readonly arms: readonly ArmResult[];
  readonly assumptions: readonly SimAssumption[];
  /** Plain statements a reader must see next to the numbers. */
  readonly caveats: readonly string[];
};
