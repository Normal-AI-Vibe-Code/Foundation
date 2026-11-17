/**
 * Flowform, in the search pane: your rooms and your files, read through your
 * Flowform link (Settings → Services).
 *
 * Before you type: the rooms you're in. Press one to bring it in as a board
 * (or open it, once it's here); it's then kept up to date from Flowform every
 * few minutes. The › on a room opens its files in place — its images, videos,
 * file cards and models, as Flowform's own file panel shows them — to pull out
 * one at a time without bringing the room in. Type, and it searches the files
 * Flowform can see for you (uploads, board media, Slack, Figma). The same
 * files answer the pane's main search too.
 *
 * A file pulled onto the grid: with file downloads allowed (Settings →
 * Services) it's copied into this board's archive and lands as the image,
 * video or file itself. Without, a file with an address of its own (Slack,
 * Figma) lands as a link card, anything else as a note naming it (lib/hits.ts).
 */

import { useEffect, useState } from "react";
import type { SearchHit } from "@foundation/protocol";
import { api, search } from "../lib/api";
import { glyphOf, pictureOf } from "../lib/hits";
import { activeBoard } from "../sync/board";
import { toast } from "../state/ui";
import { snippetHtml } from "../lib/snippet";
import { Draggable } from "./SearchPane";
import { HitPicture } from "./Clipboard";

interface Room {
  room_id: string;
  name: string;
  role: string;
  asset_count: number;
  live: { board_id: string; pulled_at: number; cards: number; error: string | null } | null;
}

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

const openBoard = (id: string) => window.dispatchEvent(new CustomEvent("foundation:board", { detail: id }));

/** Flowform files as the pane draws any result: pictures as tiles, the rest as rows; each can be pulled out or clipped */
export function FlowformFiles({ files }: { files: SearchHit[] }) {
  const tiles = files.filter((h) => pictureOf(h));
  const rows = files.filter((h) => !pictureOf(h));
  const press = (h: SearchHit) => () => (h.url ? window.open(h.url, "_blank", "noopener") : toast("Drag it onto the grid to place it"));
  return (
    <>
      {tiles.length > 0 && (
        <div className="search-tiles">
          {tiles.map((h) => (
            <Draggable key={h.id} hit={h} className="search-tile" onPress={press(h)}>
              <HitPicture hit={h} />
              <span className="search-tile-name">{h.title}</span>
            </Draggable>
          ))}
        </div>
      )}
      {rows.map((h) => (
        <Draggable key={h.id} hit={h} className="search-row" onPress={press(h)}>
          <span className="search-row-glyph">{glyphOf(h)}</span>
          <span className="search-row-main">
            <span className="search-row-title">{h.title}</span>
            {h.snippet && <span className="search-row-snip" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />}
          </span>
          <span className="search-row-src">{h.flowform?.origin ?? "flowform"}</span>
        </Draggable>
      ))}
    </>
  );
}

