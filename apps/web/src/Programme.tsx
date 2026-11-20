import { useQuery } from "@tanstack/react-query";
import { useState, type PointerEvent } from "react";
import { pct } from "./format.js";
import { useTRPC, type Arm, type Programme as ProgrammeData } from "./trpc.js";

// Colour follows the care model (three hues, validated on this surface); a full diary is the same hue, dashed.
const ARM_STYLE: Readonly<Record<Arm["id"], { readonly color: string; readonly dashed: boolean; readonly short: string }>> = {
  "baseline-abu-dhabi": { color: "var(--series-usual-ad)", dashed: false, short: "Usual care · Abu Dhabi" },
  "baseline-pooled": { color: "var(--series-usual)", dashed: false, short: "Usual care · pooled" },
  "halqa-central": { color: "var(--series-halqa)", dashed: false, short: "Halqa" },
  "baseline-pooled-capacity-bound": { color: "var(--series-usual)", dashed: true, short: "Usual care · full diary" },
  "halqa-capacity-bound": { color: "var(--series-halqa)", dashed: true, short: "Halqa · full diary" },
};

const DROP_OFF: readonly { readonly key: keyof Arm["dropOff"]; readonly label: string }[] = [
  { key: "unreachable", label: "Could not be reached" },
  { key: "declined", label: "Declined" },
  { key: "other", label: "Other, including never referred" },
  { key: "no-capacity", label: "No slot in the booking window" },
  { key: "did-not-attend", label: "Did not attend" },
  { key: "referral-rejected", label: "Referral rejected" },
  { key: "transferred", label: "Transferred" },
];

const LANGUAGES: readonly { readonly key: keyof Arm["byLanguage"]; readonly label: string }[] = [
  { key: "ar", label: "Arabic" },
  { key: "en", label: "English" },
  { key: "hi", label: "Hindi" },
  { key: "ur", label: "Urdu" },
];

function Swatch({ arm }: { readonly arm: Arm }) {
  const style = ARM_STYLE[arm.id];
  return <i className={`swatch${style.dashed ? " dashed" : ""}`} style={{ borderTopColor: style.color }} aria-hidden="true" />;
}

function BarCell({ count, total, done }: { readonly count: number; readonly total: number; readonly done?: boolean }) {
  const share = total === 0 ? 0 : (100 * count) / total;
  return (
    <span className={`barcell${done ? " done" : ""}`}>
      <i style={{ width: `${Math.max(share, 0.5)}%` }} />
      <b>{share.toFixed(1)}%</b>
    </span>
  );
}

// ───────────────────────── Completion curves ─────────────────────────
const W = 900;
const H = 380;
const M = { top: 18, right: 196, bottom: 36, left: 46 };
const Y_MAX = 80;
const X_TICKS = [0, 31, 90, 180, 270, 365];
const Y_TICKS = [0, 20, 40, 60, 80];

