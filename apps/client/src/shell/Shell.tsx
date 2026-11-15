import { cardOf, fullscreenCard, installCardUse, modHeld } from "../lib/cardUse";
/**
 * The Foundation shell: the open space's canvas edge to edge (a grid, a deck
 * or a web page), and the floor drawn on its paper — the top bar (the spaces
 * pane's fold, a tab per open space, tools), the left pane (every space by
 * recent or project folder; or the open space's own people and activity), a
 * session with the agent beside the canvas (opened from the bottom bar), and
 * search at the right — then the layers above: the agent layer, ⌘K,
 * presentation mode, the repo drawer and toasts.
 *
 * Keys (⌘ is Ctrl off a Mac, and lib/keys.ts labels it so): ⌘K commands · ⌘F search · ⌘\ spaces pane · ⌘I this space · ⌘J the agent ·
 * ⌘1…9 the tabs · ⌘W close the tab · A agent layer · P present · ⌘U upload ·
 * Esc releases an engaged app (then steps up the grid's levels).
 */

import { Council } from "../characters/Council";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { SidePane } from "./SidePane";
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

/** what a space's canvas is: the grid, a deck of slides (a grid whose sections are the slides), or a web page */
export type SpaceKind = "grid" | "deck" | "page";
export const KIND_GLYPH: Record<SpaceKind, string> = { grid: "▦", deck: "▶", page: "◳" };
export const KIND_NAME: Record<SpaceKind, string> = { grid: "Grid space", deck: "Presentation", page: "Web page" };

/** a space: one board, its canvas kind, and where it's filed */
export interface BoardRow {
  id: string;
  name: string;
  role: "admin" | "member" | "viewer";
  kind?: SpaceKind;
  /** its project folder, "/"-separated; null when loose */
  folder?: string | null;
  /** a page space's address */
  url?: string | null;
  updated_at?: number;
}

export function Shell({ user }: { user: UserInfo }) {
  const ui = useUi();
  // cards take input only when asked: ⌘/Ctrl-click, ⌘↵ / Ctrl+Enter full screen (lib/cardUse.ts)
  useEffect(() => installCardUse(), []);
  const board = useSyncExternalStore(onBoardChange, activeBoard);
  // the board list is kept on the device too, so names (and roles) show offline
  const [boards, setBoards] = useState<BoardRow[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("foundation-boards") ?? "[]") as BoardRow[];
    } catch {
      return [];
    }
  });
  const fileRef = useRef<HTMLInputElement>(null);

  // join the board named in the URL, or the company board
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("board") || localStorage.getItem("foundation-board") || "company";
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
    const load = () =>
      api<{ boards: BoardRow[] }>("/api/boards")
        .then((r) => {
          setBoards(r.boards);
          try {
            localStorage.setItem("foundation-boards", JSON.stringify(r.boards));
          } catch { /* private window */ }
        })
        .catch(() => {});
    void load();
    window.addEventListener("foundation:boards", load);
    return () => window.removeEventListener("foundation:boards", load);
  }, [board?.boardId]);

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
    localStorage.setItem("foundation-board", id);
    const url = new URL(window.location.href);
    url.searchParams.set("board", id);
    window.history.replaceState(null, "", url);
    joinBoard(id, user);
    noteSpaceOpen(id);
    requestSnap({ kind: "all" });
  };

  /** a new space, opened in a new tab: a grid at once; a web page asks for its address first */
  const newSpace = async (kind: SpaceKind = "grid", folder: string | null = null) => {
    let url: string | undefined;
    if (kind === "page") {
      url = window.prompt("The page's web address")?.trim();
      if (!url) return;
    }
    try {
      const { id } = await api<{ id: string }>("/api/boards", { method: "POST", json: { kind, folder, url } });
      window.dispatchEvent(new Event("foundation:boards"));
      switchBoard(id);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  /** rename a space or move it between folders; the list reloads from the server */
  const updateSpace = async (id: string, patch: { name?: string; folder?: string | null }) => {
    setBoards((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));
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
        if (e.key === "a" || e.key === "A") setUi({ agentLayer: !getUi().agentLayer });
        else if (e.key === "v" || e.key === "V") toggleTalk();
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

  return (
    <div className={`app shell${space?.kind === "page" ? " is-page-space" : ""}${ui.agentLayer ? " agent-layer-on" : ""}${ui.presenting ? " presenting" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      <GridViewport boardName={space?.name} />
      {space?.kind === "page" && !ui.presenting && <PageCanvas space={space} />}
      {!ui.presenting && <TopBar boards={boards} current={current} onSwitch={switchBoard} onNew={newSpace} onClose={closeSpace} onRename={(id, name) => void updateSpace(id, { name })} />}
      {!ui.presenting && ui.paneView === "spaces" && <SidePane user={user} boards={boards} current={current} onSwitch={switchBoard} onNew={newSpace} onUpdate={updateSpace} onUpload={() => fileRef.current?.click()} />}
      {!ui.presenting && ui.paneView === "info" && <SpaceInfo user={user} space={space} boards={boards} onUpdate={updateSpace} />}
      <SessionView />
      <SearchPane />
      <AgentsPane />
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
