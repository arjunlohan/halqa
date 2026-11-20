// The simulator. A deployment is fed by a laboratory, endoscopy units and the passing of real
// days. The sandbox has none of those, so this page plays their parts. None of it exists in a
// deployment, which is why it sits on its own page and not in the header.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtSpan, STAGE_LABEL } from "../format.js";
import { describeOutcome } from "../outcome.js";
import { consoleHref } from "../router.js";
import { useTRPC, type Board, type IngestOutcome } from "../trpc.js";
import { Field, Fields, PageHeader, Panel } from "./ui.js";

const SKIPS: readonly { readonly label: string; readonly hours: number }[] = [
  { label: "Skip 6 hours", hours: 6 },
  { label: "Skip 1 day", hours: 24 },
  { label: "Skip 7 days", hours: 168 },
];

type Variant = "completed" | "wrong-patient" | "wrong-code" | "not-completed";
const VARIANTS: readonly { readonly value: Variant; readonly label: string; readonly expect: string }[] = [
  { value: "completed", label: "A completed colonoscopy for this patient", expect: "Should close the case." },
  { value: "wrong-patient", label: "A completed colonoscopy for a different patient", expect: "Should be refused: wrong patient." },
  { value: "wrong-code", label: "A different procedure (sigmoidoscopy)", expect: "Should be refused: not the care the result calls for." },
  { value: "not-completed", label: "A colonoscopy that is still in progress", expect: "Should be refused: not completed." },
];

/** One simulated source: a sentence saying who is posting, the controls, and what happened last time. */
function Feed({ title, children, last }: { readonly title: string; readonly children: ReactNode; readonly last: string | null }) {
  return (
    <div className="grid gap-2 border-b py-4 first:pt-0 last:border-b-0 last:pb-0">
      <p className="font-medium">{title}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {last !== null && <p className="text-[13px] text-pretty text-muted-foreground">{last}</p>}
    </div>
  );
}