function CompletionChart({ arms, horizon }: { readonly arms: readonly Arm[]; readonly horizon: number }) {
  const [day, setDay] = useState<number | null>(null);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (d: number): number => M.left + (d / horizon) * plotW;
  const y = (share: number): number => M.top + plotH - (Math.min(share, Y_MAX) / Y_MAX) * plotH;
  const shareAt = (arm: Arm, d: number): number => (100 * (arm.completionCurve[d] ?? 0)) / arm.patients;

  const path = (arm: Arm): string => arm.completionCurve.map((count, d) => `${d === 0 ? "M" : "L"}${x(d).toFixed(1)},${y((100 * count) / arm.patients).toFixed(1)}`).join("");

  // End labels sit beside each line's last point, pushed apart where two lines finish close together.
  const ends = arms
    .map((arm) => ({ arm, share: shareAt(arm, horizon), at: y(shareAt(arm, horizon)) }))
    .sort((a, b) => a.at - b.at)
    .reduce<{ arm: Arm; share: number; at: number; labelAt: number }[]>((placed, end) => {
      const previous = placed.at(-1);
      placed.push({ ...end, labelAt: previous === undefined ? end.at : Math.max(end.at, previous.labelAt + 16) });
      return placed;
    }, []);

  const onMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setDay(Math.max(0, Math.min(horizon, Math.round(ratio * horizon))));
  };

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative share of patients with a completed colonoscopy, by days from referral, for five simulated arms">
        {Y_TICKS.map((tick) => (
          <g key={tick}>
            <line className={tick === 0 ? "axis-line" : "grid"} x1={M.left} x2={M.left + plotW} y1={y(tick)} y2={y(tick)} />
            <text x={M.left - 8} y={y(tick) + 4} textAnchor="end">
              {tick}%
            </text>
          </g>
        ))}
        {X_TICKS.map((tick) => (
          <text key={tick} x={x(tick)} y={H - M.bottom + 18} textAnchor="middle">
            {tick}
          </text>
        ))}
        <text x={M.left + plotW / 2} y={H - 2} textAnchor="middle">
          Days from referral
        </text>

        <line className="ref" x1={x(31)} x2={x(31)} y1={M.top} y2={M.top + plotH} />
        <text x={x(31) + 5} y={M.top + 10}>
          31 days: the Abu Dhabi standard
        </text>

        {arms.map((arm) => (
          <path key={arm.id} d={path(arm)} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={ARM_STYLE[arm.id].dashed ? "7 5" : undefined} style={{ stroke: ARM_STYLE[arm.id].color }} />
        ))}
        {ends.map(({ arm, share, at, labelAt }) => (
          <g key={arm.id}>
            <circle cx={x(horizon)} cy={at} r={4} strokeWidth={2} style={{ fill: ARM_STYLE[arm.id].color, stroke: "var(--surface)" }} />
            <text className="end-label" x={x(horizon) + 10} y={labelAt + 4}>
              {ARM_STYLE[arm.id].short} {share.toFixed(1)}%
            </text>
          </g>
        ))}

        {day !== null && (
          <g pointerEvents="none">
            <line className="axis-line" x1={x(day)} x2={x(day)} y1={M.top} y2={M.top + plotH} />
            {arms.map((arm) => (
              <circle key={arm.id} cx={x(day)} cy={y(shareAt(arm, day))} r={4} strokeWidth={2} style={{ fill: ARM_STYLE[arm.id].color, stroke: "var(--surface)" }} />
            ))}
          </g>
        )}
        <rect x={M.left} y={M.top} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setDay(null)} />
      </svg>

      {day !== null && (
        <div className="tooltip" style={day > horizon / 2 ? { left: `${(100 * (x(day) - 250)) / W}%` } : { left: `${(100 * (x(day) + 14)) / W}%` }}>
          <h4>Day {day} from referral</h4>
          {[...arms]
            .sort((a, b) => shareAt(b, day) - shareAt(a, day))
            .map((arm) => (
              <div key={arm.id}>
                <span>
                  <Swatch arm={arm} />
                  {ARM_STYLE[arm.id].short}
                </span>
                <b className="num">{shareAt(arm, day).toFixed(1)}%</b>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Page ─────────────────────────
const hours = (value: number | null): string => (value === null ? "no data" : value < 48 ? `${value.toFixed(1)} h` : `${(value / 24).toFixed(1)} days`);

function Live({ live }: { readonly live: ProgrammeData["live"] }) {
  const tiles: readonly { readonly big: string; readonly label: string }[] = [
    { big: String(live.open), label: `open of ${live.cases} cases` },
    { big: String(live.closure.byRecord), label: "closed on a record of care" },
    { big: String(live.closure.byDecision), label: "closed by clinician decision" },
    { big: hours(live.medianHours.toNotification), label: "median, result to notification" },
    { big: hours(live.medianHours.toBooking), label: "median, result to booking" },
    { big: `${live.teachBack.passed} · ${live.teachBack.assisted}`, label: "teach-back passed unaided · with help" },
    { big: String(live.handoffs.waiting), label: `hand-offs waiting of ${live.handoffs.total}` },
    { big: String(live.pastAllowance), label: "open past the pathway's total allowance" },
  ];
  return (
    <div className="tiles">
      {tiles.map((tile) => (
        <div key={tile.label} className="tile">
          <span className="big num">{tile.big}</span>
          <span className="label">{tile.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Programme() {
  const trpc = useTRPC();
  const query = useQuery(trpc.programme.queryOptions(undefined, { refetchInterval: 5000 }));
  if (query.isError) return <main className="programme note-error">The programme view could not be loaded: {query.error.message}</main>;
  if (query.data === undefined) return <main className="programme hint">Running the simulation…</main>;
  const { simulation, live } = query.data;
  const { arms, config } = simulation;
  const assumed = simulation.assumptions.filter((a) => a.source === "assumption").length;

  return (
    <main className="programme">
      <header className="programme-head">
        <div className="row">
          <h1>Programme view</h1>
          <span className="chip warning">Simulation, not outcome evidence</span>
        </div>
        <p className="lede">
          {config.patientsPerArm.toLocaleString("en")} synthetic patients per arm, seed {config.seed}, followed for {config.horizonDays} days. The three completion
          rates are inputs taken from published figures. What the simulation adds is timing, navigator workload, and what a full endoscopy diary does.
        </p>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>Colonoscopy completed, by days from referral</h2>
        </div>
        <div className="card-body stack">
          <div className="legend">
            {arms.map((arm) => (
              <span key={arm.id}>
                <Swatch arm={arm} />
                {arm.label}
              </span>
            ))}
          </div>
          <CompletionChart arms={arms} horizon={config.horizonDays} />
          <p className="hint">
            Dashed lines are the same two care models with endoscopy slots below demand ({config.slotsPerWeekBound} a week against {config.slotsPerWeekAmple}). With a
            full diary, neither arm completes anyone within 31 days: outreach cannot outrun capacity.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>The measures, by arm</h2>
        </div>
        <div className="card-body stack">
          <div className="table-wrap">
            <table className="wide">
              <thead>
                <tr>
                  <th>Arm</th>
                  <th>Completed within 31 days</th>
                  <th>Within 90 days</th>
                  <th>Within {config.horizonDays} days</th>
                  <th className="numcell">Median days to notification</th>
                  <th className="numcell">To booking</th>
                  <th className="numcell">To care</th>
                  <th className="numcell">Navigator minutes per case</th>
                  <th className="numcell">Alerts per navigator-day</th>
                  <th className="numcell">Unresolved at 90 days</th>
                </tr>
              </thead>
              <tbody>
                {arms.map((arm) => (
                  <tr key={arm.id}>
                    <td className="armcell">
                      <Swatch arm={arm} /> <strong>{ARM_STYLE[arm.id].short}</strong>
                    </td>
                    <td>
                      <BarCell count={arm.completedWithin31Days} total={arm.patients} done />
                    </td>
                    <td>
                      <BarCell count={arm.completedWithin90Days} total={arm.patients} />
                    </td>
                    <td>
                      <BarCell count={arm.completedWithinHorizon} total={arm.patients} />
                    </td>
                    <td className="numcell">{arm.medianDaysToNotification?.toFixed(1) ?? "none"}</td>
                    <td className="numcell">{arm.medianDaysToBooking?.toFixed(1) ?? "none"}</td>
                    <td className="numcell">{arm.medianDaysToCare?.toFixed(1) ?? "none"}</td>
                    <td className="numcell">{arm.navigatorMinutesPerCase.toFixed(1)}</td>
                    <td className="numcell">{arm.alertsPerNavigatorDay.toFixed(1)}</td>
                    <td className="numcell">{pct(arm.unresolvedAt90Days, arm.patients)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>What each arm assumes</summary>
            <dl className="basis">
              {arms.map((arm) => (
                <div key={arm.id}>
                  <dt>
                    <Swatch arm={arm} /> {arm.label}
                  </dt>
                  <dd>{arm.basis}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Why patients did not complete</h2>
          <span className="hint">share of all patients in the arm</span>
        </div>
        <div className="card-body table-wrap">
          <table className="wide">
            <thead>
              <tr>
                <th>Reason recorded</th>
                {arms.map((arm) => (
                  <th key={arm.id}>
                    <Swatch arm={arm} /> {ARM_STYLE[arm.id].short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DROP_OFF.map((reason) => (
                <tr key={reason.key}>
                  <td>{reason.label}</td>
                  {arms.map((arm) => (
                    <td key={arm.id}>
                      <BarCell count={arm.dropOff[reason.key]} total={arm.patients} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Completed within 31 days, by language</h2>
        </div>
        <div className="card-body table-wrap stack">
          <table>
            <thead>
              <tr>
                <th>Language</th>
                <th className="numcell">Patients per arm</th>
                {arms.map((arm) => (
                  <th key={arm.id} className="numcell">
                    {ARM_STYLE[arm.id].short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LANGUAGES.map((language) => (
                <tr key={language.key}>
                  <td>{language.label}</td>
                  <td className="numcell">{arms[0]?.byLanguage[language.key].patients.toLocaleString("en")}</td>
                  {arms.map((arm) => (
                    <td key={arm.id} className="numcell">
                      {pct(arm.byLanguage[language.key].completedWithin31Days, arm.byLanguage[language.key].patients)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            Every language uses the same behaviour model, so differences between rows are sampling noise. The table shows the fairness report a pilot would fill with
            real slices; it says nothing about real groups.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Read this before quoting a number</h2>
        </div>
        <div className="card-body stack">
          <ul className="caveats">
            {simulation.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
          <details>
            <summary>
              All {simulation.assumptions.length} parameters ({assumed} are assumptions, {simulation.assumptions.length - assumed} are published figures)
            </summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Parameter</th>
                    <th>Value</th>
                    <th>Source</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.assumptions.map((assumption) => (
                    <tr key={assumption.parameter}>
                      <td>{assumption.parameter}</td>
                      <td className="num">{assumption.value}</td>
                      <td>
                        <span className={`chip ${assumption.source === "published" ? "good" : "muted"}`}>{assumption.source === "published" ? "Published" : "Assumption"}</span>
                      </td>
                      <td className="hint">{assumption.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>From this board's event log</h2>
          <span className="hint">the handful of demo cases, not the simulation</span>
        </div>
        <div className="card-body">
          <Live live={live} />
        </div>
      </section>
    </main>
  );
}
