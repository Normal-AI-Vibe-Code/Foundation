import { keys } from "../lib/keys";
import { CHAT_MESSAGE_MIME, noteFromMessage, type DraggedMessage } from "../chat/chatDrop";
import { CHAT_REMOTE } from "../chat/server";
import { fetchFile } from "../lib/api";
import { CouncilGlyph } from "../characters/CouncilGlyph";
import { SectionCouncilChip } from "../characters/SectionCouncilChip";
import { LocalSectionChip } from "../panels/LocalView";
import { openCouncil, toggleCouncil } from "../lib/councilOpen";
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CONTENT_PAD,
  GridTracks,
  SECTION_HEADER,
  Section,
  addNote,
  startMachine,
  startVm,
  addSectionAdjacent,
  getState,
  cellAtWorld,
  edgeAtWorld,
  moveSectionToEdge,
  type BoardEdge,
  createMap,
  createTable,
  effectivePos,
  gridSize,
  levelUp,
  openLevel,
  subscribe,
  holdSectionFit,
  pinnedScale,
  setActiveObject,
  liveFit,
  moveSectionTo,
  objectPixelSize,
  removeSection,
  renameSection,
  requestRemoveSection,
  releaseSectionFit,
  requestSnap,
  sectionRestRect,
  startSectionEase,
  setActiveSection,
  setSectionDragTarget,
  setSectionHost,
  splitSection,
  useSection,
} from "../state/store";
import { Spring, presets } from "../physics/spring";
import { TableView } from "./TableView";
// MapLibre is ~1 MB: load it only when a board has a map
const MapView = lazy(() => import("./MapView").then((m) => ({ default: m.MapView })));
import { NoteView } from "./NoteView";
import { MediaView } from "./MediaView";
import { PANEL_GLYPH, PanelActions, PanelView } from "../panels/PanelView";
import { SlackMark } from "./SlackMark";
import { SectionCrew } from "./SectionCrew";
import { FullscreenButton } from "./Fullscreen";
import { isHostable } from "@foundation/protocol";
import { isPanel } from "../state/store";
import { ingest, ingestDrop } from "../lib/ingest";
import { SectionEmpty } from "../panels/SectionEmpty";
import { addChatPicker } from "../chat/gridChatPlace";
import { SectionRewind } from "../panels/ReplayView";
import { TimelinePast } from "../timeline/TimelinePast";
import { SectionClock, SectionTimeline } from "../timeline/SectionTimeline";
import { NoteRecorderHost, NoteTool } from "../notes/NoteRecorder";
import { setUi } from "../state/ui";
import { openContextMenu } from "./ContextMenu";
import { sectionMenuItems } from "./sectionMenu";
import { cardMenuItems } from "./cardMenu";
import { countRender } from "../state/renders";
import { askGrid, gridOfSection, makeSectionAGrid, openAsGrid, staysBehind, useGridAsk } from "../lib/subgrid";
import { openGrid } from "../lib/grids";

interface Props {
  section: Section;
  grid: GridTracks;
  active: boolean;
  canRemove: boolean;
  getScale(): number;
  zoomSpring: Spring;
  /** drawn in miniature inside a section that is a grid of its own (a preview: no tools, no moving) */
  mini?: boolean;
}

/** the store's sections at every depth, and every grid's tracks (stable objects until they change) */
const allSectionsOf = () => getState().allSections;
const gridsOf = () => getState().grids;

