// The patient's chart, and Claude's reading of it. Every sentence in the review names the records
// it rests on; pressing a record label takes you to that record on the left.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDate, fmtDateTime } from "../format.js";
import { useTRPC, type CaseDetail, type ChartRecord, type ChartReview } from "../trpc.js";
import { Disclosure, Empty, Panel, Status, useActor } from "./ui.js";

type Group = { readonly id: string; readonly label: string; readonly kinds: readonly ChartRecord["kind"][] };
const GROUPS: readonly Group[] = [
  { id: "results", label: "Results", kinds: ["result", "lab"] },
  { id: "conditions", label: "Conditions", kinds: ["condition"] },
  { id: "medicines", label: "Medicines", kinds: ["medication"] },
  { id: "procedures", label: "Procedures", kinds: ["procedure"] },
  { id: "family", label: "Family history", kinds: ["family-history"] },
  { id: "visits", label: "Visits and appointments", kinds: ["encounter", "appointment"] },
];
const FLAG: Readonly<Record<string, { readonly word: string; readonly tone: string }>> = {
  positive: { word: "Positive", tone: "text-crit" },
  low: { word: "Low", tone: "text-warn" },
  high: { word: "High", tone: "text-warn" },
};

const rowId = (ref: string): string => `record-${ref.replace(/[^A-Za-z0-9]/g, "-")}`;

function Cites({ statement, review, onCite }: { readonly statement: { readonly cites: readonly string[] }; readonly review: ChartReview; readonly onCite: (ref: string) => void }) {
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-baseline">
      {statement.cites.map((label) => {
        const ref = review.lines.find((line) => line.label === label)?.ref;
        return ref === undefined ? null : (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="h-5 rounded px-1.5 font-mono text-[11px] text-muted-foreground" onClick={() => onCite(ref)}>
                {label}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show this record in the chart</TooltipContent>
          </Tooltip>
        );
      })}
    </span>
  );
}

function Statements({ items, review, onCite }: { readonly items: ChartReview["relevant"]; readonly review: ChartReview; readonly onCite: (ref: string) => void }) {
  return (
    <ul className="grid gap-2.5">
      {items.map((item) => (
        <li key={item.text} className="text-pretty">
          {item.text}
          <Cites statement={item} review={review} onCite={onCite} />
        </li>
      ))}
    </ul>
  );
}

