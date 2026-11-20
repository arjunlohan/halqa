// The browser's own ear and mouth: speech synthesis for both voices on the call, and speech
// recognition for a person speaking as the patient. They stand in for the realtime speech model
// in the build spec. The words spoken for the agent are always the catalogue's.

type RecognitionEvent = { readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }>> };
type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};
type RecognitionConstructor = new () => Recognition;

const recognitionConstructor = (): RecognitionConstructor | null => {
  // Speech recognition is not in every browser's typings; this is the one place the window is widened.
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
};

export const canListen = (): boolean => recognitionConstructor() !== null;
export const canSpeak = (): boolean => typeof window !== "undefined" && "speechSynthesis" in window;

export type SpeechLang = "ar" | "en";
export type VoiceRole = "agent" | "patient";

/** Listen for one utterance. Returns a function that stops listening. */
export function listenOnce(lang: SpeechLang, onText: (text: string) => void, onDone: () => void): () => void {
  const Constructor = recognitionConstructor();
  if (Constructor === null) {
    onDone();
    return () => {};
  }
  const recognition = new Constructor();
  recognition.lang = lang === "ar" ? "ar-AE" : "en-GB";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event) => {
    const text = event.results[0]?.[0]?.transcript ?? "";
    if (text.trim().length > 0) onText(text);
  };
  recognition.onend = onDone;
  recognition.onerror = onDone;
  recognition.start();
  return () => recognition.stop();
}

/** Roughly how long a line takes to say, used to pace captions when no voice is available. */
const readingTime = (text: string): number => Math.min(9000, 700 + text.length * 42);

const voicesFor = (lang: SpeechLang): SpeechSynthesisVoice[] =>
  window.speechSynthesis
    .getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith(lang))
    // Local voices start instantly; network voices can stall a live demo.
    .sort((a, b) => Number(b.localService) - Number(a.localService));

/** The agent and the patient get different voices where the system has two; otherwise the patient is pitched apart. */
function voiceFor(lang: SpeechLang, role: VoiceRole): { voice: SpeechSynthesisVoice | null; pitch: number; rate: number } {
  const [first, second] = voicesFor(lang);
  if (role === "agent") return { voice: first ?? null, pitch: 1, rate: 0.98 };
  return second !== undefined ? { voice: second, pitch: 1, rate: 1.02 } : { voice: first ?? null, pitch: 0.72, rate: 1.04 };
}

/** What to say. The agent's line is named by act and slot values; the server re-renders the words from the catalogue. */
export type Line =
  | {
      readonly role: "agent";
      readonly text: string;
      readonly lang: SpeechLang;
      readonly act: string;
      readonly params: unknown;
      /** The call turn this audio is for. When set, the server records the synthesis against that turn. */
      readonly turn?: { readonly callId: string; readonly idx: number };
    }
  | { readonly role: "patient"; readonly text: string; readonly lang: SpeechLang };

// ───────────── Voice level, for anything that wants to move with the voice ─────────────
const levelListeners = new Set<(level: number) => void>();
const emitLevel = (level: number): void => {
  for (const listener of levelListeners) listener(level);
};
/** Subscribe to the loudness of the line being spoken, 0 to 1. Returns the unsubscribe function. */
export const subscribeLevel = (listener: (level: number) => void): (() => void) => {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
};

let audioContext: AudioContext | null = null;
let playing: HTMLAudioElement | null = null;
/** "unknown" until the server has answered once; "no" means it has no speech provider configured. */
let serverVoice: "unknown" | "yes" | "no" = "unknown";

/** Play synthesised audio and report its loudness while it plays. */
function playAudio(blob: Blob, onStart: () => void, paceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    playing = audio;
    let frame = 0;
    const finish = () => {
      window.cancelAnimationFrame(frame);
      emitLevel(0);
      URL.revokeObjectURL(url);
      if (playing === audio) playing = null;
      resolve();
    };
    try {
      audioContext ??= new AudioContext();
      void audioContext.resume();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaElementSource(audio).connect(analyser);
      analyser.connect(audioContext.destination);
      const samples = new Uint8Array(analyser.fftSize);
      const measure = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        emitLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3.2));
        frame = window.requestAnimationFrame(measure);
      };
      frame = window.requestAnimationFrame(measure);
    } catch {
      // No Web Audio: the line still plays, the level just stays flat.
    }
    audio.onended = finish;
    audio.onerror = finish;
    audio.onplaying = onStart;
    // If the browser refuses to play (no user gesture yet), keep the caption and the pace anyway.
    audio.play().catch(() => {
      onStart();
      window.setTimeout(finish, paceMs);
    });
  });
}

/** Ask the server for the line's audio. Null means "use the browser's voice for this line". */
async function fetchSpeech(line: Line): Promise<Blob | null> {
  if (serverVoice === "no") return null;
  try {
    const body = line.role === "agent" ? { role: line.role, act: line.act, lang: line.lang, params: line.params, turn: line.turn } : { role: line.role, text: line.text, lang: line.lang };
    const response = await fetch("/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 501) {
      serverVoice = "no";
      return null;
    }
    if (!response.ok) {
      // Quota, plan or network trouble at the provider: this line falls back, the next one tries again.
      console.warn(`Speech provider failed for one line (${response.status}); using the browser voice.`);
      return null;
    }
    serverVoice = "yes";
    return await response.blob();
  } catch {
    return null;
  }
}

function speakWithBrowser(line: Line, onStart: () => void): Promise<void> {
  const { voice, pitch, rate } = voiceFor(line.lang, line.role);
  if (!canSpeak() || voice === null) {
    onStart();
    return new Promise((resolve) => window.setTimeout(resolve, readingTime(line.text)));
  }
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(line.text);
    utterance.lang = line.lang === "ar" ? "ar-SA" : "en-GB";
    utterance.voice = voice;
    utterance.pitch = pitch;
    utterance.rate = rate;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(guard);
      resolve();
    };
    // Some engines never fire `end` on long lines; never let the call hang on one.
    const guard = window.setTimeout(done, readingTime(line.text) * 1.8 + 2500);
    utterance.onend = done;
    utterance.onerror = done;
    onStart();
    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Say a line and resolve when it has been said. `onStart` fires when the voice actually begins,
 * so captions can appear with the first word. With sound off it resolves after the time the line
 * would take, so turn-taking keeps a human pace.
 */
export async function speakLine(line: Line, sound: boolean, onStart: () => void): Promise<void> {
  if (!sound) {
    onStart();
    return new Promise((resolve) => window.setTimeout(resolve, readingTime(line.text)));
  }
  const audio = await fetchSpeech(line);
  return audio === null ? speakWithBrowser(line, onStart) : playAudio(audio, onStart, readingTime(line.text));
}

/** Start fetching a line's audio now, so it is ready (and cached) by the time it is spoken. */
export const prefetchLine = (line: Line, sound: boolean): void => {
  if (sound) void fetchSpeech(line);
};

export const stopSpeaking = (): void => {
  if (canSpeak()) window.speechSynthesis.cancel();
  playing?.pause();
  playing = null;
  emitLevel(0);
};

/** Voices load asynchronously in some browsers; touching the list early makes the first line start on time. */
export const warmVoices = (): void => {
  if (canSpeak()) window.speechSynthesis.getVoices();
};