export const SectionView = memo(function SectionView({
  section,
  grid,
  active,
  canRemove,
  getScale,
  zoomSpring,
  mini = false,
}: Props) {
  countRender("SectionView");
  const view = useSection(section.id);
  // sections are grids within themselves: this one may hold sections of its own (drawn in miniature)
  const allSections = useSyncExternalStore(subscribe, allSectionsOf);
  const grids = useSyncExternalStore(subscribe, gridsOf);
  const kids = useMemo(() => (section.virtual ? [] : Object.values(allSections).filter((s) => s.parent === section.id)), [allSections, section.id, section.virtual]);
  const isGrid = kids.length > 0;
  // the one section an opened section's cards show as: it fills its grid, and closing is going back up
  const isOpen = !!section.virtual;
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dropping, setDropping] = useState(false);
  // the layout tools folded into one button on a narrow section: whether that button has them out
  const [layoutOut, setLayoutOut] = useState(false);

  // ----- drag the whole section to another grid cell -----
  const moveDrag = useRef({
    down: false,
    dragging: false,
    startX: 0,
    startY: 0,
    target: null as { c: number; r: number } | null,
    edge: null as BoardEdge | null,
    justDragged: false,
  });

  const worldPoint = useCallback(
    (clientX: number, clientY: number) => {
      const world = cardRef.current?.closest(".world");
      if (!world) return null;
      const wr = (world as HTMLElement).getBoundingClientRect();
      const s = getScale();
      return { x: (clientX - wr.left) / s, y: (clientY - wr.top) / s };
    },
    [getScale],
  );

  const onSectionHeaderDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (mini || section.virtual) return; // a preview, or an opened section filling its grid: it stays where it is
    // the name is a button (click to rename) and also the natural handle: it drags too
    if ((e.target as HTMLElement).closest("button:not(.section-name), input")) return;
    const d = moveDrag.current;
    d.down = true;
    d.dragging = false;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.target = null;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch { /* synthetic */ }
  }, [section.id, section.virtual, mini]);

  const onSectionHeaderMove = useCallback(
    (e: React.PointerEvent) => {
      const d = moveDrag.current;
      if (!d.down) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.dragging) {
        if (Math.hypot(dx, dy) < 7) return; // preserve click / double-click
        d.dragging = true;
        cardRef.current?.classList.add("section-dragging");
      }
      const s = getScale();
      const el = cardRef.current;
      if (el) el.style.translate = `${dx / s}px ${dy / s}px`;
      const pt = worldPoint(e.clientX, e.clientY);
      const cell = pt ? cellAtWorld(pt.x, pt.y) : null;
      // past the board's edge: append the section along that whole side
      const edge = pt && !cell ? edgeAtWorld(pt.x, pt.y) : null;
      d.target = cell;
      d.edge = edge;
      setSectionDragTarget(cell ? { sectionId: section.id, c: cell.c, r: cell.r } : edge ? { sectionId: section.id, c: -1, r: -1, edge } : null);
    },
    [getScale, worldPoint, section.id],
  );

  const onSectionHeaderUp = useCallback(() => {
    const d = moveDrag.current;
    if (!d.down) return;
    d.down = false;
    if (d.dragging) {
      d.dragging = false;
      // the click that ends a drag isn't a click on the name
      d.justDragged = true;
      setTimeout(() => (d.justDragged = false), 0);
      const el = cardRef.current;
      if (el) {
        el.style.translate = "";
        el.classList.remove("section-dragging");
      }
      setSectionDragTarget(null);
      if (d.target) moveSectionTo(section.id, d.target.c, d.target.r);
      else if (d.edge) moveSectionToEdge(section.id, d.edge);
    }
  }, [section.id]);

  // the DOM gets where the card comes to rest; its CSS eases it there (wires follow sectionCardRect)
  const rect = sectionRestRect(grid, section);
  // a section that hosts an app is that app; any other cards sit over it
  const { host, objects } = view;
  // a section of the This computer grid: the project its cards show
  const localKey = objects.map((o) => (isPanel(o) && o.panel === "local" ? o.source : undefined)).find(Boolean);
  const hostable = !host && objects.length === 1 && isPanel(objects[0]) && isHostable(objects[0].panel) ? objects[0] : null;
  const lastLayout = useRef(new Map<string, { x: number; y: number }>());
  const layout = useMemo(
    () => {
      // a card that didn't move keeps its position object, so it doesn't render again when a neighbour is picked up
      const m = new Map<string, { x: number; y: number }>();
      for (const o of objects) {
        const p = effectivePos(o);
        const was = lastLayout.current.get(o.id);
        m.set(o.id, was && was.x === p.x && was.y === p.y ? was : p);
      }
      lastLayout.current = m;
      return m;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [objects, view.availW, section.id],
  );

  // ----- fitted content: a section never takes the wheel -----
  // It shows its cards as large as its body allows (store: sectionFlow) and
  // the wheel always pans the grid. Expanded, it grows to hold them at full size.
  const { fit, clipped, expanded } = view;
  // opening or closing: the card's CSS eases its size from where it's drawn now; the store's
  // rect (wires, landings) eases with it from the same frame (store: startSectionEase)
  const wasExpanded = useRef(expanded);
  useLayoutEffect(() => {
    if (wasExpanded.current === expanded) return;
    wasExpanded.current = expanded;
    const el = cardRef.current;
    // offsetWidth/Height: the size the transition starts from (mid-ease too), not the new style
    if (!el) return;
    // the height transition the new style just started is the clock both follow (it begins on the next
    // frame drawn, which a heavy render delays): 0 until it runs, 1 when it ends, null when it's gone
    const tr = el.getAnimations().find((a): a is CSSTransition => a instanceof CSSTransition && (a.transitionProperty === "height" || a.transitionProperty === "width"));
    const total = Number(tr?.effect?.getComputedTiming().duration) || 0;
    const progress = tr && total ? () => (tr.playState === "finished" || tr.playState === "idle" ? 1 : tr.currentTime == null ? 0 : Number(tr.currentTime) / total) : undefined;
    startSectionEase(section.id, { x: rect.x, y: rect.y, w: el.offsetWidth, h: el.offsetHeight }, progress);
  }, [expanded, section.id, rect.x, rect.y]);
  const fitSpring = useMemo(
    // the camera's feel, at a scale's precision (its rest threshold is for pixels)
    () => new Spring(view.fit, { ...presets.camera, restDelta: 0.0005, restSpeed: 0.0005 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [section.id],
  );
  useEffect(() => fitSpring.to(fit), [fitSpring, fit]);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const apply = (f: number) => {
      el.style.transform = `scale(${f})`;
      liveFit.set(section.id, f);
    };
    apply(fitSpring.value);
    const off = fitSpring.onChange(apply);
    return () => {
      off();
      liveFit.delete(section.id);
    };
  }, [fitSpring, section.id]);
  // cards convert pointer moves with the scale they're drawn at: the camera's times the fit
  const getContentScale = useCallback(() => getScale() * fitSpring.value, [getScale, fitSpring]);

  // pressing inside holds the fit, so the card under the finger never rescales mid-gesture
  const onBodyPointerDown = useCallback(() => {
    holdSectionFit(section.id);
    const release = () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      releaseSectionFit(section.id);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }, [section.id]);

  // the cards that don't fit (only once it has stopped shrinking)
  const hidden = useMemo(() => {
    if (!clipped) return 0;
    const bodyW = rect.w - 2;
    const bodyH = rect.h - 2 - SECTION_HEADER;
    let n = 0;
    for (const o of objects) {
      const p = layout.get(o.id) ?? { x: o.x, y: o.y };
      const sz = objectPixelSize(o);
      if ((CONTENT_PAD + p.x + sz.w) * fit > bodyW + 1 || (CONTENT_PAD + p.y + sz.h) * fit > bodyH + 1) n++;
    }
    return n;
  }, [clipped, objects, layout, fit, rect.w, rect.h]);

  // ----- media intake: desktop drag-drop + open dialog -----
  const ingestFiles = useCallback((files: FileList | File[]) => ingest(section.id, files), [section.id]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropping(false);
      // a message pulled out of a conversation (chat/chatDrop.ts): a note with who said it, and its pictures
      const said = e.dataTransfer.getData(CHAT_MESSAGE_MIME);
      if (said) {
        void dropMessage(section.id, said);
        return;
      }
      // folders too: walked and laid out as a group (the entries must be read during the event)
      void ingestDrop(section.id, e.dataTransfer);
    },
    [section.id],
  );


  // ----- right-click menu on the section's own surface -----
  const onSectionContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // primitives own their right-click (table cells etc.)
      if ((e.target as HTMLElement).closest(".obj-slot")) return;
      e.preventDefault();
      e.stopPropagation();
      setActiveSection(section.id);
      openContextMenu(e.clientX, e.clientY, sectionMenuItems(section, worldPoint(e.clientX, e.clientY), { host, hostable, isOpen, isGrid, canRemove, upload: () => fileRef.current?.click(), screen: { x: e.clientX, y: e.clientY } }));
    },
    [section.id, canRemove, host, hostable, worldPoint, section, isOpen, isGrid],
  );

  // ----- right-click on a card: the card's own menu (components/cardMenu.ts) -----
  // A table's cells answer with their own (rows, columns) and stop the event before it gets here
  const onCardContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    const items = cardMenuItems(id, { x: e.clientX, y: e.clientY });
    if (!items) return;
    e.preventDefault();
    e.stopPropagation();
    setActiveObject(id);
    openContextMenu(e.clientX, e.clientY, items);
  }, []);

  // the card pinned to this section: it spans it, on the section's own paper, under the flow
  const pinned = view.pinned;
  const pinK = pinned ? pinnedScale(section, pinned) : 1;
  const getPinnedScale = useCallback(() => getScale() * pinK, [getScale, pinK]);

  // ⤢ on a section makes it a grid of its own (lib/subgrid.ts): asked once, in place. One that stands for a grid opens it
  const gridAsk = useGridAsk(section.id);
  const childGrid = gridOfSection(host);
  const stayers = useMemo(() => (gridAsk === "ask" ? staysBehind(section.id) : []), [gridAsk, section.id]);

  // confirmation can be requested locally (✕ button) or via the context menu
  const confirmingActive = confirming || view.pendingRemoval;
  const cancelConfirm = () => {
    setConfirming(false);
    requestRemoveSection(null);
  };

  // one toolbar button: its label rolls over (shell/Tip.tsx), never a native title
  const tool = (tip: string, glyph: React.ReactNode, onClick: () => void, cls = "", kbd?: string) => (
    <button className={"sec-tool " + cls} data-tip={tip} data-kbd={kbd} aria-label={tip} onClick={onClick}>
      {glyph}
    </button>
  );

  const sectionCtx = active && view.sectionFocus;

  return (
    <motion.div
      ref={cardRef}
      className={
        "section-card" +
        (active ? " active" : "") +
        (sectionCtx ? " ctx-active" : "") +
        (dropping ? " dropping" : "") +
        (expanded ? " expanded" : "") +
        (isGrid ? " is-grid" : "") +
        (isOpen ? " is-open" : "") +
        (mini ? " is-mini" : "") +
        (confirmingActive || gridAsk ? " confirming" : "")
      }
      data-section-id={mini ? undefined : section.id}
      data-mini-section-id={mini ? section.id : undefined}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 240, damping: 22 }}
      onPointerDown={(e) => {
        // clicks on primitives set the object context themselves
        if ((e.target as HTMLElement).closest(".obj-slot")) return;
        setActiveSection(section.id);
      }}
      onContextMenu={mini ? undefined : onSectionContextMenu}
      onDoubleClick={
        mini
          ? (e) => {
              // a section seen in miniature: open the grid it's in, framed on it
              if ((e.target as HTMLElement).closest(".obj-slot")) return;
              e.stopPropagation();
              if (section.parent) openLevel(section.parent);
              requestSnap({ kind: "section", id: section.id });
            }
          : undefined
      }
      onDragOver={(e) => {
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {/* the agents at work in here, right above the section: up while the pointer is on it, or pinned */}
      {!mini && <SectionCrew sectionId={section.id} sectionName={section.name} />}

      {/* header — drag it to move the section to another grid cell */}
      <div
        className="section-header"
        style={{ height: SECTION_HEADER }}
        onPointerDown={onSectionHeaderDown}
        onPointerMove={onSectionHeaderMove}
        onPointerUp={onSectionHeaderUp}
        onPointerCancel={onSectionHeaderUp}
        onDoubleClick={(e) => {
          if (mini || (e.target as HTMLElement).closest("button, input")) return;
          requestSnap({ kind: "section", id: section.id });
        }}
      >
        {renaming ? (
          <input
            className="section-name-input"
            defaultValue={section.name}
            autoFocus
            spellCheck={false}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                renameSection(section.id, (e.target as HTMLInputElement).value);
                setRenaming(false);
              } else if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={(e) => {
              renameSection(section.id, e.target.value);
              setRenaming(false);
            }}
          />
        ) : (
          <button className="section-name" onClick={() => !moveDrag.current.justDragged && setRenaming(true)} data-tip="Rename · drag to move">
            {host && <span className="section-app-glyph">{PANEL_GLYPH[host.panel]}</span>}
            {section.name}
          </button>
        )}
        <span className="section-coords">
          {colName(section.c0)}
          {section.r0 + 1}
          {(section.c1 !== section.c0 || section.r1 !== section.r0) &&
            `:${colName(section.c1)}${section.r1 + 1}`}
        </span>
        {isGrid ? (
          <span className="section-count" data-tip={`A grid of ${kids.length} section${kids.length === 1 ? "" : "s"}`}>
            ▦ {kids.length}
          </span>
        ) : (
          objects.length > 0 && <span className="section-count">{objects.length}</span>
        )}
        {/* a section that follows a Slack channel says how that connection stands */}
        <SlackMark sectionId={section.id} />
        {/* the section's timeline: its clock beside its name, quiet, always there (the right end of a section wider
            than the window is off screen; this end is where the name is read) */}
        {!mini && <SectionClock sectionId={section.id} variant="rest" />}

        {/* at rest, what a section is: somewhere agents build with you, and a grid of its own to open */}
        {!mini && (
          <span className="section-rest">
            {localKey && <LocalSectionChip projectKey={localKey} />}
            <SectionCouncilChip sectionId={section.id} sectionName={section.name} />
            {(!host || childGrid) && (
              <button
                type="button"
                className={"sec-rest-open" + (isOpen || isGrid || childGrid ? "" : " is-make")}
                data-tip={isOpen ? "Back up a level" : childGrid ? "Open the grid" : isGrid ? "Open its grid" : "Open as its own grid: it becomes a grid inside this one"}
                aria-label={isOpen ? "Back up a level" : childGrid ? "Open the grid" : isGrid ? "Open its grid" : "Open as its own grid"}
                onClick={() => (isOpen ? levelUp() : isGrid ? openLevel(section.id) : openAsGrid(section.id, host))}
              >
                {isOpen ? "⤡" : "▦"}
              </button>
            )}
          </span>
        )}

        {/* the section's shape, on the left after its name: split it, fit it to the screen, open it as a grid.
            On a narrow section they fold into one button (a container query, App.css) */}
        {!mini && (
          <div className={"sec-layout" + (layoutOut ? " is-out" : "")} role="toolbar" aria-label={`${section.name} layout`}>
            <button
              type="button"
              className="sec-tool sec-layout-more"
              data-tip="Split, fit and open"
              aria-label="Split, fit and open"
              aria-expanded={layoutOut}
              onClick={() => setLayoutOut((o) => !o)}
            >
              <LayoutGlyph />
            </button>
            <div className="sec-layout-items" onClick={() => setLayoutOut(false)}>
              {tool("Split into two columns", "◫", () => splitSection(section.id, "h"))}
              {tool("Split into two rows", "⬓", () => splitSection(section.id, "v"))}
              {!isOpen && tool("Fit the section to the screen", <FitGlyph />, () => requestSnap({ kind: "section", id: section.id }))}
              {childGrid && !isOpen
                ? tool("Open the grid", "▦", () => openGrid(childGrid))
                : isOpen
                  ? tool("Back up a level", "⤡", () => levelUp(), "", "Esc")
                  : isGrid
                    ? tool("Open its grid", "▦", () => openLevel(section.id))
                    : !host && tool("Open as its own grid", "▦", () => openAsGrid(section.id, host))}
            </div>
          </div>
        )}

        {/* the rest wait in the top-right corner until the pointer is on the section */}
        {!mini && (
        <div className="section-tools" role="toolbar" aria-label={`${section.name} tools`}>
          {/* the hosted app's own: repo, MCP, open */}
          {host && (
            <div className="sec-group">
              <PanelActions panel={host} ask={false} />
            </div>
          )}
          {/* add a primitive */}
          <div className="sec-group">
            {hostable && tool(`Let ${hostable.name} fill the section`, "◳", () => setSectionHost(section.id, hostable.id))}
            {!host &&
              tool("Open an app or link", "◳", () => {
                setActiveSection(section.id);
                setUi({ command: true });
              }, "", keys("mod+L"))}
            {tool("Add a table", "⊞", () => createTable(section.id))}
            {tool("Add a map", "◍", () => createMap(section.id))}
            {tool("Add a note", "¶", () => addNote(section.id))}
            {/* a voice or video note (notes/): hidden from a viewer; it opens the recorder, not the microphone */}
            <NoteTool sectionId={section.id} />
            {tool("Upload an image or video", "⇪", () => fileRef.current?.click(), "", keys("mod+U"))}
          </div>
          {/* machines, and how the section's app is shown: as a card, or full screen (rightmost) */}
          <div className="sec-group">
            {tool("Start a machine here: Linux on Kiri or Docker", "▣", () => startMachine(section.id))}
            {tool("Add a full operating system here: WildOS VM", <OsGlyph />, () => startVm(section.id))}
            {host && tool(`Show ${host.name} as a card`, "◱", () => setSectionHost(section.id, null))}
            {host && <FullscreenButton id={host.id} />}
          </div>
          <div className="sec-group sec-meta">
            <SectionClock sectionId={section.id} variant="tool" />
            {tool("Council: this section's agents. Talk to them, add more", <CouncilGlyph size={14} />, () => toggleCouncil({ kind: "section", id: section.id }), "sec-agent sec-council")}
            {canRemove && !isOpen && tool("Remove this section…", "✕", () => setConfirming(true), "sec-remove")}
          </div>
        </div>
        )}
      </div>

      {/* remove confirmation */}
      <AnimatePresence>
        {confirmingActive && (
          <motion.div
            className="confirm-pop"
            initial={{ opacity: 0, y: -10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 400, damping: 26 }}
          >
            <span>
              Remove <b>{section.name}</b>
              {objects.length > 0 && ` and ${objects.length} item${objects.length === 1 ? "" : "s"}`}?
            </span>
            <motion.button
              className="confirm-btn danger"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              onClick={() => removeSection(section.id)}
            >
              Remove
            </motion.button>
            <motion.button
              className="confirm-btn"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.92 }}
              onClick={cancelConfirm}
            >
              Cancel
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* make it a grid of its own: it moves everyone's cards, so it asks first */}
      <AnimatePresence>
        {gridAsk && !mini && (
          <motion.div
            className="confirm-pop grid-ask"
            role="alertdialog"
            aria-label={`Make ${section.name} its own grid?`}
            initial={{ opacity: 0, y: -10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 400, damping: 26 }}
          >
            <span className="grid-ask-words">
              Make <b>{section.name}</b> its own grid? Its cards move into a new grid inside this one; this section keeps a preview of it.
              {stayers.length > 0 && ` T${stayers.join(", ").slice(1)} ${stayers.length === 1 ? "stays" : "stay"} here.`}
            </span>
            <motion.button className="confirm-btn primary" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.92 }} disabled={gridAsk === "making"} onClick={() => void makeSectionAGrid(section.id)}>
              {gridAsk === "making" ? "Making it…" : "Make it a grid"}
            </motion.button>
            {gridAsk === "ask" && (
              <motion.button className="confirm-btn" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.92 }} onClick={() => askGrid(null)}>
                Cancel
              </motion.button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* hidden file input for the open dialog */}
      <input
        ref={fileRef}
        type="file"

        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void ingestFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* the nested grid, fitted to the body — the wheel goes straight through to the board */}
      <div className="section-body" onPointerDownCapture={onBodyPointerDown}>
        {isGrid && (
          <MiniGrid
            grid={grids[section.id]}
            kids={kids}
            bodyW={rect.w - 2}
            bodyH={rect.h - 2 - SECTION_HEADER}
            getScale={getScale}
            zoomSpring={zoomSpring}
            onOpen={() => openLevel(section.id)}
          />
        )}
        {pinned && "cols" in pinned && (
          <div className="obj-slot pinned-slot" data-obj-id={pinned.id} data-pinned style={{ transform: `scale(${pinK})` }} onContextMenu={mini ? undefined : (e) => onCardContextMenu(e, pinned.id)}>
            <TableView table={pinned} framePos={PIN_POS} isActive={view.activeObjectId === pinned.id} getScale={getPinnedScale} />
          </div>
        )}
        <div ref={contentRef} className="section-content">
          {/* a clock card off "now": this section as it was, for this viewer only (ReplayView.tsx) */}
          {!mini && <SectionRewind sectionId={section.id} />}
          {/* a timeline off "now" (the grid's, or this section's own): this section as it was, for this viewer only */}
          {!mini && <TimelinePast sectionId={section.id} />}
          {/* the voice and video note recorder, when it's open for this section (drawn on the screen, not the grid) */}
          {!mini && <NoteRecorderHost sectionId={section.id} />}
          {objects.map((o) => {
            const pos = layout.get(o.id) ?? { x: o.x, y: o.y };
            const isObjActive = view.activeObjectId === o.id;
            const slot = (child: React.ReactNode) => (
              <div key={o.id} className="obj-slot" data-obj-id={o.id} style={{ left: CONTENT_PAD, top: CONTENT_PAD }} onContextMenu={mini ? undefined : (e) => onCardContextMenu(e, o.id)}>
                {child}
              </div>
            );
            if (isPanel(o))
              return slot(<PanelView panel={o} pos={pos} isActive={isObjActive} getScale={getContentScale} />);
            if ("cols" in o)
              return slot(
                <TableView table={o} framePos={pos} isActive={isObjActive} getScale={getContentScale} />,
              );
            if ("sourceTableId" in o)
              return slot(
                <Suspense fallback={null}>
                  <MapView
                    map={o}
                    framePos={pos}
                    isActive={isObjActive}
                    getScale={getContentScale}
                    zoomSpring={zoomSpring}
                  />
                </Suspense>,
              );
            if ("text" in o)
              return slot(
                <NoteView note={o} pos={pos} isActive={isObjActive} getScale={getContentScale} />,
              );
            return slot(
              <MediaView item={o} pos={pos} isActive={isObjActive} getScale={getContentScale} />,
            );
          })}
        </div>

        {objects.length === 0 && !host && !pinned && !isGrid && !mini && (
          <SectionEmpty
            name={section.name}
            onUpload={() => fileRef.current?.click()}
            onNote={() => addNote(section.id)}
            onAsk={() => openCouncil({ kind: "section", id: section.id })}
            onFocus={() => setActiveSection(section.id)}
            onChannel={() => void addChatPicker(section.id)}
          />
        )}

        {hidden > 0 && !mini && (
          <button
            className="section-more"
            data-tip="Open this section full-screen, as its own grid"
            onClick={() => openLevel(section.id)}
          >
            {hidden} more <span aria-hidden>⤢</span> Expand
          </button>
        )}
      </div>

      {/* the hosted app fills the section; its ports sit on the section's edges */}
      {host && (
        <PanelView
          panel={host}
          pos={{ x: 0, y: 0 }}
          hosted
          isActive={view.activeObjectId === host.id}
          getScale={getScale}
        />
      )}

      {/* the section's own timeline, unfolding from under its header (timeline/SectionTimeline.tsx) */}
      {!mini && <SectionTimeline sectionId={section.id} />}

      {/* add-section affordances on all four edges (an opened section adds beside itself, in its own grid) */}
      {!mini && ADD_EDGES.map((e) => (
        <AddSectionButton key={e.side} sectionId={section.id} side={e.side} label={e.label} />
      ))}
    </motion.div>
  );
});

