/**
 * Search, on the floor at the right (⌘F). Look things up the way flowform
 * did — board cards, files (images show), apps, Slack, GitHub, and the files
 * your Flowform link can see — and pull a result out onto the grid: it comes
 * out as a card in the hand (lib/pickup.ts) and lands where it's let go,
 * floating in the section under it. A click does what ⌘K does (frame it, or
 * open it). ＋ keeps a result on the clipboard at the foot of the pane, to
 * carry several at once (Clipboard.tsx). Before you type, it shows this
 * board's recent files and the known apps.
 */

import { SearchGlyph } from "./glyphs";
import { keys } from "../lib/keys";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchHit } from "@foundation/protocol";
import { api, search } from "../lib/api";
import { WIDTHS, setUi, toast, useUi } from "../state/ui";
import { addNote, getState } from "../state/store";
import { activeBoard } from "../sync/board";
import { snippetHtml } from "../lib/snippet";
import { glyphOf, pictureOf } from "../lib/hits";
import { flyToClipboard } from "../lib/pickup";
import { clip, unclip, useClips } from "../state/clipboard";
import { openHit } from "./CommandBar";
import { Clipboard, HitPicture, usePull } from "./Clipboard";
import { FloorEdge } from "./FloorEdge";
import { PlacesBrowser } from "./PlacesBrowser";
import { FlowformBrowser } from "./FlowformBrowser";

type Filter = "all" | "place" | "flowform" | SearchHit["source"];
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "board", label: "Board" },
  { id: "file", label: "Files" },
  { id: "app", label: "Apps" },
  { id: "slack", label: "Slack" },
  { id: "github", label: "GitHub" },
  // not a kind of result: the folders on this computer an admin approved, to browse and drag from (PlacesBrowser)
  { id: "place", label: "This computer" },
  // your Flowform rooms (bring one in as a board) and files (drag out), through your link: FlowformBrowser
  { id: "flowform", label: "Flowform" },
];

/** nothing matched: make the thing that was looked for, a grid of that name, opened */
async function newGridNamed(name: string) {
  try {
    const { id } = await api<{ id: string }>("/api/boards", { method: "POST", json: { name, kind: "grid" } });
    window.dispatchEvent(new Event("foundation:boards"));
    window.dispatchEvent(new CustomEvent("foundation:board", { detail: id }));
  } catch (e) {
    toast((e as Error).message, "bad");
  }
}

export function SearchPane() {
  const ui = useUi();
  if (!ui.search || ui.presenting) return null;
  return <Pane />;
}

