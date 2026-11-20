// The mouth, server side. With an ElevenLabs key in the environment, lines are synthesised by
// ElevenLabs and cached on disk; without one the browser falls back to its own speech synthesis.
//
// Two rules hold here:
//   1. The key never leaves this process.
//   2. Every synthesised line is cached by model, voice and exact text, so a line is paid for once.
//      The catalogue is a closed set, which is what makes pre-rendered audio possible.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SpeechLang = "ar" | "en";
export type SpeechRole = "agent" | "patient";

type ElevenLabs = { readonly key: string; readonly model: string; readonly voices: Readonly<Record<SpeechRole, string>> };

// Premade ElevenLabs voices verified for both Arabic and English.
const DEFAULT_VOICES: Readonly<Record<SpeechRole, string>> = {
  agent: "EXAVITQu4vr4xnSDxMaL", // Sarah: mature, reassuring
  patient: "JBFqnCBsd6RMkjVDRZzb", // George: warm
};

function elevenLabs(): ElevenLabs | null {
  const key = process.env["ELEVENLABS_API_KEY"];
  if (key === undefined || key.trim().length === 0) return null;
  return {
    key: key.trim(),
    model: process.env["ELEVENLABS_MODEL"] ?? "eleven_v4",
    voices: {
      agent: process.env["ELEVENLABS_VOICE_AGENT"] ?? DEFAULT_VOICES.agent,
      patient: process.env["ELEVENLABS_VOICE_PATIENT"] ?? DEFAULT_VOICES.patient,
    },
  };
}

/** What the interface shows as the voice in use. */
export const voiceLabel = (): string => {
  const config = elevenLabs();
  return config === null ? "browser speech synthesis" : `ElevenLabs ${config.model}`;
};

export type Speech =
  | { readonly ok: true; readonly audio: Uint8Array; readonly cached: boolean; readonly voice: string }
  | { readonly ok: false; readonly status: 501 | 502; readonly reason: string };

const inFlight = new Map<string, Promise<Speech>>();

export function synthesize(cacheDir: string, text: string, lang: SpeechLang, role: SpeechRole): Promise<Speech> {
  const config = elevenLabs();
  if (config === null) return Promise.resolve({ ok: false, status: 501, reason: "No speech provider is configured; use the browser's voice." });

  const voice = config.voices[role];
  const key = createHash("sha256").update(`${config.model}|${voice}|${lang}|${text}`).digest("hex");
  const file = join(cacheDir, `${key}.mp3`);
  const label = `ElevenLabs ${config.model}`;
  if (existsSync(file)) return Promise.resolve({ ok: true, audio: readFileSync(file), cached: true, voice: label });

  // Two requests for the same line share one synthesis, so a line is never paid for twice.
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const request = fetchSpeech(config, voice, text, lang)
    .then((result): Speech => {
      if (!result.ok) return result;
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, result.audio);
      return { ...result, voice: label };
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

async function fetchSpeech(config: ElevenLabs, voice: string, text: string, lang: SpeechLang): Promise<Speech> {
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": config.key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: config.model, language_code: lang }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // The provider's message can name quota or plan limits; it never contains the key.
      const detail = (await response.text()).slice(0, 300);
      return { ok: false, status: 502, reason: `ElevenLabs answered ${response.status}: ${detail}` };
    }
    return { ok: true, audio: new Uint8Array(await response.arrayBuffer()), cached: false, voice: "" };
  } catch (error) {
    return { ok: false, status: 502, reason: `ElevenLabs could not be reached: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}
