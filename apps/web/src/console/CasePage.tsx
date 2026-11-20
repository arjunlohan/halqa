// One case. The patient stays pinned at the top; the tabs below scroll inside the window.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { PhoneCall } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { collapseTimeline } from "../timeline.js";
import { useCall } from "../use-call.js";
import { dueStatus, fmtDate, fmtDateTime, LANGUAGE_LABEL, SEX_LABEL, shortHash, STAGE_LABEL, type StateKind } from "../format.js";
import { useTRPC, type CaseDetail, type Staff } from "../trpc.js";
import { callLength, callStatus, CallRecordSheet, CHANNEL_LABEL } from "./CallRecord.js";
import { LiveCallSheet } from "./LiveCall.js";
import { Records } from "./Records.js";
import { CopyId, Disclosure, Empty, Field, Fields, Panel, StaffOptions, Status, useActor } from "./ui.js";

type TabId = "overview" | "records" | "calls" | "activity";

const TRACK: readonly { readonly label: string; readonly kinds: readonly StateKind[] }[] = [
  { label: "Tell the patient", kinds: ["awaiting-notification"] },
  { label: "Confirm understanding", kinds: ["awaiting-acknowledgement"] },
  { label: "Book", kinds: ["awaiting-booking"] },
  { label: "Colonoscopy", kinds: ["awaiting-attendance", "awaiting-resolution"] },
  { label: "Closed", kinds: ["closed"] },
];

