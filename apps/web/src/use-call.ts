import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { prefetchLine, speakLine, stopSpeaking, warmVoices, type SpeechLang } from "./speech.js";
import { useTRPC, type CallDetail } from "./trpc.js";

export type Activity = "idle" | "agent" | "patient" | "thinking" | "listening";
export type Caption = { readonly who: "agent" | "patient"; readonly text: string; readonly lang: SpeechLang; readonly act?: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
const langOf = (text: string): SpeechLang => (/[ء-ي]/.test(text) ? "ar" : "en");

/**
 * One call, as the browser sees it: places it, sends what the patient says, and gives every new
 * agent turn a voice in order. The server holds the call and its record; this listens and speaks.
 */
export function useCall(caseId: string | undefined, sound: boolean, options: { readonly resume?: boolean } = {}) {
  const resume = options.resume === true;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const start = useMutation(trpc.callStart.mutationOptions());
  const say = useMutation(trpc.callSay.mutationOptions());
  const end = useMutation(trpc.callHangUp.mutationOptions());
  const [call, setCall] = useState<CallDetail | null>(null);
  const [activity, setActivity] = useState<Activity>("idle");
  const [caption, setCaption] = useState<Caption | null>(null);
  /** Agent turn index to milliseconds from "reply sent" to "first audio", as this browser measured it. */
  const [responseMs, setResponseMs] = useState<Readonly<Record<number, number>>>({});
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const voiced = useRef<{ session: string | null; count: number }>({ session: null, count: 0 });
  const chain = useRef<Promise<void>>(Promise.resolve());
  const sentAt = useRef<number | null>(null);

  // A different case means a different call: forget the old one.
  useEffect(() => {
    setCall(null);
    setCaption(null);
    setResponseMs({});
    setActivity("idle");
    voiced.current = { session: null, count: 0 };
    if (!resume || caseId === undefined) return;
    // Show where the case's latest call got to, without saying it aloud again.
    let cancelled = false;
    void (async () => {
      const detail = await queryClient.fetchQuery({ ...trpc.case.queryOptions({ caseId }), staleTime: 0 });
      const latest = detail.calls[0];
      if (latest === undefined || cancelled) return;
      const view = await queryClient.fetchQuery({ ...trpc.callRecord.queryOptions({ callId: latest.id }), staleTime: 0 });
      if (cancelled || voiced.current.session !== null) return;
      voiced.current = { session: view.id, count: view.turnList.length };
      setCall(view);
      const last = view.turnList.findLast((turn) => turn.speaker === "agent");
      if (last?.speaker === "agent") setCaption({ who: "agent", text: last.text, lang: last.lang, act: last.act });
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  useEffect(() => {
    if (call === null) return;
    if (voiced.current.session !== call.id) voiced.current = { session: call.id, count: 0 };
    const fresh = call.turnList.slice(voiced.current.count);
    voiced.current.count = call.turnList.length;
    // Fetch every new line's audio at once, so the second is ready while the first is spoken. This
    // first request names the turn, so the server records whether the line came from its cache.
    for (const turn of fresh) {
      if (turn.speaker === "agent") prefetchLine({ role: "agent", text: turn.text, lang: turn.lang, act: turn.act, params: turn.params, turn: { callId: call.id, idx: turn.idx } }, soundRef.current);
    }
    for (const turn of fresh) {
      if (turn.speaker !== "agent") continue;
      chain.current = chain.current.then(async () => {
        // The caption appears with the first word, not while the voice is still being fetched.
        setActivity("thinking");
        await speakLine({ role: "agent", text: turn.text, lang: turn.lang, act: turn.act, params: turn.params }, soundRef.current, () => {
          setCaption({ who: "agent", text: turn.text, lang: turn.lang, act: turn.act });
          setActivity("agent");
          const sent = sentAt.current;
          if (sent !== null) {
            sentAt.current = null;
            setResponseMs((previous) => ({ ...previous, [turn.idx]: Math.round(performance.now() - sent) }));
          }
        });
        setActivity("idle");
      });
    }
  }, [call?.id, call?.turnList.length]);

  useEffect(() => {
    warmVoices();
    return () => stopSpeaking();
  }, []);

  const adopt = useCallback(
    (view: CallDetail) => {
      setCall(view);
      void queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const place = useCallback(async (): Promise<void> => {
    if (caseId === undefined) return;
    setCaption(null);
    // A call placed now replaces whatever earlier call was on show.
    voiced.current = { session: "placing", count: 0 };
    setActivity("thinking");
    sentAt.current = performance.now();
    try {
      adopt(await start.mutateAsync({ caseId }));
    } finally {
      setActivity((current) => (current === "thinking" ? "idle" : current));
    }
  }, [adopt, caseId, start]);

  /** The patient speaks. With `aloud`, the line is given the patient's voice before it is sent. */
  const patientSays = useCallback(
    async (text: string, aloud: boolean): Promise<void> => {
      const line = text.trim();
      if (call === null || call.ended !== null || line.length === 0) return;
      await chain.current;
      const lang = langOf(line);
      const show = () => {
        setCaption({ who: "patient", text: line, lang });
        setActivity("patient");
      };
      // Only the scripted patient is voiced. What a person types or says as the patient is never sent to a speech provider.
      if (aloud) await speakLine({ role: "patient", text: line, lang }, soundRef.current, show);
      else {
        show();
        await sleep(350);
      }
      setActivity("thinking");
      sentAt.current = performance.now();
      try {
        adopt(await say.mutateAsync({ sessionId: call.id, text: line }));
      } finally {
        setActivity((current) => (current === "thinking" ? "idle" : current));
      }
    },
    [adopt, call, say],
  );

  const hangUp = useCallback(async (): Promise<void> => {
    if (call === null || call.ended !== null) return;
    stopSpeaking();
    adopt(await end.mutateAsync({ sessionId: call.id }));
  }, [adopt, call, end]);

  /** Resolves once everything the agent has to say so far has been said. */
  const settle = useCallback(async (): Promise<void> => {
    let seen: Promise<void>;
    do {
      await sleep(140);
      seen = chain.current;
      await seen;
    } while (seen !== chain.current);
  }, []);

  return { call, activity, setActivity, caption, responseMs, place, patientSays, hangUp, settle, error: start.error ?? say.error ?? end.error, busy: start.isPending || say.isPending };
}

export type CallControls = ReturnType<typeof useCall>;
