const HOUR = 3_600_000;

export const STATES = ["awaiting-notification", "awaiting-acknowledgement", "awaiting-booking", "awaiting-attendance", "awaiting-resolution", "closed"] as const;
export type StateKind = (typeof STATES)[number];

export const STATE_LABEL: Readonly<Record<StateKind, string>> = {
  "awaiting-notification": "Awaiting notification",
  "awaiting-acknowledgement": "Awaiting confirmation",
  "awaiting-booking": "Awaiting booking",
  "awaiting-attendance": "Awaiting attendance",
  "awaiting-resolution": "Awaiting resolution",
  closed: "Closed",
};

export const STEP_LABEL: Readonly<Record<StateKind, string>> = {
  "awaiting-notification": "Notify",
  "awaiting-acknowledgement": "Confirm",
  "awaiting-booking": "Book",
  "awaiting-attendance": "Attend",
  "awaiting-resolution": "Resolve",
  closed: "Closed",
};

const dateTime = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Dubai" });

/** Times are shown in Gulf Standard Time, the pathway's local time. */
export const fmtDateTime = (ms: number): string => dateTime.format(new Date(ms));

export function fmtSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${Math.round(minutes / (24 * 60))} days`;
}

export type Tone = "calm" | "soon" | "late";

export function dueStatus(due: number, now: number, slaHours: number | null): { readonly text: string; readonly tone: Tone } {
  const left = due - now;
  if (left <= 0) return { text: `Overdue by ${fmtSpan(left)}`, tone: "late" };
  const window = (slaHours ?? 24) * HOUR;
  return { text: `Due in ${fmtSpan(left)}`, tone: left < window * 0.25 ? "soon" : "calm" };
}

export const shortHash = (hash: string): string => `${hash.slice(0, 8)}…`;
export const pct = (count: number, total: number, digits = 1): string => (total === 0 ? "0%" : `${((100 * count) / total).toFixed(digits)}%`);

const dayOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });
export const fmtDate = (ms: number): string => dayOnly.format(new Date(ms));

/** How long ago, or how far ahead, in the largest sensible unit. */
export function fmtRelative(ms: number, now: number): string {
  const span = fmtSpan(ms - now);
  return ms <= now ? `${span} ago` : `in ${span}`;
}

/** A call's length as a table shows it: 3:22. */
export function fmtDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const SEX_LABEL: Readonly<Record<string, string>> = { male: "Male", female: "Female", other: "Other", unknown: "Not known" };
export const LANGUAGE_LABEL: Readonly<Record<string, string>> = { ar: "Arabic", en: "English" };

/** Act ids as a person would say them. */
export const ACT_LABEL: Readonly<Record<string, string>> = {
  greet: "Greeting",
  "verify-identity": "Identity question",
  "deliver-result": "Result",
  "teach-back": "Understanding check",
  "repeat-result": "Result, said again more simply",
  "answer-approved-faq": "Approved answer",
  "offer-slots": "Appointment options",
  "confirm-slot": "Booking confirmation",
  "send-prep-instructions": "Preparation instructions",
  remind: "Reminder",
  reschedule: "Reschedule request",
  "hand-off-to-human": "Hand-off to staff",
  "emergency-guidance": "Emergency guidance",
};

export const CALL_END_LABEL: Readonly<Record<string, string>> = {
  completed: "Completed",
  "handed-off": "Handed to staff",
  emergency: "Emergency guidance given",
  "hung-up": "Ended early",
};

/** Where a case stands, said as what has not happened yet. */
export const STAGE_LABEL: Readonly<Record<StateKind, string>> = {
  "awaiting-notification": "Result not yet given",
  "awaiting-acknowledgement": "Understanding not confirmed",
  "awaiting-booking": "Colonoscopy not booked",
  "awaiting-attendance": "Booked, awaiting the record",
  "awaiting-resolution": "Needs a clinician's decision",
  closed: "Closed",
};