function StageTrack({ kind }: { readonly kind: StateKind }) {
  const current = TRACK.findIndex((step) => step.kinds.includes(kind));
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Where this case stands">
      {TRACK.map((step, index) => {
        const done = index < current || kind === "closed";
        const now = index === current && kind !== "closed";
        return (
          <li key={step.label} aria-current={now ? "step" : undefined} className="grid gap-1.5">
            <span className={cn("h-1 rounded-full", done ? "bg-primary/55" : now ? "bg-primary" : "bg-border")} />
            <span className={cn("truncate text-xs", now ? "font-medium text-foreground" : "hidden text-muted-foreground sm:block")}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const WHO: Readonly<Record<CaseDetail["summary"]["next"]["who"], string>> = {
  navigator: "The care navigator",
  clinician: "A screening clinician",
  provider: "The endoscopy provider",
  none: "Nobody",
};

const CLOSE_REASONS: readonly { readonly value: "informed-decline" | "clinically-not-indicated" | "care-transferred-out" | "deceased" | "duplicate"; readonly label: string }[] = [
  { value: "informed-decline", label: "The patient declined, having understood the result" },
  { value: "clinically-not-indicated", label: "A colonoscopy is not clinically indicated" },
  { value: "care-transferred-out", label: "Care was transferred to another provider" },
  { value: "deceased", label: "The patient has died" },
  { value: "duplicate", label: "This case duplicates another" },
];

function CloseByDecision({ caseId, onDone }: { readonly caseId: string; readonly onDone: () => void }) {
  const trpc = useTRPC();
  const actor = useActor();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof CLOSE_REASONS)[number]["value"]>("informed-decline");
  const [note, setNote] = useState("");
  const close = useMutation(
    trpc.closeByDecision.mutationOptions({
      onSuccess: () => {
        setOpen(false);
        setNote("");
        onDone();
        toast.success("Case closed by decision");
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!actor.isClinician}>
          Close without a colonoscopy
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close without a colonoscopy</DialogTitle>
          <DialogDescription>Only a clinician can do this, and only with a reason and a note. Both are written to the case's permanent record under your name.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="close-reason">Reason</Label>
            <Select value={reason} onValueChange={(value) => setReason(CLOSE_REASONS.find((item) => item.value === value)?.value ?? "informed-decline")}>
              <SelectTrigger id="close-reason" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLOSE_REASONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="close-note">Note</Label>
            <Textarea id="close-note" value={note} onChange={(event) => setNote(event.target.value)} rows={4} placeholder="What was discussed or found, in at least 20 characters" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={close.isPending || note.trim().length < 20} onClick={() => close.mutate({ caseId, by: actor.ref, reason, note })}>
            Close the case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Overview({ detail, onPlaceCall, onTab }: { readonly detail: CaseDetail; readonly onPlaceCall: () => void; readonly onTab: (tab: TabId) => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const actor = useActor();
  const { summary } = detail;
  const refresh = () => queryClient.invalidateQueries();
  const onError = (error: { message: string }) => toast.error(error.message);
  const recordStep = useMutation(trpc.recordStep.mutationOptions({ onSuccess: refresh, onError }));
  const book = useMutation(trpc.book.mutationOptions({ onSuccess: refresh, onError }));
  const pickUp = useMutation(trpc.pickUpHandoff.mutationOptions({ onSuccess: refresh, onError }));
  const waiting = detail.handoffs.filter((handoff) => handoff.pickedUpAt === null);
  const review = detail.review;

  let actions: ReactNode = null;
  if (summary.kind === "awaiting-notification") {
    actions = (
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onPlaceCall}>
          <PhoneCall />
          Place the outreach call
        </Button>
        <Button variant="outline" disabled={recordStep.isPending} onClick={() => recordStep.mutate({ caseId: summary.id, by: actor.ref, step: "notified" })}>
          I told the patient myself
        </Button>
      </div>
    );
  } else if (summary.kind === "awaiting-acknowledgement") {
    actions = (
      <div>
        <Button disabled={recordStep.isPending} onClick={() => recordStep.mutate({ caseId: summary.id, by: actor.ref, step: "acknowledged" })}>
          The patient told me what happens next
        </Button>
      </div>
    );
  } else if (summary.kind === "awaiting-booking") {
    actions = (
      <ul className="grid gap-2">
        {detail.slots.map((slot) => (
          <li key={slot.slotId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <span>
              <span className="tabular-nums">{fmtDateTime(slot.at)}</span>
              <span className="text-muted-foreground"> · {slot.provider}</span>
            </span>
            <Button size="sm" variant="outline" disabled={book.isPending} onClick={() => book.mutate({ caseId: summary.id, slotId: slot.slotId, by: actor.ref })}>
              Book this time
            </Button>
          </li>
        ))}
      </ul>
    );
  } else if (summary.kind === "awaiting-attendance") {
    actions = <p className="text-[13px] text-muted-foreground">Nothing for staff to do now. The case closes by itself when the provider's record of a completed colonoscopy arrives. If the appointment is missed, the case comes back for re-booking.</p>;
  } else if (summary.kind === "closed") {
    const basis = summary.closed?.basis;
    actions =
      basis?.kind === "care-completed" ? (
        <p className="text-[13px] text-muted-foreground">
          Closed on the record of a colonoscopy performed {fmtDateTime(basis.performedAt)}:{" "}
          <a className="font-mono text-xs underline underline-offset-2" href={`/fhir/${basis.resource}`} target="_blank" rel="noreferrer">
            {basis.resource}
          </a>
        </p>
      ) : basis?.kind === "human-decision" ? (
        <p className="text-[13px] text-muted-foreground">
          Closed by {basis.by}. {CLOSE_REASONS.find((item) => item.value === basis.reason)?.label ?? basis.reason}. Note: {basis.note}
        </p>
      ) : null;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="grid grid-cols-1 gap-5">
        <Panel title="Next step" description={summary.kind === "closed" ? undefined : `Whose move: ${WHO[summary.next.who].toLowerCase()}`}>
          <div className="grid gap-4">
            <p className={cn("text-base text-pretty", summary.urgent && "text-crit")}>{summary.next.text}</p>
            {actions}
          </div>
        </Panel>

        {waiting.length > 0 && (
          <Panel title="Waiting for a person" description="The agent stopped and left these for staff. Pick one up to say you are dealing with it.">
            <ul className="grid gap-2">
              {waiting.map((handoff) => (
                <li key={handoff.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <span className="grid gap-0.5">
                    <Status tone={handoff.urgent ? "crit" : "warn"}>{handoff.reasonText}</Status>
                    <span className="pl-3.5 text-xs text-muted-foreground tabular-nums">Raised {fmtDateTime(handoff.at)}</span>
                  </span>
                  <Button size="sm" variant="outline" disabled={pickUp.isPending} onClick={() => pickUp.mutate({ handoffId: handoff.id, by: actor.ref })}>
                    Pick up
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel
          title="Chart in brief"
          description="From Claude's review of this patient's records"
          action={
            <Button variant="ghost" size="sm" onClick={() => onTab("records")}>
              Open the review
            </Button>
          }
        >
          {review === null ? (
            <p className="text-[13px] text-muted-foreground">No review of this chart is available. The records are on the Records tab.</p>
          ) : (
            <div className="grid gap-3">
              <p className="text-[15px] leading-relaxed text-pretty">{review.summary.text}</p>
              {review.flag === "clinician-should-review" ? (
                <Status tone="warn">{review.toCheck.length === 1 ? "One point" : `${review.toCheck.length} points`} for a clinician to look at before the colonoscopy</Status>
              ) : (
                <Status tone="good">Nothing in the records was flagged for a clinician</Status>
              )}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5">
        <Panel title="Case">
          <Fields>
            <Field label="Result">
              Positive FIT ·{" "}
              <a className="font-mono text-xs underline underline-offset-2" href={`/fhir/${summary.result}`} target="_blank" rel="noreferrer">
                view record
              </a>
            </Field>
            <Field label="Resulted">
              <span className="tabular-nums">{fmtDateTime(summary.resultedAt)}</span>
            </Field>
            <Field label="Case opened">
              <span className="tabular-nums">{fmtDateTime(summary.openedAt)}</span>
            </Field>
            <Field label="Pathway">{summary.pathway}</Field>
            <Field label="Appointment">
              {detail.appointment === null ? <span className="text-muted-foreground">None booked</span> : <span className="tabular-nums">{`${fmtDateTime(detail.appointment.start)}, ${detail.appointment.provider}`}</span>}
            </Field>
            <Field label="Calls">
              <Button variant="link" size="sm" className="h-auto p-0 font-normal" onClick={() => onTab("calls")}>
                {summary.calls === 0 ? "None yet" : `${summary.calls} on record`}
              </Button>
            </Field>
            <Field label="Case ID">
              <CopyId value={summary.id} head={10} />
            </Field>
          </Fields>
        </Panel>

        {summary.kind !== "closed" && (
          <Panel title="Other ways this case can close">
            <div className="grid gap-3">
              <p className="text-[13px] text-pretty text-muted-foreground">
                Without a colonoscopy on record, only a clinician can close a case, with a reason and a note.{actor.isClinician ? "" : " You are acting as a navigator, so this is not available to you."}
              </p>
              <div>
                <CloseByDecision caseId={summary.id} onDone={refresh} />
              </div>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function CaseCalls({ detail, onPlaceCall, liveCallId, onReturn }: { readonly detail: CaseDetail; readonly onPlaceCall: () => void; readonly liveCallId: string | null; readonly onReturn: () => void }) {
  const [openCall, setOpenCall] = useState<string | null>(null);
  const canCall = detail.summary.kind === "awaiting-notification";
  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[70ch] text-[13px] text-pretty text-muted-foreground">
          {canCall
            ? "The outreach call tells the patient the result, checks they understood, and books the colonoscopy."
            : "The outreach call exists to give the result, so it can only be placed while the result has not been given. From here staff work the case on the Overview tab."}
        </p>
        {liveCallId !== null ? (
          <Button onClick={onReturn}>Return to the call</Button>
        ) : (
          <Button disabled={!canCall} onClick={onPlaceCall}>
            <PhoneCall />
            Place the outreach call
          </Button>
        )}
      </div>
      <div className="rounded-xl border bg-card">
        {detail.calls.length === 0 ? (
          <Empty title="No calls on this case yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Started (GST)</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="pr-4">How it ended</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.calls.map((call) => {
                const status = callStatus(call);
                return (
                  <TableRow key={call.id} className="cursor-pointer" onClick={() => (call.live && call.id === liveCallId ? onReturn() : setOpenCall(call.id))}>
                    <TableCell className="py-3 pl-4 tabular-nums">{fmtDateTime(call.startedAt)}</TableCell>
                    <TableCell className="py-3 tabular-nums">{callLength(call)}</TableCell>
                    <TableCell className="py-3">{CHANNEL_LABEL[call.channel] ?? call.channel}</TableCell>
                    <TableCell className="py-3 pr-4 whitespace-normal">
                      <Status tone={status.tone}>{status.text}</Status>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <CallRecordSheet callId={openCall} onClose={() => setOpenCall(null)} />
    </div>
  );
}

function ActivityTab({ detail }: { readonly detail: CaseDetail }) {
  const rows = collapseTimeline(detail.timeline);
  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[11rem] pl-4">When (GST)</TableHead>
              <TableHead>What happened</TableHead>
              <TableHead className="pr-4">By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ item, count }) => (
              <TableRow key={item.seq} className="align-top hover:bg-transparent">
                <TableCell className="py-3 pl-4 text-muted-foreground tabular-nums">{fmtDateTime(item.at)}</TableCell>
                <TableCell className="py-3 whitespace-normal">
                  <span className={cn("font-medium", (item.type === "deadline-passed" || item.type === "appointment-missed") && "text-warn")}>
                    {item.title}
                    {count > 1 && <span className="font-normal text-muted-foreground tabular-nums"> · {count} times</span>}
                  </span>
                  <span className="block text-[13px] text-pretty text-muted-foreground">{item.detail}</span>
                </TableCell>
                <TableCell className="py-3 pr-4 whitespace-normal text-muted-foreground">{item.actor}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Panel title="Behind the record" bodyClassName="grid gap-1 px-4 py-2">
        <Disclosure title={detail.chain.ok ? `Tamper check passed: ${detail.chain.length} events, each sealed to the one before` : "Tamper check failed"}>
          {detail.chain.ok ? (
            <div className="grid gap-2">
              <p className="max-w-[70ch]">Each event carries a SHA-256 hash of itself and the hash before it. Changing, removing or reordering any event breaks every hash after it. The check is recomputed from storage each time this page loads.</p>
              <ol className="grid gap-0.5 font-mono text-xs">
                {detail.timeline.map((item) => (
                  <li key={item.seq} className="tabular-nums">
                    #{item.seq} {item.type} {shortHash(item.hash)}
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="text-crit">The chain breaks at event {detail.chain.atSeq}. The case is held: nothing can change it until this is investigated.</p>
          )}
        </Disclosure>
        <Disclosure title={`Records offered as proof of care (${detail.evidenceAttempts.length})`}>
          {detail.evidenceAttempts.length === 0 ? (
            <p>None yet. When a procedure record arrives for this patient, it is checked here before it can close the case.</p>
          ) : (
            <ul className="grid gap-1">
              {detail.evidenceAttempts.map((attempt) => (
                <li key={`${attempt.resource}-${attempt.at}`} className="tabular-nums">
                  {fmtDateTime(attempt.at)} · <span className="font-mono text-xs">{attempt.resource}</span> · {attempt.outcome === "accepted" ? "accepted, case closed" : `refused: ${attempt.outcome.replaceAll("-", " ")}`}
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
        <Disclosure title="This case as a FHIR Task">
          <p className="mb-2 max-w-[70ch]">Any FHIR client can read the case's status at GET /fhir/Task/{detail.summary.id} without using this console.</p>
          <pre className="overflow-x-auto rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed text-foreground/80">{JSON.stringify(detail.task, null, 2)}</pre>
        </Disclosure>
      </Panel>
    </div>
  );
}

export function CasePage({ caseId, staff }: { readonly caseId: string; readonly staff: Staff }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const actor = useActor();
  const query = useQuery(trpc.case.queryOptions({ caseId }, { refetchInterval: 2000 }));
  const [tab, setTab] = useState<TabId>("overview");
  const [sound, setSound] = useState(true);
  const [callOpen, setCallOpen] = useState(false);
  const controls = useCall(caseId, sound);
  const reassign = useMutation(trpc.reassign.mutationOptions({ onSuccess: () => queryClient.invalidateQueries(), onError: (error) => toast.error(error.message) }));
  const detail = query.data;

  if (detail === undefined) return <Empty title={query.isError ? "This case could not be loaded" : "Loading the case"}>{query.isError ? "It may have been removed by a sandbox reset. Go back to the worklist." : undefined}</Empty>;

  const { summary } = detail;
  const patient = summary.patient;
  const due = summary.due === null ? null : dueStatus(summary.due, detail.now, summary.slaHours);
  const liveCallId = controls.call !== null && controls.call.ended === null ? controls.call.id : null;
  const placeCall = () => {
    setCallOpen(true);
    if (liveCallId === null) void controls.place().catch((error: unknown) => toast.error(error instanceof Error ? error.message : "The call could not be placed."));
  };
  const identity = [
    patient.birthYear === null ? "Birth year not known" : `Born ${patient.birthYear}${patient.age === null ? "" : ` (${patient.age}y)`}`,
    patient.sex === null ? "Sex not known" : SEX_LABEL[patient.sex],
    patient.mrn === null ? "MRN not known" : `MRN ${patient.mrn}`,
    patient.language === null ? "Language not known" : `Prefers ${LANGUAGE_LABEL[patient.language] ?? patient.language}`,
  ];

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value === "records" || value === "calls" || value === "activity" ? value : "overview")} className="flex h-full flex-col gap-0">
      <div className="shrink-0 border-b bg-card/40">
        <div className="mx-auto grid w-full max-w-[1280px] gap-4 px-4 pt-5 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">{patient.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground tabular-nums">{identity.join(" · ")}</p>
            </div>
            <div className="grid justify-items-start gap-1 sm:justify-items-end">
              {summary.owner === null ? (
                <span className="text-sm text-muted-foreground">Closed {summary.closed === null ? "" : fmtDate(summary.closed.at)}</span>
              ) : (
                <>
                  <Select value={summary.owner.ref} onValueChange={(to) => reassign.mutate({ caseId, to, by: actor.ref })}>
                    <SelectTrigger size="sm" className="w-[13rem]" aria-label="Case owner">
                      <span className="text-muted-foreground">Owner</span>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <StaffOptions staff={staff} />
                    </SelectContent>
                  </Select>
                  {due !== null && summary.due !== null && (
                    <span className="text-[13px] tabular-nums">
                      {due.tone === "late" ? <Status tone="crit">{due.text}</Status> : due.tone === "soon" ? <Status tone="warn">{due.text}</Status> : <span className="text-muted-foreground">{due.text}</span>}
                      {summary.escalatedTo !== null && <span className="text-muted-foreground"> · raised to {summary.escalatedTo}</span>}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="grid gap-1">
            <StageTrack kind={summary.kind} />
            <p className="sr-only">{STAGE_LABEL[summary.kind]}</p>
          </div>
          <TabsList variant="line" className="-mb-px justify-start gap-5">
            <TabsTrigger value="overview" className="flex-none px-0.5">
              Overview
            </TabsTrigger>
            <TabsTrigger value="records" className="flex-none px-0.5">
              Records
              <span className="text-muted-foreground tabular-nums">{detail.chart.length}</span>
            </TabsTrigger>
            <TabsTrigger value="calls" className="flex-none px-0.5">
              Calls
              <span className="text-muted-foreground tabular-nums">{detail.calls.length}</span>
            </TabsTrigger>
            <TabsTrigger value="activity" className="flex-none px-0.5">
              Activity
            </TabsTrigger>
          </TabsList>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <TabsContent value="overview" className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
            <Overview detail={detail} onPlaceCall={placeCall} onTab={setTab} />
          </div>
        </TabsContent>
        <TabsContent value="records" className="h-full overflow-y-auto xl:overflow-hidden">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 xl:h-full">
            <Records detail={detail} />
          </div>
        </TabsContent>
        <TabsContent value="calls" className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
            <CaseCalls detail={detail} onPlaceCall={placeCall} liveCallId={liveCallId} onReturn={() => setCallOpen(true)} />
          </div>
        </TabsContent>
        <TabsContent value="activity" className="h-full overflow-y-auto">
          <div className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6">
            <ActivityTab detail={detail} />
          </div>
        </TabsContent>
      </div>

      <LiveCallSheet open={callOpen} onOpenChange={setCallOpen} detail={detail} controls={controls} sound={sound} onSound={setSound} />
    </Tabs>
  );
}
