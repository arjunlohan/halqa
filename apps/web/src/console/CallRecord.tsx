// A finished call as its record shows it: what it achieved, what the server measured, and the
// transcript. Opens beside whatever list it was picked from.
import { useQuery } from "@tanstack/react-query";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CALL_END_LABEL, fmtDateTime, fmtDuration, LANGUAGE_LABEL } from "../format.js";
import { consoleHref } from "../router.js";
import { useTRPC, type CallDetail, type CallRow } from "../trpc.js";
import { Transcript } from "./Transcript.js";
import { CopyId, Disclosure, Empty, Field, Fields, Status } from "./ui.js";

export const CHANNEL_LABEL: Readonly<Record<string, string>> = { web: "Web call", scripted: "Scripted history" };

/** How a call stands or ended, in one phrase. */
export function callStatus(call: Pick<CallRow, "live" | "ended" | "endText">): { readonly text: string; readonly tone: "good" | "warn" | "crit" | "quiet" | "accent" } {
  if (call.live) return { text: "In progress", tone: "accent" };
  if (call.ended === null) return { text: "Interrupted", tone: "quiet" };
  const label = CALL_END_LABEL[call.ended] ?? call.ended;
  if (call.ended === "completed") return { text: label, tone: "good" };
  if (call.ended === "emergency") return { text: label, tone: "crit" };
  if (call.ended === "handed-off") return { text: call.endText === null ? label : `${label}: ${call.endText.charAt(0).toLowerCase()}${call.endText.slice(1)}`, tone: "warn" };
  return { text: label, tone: "quiet" };
}

export const callLength = (call: Pick<CallRow, "channel" | "startedAt" | "endedAt">): string =>
  call.channel === "scripted" ? "Not timed" : call.endedAt === null ? "" : fmtDuration(call.endedAt - call.startedAt);

/** What the call achieved. Each line is read from acts that ran on the call, not judged by a model. */
export function CallOutcome({ outcome }: { readonly outcome: CallRow["outcome"] }) {
  const understanding = {
    confirmed: { text: "Confirmed: the patient said what happens next", done: true },
    "confirmed-after-repeat": { text: "Confirmed after the result was said again", done: true },
    "not-confirmed": { text: "Asked, not confirmed", done: false },
    "not-asked": { text: "Not reached", done: false },
  }[outcome.understanding];
  const rows: readonly { readonly label: string; readonly text: string; readonly done: boolean }[] = [
    { label: "Identity", text: outcome.identity === "verified" ? "Confirmed with two identifiers" : "Not confirmed", done: outcome.identity === "verified" },
    { label: "Result", text: outcome.resultDelivered ? "Given to the patient" : "Not given", done: outcome.resultDelivered },
    { label: "Understanding", text: understanding.text, done: understanding.done },
    { label: "Colonoscopy", text: outcome.booked === null ? "Not booked on this call" : `Booked ${fmtDateTime(outcome.booked.at)} at ${outcome.booked.provider}`, done: outcome.booked !== null },
  ];
  return (
    <Fields>
      {rows.map((row) => (
        <Field key={row.label} label={row.label}>
          <Status tone={row.done ? "good" : "quiet"}>{row.text}</Status>
        </Field>
      ))}
    </Fields>
  );
}

function Measures({ call }: { readonly call: CallDetail }) {
  const m = call.measures;
  return (
    <Fields className="max-w-[70ch] text-[13px]">
      <Field label="Agent lines">
        <span className="tabular-nums">
          {m.agentTurns}, of which {m.forcedByEngine} were fixed by an engine rule and {m.decideCount} were chosen by the policy
        </span>
      </Field>
      <Field label="Time to choose">
        <span className="tabular-nums">{m.decideMedianMs === null ? "No choices made" : `${m.decideMedianMs < 1 ? "Under 1" : Math.round(m.decideMedianMs)} ms median over ${m.decideCount} choices`}</span>
      </Field>
      <Field label="Voice">
        <span className="tabular-nums">
          {m.spokenTurns === 0
            ? "No audio was requested"
            : `${m.spokenTurns} lines voiced, ${m.cacheHits} from cache${m.synthMedianMs === null ? "" : `, ${Math.round(m.synthMedianMs)} ms median to synthesise the rest`}`}
        </span>
      </Field>
      <Field label="Text spoken">
        <span className="tabular-nums">{m.characters} characters</span>
      </Field>
      <Field label="Not measured">There is no phone line in this sandbox, so there is no ring time, answer detection or audio recording.</Field>
    </Fields>
  );
}

export function CallRecordSheet({ callId, onClose }: { readonly callId: string | null; readonly onClose: () => void }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.callRecord.queryOptions({ callId: callId ?? "00000000-0000-4000-8000-000000000000" }, { enabled: callId !== null, refetchInterval: 3000 }));
  const call = callId === null ? undefined : query.data;
  const status = call === undefined ? null : callStatus(call);
  return (
    <Sheet open={callId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>{call?.patient == null ? "Call" : `Call with ${call.patient.name}`}</SheetTitle>
          <SheetDescription>{call === undefined ? "Loading the call record" : `${fmtDateTime(call.startedAt)} GST · ${CHANNEL_LABEL[call.channel] ?? call.channel}`}</SheetDescription>
        </SheetHeader>
        {call === undefined || status === null ? (
          <Empty title={query.isError ? "This call could not be loaded" : "Loading"} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid gap-5 px-5 py-5">
              <Fields>
                <Field label="Status">
                  <Status tone={status.tone}>{status.text}</Status>
                </Field>
                <Field label="Length">
                  <span className="tabular-nums">{callLength(call) || "Still running"}</span>
                </Field>
                <Field label="Language">{LANGUAGE_LABEL[call.lang] ?? call.lang}</Field>
                <Field label="Call ID">
                  <CopyId value={call.id} />
                </Field>
                <Field label="Case">
                  <a className="underline underline-offset-2 hover:text-primary" href={consoleHref("case", call.caseId)}>
                    Open the case
                  </a>
                </Field>
              </Fields>
              <Separator />
              <div className="grid gap-3">
                <h3 className="text-sm font-semibold">What the call achieved</h3>
                <CallOutcome outcome={call.outcome} />
              </div>
              <Disclosure title="What the server measured">
                <Measures call={call} />
              </Disclosure>
              <Separator />
              <div className="grid gap-3">
                <h3 className="text-sm font-semibold">Transcript</h3>
                <p className="text-[13px] text-muted-foreground">
                  The agent's words are rebuilt from the script entry it used; no audio is kept. The patient's replies are kept as text with long numbers removed.
                </p>
                <Transcript turns={call.turnList} startedAt={call.startedAt} timed={call.channel !== "scripted"} />
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