/**
 * A section's own grid, drawn in miniature in its body: its sections at their
 * places in its tracks, scaled to fit (never above 100 %), cards and all. A
 * preview: double-click a section in it (or the paper between) to open the
 * grid full-screen, framed on that section.
 */
function MiniGrid({
  grid,
  kids,
  bodyW,
  bodyH,
  getScale,
  zoomSpring,
  onOpen,
}: {
  grid: GridTracks | undefined;
  kids: Section[];
  bodyW: number;
  bodyH: number;
  getScale(): number;
  zoomSpring: Spring;
  onOpen(): void;
}) {
  const tracks = grid ?? { cols: [1560], rows: [1160] };
  const size = gridSize(tracks);
  const pad = 12;
  const k = Math.max(0.01, Math.min(1, (bodyW - pad * 2) / Math.max(1, size.w), (bodyH - pad * 2) / Math.max(1, size.h)));
  const left = Math.max(pad, (bodyW - size.w * k) / 2);
  const getMiniScale = useCallback(() => getScale() * k, [getScale, k]);
  return (
    <div
      className="mini-grid"
      style={{ width: size.w, height: size.h, transform: `translate(${left}px, ${pad}px) scale(${k})` }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-mini-section-id]")) return;
        e.stopPropagation();
        onOpen();
      }}
    >
      {kids.map((s) => (
        <SectionView key={s.id} section={s} grid={tracks} active={false} canRemove={false} getScale={getMiniScale} zoomSpring={zoomSpring} mini />
      ))}
    </div>
  );
}

