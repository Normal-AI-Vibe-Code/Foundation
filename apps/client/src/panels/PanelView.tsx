/**
 * Panels — everything on the grid that isn't a spreadsheet primitive: live
 * apps and web pages, machines, uploaded files, company connectors, agent
 * jobs and Hermes asks. One frame (ObjectFrame), one header vocabulary, ports
 * on the edges for wiring.
 *
 * Performance: a live <iframe> is the most expensive thing on the board, so a
 * frame only mounts while its card is on screen and big enough to read
 * (≥ 0.3 zoom); otherwise a poster stands in. Frames take pointer input only
 * once engaged (click), so panning the grid over them stays smooth.
 */

import { JobWhat, type JobShown } from "./JobWhat";
import { PipelineBody } from "./PipelineView";
import { CollectionBody } from "./CollectionView";
import { LocalBody } from "./LocalView";
import { UploaderBody } from "./UploaderView";
import { PortLabel, portHoverProps } from "../shell/portHover";
import { DesignBody, GridLinkBody, KanbanBody } from "./SystemCards";
import { CadPreview } from "../cad/CadPreview";
import { CadFeedStrip } from "../cad/CadFeedStrip";
import { MODEL_EXT } from "../cad/model";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { drawnScale, isHosted, MINI_HEADER, emitPort, getState, subscribe, inputValue, movePanel, removePanel, requestSnap, resizePanel, sectionBodyRect, updatePanel, usePanel, type PanelMeta } from "../state/store";
import { drawnScaleOf } from "./scaledMouse";
import { ObjectFrame } from "../components/ObjectFrame";
import { beginConnect, beginDetach, beginGather, usePortLayout } from "../shell/AgentLayer";
import { landingsOf, toneOf } from "../shell/ports";
import { CHARACTER_TYPE, pageInBrowser } from "@foundation/protocol";
import { api, fetchFile, uploadFile } from "../lib/api";
import { fileLink, useFileSrc } from "../lib/fileSrc";
import { ProgressiveImage } from "../components/ProgressiveImage";
import { askAgent, toast, useUi } from "../state/ui";
import { camera, onCamera } from "../state/camera";
import { activeBoard } from "../sync/board";
import { StageBody } from "./StageView";
import { onConnectorChange } from "../lib/connectorEvents";
import { HuddleBody } from "./HuddleView";
import { ReplayBody } from "./ReplayView";
import { ChatBareButton, ChatCardBody } from "./ChatCardView";
import { SlackBody } from "./SlackView";
import { CrewCardBody } from "../components/SectionAgents";
import { AppToolAsks, MachineBody, machineAction } from "./MachineView";
import { CharacterBody } from "./CharacterView";
import { machinePage, type FromMachine, type MachinePage } from "./machinePage";
import { bridgeAccepts, bridgeTarget, frameAllow, frameFor, type FrameDecision } from "./frameSandbox";
import { useFrameContext } from "../lib/frames";
import { countRender } from "../state/renders";
import { putInUse, modHeld } from "../lib/cardUse";
import { useCalmAdmit } from "../lib/calm";
import { keys } from "../lib/keys";
import { FullscreenBar, useFullscreenCard } from "../components/Fullscreen";
import { HostPage } from "./HostPage";

interface Props {
  panel: PanelMeta;
  pos: { x: number; y: number };
  isActive: boolean;
  getScale(): number;
  /** the section hosts this app: it fills the section, ports on the section's edges, no frame of its own */
  hosted?: boolean;
}


const GLYPH: Record<PanelMeta["panel"], string> = {
  app: "◳",
  link: "↗",
  file: "▣",
  machine: "▣",
  agent: "✦",
  connector: "◉",
  ask: "✉",
  stage: "◆",
  huddle: "◐",
  slack: "◇",
  crew: "✦",
  character: "☺",
  grid: "▦",
  kanban: "▥",
  design: "◐",
  pipeline: "⇢",
  collection: "❖",
  replay: "◷",
  uploader: "⇪",
  local: "⌂",
  chat: "#",
};

/** cards whose content only slides when the hover bar makes room (a page, a terminal or desktop, a model or PDF:
 *  nothing that should resize a document for a hover); every other kind gets shorter from the top instead */
const SLIDES = new Set<PanelMeta["panel"]>(["app", "link", "machine", "file"]);

