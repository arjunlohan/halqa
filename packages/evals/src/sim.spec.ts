import { describe, expect, it } from "vitest";
import { defaultSimConfig, runSimulation } from "./sim.js";
import type { ArmId, ArmResult, SimResult } from "./sim.types.js";

const base = runSimulation();

function armOf(result: SimResult, id: ArmId): ArmResult {
  const arm = result.arms.find((candidate) => candidate.id === id);
  if (arm === undefined) throw new Error(`missing arm ${id}`);
  return arm;
}

function percentOf(count: number, arm: ArmResult): number {
  return (count / arm.patients) * 100;
}

function completionPercent(result: SimResult, id: ArmId): number {
  const arm = armOf(result, id);
  return percentOf(arm.completedWithinHorizon, arm);
}

function within31Percent(result: SimResult, id: ArmId): number {
  const arm = armOf(result, id);
  return percentOf(arm.completedWithin31Days, arm);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function expectConsistentAccounting(result: SimResult): void {
  expect(result.arms).toHaveLength(5);
  for (const arm of result.arms) {
    const curve = arm.completionCurve;
    const slices = Object.values(arm.byLanguage);

    expect(arm.patients, arm.id).toBe(result.config.patientsPerArm);
    expect(sum(Object.values(arm.dropOff)), arm.id).toBe(arm.patients - arm.completedWithinHorizon);
    expect(arm.completedWithin31Days, arm.id).toBeLessThanOrEqual(arm.completedWithin90Days);
    expect(arm.completedWithin90Days, arm.id).toBeLessThanOrEqual(arm.completedWithinHorizon);

    expect(curve, arm.id).toHaveLength(result.config.horizonDays + 1);
    expect(curve.every((count, day) => day === 0 || count >= (curve[day - 1] ?? 0)), arm.id).toBe(true);
    expect(curve.at(-1), arm.id).toBe(arm.completedWithinHorizon);
    expect(curve[31], arm.id).toBe(arm.completedWithin31Days);

    expect(sum(slices.map((slice) => slice.patients)), arm.id).toBe(arm.patients);
    expect(sum(slices.map((slice) => slice.completedWithinHorizon)), arm.id).toBe(arm.completedWithinHorizon);
    expect(sum(slices.map((slice) => slice.completedWithin31Days)), arm.id).toBe(arm.completedWithin31Days);
  }
}

describe("determinism", () => {
  it("gives the same result for the same config", () => {
    expect(runSimulation()).toEqual(base);
    expect(JSON.stringify(runSimulation())).toBe(JSON.stringify(base));
  });

  it("gives a different result for a different seed", () => {
    const other = runSimulation({ seed: defaultSimConfig.seed + 1 });
    expect(other.arms).not.toEqual(base.arms);
  });
});

describe("calibration", () => {
  it("lands each calibrated arm within 1.0 point of its published rate", () => {
    expect(Math.abs(completionPercent(base, "baseline-abu-dhabi") - 30.5)).toBeLessThanOrEqual(1.0);
    expect(Math.abs(completionPercent(base, "baseline-pooled") - 47.8)).toBeLessThanOrEqual(1.0);
    expect(Math.abs(completionPercent(base, "halqa-central") - 69.1)).toBeLessThanOrEqual(1.0);
  });

  it("keeps the Halqa arm at or below the cap", () => {
    expect(completionPercent(base, "halqa-central")).toBeLessThanOrEqual(70.1);
  });

  it("keeps usual-care time to colonoscopy near the published 72 days, and Halqa faster to notify and book", () => {
    const usual = armOf(base, "baseline-pooled");
    const halqa = armOf(base, "halqa-central");
    expect(usual.medianDaysToCare ?? 0).toBeGreaterThanOrEqual(50);
    expect(usual.medianDaysToCare ?? 0).toBeLessThanOrEqual(90);
    expect(halqa.medianDaysToNotification ?? 0).toBeLessThan(usual.medianDaysToNotification ?? 0);
    expect(halqa.medianDaysToBooking ?? 0).toBeLessThan(usual.medianDaysToBooking ?? 0);
  });
});

describe("accounting", () => {
  it("adds up in every arm at the default config", () => {
    expectConsistentAccounting(base);
  });

  it("adds up with a small cohort", () => {
    expectConsistentAccounting(runSimulation({ patientsPerArm: 500 }));
  });
});

describe("capacity", () => {
  it("lets Halqa beat usual care on 31-day completion when capacity is ample", () => {
    const margin = within31Percent(base, "halqa-central") - within31Percent(base, "baseline-pooled");
    expect(margin).toBeGreaterThan(20);
  });

  it("removes that advantage when capacity binds", () => {
    const usual = within31Percent(base, "baseline-pooled-capacity-bound");
    const halqa = within31Percent(base, "halqa-capacity-bound");
    expect(Math.abs(halqa - usual)).toBeLessThanOrEqual(2);
    // The gap closes because the queue pulls Halqa down, not because usual care catches up.
    expect(within31Percent(base, "halqa-central") - halqa).toBeGreaterThan(20);
    expect(armOf(base, "halqa-capacity-bound").dropOff["no-capacity"]).toBeGreaterThan(0);
  });

  it("never fills a week when capacity is ample", () => {
    const ampleArms: readonly ArmId[] = ["baseline-abu-dhabi", "baseline-pooled", "halqa-central"];
    for (const id of ampleArms) expect(armOf(base, id).dropOff["no-capacity"], id).toBe(0);
    const unlimited = runSimulation({ slotsPerWeekAmple: 1_000_000 });
    expect(armOf(unlimited, "halqa-central")).toEqual(armOf(base, "halqa-central"));
  });

  it("negative control: with ample slots the capacity-bound Halqa arm matches the central arm", () => {
    const lifted = runSimulation({ slotsPerWeekBound: defaultSimConfig.slotsPerWeekAmple });
    const gap = within31Percent(lifted, "halqa-capacity-bound") - within31Percent(lifted, "halqa-central");
    expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  });
});

describe("honesty of the write-up", () => {
  it("marks only the cited figures as published", () => {
    const publishedRows = base.assumptions.filter((row) => row.source === "published");
    expect(publishedRows.map((row) => row.value)).toEqual([
      "30.5%",
      "47.8%",
      "69.1%",
      "navigation 1.24, patient reminders 1.32, clinician reminders 1.36, automatic referral 1.68",
      "72 days",
    ]);
    expect(base.assumptions.length - publishedRows.length).toBeGreaterThan(publishedRows.length * 4);
  });

  it("states the required caveats", () => {
    const caveats = base.caveats.join(" ");
    expect(caveats).toContain("not evidence that Halqa improves outcomes");
    expect(caveats).toContain("an input, not a finding");
    expect(caveats).toContain("solved so the arm hits its calibration target");
    expect(caveats).toContain("sampling noise only");
  });
});
