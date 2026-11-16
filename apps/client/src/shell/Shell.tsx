import { cardOf, fullscreenCard, installCardUse, modHeld } from "../lib/cardUse";
/**
 * The Foundation shell: the whole app once you're signed in. The open place fills the paper edge
 * to edge — a grid (or a deck, or a web page), Today, or Settings (lib/place.ts) — and the floor is
 * drawn on it: the top bar (the side menu's fold, a tab per open grid, tools, the server), the side
 * menu (Today, every grid by recent or as the tree of grids inside grids, Settings; or the open
 * grid's own people and activity), a session with the agent beside the canvas (opened from the
 * bottom bar), and search at the right — then the layers above: the council, ⌘K, presentation
 * mode, the repo drawer and toasts.
 *
 * Keys (⌘ is Ctrl off a Mac, and lib/keys.ts labels it so): ⌘K commands · ⌘F search · ⌘\ side menu · ⌘I this grid · ⌘J the agent ·
 * ⌘1…9 the tabs · ⌘W close the tab · P present · ⌘U upload ·
 * Esc releases an engaged app (then steps up the grid's levels).
 */

import { Council, CouncilPreload } from "../characters/Council";
import { AgentInfoPane } from "../characters/AgentInfo";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { UserInfo } from "@foundation/protocol";
import { GridViewport } from "../components/GridViewport";
import { ContextMenuView } from "../components/ContextMenu";
import { SectionAgentsPanel } from "../components/SectionAgents";
import { CommandBar } from "./CommandBar";
import { TopBar } from "./TopBar";
import { SessionView, TouchedRings } from "./SessionView";
import { SearchPane } from "./SearchPane";
import { AgentsPane } from "./AgentsPane";
import { talkTyping, toggleTalk } from "./Talk";
import { Present } from "./Present";
import { RepoDrawer } from "./RepoDrawer";
import { HuddlePip } from "./HuddlePip";
import { UploadTray } from "./UploadTray";
import { SidePane, isSystemGrid } from "./SidePane";
import { Today } from "../today/Today";
import { SettingsSpace, SETTINGS_GRIDS } from "../settings/SettingsSpace";
import { goGrid, placeOf } from "../lib/place";
import { loadGrids, useGrids, type SpaceKind } from "../lib/grids";
export { KIND_GLYPH, KIND_NAME, type BoardRow, type SpaceKind } from "../lib/grids";
import { SpaceInfo } from "./SpaceInfo";
import { PageCanvas } from "./PageCanvas";
import { api } from "../lib/api";
import { ingest } from "../lib/ingest";
import { getState, requestSnap } from "../state/store";
import { closeSpaceTab, getUi, noteSpaceOpen, setUi, toast, toggleSession, useUi } from "../state/ui";
import { activeBoard, joinBoard, onBoardChange } from "../sync/board";

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** the grid this device had open last (never one of Foundation's own, which Settings opens) */
const lastGrid = () => new URLSearchParams(window.location.search).get("board") || localStorage.getItem("foundation-board") || "company";

export function Shell({ user, route }: { user: UserInfo; route: string }) {
  const ui = useUi();
  const place = useMemo(() => placeOf(route), [route]);
  /** Settings' Plan and Design language are grids of Foundation's own: on those tabs the grid is what shows */
  const systemGrid = place.kind === "settings" ? (SETTINGS_GRIDS[place.tab] ?? null) : null;
  // cards take input only when asked: ⌘/Ctrl-click, ⌘↵ / Ctrl+Enter full screen (lib/cardUse.ts)
  useEffect(() => installCardUse(), []);
  const board = useSyncExternalStore(onBoardChange, activeBoard);
  // every grid (lib/grids.ts): kept on the device too, so names (and roles) show offline
  const boards = useGrids();
  const fileRef = useRef<HTMLInputElement>(null);

  // join the board named in the URL, or the company board
  useEffect(() => {
    const id = lastGrid();
    joinBoard(id, user);
    noteSpaceOpen(id);
    const onSwitch = (e: Event) => switchBoard((e as CustomEvent<string>).detail);
    const onUpload = () => fileRef.current?.click();
    window.addEventListener("foundation:board", onSwitch);
    window.addEventListener("foundation:upload", onUpload);
    return () => {
      window.removeEventListener("foundation:board", onSwitch);
      window.removeEventListener("foundation:upload", onUpload);
    };
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const load = () => void loadGrids();
    load();
    window.addEventListener("foundation:boards", load);
    return () => window.removeEventListener("foundation:boards", load);
  }, [board?.boardId]);

  // Settings → Plan / Design language: Foundation's own grid takes the canvas (the server makes it the first
  // time), and the grid that was open comes back when the tab is left. It gets no tab and isn't remembered.
  useEffect(() => {
    if (systemGrid) {
      let live = true;
      void api<{ id: string }>(`/api/system-grids/${systemGrid}`, { method: "POST", json: {} })
        .then((r) => {
          if (!live) return;
          joinBoard(r.id, user);
          requestSnap({ kind: "all" });
        })
        .catch((e: Error) => toast(e.message, "bad"));
      return () => {
        live = false;
      };
    }
    const at = activeBoard()?.boardId;
    if (at && isSystemGrid(at)) {
      joinBoard(lastGrid(), user);
      requestSnap({ kind: "all" });
    }
  }, [systemGrid, user]);
  // the strip Settings lays under the top bar: a grid there frames itself below it
  useEffect(() => {
    setUi({ strip: systemGrid ? 52 : 0 });
  }, [systemGrid]);

  // my role on this board: a viewer reads (the server drops their writes; edits snap back here)
  const role = boards.find((b) => b.id === board?.boardId)?.role ?? (user.role === "viewer" ? "viewer" : "member");
  useEffect(() => {
    board?.setReadOnly(role === "viewer");
    setUi({ role });
    document.body.classList.toggle("is-viewer", role === "viewer");
  }, [board, role]);

  // ?focus=<card or section> (links sent to Slack, Hermes nudges): frame it once it has synced
  useEffect(() => {
    const url = new URL(window.location.href);
    const focus = url.searchParams.get("focus");
    if (!focus || !board) return;
    const t0 = Date.now();
    const tick = setInterval(() => {
      const st = getState();
      const kind = st.sections[focus] ? "section" : st.panels[focus] || st.notes[focus] || st.tables[focus] || st.maps[focus] || st.media[focus] ? "object" : null;
      if (!kind && Date.now() - t0 < 15_000) return;
      clearInterval(tick);
      if (kind) requestSnap({ kind, id: focus });
      url.searchParams.delete("focus");
      window.history.replaceState(null, "", url);
    }, 250);
    return () => clearInterval(tick);
  }, [board?.boardId]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchBoard = (id: string) => {
    goGrid();
    localStorage.setItem("foundation-board", id);
    const url = new URL(window.location.href);
    url.searchParams.set("board", id);
    window.history.replaceState(null, "", url);
    joinBoard(id, user);
    noteSpaceOpen(id);
    requestSnap({ kind: "all" });
  };

  /** a new grid, opened in a new tab (inside `parent` when one is named): a grid at once; a web page asks for its address first */
  const newSpace = async (kind: SpaceKind = "grid", parent: string | null = null) => {
    let url: string | undefined;
    if (kind === "page") {
      url = window.prompt("The page's web address")?.trim();
      if (!url) return;
    }
    try {
      const { id } = await api<{ id: string }>("/api/boards", { method: "POST", json: { kind, parent, url } });
      window.dispatchEvent(new Event("foundation:boards"));
      switchBoard(id);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  /** rename a space or move it between folders; the list reloads from the server */
  const updateSpace = async (id: string, patch: { name?: string; parent?: string | null }) => {
    try {
      await api(`/api/boards/${encodeURIComponent(id)}`, { method: "POST", json: patch });
    } catch (e) {
      toast((e as Error).message, "bad");
    }
    window.dispatchEvent(new Event("foundation:boards"));
  };

  const closeSpace = (id: string) => {
    const next = closeSpaceTab(id, board?.boardId ?? "");
    if (next) switchBoard(next);
  };
  // the keys below are bound once; they reach the latest of these through a ref
  const acts = useRef({ switchBoard, closeSpace });
  acts.current = { switchBoard, closeSpace };

  // global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // in a text box, ⌘I and ⌘U are italic and underline, as in any word processor
      const writing = !!(e.target as HTMLElement | null)?.closest?.(".rich-text");
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setUi({ command: !getUi().command });
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleSession();
      } else if (mod && e.key.toLowerCase() === "i" && !e.shiftKey && !writing) {
        e.preventDefault();
        const u = getUi();
        setUi(u.pane && u.paneView === "info" ? { pane: false } : { pane: true, paneView: "info" });
      } else if (mod && e.key.toLowerCase() === "f" && !e.shiftKey) {
        e.preventDefault();
        setUi({ search: !getUi().search });
      } else if (mod && e.key.toLowerCase() === "w" && getUi().spaces.length > 1) {
        e.preventDefault();
        const id = activeBoard()?.boardId;
        if (id) acts.current.closeSpace(id);
      } else if (mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const id = getUi().spaces[Number(e.key) - 1];
        if (id && id !== activeBoard()?.boardId) acts.current.switchBoard(id);
      } else if (mod && e.key.toLowerCase() === "u" && !writing) {
        e.preventDefault();
        fileRef.current?.click();
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        const u = getUi();
        setUi(u.pane && u.paneView === "spaces" ? { pane: false } : { pane: true, paneView: "spaces" });
      } else if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setUi({ command: true });
      } else if (e.key === "Escape" && getUi().engaged) {
        e.stopPropagation();
        setUi({ engaged: null });
      } else if (!mod && !typing(e) && !talkTyping() && !getUi().command && !getUi().presenting) {
        if (e.key === "v" || e.key === "V") toggleTalk();
        else if (e.key === "p" || e.key === "P") setUi({ presenting: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // clicking anywhere else releases the card in use
  useEffect(() => {
    if (!ui.engaged) return;
    const off = (e: PointerEvent) => {
      // a ⌘/Ctrl press on another card moves the use there (lib/cardUse.ts); full screen keeps it
      if (modHeld(e) || fullscreenCard()) return;
      if (cardOf(e.target) !== ui.engaged) setUi({ engaged: null });
    };
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, [ui.engaged]);

  const current = board?.boardId ?? "";
  const space = boards.find((b) => b.id === current) ?? null;
  // away from the grids (Today, a Settings page), no grid is "the open one": its tab isn't current and its tools rest
  const onGrid = place.kind === "grid";
  const away = !onGrid && !systemGrid;

  return (
    <div className={`app shell is-place-${place.kind}${away ? " is-away" : ""}${space?.kind === "page" ? " is-page-space" : ""}${ui.presenting ? " presenting" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      <GridViewport boardName={space?.name ?? (systemGrid === "plan" ? "The plan" : systemGrid === "design" ? "Design language" : undefined)} />
      {onGrid && space?.kind === "page" && !ui.presenting && <PageCanvas space={space} />}
      {place.kind === "today" && !ui.presenting && <Today user={user} />}
      {place.kind === "settings" && !ui.presenting && <SettingsSpace place={place} user={user} />}
      {!ui.presenting && <TopBar boards={boards} current={onGrid ? current : ""} place={place} onSwitch={switchBoard} onNew={newSpace} onClose={closeSpace} onRename={(id, name) => void updateSpace(id, { name })} />}
      {!ui.presenting && (ui.paneView === "spaces" || !onGrid) && <SidePane user={user} boards={boards} current={current} place={place} onSwitch={switchBoard} onNew={newSpace} />}
      {!ui.presenting && ui.paneView === "info" && onGrid && <SpaceInfo user={user} space={space} boards={boards} onUpdate={updateSpace} />}
      <SessionView />
      <SearchPane />
      <AgentsPane />
      <AgentInfoPane />
      <CouncilPreload />
      <TouchedRings />
      <SectionAgentsPanel />
      <Council />
      <ContextMenuView />
      <CommandBar />
      <Present />
      <RepoDrawer />
      <HuddlePip />
      <UploadTray />
      <Toast />

      <input
        ref={fileRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) void ingest(getState().activeSectionId, e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Toast() {
  const ui = useUi();
  return (
    <AnimatePresence>
      {ui.toast && (
        <motion.div
          key={ui.toast.at}
          className={`toast f-glass tone-${ui.toast.tone ?? "plain"}`}
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
        >
          {ui.toast.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
