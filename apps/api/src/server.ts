// One process: the HTTP API, the FHIR endpoints, and the in-process case worker with its timer loop.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { renderFromLog } from "@halqa/catalogue";
import { zCaseId, zResourceRef } from "@halqa/fhir";
import { Hono } from "hono";
import * as z from "zod";
import { HalqaHost } from "./halqa.js";
import { ReviewService } from "./review.js";
import { appRouter } from "./router.js";
import { synthesize, voiceLabel } from "./tts.js";
import { fhirTask } from "./views.js";

const dbPath = process.env["HALQA_DB"] ?? fileURLToPath(new URL("../../../data/halqa.db", import.meta.url));
const port = Number(process.env["PORT"] ?? 8787);

const dataDir = dbPath === ":memory:" ? fileURLToPath(new URL("../../../data", import.meta.url)) : dirname(dbPath);
const host = new HalqaHost(dbPath);
await host.seed();
const reviews = new ReviewService(join(dataDir, "review-cache"));

// The durable-timer loop. Deadlines live in the event log, so this loop holds no state of its own:
// kill the process at any point and the next tick after restart fires whatever came due meanwhile.
setInterval(() => host.current.runtime.tick(), 1000).unref();

const app = new Hono();

app.use("/trpc/*", trpcServer({ router: appRouter, createContext: () => ({ host, reviews }) }));

// ───────────── FHIR R4 subset ─────────────
const outcome = (severity: "error" | "information", diagnostics: string) => ({
  resourceType: "OperationOutcome",
  issue: [{ severity, code: severity === "error" ? "invalid" : "informational", diagnostics }],
});

/** Results, procedures and appointment updates arrive here, as they would from a laboratory or provider system. */
app.post("/fhir/:type", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const result = host.current.runtime.ingest(body);
  if (result.status === "rejected") return c.json(outcome("error", result.issues), 400);
  if (result.status === "duplicate") return c.json(outcome("information", `${result.ref} at this version was already received; nothing changed.`), 200);
  return c.json({ ...outcome("information", `Stored ${result.ref}.`), effects: result.effects }, 201);
});

/** A case, read as a standard Task by any FHIR client. */
app.get("/fhir/Task/:id", (c) => {
  const caseId = zCaseId.safeParse(c.req.param("id"));
  const record = caseId.success ? host.current.runtime.get(caseId.data) : undefined;
  if (!caseId.success || record === undefined) return c.json(outcome("error", "No such Task."), 404);
  return c.json(fhirTask(caseId.data, record));
});

app.get("/fhir/:type/:id", (c) => {
  const ref = zResourceRef.safeParse(`${c.req.param("type")}/${c.req.param("id")}`);
  const resource = ref.success ? host.current.runtime.resource(ref.data) : null;
  return resource === null ? c.json(outcome("error", "Not found."), 404) : c.json(resource);
});

// ───────────── Speech ─────────────
// The agent's voice is requested by act, language and slot values, never by free text: the
// words are re-rendered from the catalogue here, so the browser cannot make the agent say
// anything the catalogue does not hold. The scripted patient in the guided demo sends its line.
const zSpeak = z.discriminatedUnion("role", [
  // `turn` names the call turn this audio is for, so the synthesis is recorded against it.
  z.object({
    role: z.literal("agent"),
    act: z.string().max(60),
    lang: z.enum(["ar", "en"]),
    params: z.unknown(),
    turn: z.object({ callId: z.string().uuid(), idx: z.number().int().nonnegative() }).optional(),
  }),
  z.object({ role: z.literal("patient"), text: z.string().min(1).max(300), lang: z.enum(["ar", "en"]) }),
]);
const speechCache = join(dataDir, "tts-cache");

app.post("/tts", async (c) => {
  const parsed = zSpeak.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ reason: "Not a speakable line." }, 400);
  const request = parsed.data;
  const text = request.role === "agent" ? renderFromLog(request.act, request.lang, request.params) : request.text;
  if (text === null) return c.json({ reason: "The catalogue has no such wording." }, 400);
  const began = performance.now();
  const speech = await synthesize(speechCache, text, request.lang, request.role);
  if (!speech.ok) return c.json({ reason: speech.reason }, speech.status);
  if (request.role === "agent" && request.turn !== undefined) {
    host.current.runtime.logSpeech(request.turn.callId, request.turn.idx, { cached: speech.cached, ms: performance.now() - began, characters: text.length, voice: speech.voice });
  }
  // A fresh copy gives the bytes a plain ArrayBuffer, which is what a response body takes.
  return c.body(new Uint8Array(speech.audio), 200, { "content-type": "audio/mpeg", "cache-control": "no-store", "x-halqa-voice": speech.voice, "x-halqa-cache": speech.cached ? "hit" : "miss" });
});

app.get("/health", (c) => c.json({ ok: true, ...host.current.runtime.health(), brain: host.current.engine.brainId, voice: voiceLabel() }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Halqa API on http://localhost:${port} · brain: ${host.current.engine.brainId} · voice: ${voiceLabel()} · store: ${dbPath} · synthetic data only`);
});