/** a pinned card sits at its section body's own corner */
const PIN_POS = { x: 0, y: 0 };

const ADD_EDGES: Array<{ side: "right" | "below" | "left" | "above"; label: string }> = [
  { side: "right", label: "Add a section to the right" },
  { side: "below", label: "Add a section below" },
  { side: "left", label: "Add a section to the left" },
  { side: "above", label: "Add a section above" },
];

/**
 * A + in the gap between sections. The gaps are also where people double-click
 * to zoom, so a press only adds once it's clearly one press: the add waits out
 * the double-click window and a second click cancels it (the double-click then
 * zooms as it would on empty paper, GridViewport). The button answers the
 * press at once (it squeezes and rings), so the wait doesn't read as lag.
 */
export const ADD_DELAY_MS = 300;
const addSpring = { type: "spring", stiffness: 500, damping: 22 } as const;
function AddSectionButton({ sectionId, side, label }: { sectionId: string; side: "right" | "below" | "left" | "above"; label: string }) {
  const pending = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => () => {
    if (pending.current) window.clearTimeout(pending.current);
  }, []);
  return (
    <motion.button
      className={`add-btn add-section-${side}${armed ? " is-armed" : ""}`}
      whileHover={{ scale: 1.15 }}
      whileTap={{ scale: 0.8 }}
      transition={addSpring}
      data-tip={label}
      aria-label={label}
      onClick={(e) => {
        if (pending.current) window.clearTimeout(pending.current);
        pending.current = null;
        // the second click of a double-click: not an add
        if (e.detail > 1) {
          setArmed(false);
          return;
        }
        // keyboard presses (detail 0) are deliberate: add at once
        if (e.detail === 0) {
          addSectionAdjacent(sectionId, side);
          return;
        }
        setArmed(true);
        pending.current = window.setTimeout(() => {
          pending.current = null;
          setArmed(false);
          addSectionAdjacent(sectionId, side);
        }, ADD_DELAY_MS);
      }}
    >
      +
    </motion.button>
  );
}

