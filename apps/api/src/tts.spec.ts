import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synthesize, voiceLabel } from "./tts.js";

// No test here reaches the network: `fetch` is replaced by a counter that returns fixed bytes.
const audio = new Uint8Array([73, 68, 51, 4]);
let dir = "";
let calls: { url: string; body: unknown; key: string | null }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "halqa-tts-"));
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body), key: init.headers["xi-api-key"] ?? null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(audio, { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("speech", () => {
  it("without a key, tells the browser to use its own voice and calls nobody", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(voiceLabel()).toBe("browser speech synthesis");
    expect(await synthesize(dir, "Hello.", "en", "agent")).toMatchObject({ ok: false, status: 501 });
    expect(calls).toHaveLength(0);
  });

  it("pays for a line once: the second request is served from disk", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    expect(voiceLabel()).toBe("ElevenLabs eleven_v4");
    const first = await synthesize(dir, "Hello.", "en", "agent");
    const second = await synthesize(dir, "Hello.", "en", "agent");
    expect(first).toMatchObject({ ok: true, cached: false, voice: "ElevenLabs eleven_v4" });
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ key: "test-key", body: { text: "Hello.", model_id: "eleven_v4", language_code: "en" } });
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("two requests for the same line at the same moment share one synthesis", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    const [a, b] = await Promise.all([synthesize(dir, "Same line.", "en", "agent"), synthesize(dir, "Same line.", "en", "agent")]);
    expect(a.ok && b.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a different voice, language or wording is a different line", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    await synthesize(dir, "Hello.", "en", "agent");
    await synthesize(dir, "Hello.", "en", "patient");
    await synthesize(dir, "Hello!", "en", "agent");
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.url)).size).toBe(2);
  });

  it("negative control: a refusal from the provider is reported, not cached", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubGlobal("fetch", async () => new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 }));
    const refused = await synthesize(dir, "Hello.", "en", "agent");
    expect(refused).toMatchObject({ ok: false, status: 502 });
    expect(refused.ok ? "" : refused.reason).toContain("quota_exceeded");
    expect(refused.ok ? "" : refused.reason).not.toContain("test-key");
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
