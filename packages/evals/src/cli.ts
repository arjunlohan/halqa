// Prints the simulation arms as a table. Add --json for the full result after the table.

import { argv, stdout } from "node:process";
import { runSimulation } from "./sim.js";
import type { ArmResult, SimResult } from "./sim.types.js";

type Column = { readonly title: string; readonly cell: (arm: ArmResult) => string };

function share(count: number, arm: ArmResult): string {
  return `${((count / arm.patients) * 100).toFixed(1)}%`;
}

function days(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function largestDropOff(arm: ArmResult): string {
  const [reason, count] = Object.entries(arm.dropOff).reduce((largest, entry) => (entry[1] > largest[1] ? entry : largest));
  return `${reason} ${share(count, arm)}`;
}

const COLUMNS: readonly Column[] = [
  { title: "arm", cell: (arm) => arm.id },
  { title: "done", cell: (arm) => share(arm.completedWithinHorizon, arm) },
  { title: "<=31d", cell: (arm) => share(arm.completedWithin31Days, arm) },
  { title: "<=90d", cell: (arm) => share(arm.completedWithin90Days, arm) },
  { title: "open@90d", cell: (arm) => share(arm.unresolvedAt90Days, arm) },
  { title: "notify", cell: (arm) => days(arm.medianDaysToNotification) },
  { title: "book", cell: (arm) => days(arm.medianDaysToBooking) },
  { title: "care", cell: (arm) => days(arm.medianDaysToCare) },
  { title: "nav min/case", cell: (arm) => arm.navigatorMinutesPerCase.toFixed(1) },
  { title: "alerts/nav day", cell: (arm) => arm.alertsPerNavigatorDay.toFixed(1) },
  { title: "largest drop-off", cell: largestDropOff },
];

function formatTable(arms: readonly ArmResult[]): string {
  const rows = [COLUMNS.map((column) => column.title), ...arms.map((arm) => COLUMNS.map((column) => column.cell(arm)))];
  const widths = COLUMNS.map((_, index) => Math.max(...rows.map((row) => row[index]?.length ?? 0)));
  const formatRow = (row: readonly string[]): string =>
    row.map((cell, index) => (index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0))).join("  ");
  return rows.map(formatRow).join("\n");
}

function formatReport(result: SimResult): string {
  const { config } = result;
  const assumed = result.assumptions.filter((row) => row.source === "assumption").length;
  return [
    "Halqa pathway simulation (simulation, not outcome evidence)",
    `seed ${config.seed} · ${config.patientsPerArm} patients per arm · horizon ${config.horizonDays} days · slots per week ${config.slotsPerWeekAmple} ample, ${config.slotsPerWeekBound} bound · ${config.navigators} navigators`,
    "",
    formatTable(result.arms),
    "",
    "done, <=31d, <=90d: share with a completed colonoscopy by then. open@90d: neither completed nor dropped by day 90.",
    "notify, book, care: median days from referral among patients who reached the step.",
    `${assumed} of ${result.assumptions.length} parameters are assumptions. Run with --json for the full table and caveats.`,
  ].join("\n");
}

const result = runSimulation();
stdout.write(`${formatReport(result)}\n`);
if (argv.includes("--json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
