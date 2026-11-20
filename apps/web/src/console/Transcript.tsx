// A call, turn by turn. Each agent line can be opened to see why that line was said: the stage the
// case was in, the lines allowed there, what chose this one and how long it took.
import { cn } from "cn";
import { ACT_LABEL, fmtDuration, STAGE_LABEL } from "../format.js";
import type { AgentTurn, Turn } from "../trpc.js";
import { Disclosure, Fields, Field, Said } from "./ui.js";

const chooser = (by: string): string => (by === "engine" ? "A fixed engine rule" : by.startsWith("rules") ? `The rules policy (${by})` : `The model policy (${by})`);

function Why({ turn, responseMs }: { readonly turn: AgentTurn; readonly responseMs: number | undefined }) {
  const { trace, speech } = turn;
  return (
    <Fields className="max-w-[70ch] text-[13px]">
      <Field label="Case stage">{STAGE_LABEL[trace.state]}</Field>
      <Field label="Allowed here">
        <ul className="grid gap-0.5">
          {trace.legal.map((act) => {
            const held = !trace.offered.includes(act);
            return (
              <li key={act} className={cn(act === trace.chosen ? "text-foreground" : held ? "line-through decoration-muted-foreground/50" : undefined)}>
                {ACT_LABEL[act] ?? act}
                {act === trace.chosen && " (said)"}
                {held && <span className="no-underline"> (held back by a guard)</span>}
              </li>
            );
          })}
        </ul>
      </Field>
      <Field label="Chosen by">
        {chooser(trace.by)}
        {trace.decideMs !== null && <span className="tabular-nums"> in {trace.decideMs < 1 ? "under 1" : Math.round(trace.decideMs)} ms</span>}
      </Field>
      {trace.note !== null && <Field label="Note">{trace.note}</Field>}
      <Field label="Script line">
        <span className="font-mono text-xs">
          {turn.act} · {turn.catalogue}
        </span>
      </Field>
      <Field label="Voice">
        {speech === null ? (
          "No audio was requested for this line"
        ) : (
          <span className="tabular-nums">
            {speech.voice}, {speech.cached ? `played from cache in ${speech.ms} ms` : `synthesised in ${speech.ms} ms`}, {speech.characters} characters
          </span>
        )}
      </Field>
      {responseMs !== undefined && (
        <Field label="Reply to audio">
          <span className="tabular-nums">{(responseMs / 1000).toFixed(1)} s from the reply being sent to the first sound, measured in this browser</span>
        </Field>
      )}
    </Fields>
  );
}

export function Transcript({
  turns,
  startedAt,
  timed,
  responseMs = {},
}: {
  readonly turns: readonly Turn[];
  readonly startedAt: number;
  /** False for scripted history, where every turn happened in the same instant. */
  readonly timed: boolean;
  readonly responseMs?: Readonly<Record<number, number>>;
}) {
  return (
    <ol className="grid gap-4">
      {turns.map((turn) => (
        <li key={turn.idx} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3">
          <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">{timed ? fmtDuration(turn.at - startedAt) : ""}</span>
          {turn.speaker === "patient" ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Patient</p>
              {turn.text === null ? (
                <p className="text-muted-foreground italic">Answer to the identity question. Checked against the record, not stored.</p>
              ) : (
                <Said lang={turn.lang} className="text-foreground/90">
                  {turn.text}
                </Said>
              )}
            </div>
          ) : (
            <div className="min-w-0">
              <p className="text-xs font-medium text-primary">
                Agent <span className="font-normal text-muted-foreground">· {ACT_LABEL[turn.act] ?? turn.act}</span>
              </p>
              <Said lang={turn.lang} className={turn.act === "emergency-guidance" ? "text-crit" : undefined}>
                {turn.text}
              </Said>
              {turn.gloss !== null && <p className="mt-1 text-[13px] text-muted-foreground">{turn.gloss}</p>}
              <Disclosure title="Why this line" className="mt-1">
                <Why turn={turn} responseMs={responseMs[turn.idx]} />
              </Disclosure>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