export function FlowformBrowser({ filter }: { filter: string }) {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // bumped by Try again: the server may have been restarting, or Flowform away for a moment
  const [attempt, setAttempt] = useState(0);
  /** the room whose files are open in place, and what they are (null: reading; a string: why not) */
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<SearchHit[] | string | null>(null);

  const loadRooms = () =>
    api<{ rooms: Room[] }>("/api/flowform/rooms").then(
      (r) => setRooms(r.rooms),
      (e: Error) => setErr(e.message),
    );

  useEffect(() => {
    setErr(null);
    api<{ connected: boolean }>("/api/flowform/link").then(
      (s) => {
        setLinked(s.connected);
        if (s.connected) void loadRooms();
      },
      (e: Error) => setErr(e.message),
    );
  }, [attempt]);

  // searching Flowform's files, a moment after typing stops: the pane's one search, which asks Flowform as you
  const term = filter.trim();
  useEffect(() => {
    if (!linked || !term) return setHits(null);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await search(term, activeBoard()?.boardId ?? "company", true, ctrl.signal);
        setHits(r.hits.filter((h) => h.source === "flowform"));
        setErr(null);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setHits([]);
        setErr((e as Error).message);
      }
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [linked, term, attempt]);

  // a room's files, read when its › is opened
  useEffect(() => {
    if (!open) return;
    let live = true;
    setFiles(null);
    api<{ files: SearchHit[] }>(`/api/flowform/rooms/${encodeURIComponent(open)}/files`).then(
      (r) => live && setFiles(r.files),
      (e: Error) => live && setFiles(e.message),
    );
    return () => {
      live = false;
    };
  }, [open, attempt]);

  const bring = async (room: Room) => {
    setBusy(room.room_id);
    try {
      const r = await api<{ board: string; cards: Record<string, number>; byName: number }>(`/api/flowform/rooms/${encodeURIComponent(room.room_id)}/pull?board=ff-${encodeURIComponent(room.room_id)}`, { method: "POST", json: {} });
      const n = r.cards.create + r.cards.update;
      toast(room.live ? (n ? `${room.name}: ${n} card${n === 1 ? "" : "s"} brought up to date` : `${room.name} is up to date`) : `${room.name} is here, and stays in step with Flowform`);
      window.dispatchEvent(new Event("foundation:boards"));
      openBoard(r.board);
      void loadRooms();
    } catch (e) {
      toast(`Couldn't bring in ${room.name}: ${(e as Error).message}`, "bad");
    } finally {
      setBusy(null);
    }
  };

  const again = (
    <div className="places-foot">
      <a href="#" onClick={(e) => (e.preventDefault(), setRooms(null), setHits(null), setAttempt((n) => n + 1))}>
        Try again
      </a>
    </div>
  );
  if (err && !rooms && !hits)
    return (
      <div className="places">
        <div className="pane-empty is-bad">{err}</div>
        {again}
      </div>
    );
  if (linked === null) return <div className="places"><div className="pane-empty">Asking the server…</div></div>;
  if (!linked)
    return (
      <div className="places">
        <div className="pane-empty">
          Flowform isn't connected for you. Connect it in <a href="#/settings/services">Settings → Services</a>, and your rooms and files show here.
        </div>
      </div>
    );

  if (term) {
    return (
      <div className="places">
        <div className="pane-eyebrow">Your Flowform files</div>
        {!hits && <div className="pane-empty">Searching Flowform…</div>}
        {hits && hits.length === 0 && (err ? <><div className="pane-empty is-bad">{err}</div>{again}</> : <div className="pane-empty">Nothing in Flowform for “{term}”.</div>)}
        {hits && <FlowformFiles files={hits} />}
      </div>
    );
  }

  return (
    <div className="places">
      <div className="pane-eyebrow">Your Flowform rooms</div>
      {!rooms && <div className="pane-empty">Reading your rooms…</div>}
      {rooms && rooms.length === 0 && <div className="pane-empty">You're not in any Flowform rooms.</div>}
      {rooms?.map((r) => {
        const viewer = r.role === "viewer";
        const isOpen = open === r.room_id;
        const status = r.live
          ? r.live.error
            ? `Couldn't update ${ago(r.live.pulled_at)}: ${r.live.error}`
            : `Here, ${r.live.cards} cards · checked ${ago(r.live.pulled_at)}`
          : viewer
            ? "View only in Flowform: an editor can bring it in"
            : `${r.asset_count} file${r.asset_count === 1 ? "" : "s"} · press to bring it in`;
        return (
          <div key={r.room_id} className={`flowform-room${isOpen ? " is-open" : ""}`}>
            <button
              className="search-row is-folder"
              disabled={busy !== null || (viewer && !r.live)}
              onClick={() => (r.live && !busy ? openBoard(r.live.board_id) : bring(r))}
              data-tip={r.live ? "Open its board" : "Bring it in as a board, kept in step with Flowform"}
            >
              <span className="search-row-glyph">▦</span>
              <span className="search-row-main">
                <span className="search-row-title">{r.name}</span>
                <span className={`search-row-snip${r.live?.error ? " is-bad" : ""}`}>{busy === r.room_id ? "Reading it from Flowform…" : status}</span>
              </span>
              {r.live && !viewer ? (
                <span
                  className="search-row-src flowform-again"
                  role="button"
                  tabIndex={0}
                  data-tip="Read it from Flowform again now"
                  onClick={(e) => (e.stopPropagation(), busy === null && bring(r))}
                >
                  ↻
                </span>
              ) : (
                <span className="search-row-src">{r.role}</span>
              )}
            </button>
            <button
              className="flowform-files-toggle"
              aria-expanded={isOpen}
              aria-label={isOpen ? `Close ${r.name}'s files` : `Show ${r.name}'s files`}
              data-tip={isOpen ? "Close its files" : "Its files, to pull out one at a time"}
              onClick={() => setOpen(isOpen ? null : r.room_id)}
            >
              ›
            </button>
            {isOpen && (
              <div className="flowform-room-files">
                {files === null && <div className="pane-empty">Reading its files…</div>}
                {typeof files === "string" && <div className="pane-empty is-bad">{files}</div>}
                {Array.isArray(files) && files.length === 0 && <div className="pane-empty">No files on this room's boards.</div>}
                {Array.isArray(files) && <FlowformFiles files={files} />}
              </div>
            )}
          </div>
        );
      })}
      <div className="places-foot">Type to search your Flowform files · › shows a room's files · rooms brought in are read again every few minutes</div>
    </div>
  );
}
