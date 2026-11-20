import type { CaseDetail } from "./trpc.js";

type TimelineItem = CaseDetail["timeline"][number];

/** A case's events newest first, with a run of consecutive missed deadlines folded into one line and a count. */
export function collapseTimeline(items: readonly TimelineItem[]): readonly { readonly item: TimelineItem; readonly count: number }[] {
  const out: { item: TimelineItem; count: number }[] = [];
  for (const item of [...items].reverse()) {
    const last = out.at(-1);
    if (last !== undefined && item.type === "deadline-passed" && last.item.type === "deadline-passed") last.count += 1;
    else out.push({ item, count: 1 });
  }
  return out;
}
