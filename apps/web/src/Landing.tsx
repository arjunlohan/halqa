import AnimatedContent from "@/reactbits/AnimatedContent";
import Aurora from "@/reactbits/Aurora";
import BlurText from "@/reactbits/BlurText";
import BorderGlow from "@/reactbits/BorderGlow";
import CallChip from "@/reactbits/CallChip";
import CountUp from "@/reactbits/CountUp";
import DecryptedText from "@/reactbits/DecryptedText";
import FadeContent from "@/reactbits/FadeContent";
import GradientText from "@/reactbits/GradientText";
import MagicBento, { type MagicBentoItem } from "@/reactbits/MagicBento";
import Orb from "@/reactbits/Orb";
import RotatingText from "@/reactbits/RotatingText";
import ShinyText from "@/reactbits/ShinyText";
import SpecularButton from "@/reactbits/SpecularButton";
import SplitText from "@/reactbits/SplitText";
import SpotlightCard from "@/reactbits/SpotlightCard";
import StarBorder from "@/reactbits/StarBorder";
import TextType from "@/reactbits/TextType";
import { hrefFor } from "./router.js";

const INVARIANTS: readonly { readonly tag: string; readonly title: string; readonly body: string; readonly code: string }[] = [
  {
    tag: "I1",
    title: "Closed means evidence.",
    body: "A case reaches closed only on a completed record of the care, or a clinician's signed decision. There is no third way, in the types or at runtime.",
    code: "ClosedState.evidence: ClosureEvidence",
  },
  {
    tag: "I2",
    title: "Somebody owns it, on a clock.",
    body: "Every open case has a named human owner and a deadline. A missed deadline never drops a case. It makes the case louder.",
    code: "owner: Owner; due: Instant",
  },
  {
    tag: "I3",
    title: "The agent cannot close or own.",
    body: "An AI agent can move a case forward. It cannot mint evidence, own a case, or say a word that is not in the approved catalogue.",
    code: "AgentEvent = notified | acknowledged | booked",
  },
];

const chip = { icon: "terminal", showTimer: false, size: 26, surfaceColor: "#0d171d" } as const;

const VISUALS = {
  ingest: (
    <div className="bv bv-row">
      <code>Observation · LOINC 57905-2 · POS</code>
      <span className="bv-arrow">→</span>
      <span className="chip accent">Case opened</span>
    </div>
  ),
  call: (
    <div className="bv bv-talk">
      <span className="bv-bubble" lang="ar" dir="rtl">
        هذه نتيجة فحص مبكر وليست تشخيصاً.
      </span>
      <span className="bv-bubble them">The second one, please.</span>
    </div>
  ),
  timers: (
    <div className="bv bv-ladder">
      {["Owner", "Team lead", "Programme lead"].map((who, level) => (
        <span key={who}>
          <i className="dots">
            {[0, 1, 2].map((dot) => (
              <i key={dot} className={dot <= level ? "on" : undefined} />
            ))}
          </i>
          {who}
        </span>
      ))}
    </div>
  ),
  closure: (
    <div className="bv bv-chips">
      <CallChip {...chip} name="Procedure" argument="another patient" status="error" errorColor="#f6c160" />
      <CallChip {...chip} name="Procedure" argument="sigmoidoscopy" status="error" errorColor="#f6c160" />
      <CallChip {...chip} name="Procedure" argument="colonoscopy" status="done" doneColor="#2dd4bf" />
    </div>
  ),
  people: (
    <div className="bv bv-chips">
      <span className="chip">Owner · Mariam A.</span>
      <span className="chip warning">Hand-off waiting</span>
      <span className="chip good">Closed by Dr Layla H.</span>
    </div>
  ),
  programme: (
    <svg className="bv bv-spark" viewBox="0 0 220 70" role="img" aria-label="Two simulated completion curves">
      <path d="M0,68 C40,66 70,52 110,44 S190,38 220,37" fill="none" stroke="#3987e5" strokeWidth="2" />
      <path d="M0,68 C16,30 40,16 80,13 S180,11 220,11" fill="none" stroke="#199e70" strokeWidth="2" />
    </svg>
  ),
};

const BENTO: MagicBentoItem[] = [
  { label: "Ingest", title: "A result lands", description: "A FHIR Observation is parsed or rejected at the boundary. One actionable result opens exactly one case.", visual: VISUALS.ingest, colSpan: 2 },
  { label: "Voice", title: "The call", description: "Arabic and English, identity before any result, a teach-back, then a booking. Every word comes from an approved catalogue.", visual: VISUALS.call, colSpan: 2 },
  { label: "Timers", title: "Deadlines that survive a crash", description: "Deadlines live in the event log. Kill the process and the next tick fires whatever came due.", visual: VISUALS.timers },
  { label: "Closure", title: "The record decides", description: "Patient, procedure code, status and date are checked by the kernel before a case can close.", visual: VISUALS.closure },
  { label: "People", title: "The navigator board", description: "Owners, hand-offs, re-booking, and closure by a clinician's decision.", visual: VISUALS.people },
  { label: "Simulation", title: "Timing and capacity", description: "What the mechanism does to waiting time, and where a full diary stops it.", visual: VISUALS.programme },
];

