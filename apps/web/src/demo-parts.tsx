// Pieces of the guided demo's case panel: the escalation dots, the progress steps and the timeline.
import { fmtDateTime, shortHash, STATES, STEP_LABEL } from "./format.js";
import { collapseTimeline } from "./timeline.js";
import type { CaseDetail } from "./trpc.js";

export function Escalation({ level }: { readonly level: number }) {
  return (
    <span className={`dots${level >= 3 ? " max" : ""}`} role="img" aria-label={`Escalation level ${level} of 3`}>
      {[1, 2, 3].map((step) => (
        <i key={step} className={step <= level ? "on" : undefined} />
      ))}
    </span>
  );
}

export function ProgressSteps({ kind }: { readonly kind: CaseDetail["summary"]["kind"] }) {
  const current = STATES.indexOf(kind);
  return (
    <ol className="stepper" aria-label="Case progress">
      {STATES.map((state, index) => (
        <li key={state} className={index < current ? "done" : index === current ? `now${state === "closed" ? " closed" : ""}` : undefined} aria-current={index === current ? "step" : undefined}>
          {STEP_LABEL[state]}
        </li>
      ))}
    </ol>
  );
}

export function Timeline({ detail }: { readonly detail: CaseDetail }) {
  const rows = collapseTimeline(detail.timeline);
  return (
    <section className="card" aria-labelledby="timeline-title">
      <div className="card-head">
        <h2 id="timeline-title">Timeline</h2>
        <span className="hint">newest first</span>
      </div>
      <div className="card-body">
        <ol className="timeline">
          {rows.map(({ item, count }) => (
            <li key={item.seq} className={`event${item.type === "closed" ? " closed" : ""}${item.type === "deadline-passed" || item.type === "appointment-missed" ? " loud" : ""}`}>
              <span className="title">
                {item.title}
                {count > 1 && <span className="num"> ×{count}</span>}
              </span>
              <span className="detail-text">{item.detail}</span>
              <span className="foot">
                <span className="num">{fmtDateTime(item.at)}</span>
                <span>{item.actor}</span>
                <span className="mono" title={`Event ${item.seq}. SHA-256 over the previous hash and this event: ${item.hash}`}>
                  #{item.seq} {shortHash(item.hash)}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <div className="chain">
          {detail.chain.ok ? (
            <>
              <span className="chip good">Hash chain verified</span>
              <span className="num">{detail.chain.length} events, each hashed over the one before</span>
            </>
          ) : (
            <span className="chip critical">Hash chain broken at event {detail.chain.atSeq}</span>
          )}
        </div>
      </div>
    </section>
  );
}
