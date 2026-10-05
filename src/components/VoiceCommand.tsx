import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { runCommand } from "../state/nl";
import { SttStatus, onSttStatus, sttStatus, transcribeBlob, warmSTT } from "../state/stt";
import { sfx } from "../sound/sfx";

/**
 * Hold SPACE to speak a command; the mic waveform renders live.
 * Release: the utterance is transcribed — by the platform's speech
 * recognition when it exists, otherwise by local Whisper (WebView2 in the
 * Tauri shell has no Web Speech API) — and the command runs. When nothing
 * was heard the HUD falls back to a text field.
 */

type Phase = "idle" | "listening" | "transcribing" | "typing" | "done";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function makeRecognizer(): SpeechRecognitionLike | null {
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
  if (!Ctor) return null;
  try {
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    return r;
  } catch {
    return null;
  }
}

export function VoiceCommand() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [micReady, setMicReady] = useState(false);
  const [modelStatus, setModelStatus] = useState<SttStatus>(sttStatus());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recStartRef = useRef(0);
  const peakRef = useRef(0); // loudest mic level seen this utterance
  const runIdRef = useRef(0); // cancels stale transcriptions
  const rafRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const transcriptRef = useRef("");
  transcriptRef.current = transcript;

  useEffect(() => onSttStatus(setModelStatus), []);

  // ----- waveform drawing -----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const bars = 36;
    const bw = W / bars;
    let data: Uint8Array | null = null;
    if (analyser) {
      data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
    }
    const t = performance.now() / 1000;
    for (let i = 0; i < bars; i++) {
      let v: number;
      if (data) {
        const idx = Math.floor((i / bars) * data.length * 0.5);
        v = data[idx] / 255;
        if (data[idx] > peakRef.current) peakRef.current = data[idx];
      } else {
        // no mic: gentle idle shimmer so the HUD still breathes
        v = 0.08 + 0.05 * Math.sin(t * 3 + i * 0.7);
      }
      const h = Math.max(2, v * H * 0.92);
      ctx.fillStyle = `rgba(47, 111, 237, ${0.35 + v * 0.65})`;
      const x = i * bw + bw * 0.22;
      ctx.beginPath();
      ctx.roundRect(x, (H - h) / 2, bw * 0.56, h, 3);
      ctx.fill();
    }
    rafRef.current = requestAnimationFrame(draw);
  }, []);

  // ----- start / stop listening -----

  /** stop the recorder and hand back everything it captured */
  const stopRecorder = useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        resolve(chunks.length ? new Blob(chunks, { type: recorder.mimeType }) : null);
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });
  }, []);

  const stopAll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    recRef.current?.abort();
    recRef.current = null;
    try {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    } catch { /* already stopped */ }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, []);

  const beginListening = useCallback(async () => {
    setTranscript("");
    setFeedback(null);
    setPhase("listening");
    sfx.recordOn();
    peakRef.current = 0;
    warmSTT(); // model loads in the background while the user speaks
    // speech recognition (when the platform provides it)
    const rec = makeRecognizer();
    if (rec) {
      rec.onresult = (ev) => {
        let text = "";
        for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
        setTranscript(text);
      };
      try {
        rec.start();
        recRef.current = rec;
      } catch { /* already started */ }
    }
    // microphone: level visualization + capture for whisper
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (phaseRef.current !== "listening") {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const actx = new AudioContext();
      audioCtxRef.current = actx;
      const src = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      analyserRef.current = analyser;
      setMicReady(true);
      // record the utterance so whisper can transcribe it on release
      try {
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : undefined;
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start(250);
        recorderRef.current = recorder;
        recStartRef.current = performance.now();
      } catch { /* no recorder — typing fallback still works */ }
    } catch {
      setMicReady(false);
    }
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  const execute = useCallback((text: string) => {
    const result = runCommand(text);
    setFeedback(result);
    if (result.ok) sfx.chime();
    else sfx.nope();
    setPhase("done");
    setTimeout(() => {
      setPhase((p) => (p === "done" ? "idle" : p));
    }, 1600);
  }, []);

  const fallbackToTyping = useCallback(() => {
    setPhase("typing");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const endListening = useCallback(() => {
    sfx.recordOff();
    const platformText = transcriptRef.current.trim();
    if (platformText) {
      // the platform recognizer already heard it
      stopAll();
      execute(platformText);
      return;
    }

    const heldMs = performance.now() - recStartRef.current;
    const heardSomething = peakRef.current > 24; // mic level ever rose above noise
    const recorder = recorderRef.current;
    if (!recorder || heldMs < 350 || !heardSomething) {
      // a tap, silence, or no mic — straight to typing
      stopAll();
      fallbackToTyping();
      return;
    }

    // whisper path: finish the recording, then transcribe locally
    const runId = ++runIdRef.current;
    setPhase("transcribing");
    void stopRecorder().then(async (blob) => {
      stopAll();
      if (runIdRef.current !== runId) return; // user cancelled
      let text = "";
      if (blob) {
        try {
          text = await transcribeBlob(blob);
        } catch { /* model unavailable */ }
      }
      if (runIdRef.current !== runId || phaseRef.current !== "transcribing") return;
      if (text) execute(text);
      else fallbackToTyping();
    });
  }, [stopAll, stopRecorder, execute, fallbackToTyping]);

  // ----- hold-space handling -----
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (el?.closest(".sheet, .map-body")) return; // typing space in a cell / map keys
      if (phaseRef.current !== "idle" && phaseRef.current !== "done") return;
      e.preventDefault();
      void beginListening();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (phaseRef.current !== "listening") return;
      e.preventDefault();
      endListening();
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || phaseRef.current !== "transcribing") return;
      e.stopPropagation();
      runIdRef.current++; // discard the in-flight transcription
      setPhase("typing");
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("keydown", cancel, { capture: true });
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("keydown", cancel, { capture: true });
      stopAll();
    };
  }, [beginListening, endListening, stopAll]);

  const visible = phase !== "idle";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="voice-hud"
          initial={{ y: 60, opacity: 0, scale: 0.92 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 40, opacity: 0, scale: 0.95 }}
          transition={{ type: "spring", stiffness: 320, damping: 24 }}
        >
          {phase === "listening" && (
            <>
              <div className={"voice-dot" + (micReady ? " live" : "")} />
              <canvas ref={canvasRef} className="voice-wave" width={280} height={44} />
              <div className="voice-text">
                {transcript || (micReady ? "Listening… release space to run" : "release space to type a command")}
              </div>
            </>
          )}
          {phase === "transcribing" && (
            <>
              <div className="voice-dot thinking" />
              <div className="voice-text">
                {modelStatus === "loading"
                  ? "downloading speech model… (first run only)"
                  : "transcribing…"}
              </div>
            </>
          )}
          {phase === "typing" && (
            <>
              <span className="voice-prompt">✳</span>
              <input
                ref={inputRef}
                className="voice-input"
                placeholder="add a table · map of team · split this section · add 3 rows…"
                spellCheck={false}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    execute((e.target as HTMLInputElement).value);
                  } else if (e.key === "Escape") {
                    setPhase("idle");
                  }
                }}
              />
            </>
          )}
          {phase === "done" && feedback && (
            <motion.div
              className={"voice-feedback" + (feedback.ok ? " ok" : " err")}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 22 }}
            >
              {feedback.ok ? "✓ " : "· "}
              {feedback.message}
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
