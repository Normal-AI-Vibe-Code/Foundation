/**
 * A machine's Access view (2026-11-17, Josh: "The permissions panel should grow to be much larger and designed
 * better, use icons where you can"). Everything about who and what may use the machine in one place, a row
 * each, every row led by a 40 px round icon, its title at 14/600, what it means in mist, and its control at
 * the right:
 *
 *   People          who can type and use the desktop (editors), who only watches (viewers)
 *   Agents' commands every command an agent wants to run waits for a person (Run / Decline on the card)
 *   Agents' desktop  the leave to look, move the pointer and type: off, or who gave it and when, with Stop
 *   Links           the Foundation link (people on this board), public links open now with Stop
 *   Network         ports on 127.0.0.1 only, nothing of this computer mounted; a cluster node is privileged
 */

import { useState, type ReactNode } from "react";
import type { DesktopLeave, MachineState, PanelDoc } from "@foundation/protocol";
import { api } from "../lib/api";
import { toast } from "../state/ui";
import { ago, boardId } from "./MachineViewBits";
import { useDesktopLeave } from "./MachineViewDesktop";
import { AgentGlyph, ClusterGlyph, DesktopGlyph, EyeGlyph, GlobeGlyph, LinkGlyph, LockGlyph, PersonGlyph, PromptGlyph } from "../shell/glyphs";

function Row({ icon, tone, title, children, control, name }: { icon: ReactNode; tone?: "agent" | "warn" | "ok"; title: string; children: ReactNode; control?: ReactNode; name: string }) {
  return (
    <div className={`machine-access-row${tone ? ` is-${tone}` : ""}`} data-access={name}>
      <span className="machine-access-icon">{icon}</span>
      <span className="machine-access-words">
        <b>{title}</b>
        <span>{children}</span>
      </span>
      {control && <span className="machine-access-control">{control}</span>}
    </div>
  );
}

/** the view. Also drawn on #/design (`onAllow` and `onClose` stubbed). */
export function AccessView({ panel, m, leave, viewer, waiting = 0, now = Date.now(), onAllow, onClose, busy }: { panel: Pick<PanelDoc, "id">; m: MachineState; leave?: DesktopLeave; viewer: boolean; waiting?: number; now?: number; onAllow?: (allow: boolean) => void; onClose?: (port: number) => void; busy?: boolean }) {
  // agents' leave lives off the card now (the board's `desktopLeave`, kept by the server alone)
  const may = leave?.agentsMay;
  return (
    <div className="machine-access" data-machine-access={panel.id}>
      <div className="machine-access-head">
        <b>Access</b>
        <span>Who and what may use {m.name}. Only a person changes any of it.</span>
      </div>
      <Row name="people" icon={<PersonGlyph size={20} />} title="People on this board" control={<span className={`machine-access-tag${viewer ? " is-view" : ""}`}>{viewer ? "You watch" : "You can type"}</span>}>
        Everyone who can edit the board types in its terminal and uses its desktop; viewers watch both and can't reach the keys.
      </Row>
      <Row name="commands" icon={<PromptGlyph size={20} />} tone="agent" title="Agents' commands" control={<span className={`machine-access-tag${waiting ? " is-warn" : ""}`}>{waiting ? `${waiting} waiting` : "They ask"}</span>}>
        An agent never runs a command here by itself: each one waits on this card for a person to Run or Decline it, two minutes at most.
      </Row>
      <Row
        name="desktop"
        icon={
          <span className="machine-access-pair">
            <DesktopGlyph size={18} />
            <AgentGlyph size={11} />
          </span>
        }
        tone={may ? "agent" : undefined}
        title="Agents on the desktop"
        control={
          viewer ? (
            <span className="machine-access-tag is-view">{may ? "Allowed" : "Off"}</span>
          ) : may ? (
            <button className="f-pill machine-access-btn" disabled={busy} onClick={() => onAllow?.(false)} data-access-stop>
              Stop
            </button>
          ) : (
            <button className="f-pill machine-access-btn" disabled={busy || !m.desktop} onClick={() => onAllow?.(true)} data-access-allow data-tip={m.desktop ? undefined : "Add a desktop first"}>
              Let agents use it
            </button>
          )
        }
      >
        {may ? `Allowed: ${may.by} let them, ${ago(may.at, now)}. They look at the screen, move the pointer and type; each action shows on the card and in the activity.` : "Off. With leave they can look at the screen, move the pointer and type, each action shown here and in the activity."}
      </Row>
      <Row name="links" icon={<LinkGlyph size={20} />} title="Links" tone={m.shares?.length ? "warn" : undefined}>
        A port's Foundation link reaches people signed in here who can see this board.
        {m.shares?.length ? (
          <span className="machine-access-shares">
            {m.shares.map((s) => (
              <span key={s.port} className="machine-access-share">
                <GlobeGlyph size={14} />
                <span>
                  Port {s.port} is public at <code>{s.url}</code> · {s.by}, {ago(s.at, now)}
                </span>
                {!viewer && (
                  <button className="f-pill machine-access-btn" disabled={busy} onClick={() => onClose?.(s.port)}>
                    Stop
                  </button>
                )}
              </span>
            ))}
          </span>
        ) : (
          " No public links are open."
        )}
      </Row>
      <Row name="network" icon={m.cluster ? <ClusterGlyph size={20} /> : <LockGlyph size={20} />} tone={m.cluster ? "warn" : "ok"} title={m.cluster ? "A cluster node" : "Kept apart"}>
        {m.cluster
          ? "It runs privileged (k3s needs it): it can reach the engine's kernel that every machine here shares. Its ports are on 127.0.0.1 only and nothing of this computer is mounted."
          : "Its ports are published on 127.0.0.1 only, nothing of this computer is mounted in it, and it isn't privileged."}
      </Row>
      {viewer && (
        <div className="machine-access-foot">
          <EyeGlyph size={14} /> View only: someone who can edit this board changes these.
        </div>
      )}
    </div>
  );
}

/** the view on a card: the leave and the links pressed through the server */
export function Access({ panel, m, viewer, waiting }: { panel: Pick<PanelDoc, "id">; m: MachineState; viewer: boolean; waiting: number }) {
  const [busy, setBusy] = useState(false);
  const leave = useDesktopLeave(panel.id);
  const post = async (path: string, json: object) => {
    setBusy(true);
    try {
      await api(`/api/boards/${encodeURIComponent(boardId())}/machines/${panel.id}/${path}`, { method: "POST", json });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return <AccessView panel={panel} m={m} leave={leave} viewer={viewer} waiting={waiting} busy={busy} onAllow={(allow) => void post("agents", { allow })} onClose={(port) => void post("share", { port, close: true })} />;
}