export const PanelView = memo(function PanelView({ panel, pos, isActive, getScale, hosted }: Props) {
  countRender("PanelView");
  const layout = usePortLayout(panel);
  const fullscreen = useFullscreenCard() === panel.id;
  const ports = (
    <>
      {panel.ports.map((p) => {
        const l = layout.get(p.id);
        if (!l) return null;
        const connected = l.slots.size > 0;
        const value = p.dir === "out" ? panel.outputs?.[p.id] : inputValue(panel.id, p.id);
        return (
          <div
            key={p.id}
            className={`port port-${p.dir}${connected ? " is-connected" : ""}${value !== undefined ? " has-value" : ""}`}
            data-panel={panel.id}
            data-port-id={p.id}
            data-type={p.type ?? "json"}
            style={{ top: l.y, height: l.height, ["--wire-tone" as string]: toneOf(p.type) }}
            onPointerDown={(e) => (p.dir === "out" ? beginConnect(e, panel.id, p.id) : connected ? beginDetach(e, panel.id, p.id) : undefined)}
            {...portHoverProps(panel.id, p.id)}
          >
            <PortLabel panel={panel} port={p} hint={p.dir === "out" ? "drag to connect it to another card" : connected ? "drag to re-route" : "drop a wire here"} />
          </div>
        );
      })}
    </>
  );

  // a chat card can take its paper away, as a note can (2026-11-25)
  const chat = panel.panel === "chat";
  const extras = (
    <>
      {chat && <ChatBareButton panel={panel} />}
      <PanelActions panel={panel} />
    </>
  );

  const body =
    panel.panel === "machine" && (panel.machine || panel.vm) ? (
      <MachineBody panel={panel} />
    ) : pageInBrowser(panel) ? (
      <BrowserPage panel={panel} />
    ) : panel.panel === "app" || panel.panel === "link" || panel.panel === "machine" ? (
      <LiveFrame panel={panel} />
    ) : panel.panel === "file" ? (
      <FilePreview panel={panel} />
    ) : panel.panel === "connector" ? (
      <ConnectorBody panel={panel} />
    ) : panel.panel === "ask" ? (
      <AskBody panel={panel} />
    ) : panel.panel === "stage" ? (
      <StageBody panel={panel} />
    ) : panel.panel === "huddle" ? (
      <HuddleBody panel={panel} />
    ) : panel.panel === "slack" ? (
      <SlackBody panel={panel} />
    ) : panel.panel === "character" ? (
      <CharacterBody panel={panel} />
    ) : panel.panel === "grid" ? (
      <GridLinkBody panel={panel} />
    ) : panel.panel === "kanban" ? (
      <KanbanBody panel={panel} />
    ) : panel.panel === "design" ? (
      <DesignBody panel={panel} />
    ) : panel.panel === "pipeline" ? (
      <PipelineBody panel={panel} />
    ) : panel.panel === "local" ? (
      <LocalBody panel={panel} />
    ) : panel.panel === "collection" ? (
      <CollectionBody panel={panel} />
    ) : panel.panel === "replay" ? (
      <ReplayBody panel={panel} />
    ) : panel.panel === "uploader" ? (
      <UploaderBody panel={panel} />
    ) : panel.panel === "chat" ? (
      <ChatCardBody panel={panel} />
    ) : panel.panel === "crew" ? (
      <CrewCardBody sectionId={panel.sectionId} />
    ) : (
      <AgentBody panel={panel} />
    );

  if (hosted) {
    // an app section: each wire lands on the edge facing its other end; unwired ports wait on the sides
    const st = getState();
    const sec = st.sections[panel.sectionId];
    const bodyRect = sec ? sectionBodyRect(st.grid, sec) : null;
    const landings = landingsOf(panel.id);
    const hostedPorts = panel.ports.map((p) => {
      const mine = landings.filter((l) => l.port === p.id);
      const value = p.dir === "out" ? panel.outputs?.[p.id] : inputValue(panel.id, p.id);
      const label = <PortLabel panel={panel} port={p} hint={p.dir === "out" ? "drag to connect it to another card" : "drag to re-route"} />;
      if (!mine.length || !bodyRect) {
        const l = layout.get(p.id);
        if (!l) return null;
        return (
          <div
            key={p.id}
            className={`port port-${p.dir}${value !== undefined ? " has-value" : ""}`}
            data-panel={panel.id}
            data-port-id={p.id}
            data-type={p.type ?? "json"}
            style={{ top: l.y, height: l.height, ["--wire-tone" as string]: toneOf(p.type) }}
            onPointerDown={(e) => (p.dir === "out" ? beginConnect(e, panel.id, p.id) : p.type === CHARACTER_TYPE ? beginGather(e, panel.id, p.id) : undefined)}
            {...portHoverProps(panel.id, p.id)}
          >
            {label}
          </div>
        );
      }
      return mine.map((l) => (
        <div
          key={l.link}
          className={`port port-${p.dir} port-at-${l.side} is-connected${value !== undefined ? " has-value" : ""}`}
          data-panel={panel.id}
          data-port-id={p.id}
          data-type={p.type ?? "json"}
          style={{ left: l.x - bodyRect.x - 7, right: "auto", top: l.y - bodyRect.y, height: 14, ["--wire-tone" as string]: toneOf(p.type) }}
          onPointerDown={(e) => (p.dir === "out" ? beginConnect(e, panel.id, p.id) : beginDetach(e, panel.id, p.id))}
          {...portHoverProps(panel.id, p.id)}
        >
          {label}
        </div>
      ));
    });
    return (
      <div
        className={`hosted-app fs-able panel-card kind-${panel.panel}${panel.status ? ` status-${panel.status}` : ""}`}
        data-panel-id={panel.id}
        data-obj-id={panel.id}
      >
        {fullscreen && <FullscreenBar id={panel.id} title={panel.name} url={panel.url} />}
        <div className={`panel-body panel-${panel.panel}`}>
          <div className="panel-inner">{body}</div>
        </div>
        {panel.ports.length > 0 && <div className="port-rail">{hostedPorts}</div>}
      </div>
    );
  }

  return (
    <ObjectFrame
      id={panel.id}
      title={`${GLYPH[panel.panel]}  ${panel.name}`}
      pos={pos}
      width={panel.w}
      float={panel.float}
      isActive={isActive}
      getScale={getScale}
      onMove={(x, y) => movePanel(panel.id, x, y)}
      onResize={(dw, dh) => resizePanel(panel.id, panel.w + dw, panel.h + dh)}
      onRemove={() => removePanel(panel.id)}
      // a character is something a person paid to make: its card asks before it goes (the server takes the
      // character off every council with it; what was drawn stays in the archive)
      confirmRemove={panel.panel === "character" ? { name: panel.name, note: "Its pictures and files stay in the archive." } : undefined}
      headerExtras={extras}
      bodyClass={`panel-body panel-${panel.panel}`}
      cardClass={`panel-card kind-${panel.panel}${panel.status ? ` status-${panel.status}` : ""}${chat && panel.bare ? " is-bare" : ""}`}
      // a chat card's bar rises above it and the conversation holds still, as a note's does (2026-11-25)
      barRise={chat}
      data={{ "panel-id": panel.id }}
      openUrl={panel.url}
      overlay={panel.ports.length ? <div className="port-rail">{ports}</div> : null}
    >
      {/* the bar makes room: most cards get shorter from the top; one that holds a document, a terminal or a model slides (ObjectFrame) */}
      <div style={SLIDES.has(panel.panel) ? { height: panel.h } : { ["--h" as string]: `${panel.h}px` }} className={`panel-inner ${SLIDES.has(panel.panel) ? "bar-slide" : "bar-reflow"}`}>
        {body}
      </div>
    </ObjectFrame>
  );
});

