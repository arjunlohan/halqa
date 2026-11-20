// Test fixture: open a case, then die without warning. Run as a child process by runtime.spec.ts.
import { CaseRuntime } from "./runtime.js";
import { fitObservation } from "./synthetic.js";

const [path, wall] = process.argv.slice(2);
if (path === undefined || wall === undefined) throw new Error("usage: kill.fixture <db path> <wall clock ms>");

const runtime = new CaseRuntime({ path, wallClock: () => Number(wall) });
const outcome = runtime.ingest(fitObservation({ id: "fit-kill", patient: "Patient/syn-ahmed", issuedAt: Number(wall) - 3_600_000 }));
process.stdout.write(`${JSON.stringify(outcome)}\n`);
// No close, no flush, no tick: the process is killed with the case open and its deadline pending.
process.kill(process.pid, "SIGKILL");
