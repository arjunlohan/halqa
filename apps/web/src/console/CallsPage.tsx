// Every call the agent has placed, newest first. Picking one opens its record beside the list.
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, LANGUAGE_LABEL } from "../format.js";
import { consoleHref, navigate } from "../router.js";
import { useTRPC } from "../trpc.js";
import { callLength, CallRecordSheet, callStatus, CHANNEL_LABEL } from "./CallRecord.js";
import { CopyId, Empty, PageHeader, Status } from "./ui.js";

export function CallsPage({ selected }: { readonly selected: string | null }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.calls.queryOptions(undefined, { refetchInterval: 3000 }));
  const calls = query.data?.calls ?? [];
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title="Calls"
        description="Every call the agent has placed. A web call is one placed from this console with a person playing the patient: the sandbox has no phone line. Scripted history is the seeded past, replayed through the same engine."
      />
      <div className="rounded-xl border bg-card">
        {query.data === undefined ? (
          <Empty title={query.isError ? "Calls could not be loaded" : "Loading"} />
        ) : calls.length === 0 ? (
          <Empty title="No calls yet">Open a case on the worklist and place the outreach call.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Started (GST)</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>How it ended</TableHead>
                <TableHead className="pr-4">Call ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.map((call) => {
                const status = callStatus(call);
                return (
                  <TableRow key={call.id} className="cursor-pointer" data-state={call.id === selected ? "selected" : undefined} onClick={() => navigate(consoleHref("calls", call.id))}>
                    <TableCell className="py-3 pl-4 tabular-nums">{fmtDateTime(call.startedAt)}</TableCell>
                    <TableCell className="py-3 font-medium">{call.patient?.name ?? "Unknown"}</TableCell>
                    <TableCell className="py-3 tabular-nums">{callLength(call)}</TableCell>
                    <TableCell className="py-3">{CHANNEL_LABEL[call.channel] ?? call.channel}</TableCell>
                    <TableCell className="py-3">{LANGUAGE_LABEL[call.lang] ?? call.lang}</TableCell>
                    <TableCell className="py-3 whitespace-normal">
                      <Status tone={status.tone}>{status.text}</Status>
                    </TableCell>
                    <TableCell className="py-3 pr-4">
                      <CopyId value={call.id} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">{calls.length} calls</p>
      <CallRecordSheet callId={selected} onClose={() => navigate(consoleHref("calls"))} />
    </div>
  );
}
