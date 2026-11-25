/**
 * Talk to the crew: **hold Space** anywhere on the board and a sheet rises
 * from the bottom, listening. Your mic's level moves in it (so you know it
 * hears you) and your words show as they're heard; **let go to send**. A
 * quick **tap of Space** opens it for typing instead. Esc drops it.
 *
 * Space still pans: press the pointer while holding it and the sheet stands
 * down before it has heard anything (it waits 240 ms before it listens).
 * V and the HUD's mic pill open it too (press again to send).
 *
 * What you say goes to a new agent of the crew, with its own name and
 * cursor, without opening a tab, so the board stays in view while you watch
 * it work; several can run at once. If an agent session tab is showing, it
 * goes there instead. The sheet lists the crew at work: what each is doing,
 * Stop, and Open (its session).
 */

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { listen, voiceAvailable, type Listening } from "../lib/voice";
import { askCrew, crewAsk, sayToAgent, stopSession, titleOf, useRecentCrewAsks, useSession } from "../state/sessions";
import { getUi, openSession, toast } from "../state/ui";
import { holdsKeys } from "../lib/keysHeld";
import { crewPeers, followCrew, followingCrew, type CrewPeer } from "./Crew";
import { stopAllOnBoard } from "./CommandBar";
import { useBoardTick } from "./Presence";

type Mode = "idle" | "listening" | "typing";
let mode: Mode = "idle";
let heard = "";
let session: Listening | null = null;
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  subs.forEach((f) => f());
};

export function talking() {
  return mode === "listening";
}

/** the sheet is open for typing: the board's one-key shortcuts stand down (Shell) */
export function talkTyping() {
  return mode === "typing";
}

/**
 * Keys typed in the moment between a tap of Space and the field taking focus
 * belong to the field, not the board (an "a" there toggled the agent layer).
 * Registered at import, so it runs before the shell's own capture listener.
 */
let early = "";
function holdEarlyKeys(e: KeyboardEvent) {
  // a key typed into a machine's shell or desktop is the machine's, even with the sheet open (lib/keysHeld.ts)
  if (mode !== "typing" || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || holdsKeys(e.target)) return;
  const field = document.querySelector<HTMLTextAreaElement>(".talk-field");
  if (field && document.activeElement === field) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  early += e.key;
  if (field) takeEarlyKeys(field);
}
function takeEarlyKeys(field: HTMLTextAreaElement) {
  field.focus();
  if (!early) return;
  field.value += early;
  field.setSelectionRange(field.value.length, field.value.length);
  early = "";
}
if (typeof window !== "undefined") window.addEventListener("keydown", holdEarlyKeys, true);

function setMode(m: Mode, words = "") {
  // opening for typing starts empty: a sheet reopened while it was still closing keeps its old field
  if (m === "typing" && mode !== "typing") {
    early = "";
    document.querySelectorAll<HTMLTextAreaElement>(".talk-field").forEach((f) => (f.value = ""));
  }
  mode = m;
  heard = words;
  emit();
}

/** where words go: the agent session on screen if one is, else a new crew agent */
function send(text: string) {
  const t = text.trim();
  if (!t) return;
  const ui = getUi();
  if (ui.sessions.some((x) => x.id === ui.session && x.kind === "agent")) sayToAgent(t);
  else askCrew(t);
}

/** start listening, or (when already listening) finish and send */
export function toggleTalk() {
  if (session) return session.stop();
  startListening();
}

function startListening() {
  if (session) return;
  if (!voiceAvailable()) {
    // no recogniser here: type instead, and say why
    setMode("typing");
    toast("Voice needs speech recognition (Chrome, Edge, Safari). Type instead.", "warn");
    return;
  }
  setMode("listening");
  session = listen({
    heard: (t) => {
      heard = t;
      emit();
    },
    done: (t) => {
      session = null;
      setMode("idle");
      if (t) send(t);
    },
    failed: (m) => {
      session = null;
      setMode("idle");
      toast(m, "warn");
    },
  });
  if (!session) setMode("idle");
}

export function cancelTalk() {
  session?.cancel();
  session = null;
  setMode("idle");
}

function openTyping() {
  if (session) return;
  setMode("typing");
}

function useTalk() {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return { mode, heard };
}

const typingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** hold Space to talk (release sends), tap Space to type; a pointer pressed meanwhile means it was a pan */
function useSpaceToTalk() {
  useEffect(() => {
    let held = false;
    let downAt = 0;
    let panned = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const blocked = () => getUi().command || getUi().presenting;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typingTarget(e.target) || blocked()) return;
      if (mode === "typing") return;
      if (mode === "listening") return; // V started it: Space doesn't stop it
      held = true;
      panned = false;
      downAt = performance.now();
      timer = setTimeout(() => {
        timer = null;
        if (held && !panned) startListening();
      }, 240);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !held) return;
      held = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (panned) return;
      if (mode === "listening" && session) session.stop(); // let go: what was heard is sent
      else if (performance.now() - downAt < 240) openTyping();
    };
    const pointer = () => {
      if (!held) return;
      panned = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // it was a pan: stand down if nothing's been said yet
      if (mode === "listening" && !heard) cancelTalk();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("pointerdown", pointer, true);
      if (timer) clearTimeout(timer);
    };
  }, []);
}

