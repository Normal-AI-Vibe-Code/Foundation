/**
 * Local speech-to-text: Whisper (tiny English) running in the webview via
 * transformers.js — WebGPU when available, WASM otherwise. Used by the
 * voice HUD wherever the platform lacks the Web Speech API (notably
 * WebView2 in the Tauri shell). The model downloads once (~40 MB) and is
 * cached by the browser afterwards.
 */

import { pipeline } from "@huggingface/transformers";

export type SttStatus = "idle" | "loading" | "ready" | "unavailable";

type AsrFn = (audio: Float32Array) => Promise<string>;

let asrPromise: Promise<AsrFn> | null = null;
let status: SttStatus = "idle";
const statusListeners = new Set<(s: SttStatus) => void>();

function setStatus(s: SttStatus) {
  status = s;
  for (const fn of statusListeners) fn(s);
}

export function sttStatus(): SttStatus {
  return status;
}

export function onSttStatus(fn: (s: SttStatus) => void): () => void {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

/** kick off model load in the background (idempotent) */
export function warmSTT() {
  if (asrPromise) return;
  setStatus("loading");
  asrPromise = (async () => {
    const attempts: Array<{ device: "webgpu" | "wasm" }> = [
      { device: "webgpu" },
      { device: "wasm" },
    ];
    let lastErr: unknown;
    for (const opts of attempts) {
      try {
        const asr = await pipeline(
          "automatic-speech-recognition",
          "onnx-community/whisper-tiny.en",
          opts,
        );
        setStatus("ready");
        return async (audio: Float32Array) => {
          const out = (await asr(audio)) as { text?: string } | Array<{ text?: string }>;
          const text = Array.isArray(out) ? out[0]?.text : out.text;
          return (text ?? "").trim();
        };
      } catch (e) {
        lastErr = e;
      }
    }
    setStatus("unavailable");
    throw lastErr;
  })();
  asrPromise.catch(() => {});
}

/** decode any recorded blob to the 16 kHz mono PCM whisper expects */
async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const actx = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await actx.decodeAudioData(buf);
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
    const out = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const d = decoded.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / decoded.numberOfChannels;
    }
    return out;
  } finally {
    void actx.close().catch(() => {});
  }
}

/** transcribe a recorded utterance; empty string when nothing was heard */
export async function transcribeBlob(blob: Blob): Promise<string> {
  warmSTT();
  const run = await asrPromise!;
  const audio = await decodeTo16kMono(blob);
  if (audio.length < 1600) return ""; // under 0.1s — nothing to hear
  const text = await run(audio);
  // whisper hallucinates fillers on silence — treat pure punctuation as empty
  if (/^[\s.,!?\-–—'"()]*$/.test(text)) return "";
  return text;
}