const REAL: readonly string[] = [
  "The closure kernel, with 12 compile-time proofs and a 100,000-run property test",
  "A hash-chained event log, replay, and timers that survive kill -9",
  "The call engine: guards, red-flag rules, identity check, Arabic and English catalogue",
  "Closure from the record, with wrong-patient and wrong-code records refused",
  "The board, clinician closure, and the programme simulation",
];
const NOT_YET: readonly string[] = [
  "Voice uses the browser's speech engines, not a realtime speech model or a phone line",
  "Act selection runs on rules by default. The Claude selector is built and tested against a stand-in, and needs a key to go live",
  "Patient wording is not clinically approved, and no native speaker has reviewed the Arabic",
  "No real patient data, and no outcome evidence: the programme view is a simulation",
];

export function Landing() {
  return (
    <main className="site">
      <section className="hero">
        <div className="hero-aurora" aria-hidden="true">
          <Aurora colorStops={["#0f766e", "#2dd4bf", "#38bdf8"]} amplitude={1.1} blend={0.6} speed={0.7} height={0.55} glow={0.7} />
        </div>

        <div className="hero-copy">
          <span className="hero-badge">
            <ShinyText text="Future Health Challenge · Challenge 05 · prototype on synthetic data" color="#8fa29d" shineColor="#ecf3f1" speed={3.2} />
          </span>
          <SplitText tag="h1" className="hero-title serif" text="Every screening result, followed to care." splitType="words, chars" effect="rise" trigger="load" delay={22} duration={1} textAlign="left" />
          <div className="hero-sub">
            <BlurText
              text="Halqa turns each actionable result into an owned, clocked case. AI agents move it forward in Arabic and English. Only a record of the care, or a clinician, can close it."
              animateBy="words"
              direction="bottom"
              delay={28}
              trigger="load"
            />
          </div>
          <div className="hero-cta">
            <StarBorder as="a" href={hrefFor("demo")} color="#ffffff" trailColor="#eafffb" backgroundColor="#2dd4bf" textColor="#03211d" borderColor="#2dd4bf" className="cta-primary">
              Watch the live demo
            </StarBorder>
            <SpecularButton size="lg" onClick={() => (window.location.hash = hrefFor("console").slice(1))}>
              Open the console
            </SpecularButton>
          </div>
          <p className="hero-speaks">
            It speaks{" "}
            <RotatingText texts={["العربية", "English"]} effect="blur" splitBy="words" rotationInterval={2400} mainClassName="hero-rotate" />
          </p>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="hero-orb">
            <Orb colors={["#2dd4bf", "#38bdf8", "#0f766e"]} backgroundColor="#05090d" forceHoverState hoverIntensity={0.9} speed={0.9} followCursor clickPulse />
          </div>
          <div className="hero-card">
            <div className="hero-card-top">
              <span className="chip good">Identity verified</span>
              <span className="chip mono">crc-fit-positive v1</span>
            </div>
            <TextType
              className="hero-card-line"
              text={["This is a screening result, not a diagnosis.", "هذه نتيجة فحص مبكر وليست تشخيصاً.", "Your colonoscopy is booked for Monday at 10:00."]}
              typingSpeed={34}
              deletingSpeed={14}
              pauseDuration={2200}
              cursorCharacter="▍"
              cursorColor="#2dd4bf"
            />
            <CallChip icon="terminal" name="select_act" argument="deliver-result" status="done" showTimer={false} size={28} surfaceColor="#0d171d" doneColor="#2dd4bf" />
          </div>
        </div>
      </section>

      <section className="band">
        <AnimatedContent distance={40} duration={0.9} stagger={0.12} className="stats">
          <div className="stat">
            <span className="stat-n serif num">
              <CountUp to={30.5} decimals={1} suffix="%" duration={1.6} />
            </span>
            <p>of positive stool tests in Abu Dhabi's published 2015 to 2016 data were followed by a colonoscopy.</p>
          </div>
          <div className="stat">
            <span className="stat-n serif num">
              <CountUp to={31} suffix=" days" duration={1.6} />
            </span>
            <p>is the local standard from referral to colonoscopy, for more than 90% of people.</p>
          </div>
          <div className="stat">
            <span className="stat-n serif num">
              <CountUp to={36.3} decimals={1} suffix="%" duration={1.6} />
            </span>
            <p>received the result and a referral, then did not attend. It was the largest stated reason.</p>
          </div>
        </AnimatedContent>
        <p className="source">
          Source:{" "}
          <a href="https://link.springer.com/10.1186/s12885-021-08623-9" target="_blank" rel="noreferrer">
            Almansoori et al., BMC Cancer 2021;21:897
          </a>
          . The figure is a decade old; the current rate is unknown.
        </p>
      </section>

      <section className="band rule">
        <FadeContent blur duration={1.1}>
          <p className="rule-line serif">
            The model picks among legal moves.
            <br />
            The kernel decides which moves are legal.
            <br />
            <GradientText colors={["#7cf5dd", "#2dd4bf", "#38bdf8", "#7cf5dd"]} animationSpeed={6} className="rule-accent">
              People decide what closes.
            </GradientText>
          </p>
        </FadeContent>
      </section>

      <section className="band">
        <header className="band-head">
          <span className="eyebrow">Three invariants</span>
          <h2 className="serif">Enforced by the compiler, then again at runtime.</h2>
        </header>
        <AnimatedContent distance={36} duration={0.8} stagger={0.1} className="invariants">
          {INVARIANTS.map((item) => (
            <SpotlightCard key={item.tag} className="invariant" spotlightColor="rgba(45, 212, 191, 0.2)">
              <span className="invariant-tag mono">{item.tag}</span>
              <h3 className="serif">{item.title}</h3>
              <p>{item.body}</p>
              <code>{item.code}</code>
            </SpotlightCard>
          ))}
        </AnimatedContent>
      </section>

      <section className="band">
        <header className="band-head">
          <span className="eyebrow">How one result moves</span>
          <h2 className="serif">From the laboratory to a completed colonoscopy.</h2>
        </header>
        <MagicBento items={BENTO} columns={4} rowHeight={250} gap={14} radius={22} theme="dark" glowColor="#2dd4bf" textAutoHide={false} />
      </section>

      <section className="band proof">
        <div className="proof-copy">
          <span className="eyebrow">Try to break it</span>
          <h2 className="serif">An agent tries to close a case. Three layers say no.</h2>
          <ul className="proof-numbers">
            <li>
              <span className="serif num">
                <CountUp to={126957} separator="," duration={2} />
              </span>
              <p>
                forged closures injected through an untyped boundary. <strong>None accepted.</strong>
              </p>
            </li>
            <li>
              <span className="serif num">
                <CountUp to={12} duration={1.2} />
              </span>
              <p>illegal constructions the compiler rejects.</p>
            </li>
            <li>
              <span className="serif num">
                <CountUp to={9} duration={1.2} suffix=" of 9" />
              </span>
              <p>deliberate breaks of a safety property caught by a check.</p>
            </li>
          </ul>
        </div>
        <BorderGlow className="proof-term" glowColor="45 212 191" backgroundColor="#060c11" borderRadius={22} colors={["#2dd4bf", "#38bdf8", "#7cf5dd"]}>
          <div className="term">
            <span className="term-line dim">$ pnpm proof</span>
            <span className="term-line">
              <DecryptedText text={"error TS2322: Type '\"closed\"' is not assignable to type"} animateOn="view" speed={28} sequential />
            </span>
            <span className="term-line">{"  '\"appointment-booked\" | \"patient-acknowledged\" | \"patient-notified\"'."}</span>
            <span className="term-line dim">{'{"runs":100000,"forgedCloseAttempts":126957,'}</span>
            <span className="term-line good">{' "forgedCloseAccepted":0}'}</span>
            <div className="term-chips">
              <CallChip icon="terminal" name="compiler" argument="agent close" status="error" showTimer={false} size={28} surfaceColor="#0d171d" errorColor="#f6c160" />
              <CallChip icon="terminal" name="tool schema" argument="agent close" status="error" showTimer={false} size={28} surfaceColor="#0d171d" errorColor="#f6c160" />
              <CallChip icon="terminal" name="kernel" argument="forged evidence" status="error" showTimer={false} size={28} surfaceColor="#0d171d" errorColor="#f6c160" />
            </div>
          </div>
        </BorderGlow>
      </section>

      <section className="band">
        <header className="band-head">
          <span className="eyebrow">What is real today</span>
          <h2 className="serif">A prototype that says what it is.</h2>
        </header>
        <AnimatedContent distance={30} duration={0.8} stagger={0.12} className="honest">
          <div className="honest-col">
            <h3>Built and verified</h3>
            <ul>
              {REAL.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="honest-col not">
            <h3>Not yet</h3>
            <ul>
              {NOT_YET.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </AnimatedContent>
      </section>

      <section className="band closing">
        <h2 className="serif">See one result go all the way.</h2>
        <StarBorder as="a" href={hrefFor("demo")} color="#ffffff" trailColor="#eafffb" backgroundColor="#2dd4bf" textColor="#03211d" borderColor="#2dd4bf" className="cta-primary">
          Run the live demo
        </StarBorder>
      </section>

      <footer className="site-foot">
        <span className="brand">
          <span className="brand-name">Halqa</span>
          <span className="brand-ar" lang="ar">
            حلقة
          </span>
        </span>
        <span>Prototype. Synthetic data only. Patient wording is not clinically approved.</span>
      </footer>
    </main>
  );
}
