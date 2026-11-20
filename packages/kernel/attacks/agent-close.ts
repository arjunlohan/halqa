// This file is meant NOT to compile. The API runs the compiler on it and shows the error.
// It is the same attack as A5 in src/kernel.types.test.ts, without the `@ts-expect-error`.
import { decideForAgent, type Agent, type ClosureEvidence, type Instant, type OpenState, type Sla } from "../src/kernel.js";

declare const openCase: OpenState;
declare const now: Instant;
declare const sla: Sla;
declare const evidence: ClosureEvidence;
declare const agent: Agent;

// An agent tool handler tries to close a case.
export const attack = decideForAgent(openCase, { type: "closed", at: now, evidence, by: agent }, sla);
