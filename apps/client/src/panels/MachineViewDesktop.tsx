/**
 * A machine card's Desktop view, and agents using it (Josh, 2026-11-15).
 *
 * The head carries a `Terminal · Desktop` switch while the machine runs.
 * Desktop shows the machine's graphical desktop: a real one inside it (an X
 * server, XFCE and VNC), drawn by noVNC in a frame (desktop.html) and reached
 * through Foundation, never a published port. No desktop yet: a well says so,
 * with **Add a desktop** (a person's press; it installs packages in the
 * machine) and the package manager's own progress.
 *
 * Using it follows the terminal's rule: a plain click puts the card in use
 * and gives the desktop the pointer and keys; the card wears the "in use"
 * ring and says "Keys go to this desktop · Esc Esc to leave". Esc twice, or a
 * click anywhere else, gives them back. Full screen is the card's own.
 *
 * Agents use the desktop only where a person pressed **Let agents use this
 * desktop** (off by default, with who and when, taken back with Stop). While
 * one does, a violet line says who and what it just did, with its last few
 * actions under it; when one asks without leave, the line offers the button.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MACHINE_AGENT_ACTIVE_MS, boardMaps, type DesktopLeave, type MachineAgentAct, type MachineState } from "@foundation/protocol";
import { activeBoard } from "../sync/board";
import { onLook } from "@foundation/ui";
import type { PanelMeta } from "../state/store";
import { SERVER_NAME, api } from "../lib/api";
import { desktopRefusal as refusalWords, olderServer } from "./machineWords";
import { askRestart } from "../server/desktop";
import { AgentGlyph, ClusterGlyph, DesktopGlyph, FunctionGlyph, LockGlyph, PackageGlyph, PopOutGlyph, PullGlyph, ShieldGlyph, TerminalGlyph, WarnGlyph } from "../shell/glyphs";
import { putInUse, toggleFullscreen } from "../lib/cardUse";
import { keys } from "../lib/keys";
import { getUi, setUi, toast, useUi } from "../state/ui";
import { KeysLine, ago, boardId, useNow, useRingWidth } from "./MachineViewBits";
import { copyText, readClipboard } from "./machineTerminal";
import { MachineTools, copiedWords, openMachineWindow, useFlash } from "./MachineTools";

export type MachineViewName = "terminal" | "desktop" | "io" | "access" | "cluster";

/** which view a card shows is each person's own, kept for the tab */
export function useMachineView(panelId: string): [MachineViewName, (v: MachineViewName) => void] {
  const k = `foundation-machine-view:${panelId}`;
  const [view, set] = useState<MachineViewName>(() => {
    try {
      const v = sessionStorage.getItem(k);
      return v === "desktop" || v === "io" || v === "access" || v === "cluster" ? v : "terminal";
    } catch {
      return "terminal";
    }
  });
  return [
    view,
    (v) => {
      set(v);
      try {
        sessionStorage.setItem(k, v);
      } catch {
        /* a private window */
      }
    },
  ];
}

/** the head's switch between the shell and the desktop, and (2026-11-17, Josh: "the full screen icon should be next to the desktop") full screen right beside it */
const VIEW_WORDS: Record<MachineViewName, { word: string; tip: string; glyph: ReactNode }> = {
  terminal: { word: "Terminal", tip: "The machine's shell, shared by everyone here", glyph: <TerminalGlyph size={15} /> },
  desktop: { word: "Desktop", tip: "The machine's graphical desktop", glyph: <DesktopGlyph size={15} /> },
  io: { word: "Ins & outs", tip: "What's wired in, what comes out, where it goes, and the functions the machine offers", glyph: <FunctionGlyph size={15} /> },
  access: { word: "Access", tip: "Who and what may use this machine: people, agents, links", glyph: <ShieldGlyph size={15} /> },
  cluster: { word: "Cluster", tip: "The Kubernetes cluster this machine serves: its nodes and pods", glyph: <ClusterGlyph size={15} /> },
};

