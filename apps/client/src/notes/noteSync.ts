/**
 * A note page's words, for a card on a grid that shows it (docs/notes.md §3). The grid is the window's board
 * (sync/board.ts); the page is another board, so a card showing it opens a small second sync to that board:
 * its own Y.Doc and socket, the standard y-protocols exchange, nothing else (no awareness, no copy kept on
 * the device). Every card showing one page shares one sync; it closes a moment after the last one goes.
 *
 * The page's socket answers under the page's own role, so a viewer of the page writes nothing through a
 * card (the server drops it) and the card says it's read-only. A page this person can't see doesn't open.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { NOTE_BODY, boardMaps, noteTextOf, setNoteText } from "@foundation/protocol";
import { api, openSocket } from "../lib/api";

const MSG_SYNC = 0;

export type PageStatus = "connecting" | "live" | "offline" | "locked";

class PageSync {
  doc = new Y.Doc();
  status: PageStatus = "connecting";
  text = "";
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private subs = new Set<() => void>();
  users = 0;
  private epoch: string | null = null;
  closing: ReturnType<typeof setTimeout> | null = null;

  constructor(public id: string) {
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      this.read();
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, u);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encoding.toUint8Array(enc));
    });
    void this.connect();
  }

  private read() {
    const body = boardMaps(this.doc).objects.get(NOTE_BODY);
    const t = body ? noteTextOf(this.doc, body) : "";
    if (t !== this.text) {
      this.text = t;
      this.emit();
    }
  }

  private set(s: PageStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  private emit() {
    for (const f of this.subs) f();
  }

  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => void this.subs.delete(f);
  };

  private async connect() {
    if (this.closed) return;
    // the page's epoch says it is there for this person: a 404 is a page they can't see, or none
    let epoch: string;
    try {
      epoch = (await api<{ epoch: string }>(`/api/boards/${encodeURIComponent(this.id)}/epoch`)).epoch;
    } catch (e) {
      if (/404|no such board/i.test(String((e as Error).message))) return this.set("locked");
      this.set("offline");
      setTimeout(() => void this.connect(), this.backoff());
      return;
    }
    // a copy we hold says which board it came from (the server refuses one of a page since made again)
    this.epoch ??= epoch;
    let ws: WebSocket;
    try {
      ws = await openSocket(`/sync/${encodeURIComponent(this.id)}`, `epoch=${encodeURIComponent(this.status === "connecting" ? "" : this.epoch)}`);
    } catch {
      this.set("offline");
      setTimeout(() => void this.connect(), this.backoff());
      return;
    }
    if (this.closed) return void ws.close();
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      ws.send(encoding.toUint8Array(enc));
    };
    ws.onmessage = (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      if (decoding.readVarUint(dec) !== MSG_SYNC) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (kind === syncProtocol.messageYjsSyncStep2) this.set("live");
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      this.set("offline");
      setTimeout(() => void this.connect(), this.backoff());
    };
  }

  private backoff() {
    return Math.min(15_000, 400 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
  }

  /** the page's words, written as the smallest edit (someone typing elsewhere in it keeps theirs) */
  write(md: string) {
    if (this.status === "locked") return;
    this.doc.transact(() => setNoteText(this.doc, NOTE_BODY, md), "page-card");
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.doc.destroy();
  }
}

const open = new Map<string, PageSync>();

function take(id: string): PageSync {
  let s = open.get(id);
  if (!s) open.set(id, (s = new PageSync(id)));
  if (s.closing) clearTimeout(s.closing);
  s.closing = null;
  s.users++;
  return s;
}

function give(s: PageSync) {
  if (--s.users > 0) return;
  // a card that only re-mounted (moved, zoomed) keeps the sync
  s.closing = setTimeout(() => {
    if (s.users > 0) return;
    open.delete(s.id);
    s.close();
  }, 4000);
}

/** a note page's words and how its sync stands, for a card showing it */
export function useNotePage(id: string | undefined): { text: string; status: PageStatus; write(md: string): void } | null {
  const [sync, setSync] = useState<PageSync | null>(null);
  useEffect(() => {
    if (!id) return;
    const s = take(id);
    setSync(s);
    return () => give(s);
  }, [id]);
  const snap = useSyncExternalStore(
    (f) => (sync ? sync.subscribe(f) : () => {}),
    () => (sync ? `${sync.status}\u0000${sync.text}` : ""),
  );
  if (!id || !sync) return null;
  const [status, ...rest] = snap.split("\u0000");
  return { status: (status || "connecting") as PageStatus, text: rest.join("\u0000"), write: (md) => sync.write(md) };
}

// dev: the open page syncs, for headless checks
if ((import.meta.env?.DEV || import.meta.env?.VITE_E2E_HOOKS) && typeof window !== "undefined") (window as unknown as { __foundationPages: () => string[] }).__foundationPages = () => [...open.keys()];

/** put a note page on a section of the open grid (place_note: a write to the grid, checked by the server) */
export async function placeNote(boardId: string, note: string, section?: string): Promise<string | null> {
  try {
    await api(`/api/boards/${encodeURIComponent(boardId)}/tools/place_note`, { method: "POST", json: { note, section, request_id: `place-${note}-${section ?? ""}-${Date.now()}` } });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** a grid's own note becomes a note page (make_note_page): the card stays, showing it */
export async function makeNotePage(boardId: string, card: string): Promise<{ id: string } | string> {
  try {
    const { result } = await api<{ result: { id: string } }>(`/api/boards/${encodeURIComponent(boardId)}/tools/make_note_page`, { method: "POST", json: { id: card, request_id: `make-${card}` } });
    window.dispatchEvent(new Event("foundation:boards"));
    return result;
  } catch (e) {
    return (e as Error).message;
  }
}

/** a note page in the hand, dragged from the side pane onto a section */
export const NOTE_PAGE_MIME = "application/x-foundation-note";
