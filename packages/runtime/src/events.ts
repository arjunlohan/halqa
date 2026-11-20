// What the event log stores. A stored event is a kernel event with one difference: a `closed`
// event keeps the basis of its evidence, never the evidence itself. Evidence is re-earned on replay.
import { createHash } from "node:crypto";
import type { CaseEvent } from "@halqa/kernel";
import { zInstant, zPathwayId, zPatientRef, zResourceRef } from "@halqa/fhir";
import * as z from "zod";

export const zClinician = z.object({ kind: z.literal("clinician"), practitioner: zResourceRef, licence: z.string().min(1) });
export const zNavigator = z.object({ kind: z.literal("navigator"), practitioner: zResourceRef });
export const zAgent = z.object({ kind: z.literal("agent"), model: z.string().min(1), runId: z.string().min(1) });
const zSystem = z.object({ kind: z.literal("system") });
export const zOwner = z.discriminatedUnion("kind", [zClinician, zNavigator]);
const zActor = z.discriminatedUnion("kind", [zClinician, zNavigator, zAgent, zSystem]);

export const zHumanClosureReason = z.enum([
  "informed-decline",
  "clinically-not-indicated",
  "care-transferred-out",
  "deceased",
  "duplicate",
]);
const zChannel = z.enum(["voice", "sms", "whatsapp", "app", "in-person"]);

const zNotified = z.object({ type: z.literal("patient-notified"), at: zInstant, channel: zChannel, by: zActor });
const zAcknowledged = z.object({
  type: z.literal("patient-acknowledged"),
  at: zInstant,
  teachBack: z.enum(["passed", "assisted"]),
  by: zActor,
});
const zBooked = z.object({ type: z.literal("appointment-booked"), at: zInstant, appointment: zResourceRef, by: zActor });

/** What an agent tool handler may submit, as a runtime schema. Mirrors the kernel's `AgentEvent` type. */
export const zAgentEvent = z.discriminatedUnion("type", [
  zNotified.extend({ by: zAgent }),
  zAcknowledged.extend({ by: zAgent }),
  zBooked.extend({ by: zAgent }),
]);

export const zStoredEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("case-opened"),
    at: zInstant,
    patient: zPatientRef,
    result: zResourceRef,
    resultedAt: zInstant,
    pathway: zPathwayId,
    owner: zOwner,
    due: zInstant,
  }),
  zNotified,
  zAcknowledged,
  zBooked,
  z.object({ type: z.literal("appointment-missed"), at: zInstant }),
  z.object({ type: z.literal("care-attended"), at: zInstant }),
  z.object({ type: z.literal("deadline-passed"), at: zInstant }),
  z.object({
    type: z.literal("owner-reassigned"),
    at: zInstant,
    to: zOwner,
    by: z.discriminatedUnion("kind", [zClinician, zNavigator, zSystem]),
  }),
  z.object({
    type: z.literal("closed"),
    at: zInstant,
    basis: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("care-completed"), resource: zResourceRef }),
      z.object({ kind: z.literal("human-decision"), reason: zHumanClosureReason, by: zClinician, note: z.string() }),
    ]),
  }),
]);

export type StoredEvent = z.infer<typeof zStoredEvent>;
export type OpenedEvent = Extract<StoredEvent, { type: "case-opened" }>;

export function toStored(event: CaseEvent): StoredEvent {
  if (event.type !== "closed") return event;
  const basis = event.evidence.basis;
  return basis.kind === "care-completed"
    ? { type: "closed", at: event.at, basis: { kind: "care-completed", resource: basis.resource } }
    : { type: "closed", at: event.at, basis: { kind: "human-decision", reason: basis.reason, by: basis.by, note: basis.note } };
}

/** Keys sorted at every level, so the same event always serialises to the same bytes. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const GENESIS_HASH = "0".repeat(64);

/** SHA-256 over the previous hash and the stored bytes of this event. */
export const chainHash = (previous: string, caseId: string, seq: number, payload: string): string =>
  createHash("sha256").update(`${previous}\n${caseId}\n${seq}\n${payload}`).digest("hex");