/** the mic's level, written to the bars directly (no render per frame); silent if the mic isn't ours to read */
/** the microphone is already allowed here (no prompt would show); unknown counts as no */
async function micAllowed(): Promise<boolean> {
  try {
    const p = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return p?.state === "granted";
  } catch {
    return false;
  }
}

function useMicLevel(on: boolean, bars: React.RefObject<HTMLSpanElement | null>[]) {
  useEffect(() => {
    if (!on || !navigator.mediaDevices?.getUserMedia) return;
    let stop = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    // the level meter opens the mic a second time (Web Speech can't share its stream). Only once the
    // microphone is already allowed, so it never asks a second time; until then the bars breathe.
    void micAllowed()
      .then((ok) => (ok && !stop ? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) : Promise.reject(new Error("not yet allowed"))))
      .then((s) => {
        if (stop) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(an);
        const data = new Uint8Array(an.fftSize);
        let level = 0;
        const shape = [0.55, 0.85, 1, 0.8, 0.5];
        document.querySelector(".talk-level")?.classList.add("has-mic"); // the bars follow the mic now, not a breath
        const tick = (t: number) => {
          an.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          level += (Math.min(1, rms * 5) - level) * 0.35;
          bars.forEach((b, i) => {
            const wob = 0.82 + 0.18 * Math.sin(t / 90 + i * 1.7);
            if (b.current) b.current.style.transform = `scaleY(${(0.18 + level * shape[i] * wob).toFixed(3)})`;
          });
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      })
      .catch(() => {
        /* no mic permission: the bars breathe instead (CSS) */
      });
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      bars.forEach((b) => b.current && (b.current.style.transform = ""));
    };
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function TalkButton() {
  const { mode: m, heard: words } = useTalk();
  const board = useBoardTick();
  useSpaceToTalk();
  const open = m !== "idle";
  const prevFocus = useRef<HTMLElement | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    prevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelTalk();
      const target = prevFocus.current?.isConnected ? prevFocus.current : btnRef.current;
      requestAnimationFrame(() => target?.focus());
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [open]);

  const crew = crewPeers(board?.peers() ?? []);
  const me = board?.user.id;
  const mine = crew.filter((p) => p.crew.asker === me);
  const mineWorking = mine.filter((p) => p.crew.status === "working").length;
  const recent = useRecentCrewAsks(new Set(crew.map((p) => p.crew.id)));
  const showRoster = open || crew.length > 0;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`hud-talk f-glass${m === "listening" ? " is-on" : ""}`}
        onClick={() => (m === "typing" ? cancelTalk() : toggleTalk())}
        aria-label={m === "listening" ? "Send voice prompt" : m === "typing" ? "Close crew prompt" : "Talk to the crew"}
        data-tip={m === "listening" ? "Send · Esc drops it" : "Talk to the crew"}
        data-kbd={m === "listening" ? "V" : "hold Space"}
        aria-pressed={m === "listening"}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="5.5" y="1.5" width="5" height="9" rx="2.5" />
          <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" strokeLinecap="round" />
        </svg>
        {m === "idle" && <span className="f-kbd">Space</span>}
        {mine.length > 0 && m === "idle" && <span className="hud-talk-count">{mine.length}</span>}
      </button>
      <AnimatePresence>
        {showRoster && (
          <motion.div
            className={`talk-sheet f-glass${open ? " is-open" : " is-roster"}`}
            role={open ? "dialog" : "region"}
            aria-modal={open ? "true" : undefined}
            aria-label={open ? (m === "listening" ? "Voice prompt for the crew" : "Ask the crew") : "Agents at work"}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.99, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 280, damping: 26 }}
            data-mode={m}
          >
            {open && <TalkInput mode={m} words={words} />}
            {crew.length > 0 && (
              <ul className="crew-roster" aria-label="The crew at work">
                {mineWorking > 1 && (
                  <li className="crew-row crew-row-all">
                    <span className="crew-row-doing">{mineWorking} of yours at work</span>
                    <span className="crew-row-actions">
                      <button type="button" className="crew-row-btn is-stop" onClick={() => void stopAllOnBoard()} data-tip="Stop every agent of yours on this grid, helpers too">
                        Stop all
                      </button>
                    </span>
                  </li>
                )}
                {crew.map((p) => (
                  <RosterRow key={p.clientId} peer={p} mine={p.crew.asker === me} />
                ))}
              </ul>
            )}
            {open && recent.length > 0 && (
              <ul className="crew-roster is-recent" aria-label="Your recent asks">
                {recent.map((a) => (
                  <li key={a.session} className={`crew-row is-mine is-${a.status === "running" ? "done" : a.status}`} style={{ ["--crew" as string]: `var(--color-crew-${a.hue % 6})` }}>
                    <span className="crew-row-dot" />
                    <span className="crew-row-name">{a.name}</span>
                    <span className="crew-row-doing">
                      {a.status === "error" ? "hit a problem" : a.status === "stopped" ? "stopped" : "done"}
                      <span className="crew-row-for"> · {titleOf(a.prompt)}</span>
                    </span>
                    <span className="crew-row-actions">
                      <button type="button" className="crew-row-btn" onClick={() => openSession({ id: a.session, kind: "agent", title: titleOf(a.prompt) })} data-tip="Open its session: what it did, step by step">
                        Open
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {open && (
              <div className="talk-hints">
                {m === "listening" ? (
                  <>
                    <span>
                      Let go of <span className="f-kbd">Space</span> to send
                    </span>
                    <span>
                      <span className="f-kbd">Esc</span> drops it
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      <span className="f-kbd">↵</span> sends
                    </span>
                    <span>
                      Hold <span className="f-kbd">Space</span> on the grid to talk
                    </span>
                    <span>
                      <span className="f-kbd">Esc</span> closes
                    </span>
                  </>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function TalkInput({ mode: m, words }: { mode: Mode; words: string }) {
  const bars = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  useMicLevel(m === "listening", bars);
  const field = useRef<HTMLTextAreaElement>(null);
  // focus in the same commit (not a frame later), and take anything typed before it
  useLayoutEffect(() => {
    if (m === "typing" && field.current) takeEarlyKeys(field.current);
  }, [m]);
  useEffect(() => {
    if (m !== "typing") early = "";
  }, [m]);
  const onSession = getUi().sessions.some((x) => x.id === getUi().session && x.kind === "agent");
  return (
    <div className="talk-input">
      <span className={`talk-level${m === "listening" ? " is-on" : ""}`} aria-hidden>
        {bars.map((b, i) => (
          <span key={i} ref={b} style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </span>
      {m === "listening" ? (
        <p className={`talk-heard${words ? "" : " is-empty"}`} role="status" aria-live="polite">
          {words || (onSession ? "Listening… for this session" : "Listening… say what the crew should do")}
        </p>
      ) : (
        <textarea
          ref={field}
          className="talk-field"
          rows={1}
          aria-label={onSession ? "Message for this session" : "Ask the crew"}
          placeholder={onSession ? "Tell this session…" : "Ask the crew: make a section for…, hook up FactoryForm…"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const t = e.currentTarget.value;
              cancelTalk();
              send(t);
            }
          }}
        />
      )}
    </div>
  );
}

function RosterRow({ peer, mine }: { peer: CrewPeer; mine: boolean }) {
  const c = peer.crew;
  const ask = crewAsk(c.id);
  const run = useSession(ask?.session ?? null);
  const busy = run.busy && c.status === "working";
  return (
    <li className={`crew-row${mine ? " is-mine" : ""} is-${c.status}`} style={{ ["--crew" as string]: `var(--color-crew-${c.hue % 6})` }} data-crew-row={peer.user.name}>
      <span className="crew-row-dot" />
      <span className="crew-row-name">{peer.user.name}</span>
      <span className="crew-row-doing">
        {c.status === "working" ? c.doing : c.status === "done" ? "done" : c.status === "stopped" ? "stopped" : "hit a problem"}
        {!mine && <span className="crew-row-for"> · for {c.askerName.split(" ")[0]}</span>}
        {c.leadName && <span className="crew-row-for"> · with {c.leadName}</span>}
      </span>
      <span className="crew-row-actions">
        {c.status === "working" && (
          <button
            className={`crew-row-btn${followingCrew() === c.id ? " is-on" : ""}`}
            onClick={() => followCrew(followingCrew() === c.id ? null : c.id)}
            data-tip={followingCrew() === c.id ? "Stop following" : `Follow ${peer.user.name}: your view rides along until you move`}
          >
            {followingCrew() === c.id ? "Following" : "Follow"}
          </button>
        )}
      </span>
      {mine && ask && (
        <span className="crew-row-actions">
          <button className="crew-row-btn" onClick={() => openSession({ id: ask.session, kind: "agent", title: titleOf(ask.prompt) })} data-tip="Open its session">
            Open
          </button>
          {busy && (
            <button className="crew-row-btn is-stop" onClick={() => stopSession(ask.session)} data-tip={`Stop ${peer.user.name}`}>
              Stop
            </button>
          )}
        </span>
      )}
    </li>
  );
}