/**
 * A panel's own actions: repo, MCP, open — in its hover bar, or in its host section's toolbar. No agent
 * button here (2026-11-15): agents work at the level of the section, and are spoken to on its council.
 */
export function PanelActions({ panel }: { panel: PanelMeta; ask?: boolean }) {
  const tip = (label: string) => ({ "data-tip": label, "aria-label": label });
  return (
    <>
      {panel.repo && (
        <button className="icon-btn panel-chip" {...tip(`Repository · ${panel.repo}`)} onClick={() => openRepo(panel.repo!)}>
          <GithubGlyph />
        </button>
      )}
      {panel.mcp && (
        <button className="icon-btn panel-chip is-mcp" {...tip(`MCP tools · ${panel.mcp}`)} onClick={() => askAgent(`List the MCP tools of “${panel.name}” and tell me what it can do.`)}>
          MCP
        </button>
      )}
      {panel.url && (
        <button className="icon-btn" {...tip("Open in a browser tab")} onClick={() => window.open(panel.url, "_blank", "noopener")}>
          ↗
        </button>
      )}

    </>
  );
}

export { GLYPH as PANEL_GLYPH };

// ---------- live frames (apps, links, machines) ----------

/**
 * Whether a live body runs: on screen (with 200 px to spare) and drawn at
 * minScale or more. Drawn means the camera's zoom times its section's fit
 * (store.drawnScale): a page fitted to 40 % at zoom 0.5 is drawn at 20 %, a
 * poster. Checked when it mounts, as the camera moves and as the fit changes.
 */
export function useOnScreen(ref: React.RefObject<HTMLElement | null>, minScale = 0.3) {
  // one state, near AND big enough: a card that comes near while drawn too small (a studio zoomed out) doesn't
  // render again for it. Two states re-rendered every character card passing the screen's edge as you panned
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // fitted when it's in a section's flow; a hosted app fills its section at full size
    const section = el.closest(".section-content") ? (el.closest<HTMLElement>("[data-section-id]")?.dataset.sectionId ?? null) : null;
    let zoom = camera.scale;
    let near = false;
    // the section's fit says how big its docked cards are drawn; a card floating in a flow section (a machine laid
    // after a studio's collection, 2026-11-17) is drawn at its own size, so when the fit says too small the page is
    // asked how big it really is. That asking is a layout read (2026-11-24): it's asked only of a card near the
    // screen, only when the zoom or the fit may have changed (a pan changes neither), and every card's question
    // waits for one pass a frame that reads them all and then writes (onScreenPass), never a read after a write
    let big = false;
    const measure = () => drawnScale(zoom, section) >= minScale || (near && drawnScaleOf(el) >= minScale);
    const apply = (b: boolean) => {
      if (b === big && el.dataset.big !== undefined) return;
      big = b;
      setLive(near && b);
      el.dataset.big = b ? "1" : "0"; // what it read, for a check to see
    };
    const check = () => askOnScreen(el, measure, apply);
    const io = new IntersectionObserver(
      ([e]) => {
        near = e.isIntersecting;
        setLive(near && big);
        el.dataset.seen = near ? "1" : "0";
        // measured mid-animation (a snap, a section's fit still springing) it can read small: asked again as it comes into view
        if (near) check();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    apply(drawnScale(zoom, section) >= minScale);
    const off = onCamera((c) => {
      if (c.scale === zoom) return;
      zoom = c.scale;
      check();
    });
    const offFit = section ? subscribe(() => near && check()) : () => {};
    // …and each second while it reads too small and is near
    const again = setInterval(() => !big && near && check(), 1000);
    return () => {
      io.disconnect();
      clearInterval(again);
      off();
      offFit();
      ON_SCREEN_ASKS.delete(el);
    };
  }, [ref, minScale]);
  return live;
}

