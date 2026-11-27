/**
 * Ask this grid's agents, from the bottom bar (2026-11-26, Josh): the **Ask pill** is a line to type into, and what
 * you write goes to every agent on the grid at once (with none on it, the server's own agent takes it). A quick
 * **tap of Space** puts the caret in it.
 *
 * Aloud: **hold Space** anywhere on the board and a sheet rises from the bottom, listening. Your mic's level moves
 * in it (so you know it hears you) and your words show as they're heard; **let go to send**. Esc drops it. Nothing
 * is up over the bar until then: there is no box to type into but the pill.
 *
 * Space still pans: press the pointer while holding it and the sheet stands
 * down before it has heard anything (it waits 240 ms before it listens).
 * V and the HUD's mic pill open it too (press again to send).
 *
 * What you say goes the same way as what you type: to the grid's agents, each with its own name and cursor,
 * without opening a tab, so the board stays in view while you watch them work. If an agent session tab is
 * showing, what you say aloud goes there instead. The sheet lists the crew at work: what each is doing,
 * Stop, and Open (its session).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import { listen, voiceAvailable, type Listening } from "../lib/voice";
import { crewAsk, sayToAgent, stopSession, titleOf, useRecentCrewAsks, useSession } from "../state/sessions";
import { getUi, openSession, toast, useUi } from "../state/ui";
import { crewPeers, followCrew, followingCrew, type CrewPeer } from "./Crew";
import { stopAllOnBoard } from "./CommandBar";
import { useBoardTick } from "./Presence";
import { sayToCouncil, useCouncilSeats, useCrewOnCouncil, type CouncilSeat } from "../characters/Council";
import type { CouncilScope } from "../lib/councilOpen";
import { SendGlyph } from "./glyphs";

type Mode = "idle" | "listening";
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

function setMode(m: Mode, words = "") {
  mode = m;
  heard = words;
  emit();
}

const GRID: CouncilScope = { kind: "board" };
/** the grid's agents as the bar last saw them (HudAsk keeps it): what's said aloud goes to the same ones */
let gridSeats: CouncilSeat[] = [];

/** who a line from the bar goes to: every agent on the grid that can be reached (none on it: the server's own agent) */
export function askTargets(seats: CouncilSeat[]): { to: CouncilSeat[]; none: boolean } {
  const to = seats.filter((s) => !s.offline);
  return { to, none: seats.length > 0 && to.length === 0 };
}

/** ask every agent on this grid at once; false when there are agents and none of them is connected */
export function askGrid(text: string, seats: CouncilSeat[] = gridSeats): boolean {
  const t = text.trim();
  if (!t) return false;
  const { to, none } = askTargets(seats);
  if (none) {
    toast("None of this grid's agents is connected. Open the agents panel to see why.", "warn");
    return false;
  }
  sayToCouncil(GRID, t, to, true, null);
  return true;
}

/** where spoken words go: the agent session on screen if one is, else every agent on the grid */
function send(text: string) {
  const t = text.trim();
  if (!t) return;
  const ui = getUi();
  if (ui.sessions.some((x) => x.id === ui.session && x.kind === "agent")) sayToAgent(t);
  else askGrid(t);
}

/** put the caret in the bar's Ask pill (a tap of Space; no recogniser to talk to) */
function focusAsk() {
  document.querySelector<HTMLInputElement>("[data-hud-ask-text]")?.focus();
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
    focusAsk();
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

/** hold Space to talk (release sends), tap Space to type in the Ask pill; a pointer pressed meanwhile means it was a pan */
function useSpaceToTalk() {
  useEffect(() => {
    let held = false;
    let downAt = 0;
    let panned = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const blocked = () => getUi().command || getUi().presenting;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typingTarget(e.target) || blocked()) return;
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
      else if (performance.now() - downAt < 240 && !session) focusAsk(); // a tap: type in the bar's Ask pill
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
  // 2026-11-24 (Josh): an agent with a head to hang its work on (a seat on the open council) shows it there, not in the
  // strip over the bar; the open sheet still lists everyone (Stop all, Open)
  const onCouncil = useCrewOnCouncil();
  const listed = open ? crew : crew.filter((p) => !onCouncil.has(p.crew.id));
  const showRoster = open || listed.length > 0;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`hud-talk f-glass${m === "listening" ? " is-on" : ""}`}
        onClick={toggleTalk}
        aria-label={m === "listening" ? "Send voice prompt" : "Talk to this grid's agents"}
        data-tip={m === "listening" ? "Send · Esc drops it" : "Talk to this grid's agents"}
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
            aria-label={open ? "Voice prompt for this grid's agents" : "Agents at work"}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.99, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 280, damping: 26 }}
            data-mode={m}
          >
            {open && <TalkInput words={words} />}
            {listed.length > 0 && (
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
                {listed.map((p) => (
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
                <span>
                  Let go of <span className="f-kbd">Space</span> to send
                </span>
                <span>
                  <span className="f-kbd">Esc</span> drops it
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** the sheet's one line while it listens: the mic's level and the words as they're heard */
function TalkInput({ words }: { words: string }) {
  const bars = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  useMicLevel(true, bars);
  const onSession = getUi().sessions.some((x) => x.id === getUi().session && x.kind === "agent");
  return (
    <div className="talk-input">
      <span className="talk-level is-on" aria-hidden>
        {bars.map((b, i) => (
          <span key={i} ref={b} style={{ animationDelay: `${i * 90}ms` }} />
        ))}
      </span>
      <p className={`talk-heard${words ? "" : " is-empty"}`} role="status" aria-live="polite">
        {words || (onSession ? "Listening… for this session" : "Listening… say what this grid's agents should do")}
      </p>
    </div>
  );
}

/**
 * The bar's Ask pill (2026-11-26, Josh): a line to type into, and Enter sends it to every agent on this grid at
 * once. With no agent on the grid the server's own takes it. A viewer has no line: a viewer can't write a board.
 */
export function HudAsk() {
  const ui = useUi();
  const { seats } = useCouncilSeats(GRID);
  const [text, setText] = useState("");
  useEffect(() => {
    gridSeats = seats;
  }, [seats]);
  if (ui.role === "viewer") return null;
  const { to, none } = askTargets(seats);
  const whom = none ? "this grid's agents" : to.length > 1 ? `all ${to.length} agents` : to.length ? to[0].name : "an agent";
  const tip = none ? "None of this grid's agents is connected" : to.length > 1 ? `Ask all ${to.length} agents on this grid at once` : to.length ? `Ask ${to[0].name}, this grid's agent` : "Ask an agent to work on this grid";
  return (
    <form
      className="hud-ask-pill f-glass"
      data-hud-ask={to.length}
      data-tip={tip}
      data-kbd="Space"
      onSubmit={(e) => {
        e.preventDefault();
        if (askGrid(text, seats)) setText("");
      }}
    >
      <span className="hud-glyph" aria-hidden>
        ✦
      </span>
      <input
        className="hud-ask-text"
        data-hud-ask-text
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Ask ${whom}…`}
        aria-label={tip}
        autoComplete="off"
        onKeyDown={(e) => {
          // Esc clears the line first, then gives the keys back to the grid
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          if (text) setText("");
          else e.currentTarget.blur();
        }}
      />
      <button type="submit" className="hud-ask-send" disabled={!text.trim()} aria-label={`Send to ${whom}`}>
        <SendGlyph size={14} />
      </button>
    </form>
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
