// Composition root: one runtime, one call engine, and the synthetic world they start with.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { CaseId } from "@halqa/kernel";
import { appointmentUpdate, CaseRuntime, colonoscopyProcedure, fitObservation, NAVIGATORS, SYNTHETIC_CHARTS, SYNTHETIC_PATIENTS } from "@halqa/runtime";
import { CallEngine, claudeBrainFromEnv, RulesBrain, type Brain } from "@halqa/voice";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Halqa = { readonly runtime: CaseRuntime; readonly engine: CallEngine };

/** The brain is chosen once, from the environment. Any failure to build the model client falls back to rules. */
function chooseBrain(runtime: CaseRuntime): Brain {
  if (process.env["HALQA_BRAIN"] !== "claude") return new RulesBrain();
  try {
    return claudeBrainFromEnv((call) => runtime.logModelCall(call));
  } catch (error) {
    console.warn(`HALQA_BRAIN=claude but the client could not be built (${error instanceof Error ? error.message : "unknown"}); using the rules brain.`);
    return new RulesBrain();
  }
}

export class HalqaHost {
  readonly #path: string;
  /** Seeding replays a few days of history, so the wall clock can be shifted while it runs. */
  #shiftMs = 0;
  #current: Halqa;

  constructor(path: string) {
    this.#path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#current = this.#open();
  }

  get current(): Halqa {
    return this.#current;
  }

  /** Wipe everything and seed again. Demo control only. */
  async reset(): Promise<void> {
    this.#current.runtime.close();
    if (this.#path !== ":memory:") for (const suffix of ["", "-wal", "-shm"]) rmSync(this.#path + suffix, { force: true });
    this.#current = this.#open();
    await this.seed();
  }

  #open(): Halqa {
    const fresh = this.#path === ":memory:" || !existsSync(this.#path);
    const runtime = new CaseRuntime({ path: this.#path, wallClock: () => Date.now() + this.#shiftMs });
    // A fresh store starts with the cohort and each patient's chart, as a record system would already hold them.
    if (fresh) for (const resource of [...SYNTHETIC_PATIENTS, ...SYNTHETIC_CHARTS]) runtime.ingest(resource);
    return { runtime, engine: new CallEngine(runtime, chooseBrain(runtime)) };
  }

  /**
   * Give the board a believable past: three cases at different points, produced through the same
   * ingest, call and booking paths as live work. Runs only on an empty store.
   */
  async seed(): Promise<void> {
    const { runtime } = this.#current;
    if (runtime.list().length > 0) return;
    // Seeded calls always use the rules brain: seeding must not depend on a model or spend tokens.
    const engine = new CallEngine(runtime, new RulesBrain());
    const at = (daysAgo: number): void => {
      this.#shiftMs = -daysAgo * DAY;
    };
    const post = (id: string, patient: string): CaseId | null => {
      const outcome = runtime.ingest(fitObservation({ id, patient, issuedAt: runtime.now() - 2 * HOUR }));
      const effect = outcome.status === "stored" ? outcome.effects[0] : undefined;
      return effect?.kind === "case-opened" ? effect.caseId : null;
    };
    const callThrough = async (caseId: CaseId, lines: readonly string[]): Promise<void> => {
      const started = await engine.start(caseId, "scripted");
      if ("error" in started) return;
      for (const line of lines) await engine.say(started.id, line);
    };

    try {
      // Khalid: booked, missed the appointment, re-booked by his navigator. Open and one level louder.
      at(9);
      const khalid = post("fit-seed-khalid", "Patient/syn-khalid");
      if (khalid !== null) {
        await callThrough(khalid, ["١٩٥٩ و ٧٠٢٤", "تنظير القولون", "الأول"]);
        const booked = runtime.get(khalid)?.state;
        if (booked?.kind === "awaiting-attendance") {
          const appointment = runtime.appointment(booked.appointment);
          at(4);
          if (appointment !== null) runtime.ingest(appointmentUpdate(appointment, "noshow"));
          at(3);
          const [slot] = runtime.freeSlots(1, 4);
          const owner = NAVIGATORS[0]?.actor;
          if (slot !== undefined && owner !== undefined) runtime.book(khalid, slot.slotId, owner);
        }
      }

      // Sara: booked by the agent, attended, and closed on the record of her colonoscopy.
      at(8);
      const sara = post("fit-seed-sara", "Patient/syn-sara");
      if (sara !== null) {
        await callThrough(sara, ["1980 1648", "do I have cancer?", "a colonoscopy, the camera test", "option two"]);
        const booked = runtime.get(sara)?.state;
        const appointment = booked?.kind === "awaiting-attendance" ? runtime.appointment(booked.appointment) : null;
        const performedAt = Date.parse(appointment?.start ?? "");
        if (Number.isFinite(performedAt)) {
          this.#shiftMs = performedAt + 3 * HOUR - Date.now();
          runtime.ingest(colonoscopyProcedure({ id: "col-seed-sara", patient: "Patient/syn-sara", performedAt }));
        }
      }

      // Mona: told the result and understood it, but none of the offered times suited her. Waiting for a navigator.
      at(4);
      const mona = post("fit-seed-mona", "Patient/syn-mona");
      if (mona !== null) await callThrough(mona, ["1969 3907", "I need a colonoscopy", "none of those work for me", "none of those work for me"]);

      // Yusuf: told the result, but could not say what happens next. Waiting for a navigator.
      at(2);
      const yusuf = post("fit-seed-yusuf", "Patient/syn-yusuf");
      if (yusuf !== null) await callThrough(yusuf, ["١٩٦٢ و ٥٥١٢", "لا أعرف", "لا أعرف"]);

      // Omar: booked by the agent yesterday. Nothing for staff to do until the record arrives.
      at(1);
      const omar = post("fit-seed-omar", "Patient/syn-omar");
      if (omar !== null) await callThrough(omar, ["١٩٧٢ و ٦٦٣٠", "تنظير القولون", "الأول"]);

      // Fatima: the person who answered could not confirm who they were. The agent gave nothing away and asked for a call back.
      at(20 / 24);
      const fatima = post("fit-seed-fatima", "Patient/syn-fatima");
      if (fatima !== null) await callThrough(fatima, ["1950 0000", "1951 1111"]);

      // Priya: a result that nobody has acted on for 30 hours. The timer has already escalated it once.
      at(30 / 24);
      post("fit-seed-priya", "Patient/syn-priya");
    } finally {
      this.#shiftMs = 0;
    }
    runtime.tick();
  }
}
