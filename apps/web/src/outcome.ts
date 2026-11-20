import type { IngestOutcome } from "./trpc.js";

/** What happened when a record was posted, in a sentence. `refused` marks a refusal that is the designed outcome. */
export const describeOutcome = (outcome: IngestOutcome): { text: string; refused: boolean } => {
  if (outcome.status !== "stored") return { text: outcome.status === "duplicate" ? "Already received. Nothing changed." : `Rejected at the boundary: ${outcome.issues}`, refused: true };
  const effect = outcome.effects[0];
  if (effect === undefined) return { text: `${outcome.ref} stored. It matched no open case.`, refused: false };
  switch (effect.kind) {
    case "case-opened":
      return { text: `${outcome.ref} is actionable. Case opened.`, refused: false };
    case "case-exists":
      return { text: "The case for this result already exists.", refused: false };
    case "case-closed":
      return { text: `The kernel accepted ${outcome.ref} as closure evidence. Case closed.`, refused: false };
    case "evidence-rejected":
      return { text: `The kernel refused ${outcome.ref} as closure evidence: ${effect.reason}. The case stays open.`, refused: true };
    case "appointment-missed":
      return { text: "No-show recorded. Back to booking, one level louder.", refused: false };
    case "care-attended":
      return { text: "Attendance recorded.", refused: false };
  }
};