const glyph = { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

/** fit to the screen: four corners framing the section (full screen is the outward arrows, Fullscreen.tsx) */
export function FitGlyph() {
  return (
    <svg {...glyph}>
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
      <rect x="5.5" y="5.5" width="5" height="5" rx="1" />
    </svg>
  );
}

/** the layout tools folded into one: a section split in two, with a caret */
export function LayoutGlyph() {
  return (
    <svg {...glyph}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </svg>
  );
}

/** a whole operating system: a screen on a stand */
export function OsGlyph() {
  return (
    <svg {...glyph}>
      <rect x="2" y="2.5" width="12" height="8.5" rx="1.5" />
      <path d="M6 13.5h4M8 11v2.5" />
    </svg>
  );
}

function colName(col: number): string {
  let s = "";
  let n = col;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** a message dragged out of ChatForm, put down in a section: a note, and its files from Foundation's own archive */
async function dropMessage(sectionId: string, raw: string) {
  let m: DraggedMessage;
  try {
    m = JSON.parse(raw) as DraggedMessage;
  } catch {
    return;
  }
  const n = noteFromMessage(m);
  const others = CHAT_REMOTE ? m.files.map((f) => f.name) : [];
  const body = [`**${n.title}**`, n.body, others.length ? others.map((x) => `📎 ${x}`).join("\n") : ""].filter(Boolean).join("\n\n");
  if (n.body || others.length || !m.files.length) addNote(sectionId, body);
  if (CHAT_REMOTE || !m.files.length) return;
  const files = await Promise.all(
    m.files.map(async (f) => {
      try {
        const res = await fetchFile(f.src);
        if (!res.ok) return null;
        const blob = await res.blob();
        return new File([blob], f.name, { type: f.mime || blob.type });
      } catch {
        return null;
      }
    }),
  );
  const got = files.filter((f): f is File => !!f);
  if (got.length) void ingest(sectionId, got);
}
