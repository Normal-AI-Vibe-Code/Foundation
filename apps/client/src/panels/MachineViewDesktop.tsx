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

import { useEffect, useRef, useState } from "react";
import { MACHINE_AGENT_ACTIVE_MS, type MachineAgentAct, type MachineState } from "@foundation/protocol";
import { onNight } from "@foundation/ui";
import type { PanelMeta } from "../state/store";
import { api } from "../lib/api";
import { putInUse } from "../lib/cardUse";
import { getUi, setUi, toast, useUi } from "../state/ui";
import { KeysLine, ago, boardId, useNow } from "./MachineViewBits";

export type MachineViewName = "terminal" | "desktop";

/** which view a card shows is each person's own, kept for the tab */
export function useMachineView(panelId: string): [MachineViewName, (v: MachineViewName) => void] {
  const k = `foundation-machine-view:${panelId}`;
  const [view, set] = useState<MachineViewName>(() => {
    try {
      return sessionStorage.getItem(k) === "desktop" ? "desktop" : "terminal";
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

/** the head's switch between the shell and the desktop */
export function ViewSwitch({ view, onView }: { view: MachineViewName; onView?: (v: MachineViewName) => void }) {
  return (
    <span className="machine-view" role="tablist" aria-label="What this card shows">
      {(["terminal", "desktop"] as const).map((v) => (
        <button key={v} role="tab" aria-selected={view === v} className={`machine-view-tab${view === v ? " is-on" : ""}`} onClick={() => onView?.(v)} data-tip={v === "terminal" ? "The machine's shell, shared by everyone here" : "The machine's graphical desktop"}>
          {v === "terminal" ? "Terminal" : "Desktop"}
        </button>
      ))}
    </span>
  );
}

const post = (panelId: string, path: "desktop" | "agents", json: object = {}) => api<{ machine: MachineState }>(`/api/boards/${encodeURIComponent(boardId())}/machines/${panelId}/${path}`, { method: "POST", json });

// ---------- the Desktop view ----------

export function Desktop({ panel, m, viewer }: { panel: PanelMeta; m: MachineState; viewer: boolean }) {
  const d = m.desktop;
  const [busy, setBusy] = useState(false);
  const [hasKeys, setHasKeys] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await post(panel.id, "desktop");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  if (d?.state === "ready") {
    return (
      <>
        <DesktopScreen panelId={panel.id} name={m.name} viewer={viewer} onKeys={setHasKeys} />
        {/* under the screen, not over it: the machine's own screen stays whole */}
        <div className="machine-desk-foot">
          <AgentsMay panelId={panel.id} m={m} viewer={viewer} />
          {hasKeys && !viewer && <KeysLine what="this desktop" inline />}
        </div>
      </>
    );
  }
  return <DesktopWell state={d?.state ?? "none"} detail={d?.detail} name={m.name} viewer={viewer} busy={busy} onAdd={() => void add()} />;
}

/** no desktop yet, one being installed, or an install that failed. Also drawn on #/design. */
export function DesktopWell({ state, detail, name, viewer, busy, onAdd }: { state: "none" | "installing" | "error"; detail?: string; name: string; viewer: boolean; busy?: boolean; onAdd?: () => void }) {
  if (state === "installing") {
    return (
      <div className="machine-progress machine-desk-progress">
        <span className="f-dot is-warn is-live" />
        <span>Adding a desktop: {detail ?? "starting…"}</span>
      </div>
    );
  }
  return (
    <div className="machine-well machine-desk-well">
      <div className="connector-offline-title">{state === "error" ? `The desktop didn't go in` : `${name} has no desktop yet`}</div>
      <div className="connector-offline-reason">
        {state === "error" ? detail : "A desktop is an X server, the XFCE desktop and VNC, installed inside the machine. You see and use it here, on this card; agents can too, once you let them."}
      </div>
      {viewer ? (
        <div className="machine-note">View only: someone who can edit this board adds it.</div>
      ) : (
        <div className="machine-start">
          <button className="f-pill is-accent" disabled={busy} onClick={onAdd}>
            {busy ? "Starting…" : state === "error" ? "Try again" : "Add a desktop"}
          </button>
          <span className="machine-terms">Installs packages in the machine (Ubuntu, Debian, Alpine) · a few minutes · nothing is published</span>
        </div>
      )}
    </div>
  );
}

function DesktopScreen({ panelId, name, viewer, onKeys }: { panelId: string; name: string; viewer: boolean; onKeys: (on: boolean) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const inUse = useUi().engaged === panelId;
  const [hasKeys, setKeys] = useState(false);
  const setHasKeys = (on: boolean) => {
    setKeys(on);
    onKeys(on);
  };
  useEffect(() => () => onKeys(false), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [note, setNote] = useState<string | null>("Opening the desktop…");
  const src = `${import.meta.env.BASE_URL}desktop.html#board=${encodeURIComponent(boardId())}&panel=${encodeURIComponent(panelId)}${viewer ? "&view=1" : ""}`;
  const tell = (cmd: string, more: object = {}) => frame.current?.contentWindow?.postMessage({ type: "foundation:desktop", cmd, ...more }, window.location.origin);
  // the frame's ground is the card's, in day and night (a frame can't read our tokens)
  const paint = () => wrap.current && tell("paint", { background: getComputedStyle(wrap.current).backgroundColor });

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; event?: string; on?: boolean; reason?: string; final?: boolean };
      if (d?.type !== "foundation:desktop") return;
      if (d.event === "connected") {
        setNote(null);
        paint();
      } else if (d.event === "closed") setNote(d.reason ?? "The desktop closed.");
      else if (d.event === "keys") {
        setHasKeys(Boolean(d.on));
        if (d.on) putInUse(panelId);
      } else if (d.event === "leave") {
        frame.current?.blur();
        if (getUi().engaged === panelId) setUi({ engaged: null });
      }
    };
    window.addEventListener("message", onMsg);
    const offNight = onNight(() => {
      setTimeout(paint, 700);
      setTimeout(paint, 1500);
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
    putInUse(panelId);
    frame.current?.focus();
    tell("focus");
  };
  return (
    <div ref={wrap} className={`machine-desk${inUse ? " is-in-use" : ""}${hasKeys && !viewer ? " has-keys" : ""}`}>
      <iframe ref={frame} src={src} title={`${name}'s desktop`} onLoad={paint} allow="clipboard-read; clipboard-write" />
      {!inUse && (
        // a plain click uses the desktop, as it puts the caret in the terminal; until then the wheel and the pointer are the grid's
        <div className="machine-desk-shield" onPointerDown={(e) => e.stopPropagation()} onClick={use}>
          {!note && <span className="f-pill machine-desk-hint">{viewer ? "Click to look closer" : "Click to use the desktop"}</span>}
        </div>
      )}
      {viewer && <div className="machine-watching">View only: you're watching</div>}
      {note && <div className="machine-closed">{note}</div>}
    </div>
  );
}

// ---------- agents: leave, and who is driving ----------

function AgentsMay({ panelId, m, viewer }: { panelId: string; m: MachineState; viewer: boolean }) {
  const [busy, setBusy] = useState(false);
  const set = async (allow: boolean) => {
    setBusy(true);
    try {
      await post(panelId, "agents", { allow });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return <AgentsMayLine may={m.agentsMay} viewer={viewer} busy={busy} onSet={(allow) => void set(allow)} />;
}

/** the leave agents have (or don't) to use this desktop. Also drawn on #/design. */
export function AgentsMayLine({ may, viewer, busy, onSet, now = Date.now() }: { may?: MachineState["agentsMay"]; viewer: boolean; busy?: boolean; onSet?: (allow: boolean) => void; now?: number }) {
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
  const last = m.agentActs?.at(-1);
  const asked = m.agentAsked && !m.agentsMay ? m.agentAsked : undefined;
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
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return <AgentUseLine acts={driving ? (m.agentActs ?? []) : []} asked={driving ? undefined : asked} viewer={viewer} now={now} watching={view === "desktop"} busy={busy} onWatch={onWatch} onAllow={() => void allow()} />;
}

/** Also drawn on #/design. */
export function AgentUseLine({ acts, asked, viewer, now, watching, busy, onWatch, onAllow }: { acts: MachineAgentAct[]; asked?: MachineState["agentAsked"]; viewer: boolean; now: number; watching?: boolean; busy?: boolean; onWatch?: () => void; onAllow?: () => void }) {
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