function ReviewPanel({ detail, review, onCite }: { readonly detail: CaseDetail; readonly review: ChartReview; readonly onCite: (ref: string) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const actor = useActor();
  const refresh = () => queryClient.invalidateQueries();
  const mark = useMutation(trpc.markReview.mutationOptions({ onSuccess: refresh, onError: (error) => toast.error(error.message) }));
  const run = useMutation(trpc.runReview.mutationOptions({ onSuccess: refresh, onError: (error) => toast.error(error.message) }));
  const caseId = detail.summary.id;
  const checked = review.marks.findLast((item) => item.kind === "checked");
  const reported = review.marks.findLast((item) => item.kind === "reported-inaccurate");
  const source = review.source;

  return (
    <Panel
      title="Chart review by Claude"
      description={
        source.kind === "stored"
          ? `Written by ${source.model} on ${source.generatedOn} from ${review.lines.length} records.`
          : `Written by ${source.model} on ${fmtDateTime(source.at)} in ${(source.ms / 1000).toFixed(1)} s from ${review.lines.length} records.`
      }
      action={
        detail.liveReview ? (
          <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate({ caseId })}>
            <RefreshCw className={run.isPending ? "animate-spin" : undefined} />
            {run.isPending ? "Reviewing" : "Review again"}
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-5 text-sm">
        <div className="grid gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">In brief</h3>
          <p className="text-[15px] leading-relaxed text-pretty">
            {review.summary.text}
            <Cites statement={review.summary} review={review} onCite={onCite} />
          </p>
        </div>

        <div className="grid gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Assessment</h3>
          {review.flag === "clinician-should-review" ? (
            <Status tone="warn">
              {review.toCheck.length === 1 ? "One point" : `${review.toCheck.length} points`} for a clinician to look at before the colonoscopy goes ahead
            </Status>
          ) : (
            <Status tone="good">Nothing in these records was flagged for a clinician</Status>
          )}
          <p className="text-[13px] text-muted-foreground">This points at records. It is not a diagnosis and it decides nothing.</p>
        </div>

        <Accordion type="multiple" defaultValue={review.toCheck.length > 0 ? ["check"] : ["relevant"]} className="border-t">
          {review.toCheck.length > 0 && (
            <AccordionItem value="check">
              <AccordionTrigger>For a clinician to check ({review.toCheck.length})</AccordionTrigger>
              <AccordionContent>
                <Statements items={review.toCheck} review={review} onCite={onCite} />
              </AccordionContent>
            </AccordionItem>
          )}
          <AccordionItem value="relevant">
            <AccordionTrigger>Relevant to the colonoscopy ({review.relevant.length})</AccordionTrigger>
            <AccordionContent>{review.relevant.length === 0 ? <p className="text-muted-foreground">Nothing listed.</p> : <Statements items={review.relevant} review={review} onCite={onCite} />}</AccordionContent>
          </AccordionItem>
          <AccordionItem value="missing">
            <AccordionTrigger>Looked for, not in these records ({review.notFound.length})</AccordionTrigger>
            <AccordionContent>
              <ul className="grid list-disc gap-1 pl-4">
                {review.notFound.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className="mt-2 text-[13px] text-muted-foreground">"Not in these records" is not the same as "not true of the patient".</p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {review.notCovered.length > 0 && (
          <p className="text-[13px] text-pretty text-muted-foreground">
            {review.notCovered.length === 1 ? "One newer record was" : `${review.notCovered.length} newer records were`} not part of this review:{" "}
            {review.notCovered.map((record) => `${record.title}${record.at === null ? "" : ` (${fmtDate(record.at)})`}`).join("; ")}.
          </p>
        )}
        {review.dropped > 0 && (
          <p className="text-[13px] text-muted-foreground">
            {review.dropped} {review.dropped === 1 ? "sentence was" : "sentences were"} removed because {review.dropped === 1 ? "it" : "they"} cited no record in this chart.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="grid gap-0.5 text-[13px]">
            {checked === undefined ? (
              <span className="text-muted-foreground">Not yet checked against the chart by a clinician</span>
            ) : (
              <Status tone="good">
                Checked against the chart by {checked.by}, {fmtDateTime(checked.at)}
              </Status>
            )}
            {reported !== undefined && (
              <Status tone="warn">
                Reported as inaccurate by {reported.by}, {fmtDateTime(reported.at)}
              </Status>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button size="sm" variant="outline" disabled={!actor.isClinician || mark.isPending} onClick={() => mark.mutate({ caseId, hash: review.hash, kind: "checked", by: actor.ref })}>
                    Mark as checked
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{actor.isClinician ? "Record that you compared this review with the chart" : "Only a clinician can record a check. Switch who you are acting as, top right."}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-8" aria-label="More actions for this review">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => mark.mutate({ caseId, hash: review.hash, kind: "reported-inaccurate", by: actor.ref })}>Report inaccurate or made-up information</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <Disclosure title="How this review is made">
          <ul className="grid max-w-[68ch] list-disc gap-1.5 pl-4">
            <li>The chart is sent to the model as a list of records with labels (R1, R2, and so on). It carries a birth year and a sex, and no name, MRN or national ID.</li>
            <li>The model must cite a record for every sentence. Software then removes any sentence whose citations do not match a record in this chart, so an unsupported sentence is never shown.</li>
            <li>The facts in a sentence come from the cited record. The reason given for why it matters to a colonoscopy is the model's general knowledge, which is why a clinician checks it.</li>
            <li>The assessment line is set by software from the list of points, never by the model.</li>
            {source.kind === "stored" ? (
              <li>
                {source.via} It is shown only while the records it was written from are unchanged; if one of them changes, the review is withdrawn. A live review needs an API key on the server.
              </li>
            ) : (
              <li>This review was requested live from the API and is kept on the server under a fingerprint of the chart text.</li>
            )}
          </ul>
        </Disclosure>
      </div>
    </Panel>
  );
}

export function Records({ detail }: { readonly detail: CaseDetail }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const review = detail.review;
  const run = useMutation(trpc.runReview.mutationOptions({ onSuccess: () => queryClient.invalidateQueries(), onError: (error) => toast.error(error.message) }));
  const groups = useMemo(() => GROUPS.map((group) => ({ ...group, records: detail.chart.filter((record) => group.kinds.includes(record.kind)) })).filter((group) => group.records.length > 0), [detail.chart]);
  const [open, setOpen] = useState<readonly string[]>(() => GROUPS.map((group) => group.id));
  const flash = useRef<number | null>(null);
  const labelOf = (ref: string): string | undefined => review?.lines.find((line) => line.ref === ref)?.label;

  const showRecord = (ref: string) => {
    const group = groups.find((candidate) => candidate.records.some((record) => record.ref === ref));
    if (group !== undefined && !open.includes(group.id)) setOpen([...open, group.id]);
    // Wait for the group to open before scrolling to the row inside it.
    window.setTimeout(() => {
      const row = document.getElementById(rowId(ref));
      if (row === null) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.remove("cite-flash");
      void row.offsetWidth;
      row.classList.add("cite-flash");
      if (flash.current !== null) window.clearTimeout(flash.current);
      flash.current = window.setTimeout(() => row.classList.remove("cite-flash"), 1700);
    }, 60);
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:h-full xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:overflow-hidden">
      <div className="order-2 xl:order-1 xl:overflow-y-auto xl:pr-1">
        <Panel title="Chart" description={`${detail.chart.length} records held for this patient, newest first in each group.`} bodyClassName="px-4 py-1">
          {groups.length === 0 ? (
            <Empty title="No records for this patient" />
          ) : (
            <Accordion type="multiple" value={[...open]} onValueChange={setOpen}>
              {groups.map((group) => (
                <AccordionItem key={group.id} value={group.id}>
                  <AccordionTrigger>
                    <span>
                      {group.label} <span className="font-normal text-muted-foreground tabular-nums">{group.records.length}</span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <ul className="grid">
                      {group.records.map((record) => {
                        const flagged = record.flag === null ? undefined : FLAG[record.flag];
                        const label = labelOf(record.ref);
                        return (
                          <li key={record.ref} id={rowId(record.ref)} className="-mx-2 grid grid-cols-[5.5rem_minmax(0,1fr)_auto] gap-x-3 rounded-md px-2 py-2">
                            <span className="text-[13px] text-muted-foreground tabular-nums">{record.at === null ? "No date" : fmtDate(record.at)}</span>
                            <span className="min-w-0">
                              <span className="block text-pretty">{record.title}</span>
                              <span className="block text-[13px] text-muted-foreground">
                                {record.detail}
                                {flagged !== undefined && <span className={flagged.tone}> · {flagged.word}</span>}
                              </span>
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">{label ?? ""}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </Panel>
      </div>

      <div className="order-1 xl:order-2 xl:overflow-y-auto xl:pr-1">
        {review === null ? (
          <Panel title="Chart review by Claude">
            <Empty title="No review of this chart">
              {detail.liveReview
                ? "The chart has not been reviewed as it stands now."
                : "The stored review was withdrawn because a record it was written from has changed, and a live review needs an API key on the server (ANTHROPIC_API_KEY)."}
            </Empty>
            {detail.liveReview && (
              <div className="flex justify-center pb-4">
                <Button disabled={run.isPending} onClick={() => run.mutate({ caseId: detail.summary.id })}>
                  {run.isPending ? "Reviewing" : "Ask Claude to review this chart"}
                </Button>
              </div>
            )}
          </Panel>
        ) : (
          <ReviewPanel detail={detail} review={review} onCite={showRecord} />
        )}
      </div>
    </div>
  );
}
