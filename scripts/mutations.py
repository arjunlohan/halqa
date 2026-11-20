"""Negative controls for the build itself.

Each mutation breaks one safety property on purpose, runs the check that should notice, and restores
the file. A mutation that is not caught means a check is weaker than it looks.

    python3 -I scripts/mutations.py        (or: pnpm mutations)

Exit code 1 if any mutation survives.
"""
import os
import subprocess
import sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TSC = "pnpm -s exec tsc --noEmit -p tsconfig.json"
VIT = "NODE_OPTIONS=--disable-warning=ExperimentalWarning pnpm -s exec vitest run "
PROOF = "pnpm -s exec tsc -p packages/kernel/tsconfig.build.json && node packages/kernel/dist/kernel.prop.test.js"
K = "packages/kernel/src/kernel.ts"
E = "packages/voice/src/engine.ts"
mutations = [
  ("K1 kernel: drop the runtime evidence check", K, '      if (!ClosureEvidence.is(event.evidence)) return err({ reason: "forged-evidence" });\n', "", PROOF),
  ("K2 kernel: make ClosedState.evidence optional", K, "  readonly evidence: ClosureEvidence;\n  readonly closedAt: Instant;", "  readonly evidence?: ClosureEvidence;\n  readonly closedAt: Instant;", TSC),
  ("K3 kernel: let an Agent be an Owner", K, "export type Owner = Clinician | Navigator;", "export type Owner = Clinician | Navigator | Agent;", TSC),
  ("K4 kernel: let an AgentEvent be a close", K, '{ type: "patient-notified" | "patient-acknowledged" | "appointment-booked" }', '{ type: "patient-notified" | "patient-acknowledged" | "appointment-booked" | "closed" }', TSC),
  ("R1 record mapper: treat in-progress as completed", "packages/fhir/src/index.ts", '  "in-progress": "in-progress",', '  "in-progress": "completed",', VIT + "packages/runtime"),
  ("R2 replay: ignore a broken hash chain", "packages/runtime/src/runtime.ts", '      if (!chained) return hold("hash chain broken");\n', "", VIT + "packages/runtime"),
  ("V1 call: offer deliver-result before identity", E, '        return session.identity === "verified";', "        return true;", VIT + "packages/voice"),
  ("V2 call: skip the red-flag rules", E, "    if (isRedFlag(text)) {", "    if (isRedFlag(text) && text === '') {", VIT + "packages/voice"),
  ("V3 call: trust the brain without validating", E, "        if (problem === null) return settle(output, this.#brain.id, null);", "        return settle(output, this.#brain.id, null);", VIT + "packages/voice"),
  ("V4 call record: store the identity answer", E, "{ text: answersIdentity ? null : redactForRecord(text), lang: session.lang }", "{ text: redactForRecord(text), lang: session.lang }", VIT + "packages/voice"),
  ("C1 chart review: keep a sentence that cites no record", "packages/review/src/review.ts", '    if (cites.length === 0 || text === "") {', '    if (text === "") {', VIT + "apps/api"),
  ("C2 chart review: send the record ids with the chart", "packages/review/src/bundle.ts", "    const parts = [KIND_NAME[record.kind],", "    const parts = [record.ref, KIND_NAME[record.kind],", VIT + "apps/api"),
]
caught = 0
for name, rel, old, new, cmd in mutations:
    path = os.path.join(root, rel)
    original = open(path).read()
    if original.count(old) != 1:
        print(f"SKIP  {name}: anchor found {original.count(old)} times"); continue
    try:
        open(path, "w").write(original.replace(old, new))
        r = subprocess.run(cmd, shell=True, cwd=root, capture_output=True, text=True)
    finally:
        open(path, "w").write(original)
    out = (r.stdout + r.stderr).strip().splitlines()
    signal = next((l.strip() for l in out if "error TS" in l or "AssertionError" in l or "failed" in l.lower() or "Property failed" in l), out[-1] if out else "")
    ok = r.returncode != 0
    caught += ok
    print(f"{'CAUGHT' if ok else 'MISSED'}  {name}\n        {signal[:170]}")
print(f"\n{caught} of {len(mutations)} mutations caught")
sys.exit(0 if caught == len(mutations) else 1)
