// "An agent tries to close a case", run for real against three layers. Nothing here is mocked:
// the compiler is invoked, the schema is the one agent tool handlers use, and the kernel is the kernel.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ClosureEvidence, decide, type CaseEvent, type CaseId } from "@halqa/kernel";
import { pathwayById } from "@halqa/pathways";
import { zAgentEvent, type CaseRuntime } from "@halqa/runtime";
import * as z from "zod";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const attackFile = "packages/kernel/attacks/agent-close.ts";

export type AttackLayer = {
  readonly layer: "compiler" | "tool-schema" | "kernel";
  readonly title: string;
  readonly attempt: string;
  readonly rejected: boolean;
  readonly output: string;
};

async function compilerLayer(): Promise<AttackLayer> {
  const source = readFileSync(`${repoRoot}${attackFile}`, "utf8");
  const attempt = source.split("\n").filter((line) => line.startsWith("export const attack")).join("\n");
  try {
    await run("node_modules/.bin/tsc", ["-p", "packages/kernel/attacks/tsconfig.json", "--pretty", "false"], { cwd: repoRoot });
    return { layer: "compiler", title: "Compile time", attempt, rejected: false, output: "The attack compiled. The type-level guarantee is broken." };
  } catch (error) {
    const parsed = z.object({ stdout: z.string() }).safeParse(error);
    return { layer: "compiler", title: "Compile time", attempt, rejected: true, output: parsed.success ? parsed.data.stdout.trim() : "tsc exited with an error" };
  }
}

export async function agentCloseAttack(runtime: CaseRuntime, caseId: CaseId): Promise<{ readonly layers: readonly AttackLayer[]; readonly stateAfter: string; readonly chainIntact: boolean } | null> {
  const record = runtime.get(caseId);
  const pathway = record === undefined ? undefined : pathwayById(record.state.pathway);
  if (record === undefined || pathway === undefined) return null;
  const at = runtime.now();
  const agent = { kind: "agent", model: "compromised-handler", runId: "attack" };

  // What a model-written or attacker-written tool payload would look like.
  const payload = { type: "closed", at, by: agent, evidence: { basis: { kind: "care-completed", resource: "Procedure/never-happened", code: "73761001", performedAt: at } } };
  const schema = zAgentEvent.safeParse(payload);

  // Past the schema: the forgeries a cast, a JSON round-trip or a prototype trick would produce.
  const forgeries: readonly { readonly name: string; readonly evidence: unknown }[] = [
    { name: "look-alike object", evidence: payload.evidence },
    { name: "JSON round-trip of a look-alike", evidence: JSON.parse(JSON.stringify(payload.evidence)) },
    { name: "bare ClosureEvidence prototype", evidence: Object.create(ClosureEvidence.prototype) },
    { name: "prototype with fields copied on", evidence: Object.assign(Object.create(ClosureEvidence.prototype), payload.evidence) },
    { name: "a string", evidence: "closed by agent: patient says the test is done" },
  ];
  const verdicts = forgeries.map(({ name, evidence }) => {
    // The cast is the attack: it is how an untyped payload reaches `decide` in a compromised handler.
    const forged = { type: "closed", at, evidence } as unknown as CaseEvent;
    const verdict = decide(record.state, forged, pathway.sla);
    return { name, rejected: !verdict.ok, reason: verdict.ok ? "ACCEPTED" : verdict.error.reason };
  });

  const layers: AttackLayer[] = [
    await compilerLayer(),
    {
      layer: "tool-schema",
      title: "Tool handler boundary",
      attempt: JSON.stringify(payload),
      rejected: !schema.success,
      output: schema.success ? "The schema accepted a close from an agent." : z.prettifyError(schema.error),
    },
    {
      layer: "kernel",
      title: "Kernel at runtime",
      attempt: "decide(state, { type: \"closed\", evidence: <forgery> } as unknown as CaseEvent, sla)",
      rejected: verdicts.every((v) => v.rejected),
      output: verdicts.map((v) => `${v.name}: ${v.reason}`).join("\n"),
    },
  ];
  return { layers, stateAfter: runtime.get(caseId)?.state.kind ?? "unknown", chainIntact: runtime.verifyChain(caseId).ok };
}
