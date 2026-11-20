// The worklist: every positive result that has not yet led to a colonoscopy, with the one thing
// that should happen next on each.
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dueStatus, fmtRelative, SEX_LABEL, STAGE_LABEL } from "../format.js";
import { consoleHref, navigate } from "../router.js";
import type { Board, CaseSummary } from "../trpc.js";
import { Disclosure, Empty, PageHeader, Status } from "./ui.js";

type Queue = "action" | "waiting" | "closed" | "all";

const QUEUES: readonly { readonly id: Queue; readonly label: string; readonly empty: string; readonly has: (item: CaseSummary) => boolean }[] = [
  { id: "action", label: "Needs action", empty: "Nothing is waiting on staff.", has: (item) => item.kind !== "closed" && item.next.who !== "provider" },
  { id: "waiting", label: "Booked", empty: "No case is waiting on a colonoscopy record.", has: (item) => item.kind !== "closed" && item.next.who === "provider" },
  { id: "closed", label: "Closed", empty: "No case has closed yet.", has: (item) => item.kind === "closed" },
  { id: "all", label: "All", empty: "No cases yet. A case opens when a positive FIT result arrives.", has: () => true },
];

export function PatientLine({ patient }: { readonly patient: CaseSummary["patient"] }) {
  const parts = [patient.age === null ? null : `${patient.age}y`, patient.sex === null ? null : SEX_LABEL[patient.sex], patient.mrn === null ? null : `MRN ${patient.mrn}`];
  return <span className="text-xs text-muted-foreground tabular-nums">{parts.filter((part) => part !== null).join(" · ")}</span>;
}

function DueCell({ item, now }: { readonly item: CaseSummary; readonly now: number }) {
  if (item.due === null) {
    const basis = item.closed?.basis;
    return <span className="text-muted-foreground">{basis?.kind === "care-completed" ? "Colonoscopy on record" : basis?.kind === "human-decision" ? "Closed by a clinician" : ""}</span>;
  }
  const due = dueStatus(item.due, now, item.slaHours);
  return (
    <div className="grid gap-0.5">
      <span className="tabular-nums">{due.tone === "late" ? <Status tone="crit">{due.text}</Status> : due.tone === "soon" ? <Status tone="warn">{due.text}</Status> : due.text}</span>
      {item.escalatedTo !== null && <span className="text-xs text-muted-foreground">Raised to {item.escalatedTo}</span>}
    </div>
  );
}

export function Worklist({ board }: { readonly board: Board }) {
  const [queue, setQueue] = useState<Queue>("action");
  const active = QUEUES.find((candidate) => candidate.id === queue) ?? QUEUES[0];
  const rows = active === undefined ? [] : board.cases.filter(active.has);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Worklist" description="Positive FIT results that have not yet led to a colonoscopy. Each case has one owner, one deadline and one next step." />

      <Tabs value={queue} onValueChange={(value) => setQueue(QUEUES.find((candidate) => candidate.id === value)?.id ?? "action")}>
        <TabsList variant="line" className="w-full justify-start gap-4 border-b">
          {QUEUES.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className="flex-none px-0.5">
              {item.label}
              <span className="text-muted-foreground tabular-nums">{board.cases.filter(item.has).length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="rounded-xl border bg-card">
        {rows.length === 0 ? (
          <Empty title={active?.empty ?? ""} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Patient</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="min-w-[16rem]">Next step</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Deadline</TableHead>
                <TableHead className="pr-4">Last call</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((item) => (
                <TableRow key={item.id} className="cursor-pointer align-top" onClick={() => navigate(consoleHref("case", item.id))}>
                  <TableCell className="py-3 pl-4">
                    <a href={consoleHref("case", item.id)} className="font-medium underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none" onClick={(event) => event.stopPropagation()}>
                      {item.patient.name}
                    </a>
                    <div>
                      <PatientLine patient={item.patient} />
                    </div>
                  </TableCell>
                  <TableCell className="py-3">{item.kind === "closed" ? <span className="text-muted-foreground">Closed</span> : STAGE_LABEL[item.kind]}</TableCell>
                  <TableCell className="py-3 whitespace-normal">
                    {item.urgent ? <Status tone="crit">{item.next.text}</Status> : item.kind === "closed" ? <span className="text-muted-foreground">None</span> : item.next.text}
                  </TableCell>
                  <TableCell className="py-3">{item.owner?.name ?? <span className="text-muted-foreground">None</span>}</TableCell>
                  <TableCell className="py-3">
                    <DueCell item={item} now={board.now} />
                  </TableCell>
                  <TableCell className="py-3 pr-4 text-muted-foreground tabular-nums">{item.lastCallAt === null ? "No calls" : fmtRelative(item.lastCallAt, board.now)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Disclosure title="How cases get here and how they leave">
        <ul className="grid max-w-[78ch] list-disc gap-1.5 pl-4">
          <li>A case opens by itself when a laboratory posts a positive FIT result. Nobody has to notice the result.</li>
          <li>Each stage has a time allowance. When it runs out the case stays open and is raised one level: to its owner, then the team lead, then the programme lead.</li>
          <li>A case closes in two ways only: a completed colonoscopy for the same patient arrives on the record, or a clinician closes it with a reason and a note.</li>
          <li>The voice agent can tell the patient the result, check understanding and book. It cannot own a case and it cannot close one.</li>
        </ul>
      </Disclosure>
    </div>
  );
}