function Pane() {
  const ui = useUi();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [recent, setRecent] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const board = activeBoard()?.boardId ?? "company";

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus());
    // before typing: recent files on this board, and the apps Foundation knows
    void Promise.allSettled([
      api<{ files: Array<{ id: string; name: string; mime: string; url: string }> }>(`/api/files?board=${encodeURIComponent(board)}`),
      api<{ apps: Array<{ id: string; name: string; url?: string; description?: string }> }>("/api/apps"),
    ]).then(([f, a]) => {
      const files: SearchHit[] = f.status === "fulfilled" ? f.value.files.slice(0, 24).map((x) => ({ source: "file", id: `file:${x.id}`, title: x.name, snippet: x.mime, url: x.url, score: 1 })) : [];
      const apps: SearchHit[] = a.status === "fulfilled" ? a.value.apps.slice(0, 12).map((x) => ({ source: "app", id: `app:${x.id}`, title: x.name, snippet: x.description ?? x.url ?? "", url: x.url, score: 1 })) : [];
      setRecent([...files, ...apps]);
    });
  }, [board]);

  // local first (a few ms), then everything
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      // a search cut short by clearing the box leaves no dots behind
      setHits([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        setHits((await search(term, board, false, ctrl.signal)).hits);
        setHits((await search(term, board, true, ctrl.signal)).hits);
      } catch {
        /* aborted */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 90);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, board]);

  const shown = useMemo(() => {
    const list = q.trim() ? hits : recent;
    return filter === "all" ? list : list.filter((h) => h.source === filter);
  }, [q, hits, recent, filter]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const h of q.trim() ? hits : recent) c[h.source] = (c[h.source] ?? 0) + 1;
    return c;
  }, [q, hits, recent]);

  // anything with a picture is a tile: an image file here, or a Flowform file Flowform has a small picture of
  const images = shown.filter((h) => pictureOf(h));
  const rest = shown.filter((h) => !images.includes(h));

  return (
    <aside className="search-pane floor-pane" style={{ width: ui.searchW }} aria-label="Search">
      <FloorEdge side="left" value={ui.searchW} {...WIDTHS.search} onChange={(w) => setUi({ searchW: w })} label="Search" />
      <header className="search-head">
        <span className="search-glyph">
          <SearchGlyph />
        </span>
        <input
          ref={input}
          className="search-field"
          value={q}
          placeholder="Try “stator”, a file's name, an app, a channel…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (q ? setQ("") : setUi({ search: false }))}
        />
        {loading && <span className="thinking-dots"><i /><i /><i /></span>}
        <button className="top-btn" onClick={() => setUi({ search: false })} title={`Close (${keys("mod+F")})`} aria-label="Close search">
          ✕
        </button>
      </header>
      <div className="search-filters">
        {FILTERS.map((f) => (
          <button key={f.id} className={`search-chip${filter === f.id ? " is-on" : ""}`} onClick={() => setFilter(f.id)}>
            {f.label}
            {f.id !== "all" && counts[f.id] ? <span className="search-chip-n">{counts[f.id]}</span> : null}
          </button>
        ))}
      </div>
      {filter === "place" && <PlacesBrowser board={board} filter={q.trim()} />}
      {filter === "flowform" && <FlowformBrowser filter={q} />}
      <div className="search-results" hidden={filter === "place" || filter === "flowform"}>
        {!q.trim() && shown.length > 0 && <div className="pane-eyebrow">Recent on this board</div>}
        {q.trim() && !loading && shown.length === 0 && (
          <div className="pane-empty is-create" data-search-empty>
            <span>
              Nothing for “{q.trim()}”{filter !== "all" ? ` in ${FILTERS.find((f) => f.id === filter)?.label}` : ""}.
            </span>
            {ui.role !== "viewer" && (
              <span className="pane-empty-acts">
                <button className="f-pill is-accent" onClick={() => void newGridNamed(q.trim())}>
                  New grid “{q.trim().slice(0, 24)}”
                </button>
                <button className="f-pill" onClick={() => void addNote(getState().activeSectionId)}>
                  New note here
                </button>
              </span>
            )}
          </div>
        )}
        {images.length > 0 && (
          <div className="search-tiles">
            {images.map((h) => (
              <Draggable key={h.id} hit={h} className="search-tile">
                <HitPicture hit={h} />
                <span className="search-tile-name">{h.title}</span>
              </Draggable>
            ))}
          </div>
        )}
        {rest.map((h) => (
          <Draggable key={h.id} hit={h} className="search-row">
            <span className="search-row-glyph">{glyphOf(h)}</span>
            <span className="search-row-main">
              <span className="search-row-title">{h.title}</span>
              {h.snippet && <span className="search-row-snip" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />}
            </span>
            <span className="search-row-src">{h.source === "flowform" ? (h.flowform?.origin ?? "flowform") : h.source}</span>
          </Draggable>
        ))}
      </div>
      <Clipboard />
    </aside>
  );
}


// ---------- a result you can press, clip, or pick up ----------

/**
 * A result: press it (open, as ⌘K does), pull it out onto the grid (lib/pickup.ts: it comes out as a card in
 * the hand), or clip it for later (its ＋, or ⌘/Ctrl-click: state/clipboard.ts).
 */
export function Draggable({
  hit,
  className,
  children,
  onPress,
}: {
  hit: SearchHit;
  className: string;
  children: React.ReactNode;
  /** a press that isn't a drag (default: open the hit, as ⌘K does) */
  onPress?: () => void;
}) {
  const clips = useClips();
  const clipped = clips.some((c) => c.id === hit.id);
  const toggle = (el: HTMLElement) => {
    if (clipped) return unclip(hit.id);
    clip(hit);
    flyToClipboard(hit, el);
  };
  const pull = usePull(() => [hit], {
    onPress: (e) => (e.metaKey || e.ctrlKey ? toggle(e.currentTarget as HTMLElement) : onPress ? onPress() : openHit(hit)),
  });
  return (
    <button className={`${className}${clipped ? " is-clipped" : ""}`} data-tip={hit.title} data-hit-id={hit.id} {...pull}>
      {children}
      <span
        className="clip-btn"
        role="button"
        aria-label={clipped ? "Take it off the clipboard" : "Keep it on the clipboard"}
        data-tip={clipped ? "On the clipboard" : "Keep on the clipboard"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => (e.stopPropagation(), toggle((e.currentTarget as HTMLElement).closest<HTMLElement>("[data-hit-id]")!))}
      >
        {clipped ? "✓" : "＋"}
      </span>
    </button>
  );
}
