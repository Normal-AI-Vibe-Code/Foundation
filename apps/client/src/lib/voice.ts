/**
 * Talking to Foundation: the browser's speech recognition (Web Speech), one
 * utterance at a time. Used by the session composer's mic and by the HUD's
 * talk button (V), which sends what you said straight to the agent.
 *
 * In Chrome the audio goes to Google's recogniser (SPEC §7); Firefox has none,
 * and then this says so instead of listening.
 */

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void;
  onend: () => void;
  onerror: (e: { error: string }) => void;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionCtor = new () => Recognition;

export function voiceAvailable() {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

export interface Listening {
  /** finish: what was heard so far is final */
  stop(): void;
  /** drop it: nothing is sent */
  cancel(): void;
}

/**
 * Listen for one utterance. `heard` gets the words as they come (interim);
 * `done` gets the final words when the person stops talking (or stop()),
 * or an error a person can act on.
 */
export function listen(on: { heard(text: string): void; done(text: string): void; failed(message: string): void }): Listening | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) {
    on.failed("Voice needs a browser with speech recognition (Chrome, Edge, Safari).");
    return null;
  }
  const r = new Ctor();
  r.lang = navigator.language || "en-US";
  r.interimResults = true;
  r.continuous = false;
  let text = "";
  let cancelled = false;
  r.onresult = (e) => {
    text = Array.from(e.results)
      .map((x) => x[0].transcript)
      .join("");
    on.heard(text);
  };
  r.onerror = (e) => {
    if (e.error === "aborted" || e.error === "no-speech") return;
    on.failed(e.error === "not-allowed" ? "The browser didn't allow the microphone." : `Voice stopped: ${e.error}`);
  };
  r.onend = () => {
    if (!cancelled) on.done(text.trim());
  };
  r.start();
  return {
    stop: () => r.stop(),
    cancel: () => {
      cancelled = true;
      r.abort();
    },
  };
}