export function ViewSwitch({ view, onView, panelId, only = ["terminal", "desktop", "io", "access"] }: { view: MachineViewName; onView?: (v: MachineViewName) => void; panelId?: string; only?: MachineViewName[] }) {
  return (
    <>
      <span className="machine-view" role="tablist" aria-label="What this card shows">
        {only.map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={`machine-view-tab${view === v ? " is-on" : ""}`} onClick={() => onView?.(v)} data-tip={VIEW_WORDS[v].tip} data-machine-view={v}>
            {VIEW_WORDS[v].glyph}
            <span>{VIEW_WORDS[v].word}</span>
          </button>
        ))}
      </span>
      {panelId && (
        <button type="button" className="machine-full" onClick={() => void toggleFullscreen(panelId)} aria-label="Full screen" data-tip="Full screen" data-kbd={keys("mod+enter")} data-machine-full>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
            <path d="M8.5 2.5h3v3M5.5 11.5h-3v-3M11.5 2.5 8 6M2.5 11.5 6 8" />
          </svg>
        </button>
      )}
    </>
  );
}

/** the desktop app (Tauri), which can restart this computer's server itself */
const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const post = (panelId: string, path: "desktop" | "agents", json: object = {}) => api<{ machine: MachineState }>(`/api/boards/${encodeURIComponent(boardId())}/machines/${panelId}/${path}`, { method: "POST", json });

/** why a press didn't work, for the card (machineWords.ts: a server older than the app says so) */
const desktopRefusal = (e: unknown, doing?: string) => refusalWords(e, SERVER_NAME, doing);

// ---------- the Desktop view ----------

export function Desktop({ panel, m, viewer }: { panel: PanelMeta; m: MachineState; viewer: boolean }) {
  const d = m.desktop;
  const [busy, setBusy] = useState(false);
  const [hasKeys, setHasKeys] = useState(false);
  // a press the server refused (or never got): the card says why, where the button is, until the next press
  const [refused, setRefused] = useState<string | null>(null);
  // the refusal was a server from before desktops: in the desktop app, the well offers to restart it
  const [older, setOlder] = useState(false);
  const add = async () => {
    setBusy(true);
    setRefused(null);
    setOlder(false);
    try {
      await post(panel.id, "desktop");
    } catch (e) {
      setRefused(desktopRefusal(e));
      setOlder(olderServer(e));
    } finally {
      setBusy(false);
    }
  };
  // the way out of an install: it is ended in the machine and the card goes back to "no desktop yet"
  const stop = async () => {
    setBusy(true);
    try {
      await post(panel.id, "desktop", { stop: true });
    } catch (e) {
      toast(desktopRefusal(e, "stop an install"), "bad");
    } finally {
      setBusy(false);
    }
  };
  if (d?.state === "ready") {
    return (
      <DesktopScreen panelId={panel.id} name={m.name} viewer={viewer} onKeys={setHasKeys}>
        <AgentsMay panelId={panel.id} m={m} viewer={viewer} />
        {hasKeys && !viewer && <KeysLine what="this desktop" inline />}
      </DesktopScreen>
    );
  }
  if (refused && d?.state !== "installing") return <DesktopWell state="error" detail={refused} name={m.name} viewer={viewer} busy={busy} onAdd={() => void add()} onRestart={older && inDesktop ? askRestart : undefined} />;
  return <DesktopWell state={d?.state ?? "none"} detail={d?.detail} name={m.name} viewer={viewer} busy={busy} onAdd={() => void add()} onStop={() => void stop()} />;
}

/**
 * No desktop yet, one being installed, or an install that failed (2026-11-17, Josh: "design the vm start
 * interface and add desktop feature a little better centering, making the text larger, and using icons to
 * indicate the right features"). One centred column: a 48 px round mark, a title at 18, what it is at 13.5,
 * what you get as three rows each led by its icon, the one blue action, and its terms as icon-led chips.
 * Failed is the same column with the warn mark and the whole reason (selectable, to copy). Installing is the
 * mark breathing, the package manager's own line and Stop. Also drawn on #/design.
 */
