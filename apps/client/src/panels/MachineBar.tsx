/**
 * A machine card's head, redrawn (2026-11-17, Josh: "we should be able to see its web, address, the buttons
 * and selectors should be much larger … Start, restart and remove should be in the top bar … The sharing of
 * the link should be a feature").
 *
 *   the title row   state · the machine's name (16/650) · engine and image in dim · Start or Stop, Restart,
 *                   Remove as 32 px buttons with their icons (Remove asks once more, in red)
 *   the nav row     Terminal · Desktop · Ins & outs · Access (30 px tabs, icons and words) and full screen;
 *                   then the address bar: the globe, the port (a picker when there are several), the address in
 *                   code type (selectable), Copy, Open beside it, Open in the browser, and Share
 *   Share           the Foundation link (relayed by this server: /m/<board>/<card>/<port>/, for anyone signed in
 *                   who can see the board), this machine's own window, and a public link (a person opens a
 *                   Cloudflare quick tunnel: anyone with it reaches that port; Stop ends it)
 *
 * Both rows grow with the card (×1.2 from 880 px, ×1.4 from 1240 px), as its wells do.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MachineState, PanelDoc } from "@foundation/protocol";
import { SERVER, api } from "../lib/api";
import { addPanel, addSectionAdjacent, getState } from "../state/store";
import { toast } from "../state/ui";
import { ago, boardId } from "./MachineViewBits";
import { copyText } from "./machineTerminal";
import { machineWindowUrl } from "./MachineTools";
import { portUrl } from "./machinePage";
import { CopyGlyph, GlobeGlyph, LinkGlyph, PlayGlyph, PopOutGlyph, RestartGlyph, ShareGlyph, StopGlyph, TrashGlyph, BrowserGlyph } from "../shell/glyphs";

type Verb = "start" | "stop" | "restart" | "remove";

const act = (panelId: string, verb: Verb, json: Record<string, unknown> = {}) => api<{ machine: MachineState }>(`/api/boards/${encodeURIComponent(boardId())}/machines/${panelId}/${verb}`, { method: "POST", json });

/** the title row's buttons: what a person can do to the machine now. Also drawn on #/design. */
export function MachineActions({ m, viewer, engineName, onAct, busy, armed }: { m: Pick<MachineState, "state" | "containerId">; viewer: boolean; engineName?: string; onAct?: (v: Verb) => void; busy?: Verb | null; armed?: boolean }) {
  if (viewer || !m.containerId || m.state === "absent") return null;
  const running = m.state === "running";
  const moving = m.state === "pulling" || m.state === "starting";
  return (
    <span className="machine-actions">
      {!running && !moving && (
        <button className="machine-act is-go" disabled={busy != null} onClick={() => onAct?.("start")} data-tip={`Run it again on ${engineName ?? "its engine"}: its disk was kept`}>
          <PlayGlyph />
          <span>{busy === "start" ? "Starting…" : "Start"}</span>
        </button>
      )}
      {running && (
        <>
          <button className="machine-act" disabled={busy != null} onClick={() => onAct?.("stop")} data-tip="Stop it. The disk is kept; Start runs it again.">
            <StopGlyph />
            <span>{busy === "stop" ? "Stopping…" : "Stop"}</span>
          </button>
          <button className="machine-act" disabled={busy != null} onClick={() => onAct?.("restart")} data-tip="Stop it and start it again (its terminal starts over)">
            <RestartGlyph />
            <span>{busy === "restart" ? "Restarting…" : "Restart"}</span>
          </button>
        </>
      )}
      <button className={`machine-act is-remove${armed ? " is-armed" : ""}`} disabled={busy != null} onClick={() => onAct?.("remove")} data-tip="Remove the machine and its disk. The card stays." data-machine-remove>
        <TrashGlyph />
        <span>{busy === "remove" ? "Removing…" : armed ? "Remove it and its disk?" : "Remove"}</span>
      </button>
    </span>
  );
}

