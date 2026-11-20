// Where the rules are set. Each page shows the definitions the engine is running on right now,
// read from the same typed source, and says where that source lives and how it changes.
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ACT_LABEL, STAGE_LABEL, type StateKind } from "../format.js";
import { useTRPC, type Config } from "../trpc.js";
import { Disclosure, Empty, Field, Fields, PageHeader, Panel, Said, Status } from "./ui.js";

export type SettingsSection = "pathway" | "script" | "guardrails" | "models" | "data" | "team";

export const SETTINGS_SECTIONS: readonly { readonly id: SettingsSection; readonly label: string }[] = [
  { id: "pathway", label: "Pathway rules" },
  { id: "script", label: "Agent script" },
  { id: "guardrails", label: "Guardrails" },
  { id: "models", label: "Voice and models" },
  { id: "data", label: "Data and integrations" },
  { id: "team", label: "Team" },
];

const Code = ({ children }: { readonly children: ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground/85">{children}</code>;

/** Where a page's rules live and how they change. The same note sits at the top of every configuration page. */
function Source({ file, children }: { readonly file: string; readonly children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed px-4 py-3 text-[13px] text-pretty text-muted-foreground">
      <span className="font-medium text-foreground">Where this is set: </span>
      <Code>{file}</Code>. {children}
    </div>
  );
}

const allowance = (hours: number): string => (hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : `${hours} hours`);
const SLA_SOURCE: Readonly<Record<string, string>> = {
  "doh-standard": "Abu Dhabi standard: 31 days from referral to colonoscopy",
  assumption: "Working assumption, to be agreed with the programme",
};
const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function Pathway({ config }: { readonly config: Config }) {
  const { pathway } = config;
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Pathway rules" description={`${pathway.title}. These rules decide when a case opens, how long each stage may take, who is told when time runs out, and what closes a case.`} />
      <Source file="packages/pathways/src/index.ts">
        One typed definition per pathway. The engine and this page both read it, so what you see here is what runs. A pathway that leaves out a stage's deadline does not compile. Rules change by editing that file and shipping a
        new version after clinical sign-off; this console shows them and does not edit them.
      </Source>

      <Panel title="What opens a case" description={`A final ${pathway.trigger.resource} with one of these codes and an interpretation of ${pathway.trigger.interpretation.join(" or ")}. Nobody has to notice the result.`} bodyClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">LOINC code</TableHead>
              <TableHead className="pr-4">Test</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pathway.trigger.codes.map((code) => (
              <TableRow key={code.code} className="hover:bg-transparent">
                <TableCell className="pl-4 font-mono text-xs">{code.code}</TableCell>
                <TableCell className="pr-4 whitespace-normal">{code.display}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel title="Stage deadlines" description="Each open stage has a time allowance. The deadline is stored on the case, so it survives a restart." bodyClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Stage</TableHead>
              <TableHead>Time allowed</TableHead>
              <TableHead className="pr-4">Where the number comes from</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pathway.stages.map((stage) => (
              <TableRow key={stage.state} className="hover:bg-transparent">
                <TableCell className="pl-4">{STAGE_LABEL[stage.state as StateKind]}</TableCell>
                <TableCell className="tabular-nums">{allowance(stage.hours)}</TableCell>
                <TableCell className="pr-4 whitespace-normal text-muted-foreground">{SLA_SOURCE[stage.source] ?? stage.source}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel title="When a deadline passes" description="The case stays open, the clock restarts, and the case is raised one level. Each level tells one more person.">
        <ol className="grid gap-2">
          {pathway.escalation.map((step) => (
            <li key={step.level} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3">
              <span className="text-muted-foreground tabular-nums">Level {step.level}</span>
              <span className="first-letter:uppercase">{step.contact}</span>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="What closes a case">
        <div className="grid gap-3">
          <p className="text-pretty">
            A procedure record closes a case only if all four hold: it is for the same patient, its code is{" "}
            {pathway.closing.map((code) => (
              <span key={code.code}>
                {code.display} (<span className="font-mono text-xs">SNOMED {code.code}</span>)
              </span>
            ))}
            , its status is completed, and it was performed after the result. Anything else is refused and the case stays open.
          </p>
          <p className="text-pretty text-muted-foreground">Otherwise only a clinician can close a case, with a reason and a note of at least 20 characters. The voice agent has no way to close one.</p>
        </div>
      </Panel>

      <Panel title="Limits on chasing the patient">
        <Fields>
          <Field label="Call attempts">
            <span className="tabular-nums">At most {pathway.outreach.maxAttempts}</span>
          </Field>
          <Field label="Quiet hours">
            <span className="tabular-nums">
              No calls between {String(pathway.outreach.quietHours[0]).padStart(2, "0")}:00 and {String(pathway.outreach.quietHours[1]).padStart(2, "0")}:00
            </span>
          </Field>
          <Field label="Status">
            <Status tone="warn">Defined in the pathway, not yet enforced by the call button in this prototype</Status>
          </Field>
        </Fields>
      </Panel>
    </div>
  );
}

function Script({ config }: { readonly config: Config }) {
  const { script } = config;
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Agent script" description="Everything the agent can say to a patient. It never composes a sentence: it picks one of these lines, and the wording here is what is spoken." />
      <Source file="packages/catalogue/src/index.ts">
        Script <Code>{script.id}</Code> version {script.version}. Every call record names the script version each line came from, so the exact words can be rebuilt later without keeping audio.
      </Source>
      <div className="rounded-xl border bg-card px-4 py-3">
        <Status tone="warn">Not clinically approved</Status>
        <p className="mt-1 pl-3.5 text-[13px] text-pretty text-muted-foreground">
          This wording was written by the build team for a prototype on synthetic data. It needs review by a clinician and by a native Arabic speaker before any patient hears it. The Arabic uses masculine forms throughout.
        </p>
      </div>
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[13rem] pl-4">Line</TableHead>
              <TableHead>English</TableHead>
              <TableHead className="pr-4">Arabic</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {script.lines.map((line) => (
              <TableRow key={`${line.act}-${line.variant ?? ""}`} className="align-top hover:bg-transparent">
                <TableCell className="py-3 pl-4 whitespace-normal">
                  <span className="font-medium">{ACT_LABEL[line.act] ?? line.act}</span>
                  {line.variant !== null && <span className="block text-xs text-muted-foreground">{line.variant.replaceAll("-", " ")}</span>}
                </TableCell>
                <TableCell className="py-3 whitespace-normal text-pretty">{line.en}</TableCell>
                <TableCell className="py-3 pr-4 whitespace-normal">
                  <Said lang="ar">{line.ar}</Said>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SelfTest() {
  const trpc = useTRPC();
  const board = useQuery(trpc.board.queryOptions());
  const target = board.data?.cases.find((item) => item.kind !== "closed");
  const attack = useMutation(trpc.attackAgentClose.mutationOptions({ onError: (error) => toast.error(error.message) }));
  const result = attack.data;
  return (
    <Panel
      title="Self-test: can an agent close a case?"
      description="Runs for real, against an open case, at three layers. Nothing is mocked. The test passes when every layer refuses."
      action={
        <Button variant="outline" size="sm" disabled={attack.isPending || target === undefined} onClick={() => target !== undefined && attack.mutate({ caseId: target.id })}>
          {attack.isPending ? "Running" : "Run the self-test"}
        </Button>
      }
    >
      {target === undefined ? (
        <p className="text-[13px] text-muted-foreground">There is no open case to test against. Post a positive FIT from the Simulator first.</p>
      ) : result === undefined ? (
        <p className="text-[13px] text-pretty text-muted-foreground">
          The test writes code in which an agent's tool handler closes {target.patient.name}'s case, then tries it three ways: compiling it, passing it through the tool handler's input check, and handing forged close events to the
          kernel. It takes a few seconds because it runs the TypeScript compiler.
        </p>
      ) : (
        <div className="grid gap-3">
          {result.layers.map((layer) => (
            <div key={layer.layer} className="grid gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{layer.title}</span>
                <Status tone={layer.rejected ? "good" : "crit"}>{layer.rejected ? "Refused" : "Accepted: the guarantee is broken"}</Status>
              </div>
              <p className="text-[13px] text-muted-foreground">{layer.attempt}</p>
              <Disclosure title="Output">
                <pre className="overflow-x-auto rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">{layer.output}</pre>
              </Disclosure>
            </div>
          ))}
          <p className="border-t pt-3 text-[13px] text-muted-foreground">
            After the test the case is still {STAGE_LABEL[result.stateAfter as StateKind]?.toLowerCase() ?? result.stateAfter} and its record {result.chainIntact ? "passes" : "fails"} the tamper check.
          </p>
        </div>
      )}
    </Panel>
  );
}

function Guardrails({ config }: { readonly config: Config }) {
  const { pathway, guardrails } = config;
  const acts = [...new Set(pathway.stages.flatMap((stage) => stage.acts))];
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Guardrails" description="What the agent cannot do, and what stops it. Three layers: rules about cases that the code cannot break, a table of lines allowed at each stage, and checks that run on every reply before any choice is made." />
      <Source file="packages/kernel/src/kernel.ts and packages/voice/src/engine.ts">
        The case rules and the allowed-lines table are in the kernel, which is proven by type-level tests and property tests on every build. The per-reply checks and their limits are in the call engine.
      </Source>

      <Panel title="Three rules the code cannot break">
        <ol className="grid gap-2.5">
          <li className="grid grid-cols-[1.5rem_minmax(0,1fr)]">
            <span className="text-muted-foreground tabular-nums">1</span>
            <span className="text-pretty">A case is closed only with evidence: a record of completed care, or a clinician's decision with a reason.</span>
          </li>
          <li className="grid grid-cols-[1.5rem_minmax(0,1fr)]">
            <span className="text-muted-foreground tabular-nums">2</span>
            <span className="text-pretty">Every open case has a human owner and a deadline. There is no open state without both.</span>
          </li>
          <li className="grid grid-cols-[1.5rem_minmax(0,1fr)]">
            <span className="text-muted-foreground tabular-nums">3</span>
            <span className="text-pretty">An agent can neither close a case nor own one. The types give it no way to say so.</span>
          </li>
        </ol>
      </Panel>

      <SelfTest />

      <Panel title="Lines allowed at each stage" description="The agent chooses from the column for the case's current stage and nothing else. A hand-off and emergency guidance are always available." bodyClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Line</TableHead>
              {pathway.stages.map((stage) => (
                <TableHead key={stage.state} className="max-w-[8rem] text-center whitespace-normal">
                  {STAGE_LABEL[stage.state as StateKind]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {acts.map((act) => (
              <TableRow key={act} className="hover:bg-transparent">
                <TableCell className="pl-4">{ACT_LABEL[act] ?? act}</TableCell>
                {pathway.stages.map((stage) => (
                  <TableCell key={stage.state} className="text-center">
                    {stage.acts.includes(act) ? <Check className="mx-auto size-4 text-primary" aria-label="Allowed" /> : <span className="sr-only">Not allowed</span>}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>

      <Panel title="Checks on every reply" description="These run in order, before anything chooses a line. They hold whichever policy is choosing.">
        <ol className="grid gap-4">
          <li className="grid gap-1">
            <span className="font-medium">Possible emergency</span>
            <p className="text-[13px] text-pretty text-muted-foreground">If the reply matches the red-flag list, the agent gives emergency guidance, raises an urgent hand-off and stops talking. The policy is not consulted. The list is tuned to over-trigger.</p>
            <Disclosure title={`The red-flag list (${guardrails.redFlags.ar.length} Arabic phrases and an English pattern)`}>
              <div className="grid gap-3">
                <div dir="rtl" lang="ar" className="flex flex-wrap gap-x-4 gap-y-1 text-foreground/85">
                  {guardrails.redFlags.ar.map((phrase) => (
                    <span key={phrase}>{phrase}</span>
                  ))}
                </div>
                <pre className="overflow-x-auto rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">{guardrails.redFlags.en}</pre>
              </div>
            </Disclosure>
          </li>
          <li className="grid gap-1">
            <span className="font-medium">Identity before any result</span>
            <p className="text-[13px] text-pretty text-muted-foreground">
              The result is not offered as a line until the reply to the identity question matches two identifiers on record: the birth year and the last four digits of the ID. After {guardrails.limits.identityAttempts} failed attempts
              the agent offers a call back and hands off. The answer is checked in memory, never stored, and never sent to a model.
            </p>
          </li>
          <li className="grid gap-1">
            <span className="font-medium">Understanding, in the patient's words</span>
            <p className="text-[13px] text-pretty text-muted-foreground">After the result the patient is asked to say what happens next. If they cannot after {guardrails.limits.teachBackAttempts} tries, the agent hands off to a person.</p>
          </li>
          <li className="grid gap-1">
            <span className="font-medium">No loops</span>
            <p className="text-[13px] text-pretty text-muted-foreground">The same line is never said more than {guardrails.limits.sameActInARow} times in a row. The agent hands off instead.</p>
          </li>
          <li className="grid gap-1">
            <span className="font-medium">Every choice is checked</span>
            <p className="text-[13px] text-pretty text-muted-foreground">Whatever picks the line, the pick is checked against the allowed list before anything is said. A pick that is missing or not allowed falls back to the rules policy, then to a hand-off.</p>
          </li>
        </ol>
      </Panel>
    </div>
  );
}

function Models({ config }: { readonly config: Config }) {
  const { models, script } = config;
  const rulesPolicy = models.policy.startsWith("rules");
  const rows: readonly { readonly stage: string; readonly here: ReactNode; readonly deployed: string }[] = [
    { stage: "The line", here: "None. The call runs inside this browser, with a person playing the patient.", deployed: "A SIP trunk from the institution's telephony, with caller ID and answering-machine detection." },
    { stage: "Hearing the patient", here: "This browser's speech recognition, or typed text. The engine receives text only.", deployed: "A streaming speech-to-text service hosted in region." },
    {
      stage: "Choosing the line",
      here: rulesPolicy ? (
        <>
          The rules policy (<Code>{models.policy}</Code>): fixed rules, no model. The model policy ({models.policyModel}) picks from the same allowed list and is switched on with an API key and <Code>HALQA_BRAIN=claude</Code>.
        </>
      ) : (
        <>
          The model policy (<Code>{models.policy}</Code>), picking from the allowed list. The rules policy takes over if its pick is missing or not allowed.
        </>
      ),
      deployed: "The same. The allowed list and the checks do not depend on which policy picks.",
    },
    { stage: "The words", here: `Script ${script.id} version ${script.version}. The agent's words are never generated.`, deployed: "The same, after clinical approval." },
    { stage: "The voice", here: `${models.voice}. Each line is synthesised once, then replayed from a cache on the server.`, deployed: "The same, or audio recorded ahead of time for every line, since the script is a closed set." },
    { stage: "Turn-taking", here: "None. The agent speaks, then waits for a reply. It does not handle being interrupted.", deployed: "Voice activity detection, end-of-turn detection and barge-in handling." },
    { stage: "Recording", here: "No audio is kept. The call record holds script entries and redacted text.", deployed: "As the institution's policy requires." },
  ];
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Voice and models" description="What runs on a call, part by part: what this sandbox uses, and what a deployment would put in its place." />
      <Source file=".env">
        At the repository root. <Code>ELEVENLABS_API_KEY</Code> turns on the synthesised voice, <Code>HALQA_BRAIN=claude</Code> with <Code>ANTHROPIC_API_KEY</Code> turns on the model policy and live chart reviews. Keys stay on the server and never reach
        the browser.
      </Source>
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[11rem] pl-4">Part of the call</TableHead>
              <TableHead>In this sandbox</TableHead>
              <TableHead className="pr-4">In a deployment</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.stage} className="align-top hover:bg-transparent">
                <TableCell className="py-3 pl-4 font-medium">{row.stage}</TableCell>
                <TableCell className="py-3 whitespace-normal text-pretty">{row.here}</TableCell>
                <TableCell className="py-3 pr-4 whitespace-normal text-pretty text-muted-foreground">{row.deployed}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Panel title="Models in use">
        <Fields>
          <Field label="Choosing lines">{rulesPolicy ? "No model. Fixed rules." : models.policy}</Field>
          <Field label="Chart review">
            {models.reviewModel}.{" "}
            {models.storedReviews === null ? "No stored reviews." : `The reviews shipped with the sandbox were written by ${models.storedReviews.model} on ${models.storedReviews.generatedOn}.`}{" "}
            {models.liveReview ? "Live reviews are on." : "Live reviews are off: no API key on the server."}
          </Field>
          <Field label="Model calls logged">
            <span className="tabular-nums">{models.modelCalls}</span>. Each is logged by a hash of its prompt, never the prompt text.
          </Field>
        </Fields>
      </Panel>
    </div>
  );
}

function Data({ config }: { readonly config: Config }) {
  const { data } = config;
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Data and integrations" description="Where records come from, what is stored, what is kept about a call, and what leaves the building." />
      <Source file="apps/api/src/server.ts and packages/runtime/src/runtime.ts">The FHIR endpoints and the store. Every resource is parsed against a schema on the way in or refused.</Source>

      <Panel title="Where records come from" description="Laboratories and providers post FHIR R4 resources. In this sandbox nothing is connected; the Simulator page posts through the same door.">
        <ul className="grid gap-2 font-mono text-xs">
          <li>
            POST /fhir/Observation <span className="font-sans text-[13px] text-muted-foreground">· a result. A positive FIT opens a case.</span>
          </li>
          <li>
            POST /fhir/Procedure <span className="font-sans text-[13px] text-muted-foreground">· care that happened. A completed colonoscopy can close a case.</span>
          </li>
          <li>
            POST /fhir/Appointment <span className="font-sans text-[13px] text-muted-foreground">· a status change. A no-show sends the case back for booking.</span>
          </li>
          <li>
            GET /fhir/Task/&#123;case id&#125; <span className="font-sans text-[13px] text-muted-foreground">· a case, readable by any FHIR client.</span>
          </li>
        </ul>
      </Panel>

      <Panel title="What is stored">
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Fields>
            {data.resources.map((resource) => (
              <Field key={resource.type} label={resource.type}>
                <span className="tabular-nums">{resource.count}</span>
              </Field>
            ))}
          </Fields>
          <Fields>
            <Field label="Cases">
              <span className="tabular-nums">{data.cases}</span>
            </Field>
            <Field label="Case events">
              <span className="tabular-nums">{data.events}</span>
            </Field>
            <Field label="Tamper check">
              <Status tone={data.chainsIntact === data.cases ? "good" : "crit"}>
                {data.chainsIntact} of {data.cases} case records pass
              </Status>
            </Field>
          </Fields>
        </div>
      </Panel>

      <Panel title="What is kept about a call">
        <ul className="grid max-w-[78ch] list-disc gap-1.5 pl-4 text-pretty">
          <li>The agent's side: which script line, which version, which language and which appointment values. The words are rebuilt from those. No audio.</li>
          <li>The patient's replies: as text, with any run of four or more digits removed.</li>
          <li>The answer to the identity question: never stored.</li>
          <li>A reply that matched the red-flag list, and the patient's answer to the understanding check: kept in full, for clinical review.</li>
        </ul>
      </Panel>

      <Panel title="What leaves the building" description="All data here is synthetic. In a deployment each of these needs an endpoint in region or an agreement with the provider.">
        <ul className="grid max-w-[78ch] list-disc gap-1.5 pl-4 text-pretty">
          <li>To the voice provider: the text of a script line. It holds no patient details beyond an appointment time and place.</li>
          <li>To the model, for a chart review: the chart with a birth year and a sex, without name, MRN or national ID.</li>
          <li>To the model, when the model policy is on: the patient's reply with all digits removed, and the list of allowed lines.</li>
        </ul>
      </Panel>
    </div>
  );
}

function Team({ config }: { readonly config: Config }) {
  const { staff, pathway } = config;
  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader title="Team" description="Who works cases here, who is told when a deadline passes, and where colonoscopies are booked. Every name is invented." />
      <Source file="packages/runtime/src/directory.ts">The sandbox has no sign-in, so the header lets you act as any of these people. A deployment would take identity and role from the institution's directory.</Source>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="Care navigators" description="Own cases, place calls, book, and record what they did by phone.">
          <ul className="grid gap-1.5">
            {staff.navigators.map((person) => (
              <li key={person.ref}>{person.name}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="Screening clinicians" description="Everything a navigator can do, and two things only they can: close a case without a colonoscopy, and record that a chart review was checked.">
          <ul className="grid gap-1.5">
            {staff.clinicians.map((person) => (
              <li key={person.ref}>{person.name}</li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel title="Who is told when a deadline passes">
        <ol className="grid gap-2">
          {pathway.escalation.map((step) => (
            <li key={step.level} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3">
              <span className="text-muted-foreground tabular-nums">Level {step.level}</span>
              <span className="first-letter:uppercase">{step.contact}</span>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Endoscopy providers" description="Weekday slots the agent and navigators can book. In a deployment these come from the providers' scheduling systems.">
        <Fields>
          {staff.providers.map((provider) => (
            <Field key={provider.key} label={provider.name}>
              <span className="tabular-nums">Slots at {provider.starts.map(clock).join(" and ")}</span>
            </Field>
          ))}
        </Fields>
      </Panel>

      <Panel title="The voice agent">
        <p className="max-w-[78ch] text-pretty">It can tell a patient the result, check they understood, and book an appointment. It is not a member of the team: it cannot own a case and it cannot close one.</p>
      </Panel>
    </div>
  );
}

export function Settings({ section }: { readonly section: SettingsSection }) {
  const trpc = useTRPC();
  const query = useQuery(trpc.config.queryOptions(undefined, { refetchInterval: 10_000 }));
  const config = query.data;
  if (config === undefined) return <Empty title={query.isError ? "The configuration could not be loaded" : "Loading"} />;
  switch (section) {
    case "pathway":
      return <Pathway config={config} />;
    case "script":
      return <Script config={config} />;
    case "guardrails":
      return <Guardrails config={config} />;
    case "models":
      return <Models config={config} />;
    case "data":
      return <Data config={config} />;
    case "team":
      return <Team config={config} />;
  }
}