export function DesktopWell({ state, detail, name, viewer, busy, onAdd, onStop, onRestart }: { state: "none" | "installing" | "error"; detail?: string; name: string; viewer: boolean; busy?: boolean; onAdd?: () => void; onStop?: () => void; onRestart?: () => void }) {
  if (state === "installing") {
    return (
      <div className="machine-hero machine-progress machine-desk-progress">
        <span className="machine-hero-mark is-busy">
          <PackageGlyph size={22} />
        </span>
        <div className="machine-hero-title">Adding a desktop to {name}</div>
        <span className="machine-desk-said machine-copyable" onPointerDown={(e) => e.stopPropagation()}>
          <span className="f-dot is-warn is-live" />
          Adding a desktop: {detail ?? "starting…"}
        </span>
        {/* a person can always leave this state: an install that has gone quiet says so in its line, and Stop ends it */}
        {!viewer && (
          <button className="f-pill machine-desk-stop" disabled={busy} onClick={onStop} data-tip="Ends the install in the machine. What it has unpacked stays on the machine's disk; Add a desktop picks up from there.">
            Stop
          </button>
        )}
      </div>
    );
  }
  const failed = state === "error";
  return (
    <div className={`machine-well machine-hero machine-desk-well${failed ? " is-failed" : ""}`}>
      <span className={`machine-hero-mark${failed ? " is-warn" : ""}`}>{failed ? <WarnGlyph size={22} /> : <DesktopGlyph size={22} />}</span>
      <div className="machine-hero-title connector-offline-title">{failed ? `The desktop didn't go in` : `${name} has no desktop yet`}</div>
      {failed ? (
        // the whole reason, which can be copied out (a press here doesn't move the card)
        <div className="machine-hero-lede machine-copyable connector-offline-reason" onPointerDown={(e) => e.stopPropagation()}>
          {detail}
        </div>
      ) : (
        <>
          <div className="machine-hero-lede connector-offline-reason">A real desktop inside the machine: an X server, XFCE and VNC.</div>
          <ul className="machine-feats">
            <li>
              <DesktopGlyph />
              <span>
                <b>Use it on this card</b> · click the screen and the keys are the machine's
              </span>
            </li>
            <li>
              <PopOutGlyph />
              <span>
                <b>Or in a window of its own</b> · full screen, none of Foundation's shortcuts
              </span>
            </li>
            <li className="is-agent">
              <AgentGlyph />
              <span>
                <b>Agents can use it too</b> · only once you let them
              </span>
            </li>
          </ul>
        </>
      )}
      {viewer ? (
        <div className="machine-note">View only: someone who can edit this board adds it.</div>
      ) : (
        <div className="machine-hero-go">
          {onRestart && (
            <button className="f-pill is-accent machine-hero-button" disabled={busy} onClick={onRestart} data-tip="Stops this computer's Foundation server and starts it again from its folder, so it runs the code that's there now. The app reloads when it's back.">
              Restart the server
            </button>
          )}
          <button className={`f-pill machine-hero-button${onRestart ? "" : " is-accent"}`} disabled={busy} onClick={onAdd}>
            {busy ? "Starting…" : failed ? "Try again" : "Add a desktop"}
          </button>
        </div>
      )}
      {!viewer && !failed && (
        <ul className="machine-hero-terms machine-terms">
          <li>
            <PackageGlyph size={14} /> Installs packages in the machine · Ubuntu, Debian, Alpine
          </li>
          <li>
            <PullGlyph size={14} /> A few minutes
          </li>
          <li>
            <LockGlyph size={14} /> Nothing is published
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * The machine's screen in its frame, and under it the tools row (MachineTools.tsx), which also carries what's
 * given as children (the agents' leave, the keys line): under the screen, never over it, so the machine's own
 * screen stays whole. `alone`: in a window of its own (machineWindow.tsx), where the desktop has the keys from
 * the start and there is no grid to zoom, card to use or ring to draw.
 */
export function DesktopScreen({ panelId, name, viewer, onKeys, alone, board, onFull, children }: { panelId: string; name: string; viewer: boolean; onKeys: (on: boolean) => void; alone?: boolean; board?: string; onFull?: () => void; children?: ReactNode }) {
  const bid = board ?? boardId();
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const engaged = useUi().engaged === panelId;
  const inUse = Boolean(alone) || engaged;
  const [hasKeys, setKeys] = useState(false);
  // the last text the machine copied (x11vnc sends its selection): Copy puts it on this computer's clipboard again
  const [clip, setClip] = useState("");
  const [flash, say] = useFlash(2400);
  const setHasKeys = (on: boolean) => {
    setKeys(on);
    onKeys(on);
  };
  useEffect(() => () => onKeys(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState<string | null>("Opening the desktop…");
  // the last word on a connection that won't be tried again by itself: the card offers the way back
  const [final, setFinal] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // the machine's screen as it came (1280×800): the ring goes round the picture, not the letterbox
  const [shape, setShape] = useState<{ w: number; h: number } | null>(null);
  useRingWidth(wrap, hasKeys && !viewer && !alone);
  const src = `${import.meta.env.BASE_URL}desktop.html#board=${encodeURIComponent(bid)}&panel=${encodeURIComponent(panelId)}${viewer ? "&view=1" : ""}`;
  const tell = (cmd: string, more: object = {}) => frame.current?.contentWindow?.postMessage({ type: "foundation:desktop", cmd, ...more }, window.location.origin);
  // the frame's ground is the card's, in day and night (a frame can't read our tokens)
  const paint = () => wrap.current && tell("paint", { background: getComputedStyle(wrap.current).backgroundColor });

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; event?: string; on?: boolean; reason?: string; final?: boolean; w?: number; h?: number; text?: string; copied?: boolean; dx?: number; dy?: number; mode?: number; x?: number; y?: number };
      if (d?.type !== "foundation:desktop") return;
      if (d.event === "connected") {
        setNote(null);
        setFinal(false);
        setShape(d.w && d.h ? { w: d.w, h: d.h } : null);
        paint();
      } else if (d.event === "closed") {
        setNote(d.reason ?? "The desktop closed.");
        setFinal(Boolean(d.final));
      } else if (d.event === "keys") {
        setHasKeys(Boolean(d.on));
        if (d.on && !alone) putInUse(panelId);
      } else if (d.event === "leave") {
        if (alone) return; // a window of its own has nothing to leave to
        frame.current?.blur();
        if (getUi().engaged === panelId) setUi({ engaged: null });
      } else if (d.event === "clip" && d.text) {
        setClip(d.text);
        say(d.copied ? `${copiedWords(d.text)} from the machine` : "The machine copied text: Copy puts it on your clipboard");
      } else if (d.event === "wheel" && !alone) {
        // ⌘/Ctrl-wheel over the screen is the grid's zoom (lib/cardUse.ts), about the same point: the frame
        // measures in its own unscaled pixels, the card is drawn at the board's scale
        const f = frame.current;
        if (!f) return;
        const r = f.getBoundingClientRect();
        const k = f.clientWidth ? r.width / f.clientWidth : 1;
        f.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaX: d.dx ?? 0, deltaY: d.dy ?? 0, deltaMode: d.mode ?? 0, clientX: r.left + (d.x ?? 0) * k, clientY: r.top + (d.y ?? 0) * k }));
      }
    };
    window.addEventListener("message", onMsg);
    const offNight = onLook(() => {
      for (const ms of [0, 700, 1500]) setTimeout(paint, ms);
    });
    return () => {
      window.removeEventListener("message", onMsg);
      offNight();
    };
  }, [panelId]); // eslint-disable-line react-hooks/exhaustive-deps

  // the card's use ended (a click elsewhere, Esc Esc): the desktop gives the keys back
  useEffect(() => {
    if (inUse) return;
    tell("blur");
    if (document.activeElement === frame.current) frame.current?.blur();
    setHasKeys(false);
  }, [inUse]); // eslint-disable-line react-hooks/exhaustive-deps

  const use = () => {
    if (!alone) putInUse(panelId);
    frame.current?.focus();
    tell("focus");
  };
  const copy = async () => {
    if (!clip) return say("Select or copy text in the machine first", "warn");
    say((await copyText(clip)) ? copiedWords(clip) : "Your browser didn't allow the copy", "ok");
  };
  const paste = async () => {
    const text = await readClipboard();
    if (text === null) return say("Your browser didn't let Foundation read the clipboard: press Ctrl+V in the machine", "warn");
    if (!text) return say("Your clipboard is empty", "warn");
    use();
    tell("type", { text });
    say(`Typed ${copiedWords(text).slice("Copied ".length)} into the machine`);
  };
  return (
    <>
    <div ref={wrap} className={`machine-desk${inUse ? " is-in-use" : ""}${hasKeys && !viewer ? " has-keys" : ""}${alone ? " is-alone" : ""}`}>
      {/* in a window of its own the desktop takes the keys as soon as it's there */}
      <iframe key={attempt} ref={frame} src={src} title={`${name}'s desktop`} onLoad={() => (paint(), alone && use())} allow="clipboard-read; clipboard-write" />
      {hasKeys && !viewer && !alone && <span className={`machine-desk-ring${shape ? " is-screen" : ""}`} style={shape ? ({ "--screen-ar": String(shape.w / shape.h) } as CSSProperties) : undefined} />}
      {!inUse && (
        // a plain click uses the desktop, as it puts the caret in the terminal; until then the wheel and the pointer are the grid's
        <div className="machine-desk-shield" onPointerDown={(e) => e.stopPropagation()} onClick={use}>
          {!note && <span className="f-pill machine-desk-hint">{viewer ? "Click to look closer" : "Click to use the desktop"}</span>}
        </div>
      )}
      {viewer && <div className="machine-watching">View only: you're watching</div>}
      {note && (
        <div className={`machine-closed${final ? " is-final" : ""}`}>
          <span>{note}</span>
          {final && (
            <button
              className="f-pill"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setNote("Opening the desktop…");
                setFinal(false);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
    <MachineTools view="desktop" canType={!viewer} canCopy={Boolean(clip)} flash={flash} onCopy={() => void copy()} onPaste={() => void paste()} onFull={onFull} onPopOut={alone ? undefined : () => void openMachineWindow(bid, panelId, "desktop", name, viewer)}>
      {children}
    </MachineTools>
    </>
  );
}

// ---------- agents: leave, and who is driving ----------

/** agents' leave to use this desktop, and an agent's ask for it: the board's `desktopLeave`, written by the server alone */
export function useDesktopLeave(panelId: string): DesktopLeave {
  const [leave, setLeave] = useState<DesktopLeave>({});
  useEffect(() => {
    const b = activeBoard();
    if (!b) return;
    const map = boardMaps(b.doc).desktopLeave;
    const read = () => setLeave(map.get(panelId) ?? {});
    read();
    const onChange = (e: { keysChanged: Set<string> }) => e.keysChanged.has(panelId) && read();
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [panelId]);
  return leave;
}

function AgentsMay({ panelId, viewer }: { panelId: string; m: MachineState; viewer: boolean }) {
  const leave = useDesktopLeave(panelId);
  const [busy, setBusy] = useState(false);
  const set = async (allow: boolean) => {
    setBusy(true);
    try {
      await post(panelId, "agents", { allow });
    } catch (e) {
      toast(desktopRefusal(e, "let agents use a desktop"), "bad");
    } finally {
      setBusy(false);
    }
  };
  return <AgentsMayLine may={leave.agentsMay} viewer={viewer} busy={busy} onSet={(allow) => void set(allow)} />;
}

/** the leave agents have (or don't) to use this desktop. Also drawn on #/design. */
export function AgentsMayLine({ may, viewer, busy, onSet, now = Date.now() }: { may?: DesktopLeave["agentsMay"]; viewer: boolean; busy?: boolean; onSet?: (allow: boolean) => void; now?: number }) {
  return (
    <div className={`machine-may${may ? " is-on" : ""}`}>
      {may ? (
        <>
          <span className="f-dot is-agent" />
          <span className="machine-may-what">
            Agents may use this desktop <span className="machine-may-by">· {may.by} let them, {ago(may.at, now)}</span>
          </span>
          {!viewer && (
            <button className="f-pill" disabled={busy} onClick={() => onSet?.(false)} data-tip="Agents stop being able to look at or use this desktop">
              Stop
            </button>
          )}
        </>
      ) : viewer ? (
        <span className="machine-may-by">Agents can't use this desktop. Someone who can edit this board decides.</span>
      ) : (
        <>
          <button className="f-pill" disabled={busy} onClick={() => onSet?.(true)}>
            Let agents use this desktop
          </button>
          <span className="machine-terms">They can then look at the screen, move the pointer and type · each action shows here and in the activity · off until you press</span>
        </>
      )}
    </div>
  );
}

/**
 * Who is using the desktop, on the card whichever view it shows: a violet
 * line while an agent drives (its last few actions under it), or an agent's
 * ask for leave with the person's button.
 */
export function AgentUse({ panelId, m, viewer, view, onWatch }: { panelId: string; m: MachineState; viewer: boolean; view: MachineViewName; onWatch: () => void }) {
  const leave = useDesktopLeave(panelId);
  const last = m.agentActs?.at(-1);
  const asked = leave.agentAsked && !leave.agentsMay ? leave.agentAsked : undefined;
  const now = useNow(Boolean(last && Date.now() - last.at < MACHINE_AGENT_ACTIVE_MS + 2000) || Boolean(asked));
  const [busy, setBusy] = useState(false);
  const driving = last && now - last.at < MACHINE_AGENT_ACTIVE_MS;
  const asking = asked && now - asked.at < 5 * 60_000;
  if (!driving && !asking) return null;
  const allow = async () => {
    setBusy(true);
    try {
      await post(panelId, "agents", { allow: true });
    } catch (e) {
      toast(desktopRefusal(e, "let agents use a desktop"), "bad");
    } finally {
      setBusy(false);
    }
  };
  return <AgentUseLine acts={driving ? (m.agentActs ?? []) : []} asked={driving ? undefined : asked} viewer={viewer} now={now} watching={view === "desktop"} busy={busy} onWatch={onWatch} onAllow={() => void allow()} />;
}

/** Also drawn on #/design. */
export function AgentUseLine({ acts, asked, viewer, now, watching, busy, onWatch, onAllow }: { acts: MachineAgentAct[]; asked?: DesktopLeave["agentAsked"]; viewer: boolean; now: number; watching?: boolean; busy?: boolean; onWatch?: () => void; onAllow?: () => void }) {
  const last = acts.at(-1);
  if (!last && asked) {
    return (
      <div className="machine-agent is-asking">
        <div className="machine-agent-head">
          <span className="f-dot is-agent is-live" />
          <span className="machine-agent-who">✦ {asked.by}</span>
          <span className="machine-agent-did">asks to use this desktop{asked.for && asked.for !== asked.by ? ` · for ${asked.for}` : ""}</span>
          {viewer ? (
            <span className="machine-ask-note">View only: someone who can edit decides.</span>
          ) : (
            <button className="f-pill machine-agent-act" disabled={busy} onClick={onAllow} data-tip="Agents can then look at the screen, move the pointer and type on this machine's desktop. Stop takes it back.">
              Let agents use this desktop
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!last) return null;
  return (
    <div className="machine-agent is-driving">
      <div className="machine-agent-head">
        <span className="f-dot is-agent is-live" />
        <span className="machine-agent-who">✦ {last.by}</span>
        <span className="machine-agent-did">
          is using this desktop · {last.did}
          {last.for && last.for !== last.by ? ` · for ${last.for}` : ""}
        </span>
        {!watching && (
          <button className="f-pill machine-agent-act" onClick={onWatch}>
            Watch
          </button>
        )}
      </div>
      {acts.length > 1 && (
        <ol className="machine-agent-acts">
          {acts
            .slice(0, -1)
            .reverse()
            .map((a) => (
              <li key={a.at}>
                <span className="machine-agent-past">{a.by === last.by ? a.did : `${a.by} ${a.did}`}</span>
                <span className="machine-agent-when">{ago(a.at, now)}</span>
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}