export function Sandbox({ board }: { readonly board: Board }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries();
  const onError = (error: { message: string }) => toast.error(error.message);

  const open = board.cases.filter((item) => item.kind !== "closed");
  const booked = open.filter((item) => item.kind === "awaiting-attendance");
  const [fitPatient, setFitPatient] = useState<string>("");
  const [procedureCase, setProcedureCase] = useState<string>("");
  const [variant, setVariant] = useState<Variant>("completed");
  const [appointmentCase, setAppointmentCase] = useState<string>("");
  const [attendance, setAttendance] = useState<"noshow" | "fulfilled">("noshow");
  const [last, setLast] = useState<{ readonly fit: string | null; readonly procedure: string | null; readonly appointment: string | null }>({ fit: null, procedure: null, appointment: null });

  const patient = board.idlePatients.find((item) => item.ref === fitPatient) ?? board.idlePatients[0];
  const targetCase = open.find((item) => item.id === procedureCase) ?? open[0];
  const bookedCase = booked.find((item) => item.id === appointmentCase) ?? booked[0];
  const bookedDetail = useQuery(trpc.case.queryOptions({ caseId: bookedCase?.id ?? "case-000000000000" }, { enabled: bookedCase !== undefined }));
  const appointmentRef = bookedCase === undefined ? null : (bookedDetail.data?.appointment?.ref ?? null);

  const advance = useMutation(
    trpc.advanceClock.mutationOptions({
      onSuccess: (result, input) => {
        void refresh();
        toast.success(`Skipped ${fmtSpan(input.hours * 3_600_000)}`, { description: result.deadlinesFired === 0 ? "No deadline passed." : `${result.deadlinesFired} ${result.deadlinesFired === 1 ? "case had a deadline" : "cases had deadlines"} pass. See the worklist.` });
      },
      onError,
    }),
  );
  /** After a record is posted: refresh, and say under that feed what the engine did with it. */
  const posted = (feed: keyof typeof last) => ({
    onSuccess: (outcome: IngestOutcome) => {
      void refresh();
      setLast((previous) => ({ ...previous, [feed]: describeOutcome(outcome).text }));
    },
    onError,
  });
  const postFit = useMutation(trpc.postFit.mutationOptions(posted("fit")));
  const postProcedure = useMutation(trpc.postProcedure.mutationOptions(posted("procedure")));
  const postAppointment = useMutation(trpc.postAppointmentStatus.mutationOptions(posted("appointment")));
  const reset = useMutation(
    trpc.reset.mutationOptions({
      onSuccess: () => {
        void refresh();
        setLast({ fit: null, procedure: null, appointment: null });
        toast.success("Sandbox data rebuilt");
      },
      onError,
    }),
  );

  const now = board.now;
  const offset = board.clockOffsetMs;
  const deadlines = open.flatMap((item) => (item.due === null ? [] : [{ ...item, due: item.due }])).sort((a, b) => a.due - b.due);

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Simulator"
        description="A deployment is fed by a laboratory, by endoscopy units, and by real days going by. This sandbox is connected to none of them, so this page plays their parts. Nothing on it exists in a deployment."
      />

      <Panel title="Time" description="Deadlines are measured on the sandbox clock. Skipping it forward shows what happens when nobody acts.">
        <div className="grid grid-cols-1 gap-5">
          <Fields>
            <Field label="Sandbox time">
              <span className="tabular-nums">{fmtDateTime(now)} GST</span>
            </Field>
            <Field label="Compared with now">{offset > 0 ? <span className="text-warn">{fmtSpan(offset)} ahead of real time</span> : "The same as real time"}</Field>
          </Fields>
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              {SKIPS.map((skip) => {
                const passing = deadlines.filter((deadline) => deadline.due <= now + skip.hours * 3_600_000).length;
                return (
                  <Button key={skip.hours} variant="outline" disabled={advance.isPending} onClick={() => advance.mutate({ hours: skip.hours })}>
                    {skip.label}
                    <span className="text-muted-foreground tabular-nums">· {passing === 0 ? "no deadline passes" : `${passing} ${passing === 1 ? "deadline passes" : "deadlines pass"}`}</span>
                  </Button>
                );
              })}
            </div>
            <p className="max-w-[78ch] text-[13px] text-pretty text-muted-foreground">
              Every deadline that falls inside the skip fires in order: the case stays open, is raised one level, and its clock restarts. A booked appointment does not happen by itself when time is skipped; the provider's record
              has to arrive, which you send below.
            </p>
          </div>
          {deadlines.length > 0 && (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-3">Open case</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead className="pr-3">Raised</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deadlines.map((deadline) => (
                    <TableRow key={deadline.id} className="hover:bg-transparent">
                      <TableCell className="pl-3">
                        <a className="underline-offset-2 hover:underline" href={consoleHref("case", deadline.id)}>
                          {deadline.patient.name}
                        </a>
                      </TableCell>
                      <TableCell>{STAGE_LABEL[deadline.kind]}</TableCell>
                      <TableCell className="tabular-nums">
                        {deadline.due <= now ? <span className="text-crit">Passed {fmtSpan(now - deadline.due)} ago</span> : `In ${fmtSpan(deadline.due - now)}`}
                      </TableCell>
                      <TableCell className="pr-3 text-muted-foreground tabular-nums">{deadline.escalation === 0 ? "Not raised" : `Level ${deadline.escalation} of 3`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Records from other systems" description="Each button posts a FHIR resource through the same endpoint a real system would use.">
        <Feed title="A laboratory reports a positive FIT" last={last.fit}>
          {patient === undefined ? (
            <p className="text-[13px] text-muted-foreground">Every synthetic patient already has an open case.</p>
          ) : (
            <>
              <Select value={patient.ref} onValueChange={setFitPatient}>
                <SelectTrigger className="w-[14rem]" aria-label="Patient">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {board.idlePatients.map((item) => (
                    <SelectItem key={item.ref} value={item.ref}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" disabled={postFit.isPending} onClick={() => postFit.mutate({ patient: patient.ref })}>
                Post the result
              </Button>
            </>
          )}
        </Feed>

        <Feed title="An endoscopy unit reports a procedure" last={last.procedure}>
          {targetCase === undefined ? (
            <p className="text-[13px] text-muted-foreground">There is no open case to send a record for.</p>
          ) : (
            <>
              <Select value={targetCase.id} onValueChange={setProcedureCase}>
                <SelectTrigger className="w-[14rem]" aria-label="Case">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {open.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.patient.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={variant} onValueChange={(value) => setVariant(VARIANTS.find((item) => item.value === value)?.value ?? "completed")}>
                <SelectTrigger className="w-[22rem] max-w-full" aria-label="Which record">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VARIANTS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" disabled={postProcedure.isPending} onClick={() => postProcedure.mutate({ caseId: targetCase.id, variant })}>
                Post the record
              </Button>
              <span className="text-[13px] text-muted-foreground">{VARIANTS.find((item) => item.value === variant)?.expect}</span>
            </>
          )}
        </Feed>

        <Feed title="A provider updates a booked appointment" last={last.appointment}>
          {bookedCase === undefined ? (
            <p className="text-[13px] text-muted-foreground">No case has a booked appointment.</p>
          ) : (
            <>
              <Select value={bookedCase.id} onValueChange={setAppointmentCase}>
                <SelectTrigger className="w-[14rem]" aria-label="Case with an appointment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {booked.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.patient.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={attendance} onValueChange={(value) => setAttendance(value === "fulfilled" ? "fulfilled" : "noshow")}>
                <SelectTrigger className="w-[14rem]" aria-label="What happened">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="noshow">The patient did not attend</SelectItem>
                  <SelectItem value="fulfilled">The patient attended</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" disabled={postAppointment.isPending || appointmentRef === null} onClick={() => appointmentRef !== null && postAppointment.mutate({ appointment: appointmentRef, status: attendance })}>
                Post the update
              </Button>
            </>
          )}
        </Feed>
      </Panel>

      <Panel title="Start again" description="Erase every case, call and event, and rebuild the seeded history. The sandbox clock returns to real time.">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline" disabled={reset.isPending}>
              {reset.isPending ? "Rebuilding" : "Reset sandbox data"}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reset the sandbox?</DialogTitle>
              <DialogDescription>Every case, call record and event is erased and the seeded history is rebuilt. Cached voice audio and stored chart reviews are kept. This cannot be undone.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="destructive" onClick={() => reset.mutate()}>
                  Reset
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Panel>
    </div>
  );
}