/** the cards waiting to be measured this frame: one rAF reads every card's size, then sets what each read */
const ON_SCREEN_ASKS = new Map<HTMLElement, { measure: () => boolean; apply: (big: boolean) => void }>();
let onScreenFrame = 0;
function askOnScreen(el: HTMLElement, measure: () => boolean, apply: (big: boolean) => void) {
  ON_SCREEN_ASKS.set(el, { measure, apply });
  if (!onScreenFrame) onScreenFrame = requestAnimationFrame(onScreenPass);
}
function onScreenPass() {
  onScreenFrame = 0;
  const asks = [...ON_SCREEN_ASKS.values()];
  ON_SCREEN_ASKS.clear();
  const read = asks.map((a) => a.measure());
  asks.forEach((a, i) => a.apply(read[i]));
}

/** a page shown by the built-in browser (HostPage.tsx): live when it's on screen, big enough to read and the camera is calm */
function BrowserPage({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  const on = useOnScreen(host);
  const admitted = useCalmAdmit(on);
  const [near, setNear] = useState(false);
  // once near it stays near while it's on screen (a pan doesn't drop the page); it goes far when it leaves or shrinks
  useEffect(() => {
    if (!on) setNear(false);
    else if (admitted) setNear(true);
  }, [on, admitted]);
  return (
    <div ref={host} className={`live-frame${useUi().engaged === panel.id ? " is-engaged" : ""}`}>
      <HostPage panel={panel} near={near} />
    </div>
  );
}

function LiveFrame({ panel }: { panel: PanelMeta }) {
  const ui = useUi();
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const live = useOnScreen(host);
  const [loaded, setLoaded] = useState(false);
  const [everLive, setEverLive] = useState(false);
  const engaged = ui.engaged === panel.id;
  useEffect(() => {
    if (live) setEverLive(true);
  }, [live]);

  // a page opened from a machine's port follows that machine: live while it runs, honest when it doesn't
  const from = panel.fromMachine;
  const card = usePanel(from?.panel);
  const viewer = ui.role === "viewer";
  const page = from ? machinePage(from, card, viewer) : null;
  const url = page ? (page.kind === "live" ? page.url : undefined) : panel.url;
  const held = page !== null && page.kind !== "live";
  const waiting = useMachineReturn(from, url, held);
  useMachineWatch(from, live && Boolean(card?.machine));
  // the engine may publish the port on a new host port when the machine runs again: the page keeps the address it's at
  const liveUrl = page?.kind === "live" ? page.url : null;
  useEffect(() => {
    if (liveUrl && liveUrl !== panel.url && !viewer) updatePanel(panel.id, { url: liveUrl });
  }, [liveUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  // a held page drops what it showed; running again, the frame loads afresh
  useEffect(() => {
    if (held || waiting) setLoaded(false);
  }, [held, waiting]);

  // what this frame may be (frameSandbox.ts): never Foundation itself; its own origin only for a saved app
  const frameCtx = useFrameContext();
  const decision: FrameDecision | null = useMemo(() => (url ? frameFor(url, frameCtx) : null), [url, frameCtx, frameCtx.saved]);
  const decided = useRef(decision);
  decided.current = decision;

  // Foundation bridge: apps talk to the grid with postMessage
  //   app → grid  { type: "foundation:output", port, value }
  //   grid → app  { type: "foundation:input", port, value } and { type: "foundation:hello", panel, ports }
  // only this frame's window, from its own origin, is heard; and what's sent names that origin (never "*")
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || !decided.current || !bridgeAccepts(decided.current, e, frame.current.contentWindow)) return;
      const d = e.data as { type?: string; port?: string; value?: unknown; ports?: Array<{ name: string; dir: "in" | "out"; type?: string }> };
      if (d?.type === "foundation:output" && d.port) {
        const cur = getState().panels[panel.id];
        let port = cur?.ports.find((p) => p.name === d.port || p.id === d.port);
        if (cur && !port) {
          port = { id: `port_${Math.random().toString(36).slice(2, 9)}`, name: d.port, dir: "out" };
          updatePanel(panel.id, { ports: [...cur.ports, port] });
        }
        if (port) emitPort(panel.id, port.id, d.value);
      } else if (d?.type === "foundation:ports" && Array.isArray(d.ports)) {
        const cur = getState().panels[panel.id];
        if (!cur) return;
        const known = new Set(cur.ports.map((p) => `${p.dir}:${p.name}`));
        const add = d.ports.filter((p) => !known.has(`${p.dir}:${p.name}`)).map((p) => ({ ...p, id: `port_${Math.random().toString(36).slice(2, 9)}` }));
        if (add.length) updatePanel(panel.id, { ports: [...cur.ports, ...add] });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [panel.id]);

  // deliver inputs whenever an upstream value changes
  const inputs = panel.ports.filter((p) => p.dir === "in").map((p) => [p, inputValue(panel.id, p.id)] as const);
  const inputKey = JSON.stringify(inputs.map(([p, v]) => [p.name, v]));
  useEffect(() => {
    const w = frame.current?.contentWindow;
    // an opaque frame (not a saved app) has no origin to name, so it is sent nothing
    const target = decision ? bridgeTarget(decision) : null;
    if (!w || !loaded || !target) return;
    w.postMessage({ type: "foundation:hello", panel: panel.id, ports: panel.ports.map(({ name, dir, type }) => ({ name, dir, type })) }, target);
    for (const [p, v] of inputs) if (v !== undefined) w.postMessage({ type: "foundation:input", port: p.name, value: v }, target);
  }, [inputKey, loaded, decision]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = url ?? panel.url ?? "";
  const [domain, favicon] = useMemo(() => {
    try {
      const u = new URL(shown);
      // the site's own icon, and only a saved app's: any other address isn't asked for anything until it's opened
      return [u.host, decision?.ok && decision.trusted ? `${u.origin}/favicon.ico` : ""];
    } catch {
      return [shown, ""];
    }
  }, [shown, decision]);

  // a page starts once the camera is calm, one at a time (lib/calm.ts): never mid-pan, mid-pinch or mid-glide
  const admitted = useCalmAdmit(live);
  // a frame waits for the saved apps (so it never loads with less than it gets), and Foundation itself is never framed
  const refused = decision && !decision.ok ? decision.reason : null;
  const mount = Boolean(url) && frameCtx.ready && Boolean(decision?.ok) && !held && !waiting && ((live && admitted) || (everLive && loaded));
  const hold: Exclude<MachinePage, { kind: "live" }> | null =
    page && page.kind !== "live"
      ? page
      : waiting && card?.machine && from
        ? { kind: "starting", word: "Running", tone: "ok", breathing: true, title: `${card.machine.name} is running`, reason: `Waiting for :${from.port} to answer…`, canStart: false, canShow: false }
        : null;
  return (
    <div ref={host} className={`live-frame${engaged ? " is-engaged" : ""}`}>
      {mount && decision?.ok && (
        <iframe
          key={url}
          ref={frame}
          src={decision.url}
          title={panel.name}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          // camera, microphone and reading the clipboard only for a saved app (frameSandbox.ts)
          allow={frameAllow(decision, "fullscreen")}
          // always sandboxed; its own origin only for a saved app (frameSandbox.ts, #80)
          sandbox={decision.sandbox}
          referrerPolicy="no-referrer"
        />
      )}
      {(!mount || !loaded) && (
        <div className={`frame-poster${hold ? " is-held" : ""}`}>
          {favicon && !hold && <img className="frame-favicon" alt="" src={favicon} onError={(e) => (e.currentTarget.style.visibility = "hidden")} />}
          <div className="frame-poster-name">{panel.name}</div>
          <div className="frame-poster-domain">{domain || "no address yet"}</div>
          {refused ? <div className="frame-poster-text" data-frame-refused>{refused}</div> : panel.text && <div className="frame-poster-text">{panel.text}</div>}
          {mount && !loaded && <div className="frame-poster-loading" />}
          {hold && from && <MachineHold page={hold} from={from} viewer={viewer} />}
        </div>
      )}
      {!engaged && mount && (
        // a plain click selects the card (the wheel and the pointer stay the grid's); ⌘/Ctrl-click uses the app (lib/cardUse.ts)
        <button
          type="button"
          className="frame-engage"
          aria-label={`Use ${panel.name}`}
          onClick={(e) => {
            if (e.detail !== 0 && !modHeld(e)) return;
            e.preventDefault();
            e.stopPropagation();
            putInUse(panel.id);
          }}
        >
          <span className="f-pill frame-engage-pill">
            {keys("mod+click")} to use · {keys("mod+enter")} full screen
          </span>
        </button>
      )}
      {panel.mcp && <AppToolAsks panelId={panel.id} viewer={viewer} />}
    </div>
  );
}

/**
 * While a machine's page is on screen, ask the server to read the engine back
 * (as the card does while it's on screen), so a machine stopped or removed
 * outside Foundation reaches the page even with its card out of view.
 */
function useMachineWatch(from: FromMachine | undefined, on: boolean) {
  const card = from?.panel;
  useEffect(() => {
    if (!card || !on) return;
    const boardId = activeBoard()?.boardId ?? "company";
    const read = () => api(`/api/boards/${encodeURIComponent(boardId)}/machines/${card}`).catch(() => {});
    const t = setInterval(read, 5000);
    return () => clearInterval(t);
  }, [card, on]);
}

/**
 * Running again after being held: the engine says running a moment before the
 * server inside answers, so wait (up to 20 s) for the port to answer before
 * the frame loads, rather than load the browser's own "refused" page.
 */
function useMachineReturn(from: FromMachine | undefined, url: string | undefined, held: boolean) {
  const [waiting, setWaiting] = useState(false);
  const wasHeld = useRef(held);
  useEffect(() => {
    const back = wasHeld.current && !held;
    wasHeld.current = held;
    if (!from || !back || !url) return;
    let stop = false;
    setWaiting(true);
    const until = Date.now() + 20_000;
    void (async () => {
      while (!stop && Date.now() < until) {
        // an opaque answer is enough: something is listening (a refused port rejects)
        const ok = await fetch(url, { mode: "no-cors", cache: "no-store" }).then(
          () => true,
          () => false,
        );
        if (ok || stop) break;
        await new Promise((r) => setTimeout(r, 600));
      }
      if (!stop) setWaiting(false);
    })();
    return () => {
      stop = true;
      setWaiting(false);
    };
  }, [held, url]); // eslint-disable-line react-hooks/exhaustive-deps
  return waiting;
}

/** the page of a machine that isn't running: its state pill, what happened, and what a person can do */
function MachineHold({ page, from, viewer }: { page: Exclude<MachinePage, { kind: "live" }>; from: FromMachine; viewer: boolean }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      // the card's own Start: a person's browser session on a board they can edit, checked by the server
      await machineAction(from.panel, "start");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const show = () => {
    const card = getState().panels[from.panel];
    if (!card) return;
    const hosted = getState().sections[card.sectionId]?.host === card.id;
    requestSnap(hosted ? { kind: "section", id: card.sectionId } : { kind: "object", id: card.id });
  };
  return (
    <div className={`machine-hold is-${page.kind}`} role="status">
      <span className={`machine-state is-${page.tone}`}>
        <span className={`f-dot${page.tone === "idle" ? "" : ` is-${page.tone}`}${page.breathing ? " is-live" : ""}`} />
        {page.word}
      </span>
      <div className="machine-hold-title">{page.title}</div>
      <div className="machine-hold-reason">{page.reason}</div>
      {(page.canStart || page.canShow) && (
        <div className="machine-hold-actions">
          {page.canStart && (
            <button className="f-pill is-accent" disabled={busy} onClick={() => void start()} data-tip="Start the machine again (its disk is kept). This page reloads when it runs.">
              {busy ? "Starting…" : "Start it"}
            </button>
          )}
          {page.canShow && (
            <button className="f-pill" onClick={show} data-tip="Go to the machine's card">
              Show the machine
            </button>
          )}
        </div>
      )}
      {viewer && (page.kind === "stopped" || page.kind === "error") && <div className="machine-hold-note">View only: someone who can edit this board starts it.</div>}
    </div>
  );
}

// ---------- files ----------

const CAD = /\.(step|stp|iges|igs|stl|obj|3mf|glb|gltf|f3d|sldprt|sldasm|x_t|dxf|dwg)$/i;
/** a model's type as the server keeps it (cadfeed.ts), as the extension the viewer loads by */
const MODEL_MIME_EXT: Record<string, string> = { "model/stl": ".stl", "application/sla": ".stl", "model/obj": ".obj", "model/gltf-binary": ".glb", "model/step": ".step", "model/iges": ".iges" };
const TEXTY = /\.(txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|log|js|ts|tsx|py|rs|go)$/i;

function FilePreview({ panel }: { panel: PanelMeta }) {
  // the file's own path (`/files/…`): fetched with this device's session, wherever the server is (lib/fileSrc.ts)
  const url = panel.fileId ? `/files/${panel.fileId}` : panel.url;
  const mime = panel.mime ?? "";
  // a card named for its part ("Fan hub", from add_cad) is still its model: the type gives the viewer its loader
  const name = !CAD.test(panel.name) && MODEL_MIME_EXT[mime.toLowerCase()] ? `${panel.name}${MODEL_MIME_EXT[mime.toLowerCase()]}` : panel.name;
  const [text, setText] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const live = useOnScreen(host, 0.2);
  // once shown, a 3D preview stays (it's a still; no reason to read the file again)
  const [seenLive, setSeenLive] = useState(false);
  useEffect(() => {
    if (live) setSeenLive(true);
  }, [live]);
  // what a <video> or <iframe> loads: the server URL, or (bearer) a blob once it's been on screen (images use ProgressiveImage)
  const shown = useFileSrc(url, (live || seenLive) && (mime.startsWith("video/") || mime === "application/pdf"));

  useEffect(() => {
    if (!live || text !== null || !url) return;
    if (TEXTY.test(name) || mime.startsWith("text/") || CAD.test(name)) {
      if (CAD.test(name) && panel.fileId) {
        api<{ result: string }>(`/api/boards/${activeBoard()?.boardId ?? "company"}/tools/read_file`, { method: "POST", json: { file_id: panel.fileId } })
          .then((r) => setText(r.result))
          .catch(() => setText(""));
      } else {
        fetchFile(url, { headers: { range: "bytes=0-8191" } })
          .then((r) => r.text())
          .then(setText)
          .catch(() => setText(""));
      }
    }
  }, [live, url, name, mime, text, panel.fileId]);

  // the observed element stays the same through the upload, so the preview starts when it lands
  return (
    <div ref={host} className="file-preview">
      {panel.status === "running" ? (
        <div className="file-uploading">
          <div className="upload-bar" style={{ ["--p" as string]: String(Number(panel.text ?? 0)) }} />
          <span>Uploading {name}…</span>
        </div>
      ) : mime.startsWith("image/") ? (
        <ProgressiveImage src={url} alt={name} targetWidth={512} enabled={live || seenLive} fit="contain" />
      ) : mime.startsWith("video/") ? (
        <video src={shown} muted loop playsInline controls preload="metadata" />
      ) : mime === "application/pdf" ? (
        // no sandbox attribute: Chromium's PDF viewer shows nothing in a sandboxed frame. The server answers every
        // file with a CSP sandbox and nosniff, and anything that isn't a passive type (a page, an SVG, a script) as a
        // download of opaque bytes, so this frame can only ever hold the browser's PDF viewer or a download (files.ts)
        live && shown ? <iframe src={shown} title={name} /> : <div className="file-card-glyph">PDF</div>
      ) : CAD.test(name) ? (
        // a model fills the card (the card is the 3D node); a fed card says where its model comes from on top
        <div className={`cad-card${MODEL_EXT.test(name) ? " is-model" : ""}`}>
          {panel.feed && <CadFeedStrip panel={panel as PanelMeta & { feed: NonNullable<PanelMeta["feed"]> }} />}
          {MODEL_EXT.test(name) && url && (live || seenLive) ? (
            // the part itself (OpenCascade for STEP/IGES, as Vision reads it)
            <CadPreview url={url} name={name} />
          ) : (
            <>
              <div className="cad-glyph">
                <CubeGlyph />
              </div>
              <div className="cad-ext">{name.split(".").pop()?.toUpperCase()}</div>
              {text && <div className="cad-header">{text.slice(0, 220)}</div>}
            </>
          )}
          <div className="cad-actions">
            <a className="f-pill" {...fileLink(url ?? "", name)} download={name}>
              Download
            </a>
            <button className="f-pill is-agent" onClick={() => askAgent(`Brief Vision on “${name}”: review this CAD, simulate what matters, and ask the right people to review.`)}>
              Send to Vision
            </button>
          </div>
        </div>
      ) : text !== null ? (
        <pre className="file-text">{text.slice(0, 6000)}</pre>
      ) : (
        <div className="file-card-glyph">{name.split(".").pop()?.toUpperCase() ?? "FILE"}</div>
      )}
    </div>
  );
}

// ---------- company connectors ----------

interface ConnectorState {
  ok: boolean;
  summary: string;
  url: string;
  metrics: Array<{ label: string; value: string | number; tone?: "ok" | "warn" | "bad" }>;
  strips?: Array<{ label: string; dots: Array<{ name: string; tone: "ok" | "warn" | "bad" | "idle" }> }>;
  lists?: Array<{ title: string; items: Array<{ text: string; tone?: "ok" | "warn" | "bad" }> }>;
  provenance?: string;
  provenanceLabel?: string;
  live?: boolean;
  checkedAt: number;
}

function ConnectorBody({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useOnScreen(host, 0.12);
  const [st, setSt] = useState<ConnectorState | null>(null);
  useEffect(() => {
    if (!live || !panel.connector) return;
    let stop = false;
    const load = () =>
      api<ConnectorState>(`/api/connectors/${panel.connector}`)
        .then((s) => !stop && setSt(s))
        .catch(() => {});
    void load();
    const t = setInterval(load, 20_000);
    // pushed changes (FactoryForm's event stream) refetch at once
    const off = onConnectorChange(panel.connector, () => void load());
    return () => {
      stop = true;
      clearInterval(t);
      off();
    };
  }, [live, panel.connector]);
  const offline = st && !st.ok;
  const reason = st?.summary.replace(/^offline — /, "") ?? "";
  return (
    <div ref={host} className={`connector-body${offline ? " is-offline" : ""}`}>
      {/* a hosted connector's section header names it; as a card at rest it names itself */}
      {!isHosted(panel) && <div className="connector-name">{panel.name}</div>}
      <div className="connector-head">
        <span className={`connector-status ${!st ? "is-checking" : st.ok ? "is-live" : "is-off"}`}>
          <span className={`f-dot ${!st ? "is-live" : st.ok ? "is-ok is-live" : "is-warn"}`} />
          {!st ? "Checking" : st.ok ? "Live" : "Offline"}
        </span>
        <span className="connector-role">{panel.text}</span>
        {st?.live && (
          <span className="connector-live" title="Updates arrive live from the system's event stream">
            live
          </span>
        )}
        {st?.provenance && (
          <span className="connector-provenance" title={st.provenance}>
            {st.provenanceLabel ?? "demo data"}
          </span>
        )}
      </div>
      {offline ? (
        <div className="connector-offline">
          <div className="connector-offline-title">Not reachable from Foundation</div>
          <div className="connector-offline-reason">{reason}</div>
        </div>
      ) : st && st.metrics.length > 0 ? (
        <>
          <div className="connector-metrics">
            {st.metrics.slice(0, st.strips?.length || st.lists?.length ? 3 : 6).map((m) => (
              <div key={m.label} className={`metric${m.tone ? ` tone-${m.tone}` : ""}`}>
                <div className="metric-value">{m.value}</div>
                <div className="metric-label">{m.label}</div>
              </div>
            ))}
          </div>
          {st.strips?.map((strip) => (
            <div key={strip.label} className="connector-strip" title={strip.label}>
              <span className="connector-strip-label">{strip.label}</span>
              {strip.dots.map((d, i) => (
                <span key={i} className={`strip-dot tone-${d.tone}`} title={d.name} />
              ))}
            </div>
          ))}
          {st.lists?.map((list) => (
            <div key={list.title} className="connector-list">
              <span className="connector-strip-label">{list.title}</span>
              {list.items.map((it, i) => (
                <div key={i} className={`connector-list-item tone-${it.tone ?? "plain"}`}>
                  {it.text}
                </div>
              ))}
            </div>
          ))}
          <div className="connector-summary is-small">{st.summary}</div>
        </>
      ) : st?.ok && st.summary === "reachable" ? (
        // a service with no read API for Foundation yet: say it's up, and where
        <div className="connector-offline is-up">
          <div className="connector-offline-title">Up and answering</div>
          <div className="connector-offline-reason">{hostOf(st.url)} · nothing to read from it here yet; Open shows it</div>
        </div>
      ) : (
        <div className="connector-summary">{st ? st.summary : "Reaching the service…"}</div>
      )}
      <div className="connector-foot">
        <button className="f-pill is-agent" onClick={() => askAgent(offline ? `${panel.name} is offline (${reason}). How do we bring it back?` : `What's happening in ${panel.name} right now? Read it and tell me what needs attention.`)}>
          ✦ {offline ? "How do I connect it?" : "What's going on?"}
        </button>
        {st?.url && /^https?:/.test(st.url) && !offline && (
          <button className="f-pill" onClick={() => window.open(st.url, "_blank", "noopener")}>
            Open ↗
          </button>
        )}
        {st && <span className="connector-checked">checked {checkedAgo(st.checkedAt)}</span>}
      </div>
    </div>
  );
}

function hostOf(url: string | undefined) {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return url ?? "";
  }
}

/** "checked 4s ago", "checked 3 min ago", "checked 2 h ago" */
export function checkedAgo(at: number, now = Date.now()) {
  const s = Math.max(1, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

// ---------- Hermes asks ----------

function AskBody({ panel }: { panel: PanelMeta }) {
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const done = panel.status === "done";
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (!file || !panel.sessionId) return;
    try {
      const up = await uploadFile(file, activeBoard()?.boardId ?? "company", setProgress);
      await api(`/api/asks/${panel.sessionId}/resolve`, { method: "POST", json: { fileId: up.id } });
      toast(`Thanks — ${file.name} is on the board`, "ok");
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setProgress(null);
    }
  };
  return (
    <div
      className={`ask-body${over ? " is-over" : ""}${done ? " is-done" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="ask-who">
        <span className="f-eyebrow">{done ? "Answered" : "Waiting on"}</span>
        <span className="ask-assignee">{panel.assignee}</span>
      </div>
      <div className="ask-prompt">{panel.text}</div>
      {done ? (
        panel.fileId ? (
          <a className="f-pill" {...fileLink(`/files/${panel.fileId}`)} target="_blank" rel="noreferrer">
            Open the file
          </a>
        ) : (
          <span className="ask-note">Resolved</span>
        )
      ) : progress !== null ? (
        <div className="upload-bar" style={{ ["--p" as string]: String(progress) }} />
      ) : (
        <div className="ask-drop">Drop the file here to answer</div>
      )}
    </div>
  );
}

// ---------- agent jobs ----------

function AgentBody({ panel }: { panel: PanelMeta }) {
  const [output, setOutput] = useState<string>("");
  const [what, setWhat] = useState<JobShown | null>(null);
  const [asking, setAsking] = useState(false);
  const waiting = Boolean(panel.sessionId) && panel.status !== "running" && panel.status !== "done";
  // before Run: what will run, from the job itself
  useEffect(() => {
    if (!panel.sessionId || !waiting) return;
    let live = true;
    api<JobShown>(`/api/jobs/${panel.sessionId}`)
      .then((r) => live && setWhat({ target: r.target, goal: r.goal, program: r.program, shown: r.shown }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [panel.sessionId, waiting]);
  useEffect(() => {
    if (!panel.sessionId || panel.status !== "running") return;
    const t = setInterval(() => {
      api<{ job: { output: string } }>(`/api/jobs/${panel.sessionId}`)
        .then((r) => setOutput(r.job.output))
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [panel.sessionId, panel.status]);
  // Run asks first, showing the whole target and goal; the press names what it showed, and the server runs only that
  const run = () => {
    if (!what) return;
    setAsking(false);
    api(`/api/jobs/${panel.sessionId}/run`, { method: "POST", json: { shown: what.shown } })
      .then(() => toast("Starting…", "agent"))
      .catch((e) => toast((e as Error).message, "bad"));
  };
  return (
    <div className="agent-body">
      <div className="agent-status">
        <span className={`f-dot ${panel.status === "running" ? "is-agent is-live" : panel.status === "done" ? "is-ok" : panel.status === "error" ? "is-bad" : ""}`} />
        <span>{panel.status ?? "idle"}</span>
        {panel.sessionId && panel.status !== "running" && panel.status !== "done" && !asking && (
          <button className="f-pill is-agent" disabled={!what} onClick={() => setAsking(true)}>
            Run
          </button>
        )}
      </div>
      {waiting && what ? (
        <JobWhat what={what} ask={asking ? { onRun: run, onCancel: () => setAsking(false) } : undefined} />
      ) : null}
      {/^https?:\/\/\S+$/.test(output.trim()) ? (
        // a hand-off: the job's output is where the work is happening
        <div className="agent-handoff">
          <p>{panel.text}</p>
          <a className="f-pill is-agent" href={output.trim()} target="_blank" rel="noopener noreferrer">
            Open in Vision Code ↗
          </a>
        </div>
      ) : waiting && what && panel.status !== "error" ? null : (
        <pre className="agent-output">{panel.status === "running" ? output.slice(-4000) || "…" : panel.text}</pre>
      )}
    </div>
  );
}

// ---------- repo drawer ----------

function openRepo(repo: string) {
  window.dispatchEvent(new CustomEvent("foundation:repo", { detail: repo }));
}

function GithubGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

function CubeGlyph() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M28 6 48 17v22L28 50 8 39V17Z" />
      <path d="M8 17l20 11 20-11M28 28v22" />
    </svg>
  );
}

export const PANEL_HEADER = MINI_HEADER;