/** the title row: the state, the name, what it runs on, and the actions */
export function MachineTitle({ panel, m, viewer, engineName, engineVersion, pill }: { panel: Pick<PanelDoc, "id">; m: MachineState; viewer: boolean; engineName?: string; engineVersion?: string; pill: ReactNode }) {
  const [busy, setBusy] = useState<Verb | null>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  const onAct = async (v: Verb) => {
    if (v === "remove" && !armed) return setArmed(true);
    setArmed(false);
    setBusy(v);
    try {
      await act(panel.id, v, v === "remove" ? { confirm: true } : {});
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="machine-title-row">
      {pill}
      <span className="machine-title" data-tip={`The container is machine-${m.name}: \`kiri machine shell ${m.name}\` reaches it too`}>
        {m.name}
      </span>
      <span className="machine-sub">
        {engineName && <span className="machine-sub-engine">{[engineName, engineVersion].filter(Boolean).join(" ")}</span>}
        {m.image && <code className="machine-sub-image">{m.image}</code>}
      </span>
      <MachineActions m={m} viewer={viewer} engineName={engineName} onAct={(v) => void onAct(v)} busy={busy} armed={armed} />
    </div>
  );
}

/** a machine port's Foundation link: relayed by this server, for anyone signed in who can see the board */
export function foundationLink(board: string, panel: string, port: number): string {
  const base = (SERVER || window.location.origin).replace(/\/$/, "");
  return `${base}/m/${encodeURIComponent(board)}/${encodeURIComponent(panel)}/${port}/`;
}

/** the address bar: which port, its address, copy, open, share. Also drawn on #/design (`still`). */
export function AddressBar({ panel, m, viewer, still }: { panel: Pick<PanelDoc, "id" | "sectionId" | "name">; m: MachineState; viewer: boolean; still?: boolean }) {
  const ports = m.ports ?? [];
  const [pick, setPick] = useState<number | null>(null);
  const port = ports.find((p) => p.port === pick) ?? ports[0];
  const [shareOpen, setShareOpen] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 1600);
    return () => clearTimeout(t);
  }, [said]);
  if (!port) {
    return (
      <span className="machine-address is-none" data-tip="A port is published when the machine starts: Remove it and Start again with Ports (8080, 3000…) to give it one">
        <GlobeGlyph />
        <span className="machine-address-none">No web port</span>
      </span>
    );
  }
  const url = portUrl(port.host);
  const shown = url.replace(/^https?:\/\//, "");
  const copy = async (text: string, what: string) => setSaid((await copyText(text)) ? `${what} copied` : "Your browser didn't allow the copy");
  const openBeside = () => {
    // a machine that fills its section gets a section beside it for the page (a card behind it would be hidden)
    const hosted = getState().sections[panel.sectionId]?.host === panel.id;
    const where = hosted ? addSectionAdjacent(panel.sectionId, "right") : panel.sectionId;
    if (where) addPanel(where, { panel: "link", name: `${m.name}:${port.port}`, url, text: `Port ${port.port} of the machine ${m.name}`, fromMachine: { panel: panel.id, port: port.port, name: m.name } });
  };
  const shared = m.shares?.find((s) => s.port === port.port);
  return (
    <span className={`machine-address${shared ? " is-public" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
      <span className="machine-address-field">
        <GlobeGlyph />
        {ports.length > 1 ? (
          <select className="machine-address-port" value={port.port} onChange={(e) => setPick(Number(e.target.value))} aria-label="Which port" disabled={still}>
            {ports.map((p) => (
              <option key={p.port} value={p.port}>
                :{p.port}
              </option>
            ))}
          </select>
        ) : (
          <span className="machine-address-port is-one">:{port.port}</span>
        )}
        <code className="machine-address-url" data-tip={`Port ${port.port} in the machine is ${url} on this computer`}>
          {shown}
        </code>
        {said && <span className="machine-address-said">{said}</span>}
        {shared && (
          <span className="machine-address-public" data-tip={`Public: ${shared.url}`}>
            <span className="f-dot is-warn is-live" /> Public
          </span>
        )}
      </span>
      <button className="machine-addr-btn" onClick={() => void copy(url, "Address")} data-tip="Copy the address" aria-label="Copy the address">
        <CopyGlyph />
      </button>
      <button className="machine-addr-btn" onClick={openBeside} data-tip="Open it as a page beside the machine" aria-label="Open it beside the machine">
        <PopOutGlyph />
      </button>
      <a className="machine-addr-btn" href={url} target="_blank" rel="noreferrer" data-tip="Open it in the browser" aria-label="Open it in the browser">
        <BrowserGlyph />
      </a>
      <span className="machine-share-wrap">
        <button className={`machine-addr-btn is-share${shareOpen ? " is-on" : ""}`} onClick={() => setShareOpen((o) => !o)} aria-expanded={shareOpen} data-tip="Share a link to it" data-machine-share>
          <ShareGlyph />
          <span>Share</span>
        </button>
        {(shareOpen || still) && <SharePanel panel={panel} m={m} port={port.port} viewer={viewer} onClose={() => setShareOpen(false)} still={still} />}
      </span>
    </span>
  );
}

/** Share: the Foundation link, this machine's own window, and a public link */
export function SharePanel({ panel, m, port, viewer, onClose, still }: { panel: Pick<PanelDoc, "id">; m: MachineState; port: number; viewer: boolean; onClose?: () => void; still?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ key: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const board = boardId();
  const shared = m.shares?.find((s) => s.port === port);
  useEffect(() => {
    if (still) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".machine-addr-btn.is-share") && onClose?.();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose?.();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [onClose, still]);
  const copy = async (key: string, text: string) => setSaid({ key, text: (await copyText(text)) ? "Copied" : "Not allowed" });
  const share = async (close: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/boards/${encodeURIComponent(board)}/machines/${panel.id}/share`, { method: "POST", json: close ? { port, close: true } : { port } });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fLink = foundationLink(board, panel.id, port);
  const wLink = machineWindowUrl(board, panel.id, "terminal", false, m.name);
  const Row = ({ k, icon, title, sub, link }: { k: string; icon: ReactNode; title: string; sub: string; link: string }) => (
    <div className="machine-share-row">
      <span className="machine-share-icon">{icon}</span>
      <span className="machine-share-words">
        <b>{title}</b>
        <span>{sub}</span>
        <code className="machine-share-link">{link}</code>
      </span>
      <button className="f-pill machine-share-copy" onClick={() => void copy(k, link)} data-machine-share-copy={k}>
        <CopyGlyph size={14} /> {said?.key === k ? said.text : "Copy"}
      </button>
    </div>
  );
  return (
    <div ref={box} className={`machine-share${still ? " is-still" : ""}`} role="dialog" aria-label={`Share port ${port} of ${m.name}`} onPointerDown={(e) => e.stopPropagation()} data-machine-share-panel>
      <div className="machine-share-head">
        <ShareGlyph />
        <b>Share port {port}</b>
      </div>
      <Row k="foundation" icon={<LinkGlyph />} title="A Foundation link" sub="For anyone signed in here who can see this board, from any computer that reaches this Foundation" link={fLink} />
      <Row k="window" icon={<PopOutGlyph />} title="This machine's window" sub="Its terminal and desktop alone, for people on this board" link={wLink} />
      <div className={`machine-share-row is-public${shared ? " is-on" : ""}`}>
        <span className="machine-share-icon">
          <GlobeGlyph />
        </span>
        <span className="machine-share-words">
          <b>A public link</b>
          {shared ? (
            <>
              <span>
                Anyone with it reaches port {port}, no sign-in · {shared.by} opened it {ago(shared.at, Date.now())}
              </span>
              <code className="machine-share-link">{shared.url}</code>
            </>
          ) : (
            <span>Anyone with it reaches port {port}, no sign-in. Through Cloudflare's free quick tunnels (cloudflared on this computer); it ends when you stop it or the machine stops.</span>
          )}
          {err && <span className="machine-share-err">{err}</span>}
        </span>
        {shared ? (
          <span className="machine-share-btns">
            <button className="f-pill machine-share-copy" onClick={() => void copy("public", shared.url)}>
              <CopyGlyph size={14} /> {said?.key === "public" ? said.text : "Copy"}
            </button>
            {!viewer && (
              <button className="f-pill" disabled={busy} onClick={() => void share(true)} data-machine-share-stop>
                Stop
              </button>
            )}
          </span>
        ) : viewer ? (
          <span className="machine-share-note">View only</span>
        ) : (
          <button className="f-pill is-accent" disabled={busy || m.state !== "running"} onClick={() => void share(false)} data-machine-share-public>
            {busy ? "Opening…" : "Make a public link"}
          </button>
        )}
      </div>
    </div>
  );
}
