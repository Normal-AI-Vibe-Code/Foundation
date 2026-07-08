import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { runCommand } from "../state/nl";
import { sfx } from "../sound/sfx";

/**
 * Hold SPACE to speak a command; the mic waveform renders live.
 * Release: if speech was recognized it runs immediately; otherwise the HUD
 * stays open with a text field (works in environments without speech
 * recognition or a microphone). Focus context comes from the store.
 */

type Phase = "idle" | "listening" | "typing" | "done";

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const rafRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const transcriptRef = useRef("");
  transcriptRef.current = transcript;

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
  const stopAll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    recRef.current?.abort();
    recRef.current = null;
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
    // microphone level visualization
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

  const endListening = useCallback(() => {
    sfx.recordOff();
    stopAll();
    const text = transcriptRef.current.trim();
    if (text) {
      execute(text);
    } else {
      // no speech captured — fall back to typing
      setPhase("typing");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [stopAll, execute]);

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
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
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
