/**
 * CAD cards fed by an app (2026-11-25, docs/cad-feed.md). Josh: an agent goes into the BOM app, takes the parts' STL
 * files, and puts 3D CAD nodes beside it on the grid, wired to the app so that when the app's part changes the model
 * does; cut the wire and the card is an orphan that keeps its last model; copy it elsewhere to work on it apart.
 *
 * - An app's tool that answers with a file (an MCP `resource` block with a `blob`) has that file kept in the board's
 *   files (archived, never deleted), and its id handed back: `filesFromContent`.
 * - `add_cad` (tools.ts) makes a "file" card for a model, either from a file id or from an app card's tool; from an
 *   app, the card carries `feed` and a wire runs from the app card's `cad` port into the card's `model` port.
 * - A fed card is asked again (the same tool, the same arguments, under the name of the person who set it up and that
 *   board's Allow on the tool) when its wire is made again, when a person presses Refresh, and every
 *   FOUNDATION_CAD_REFRESH_MS (10 min) while its board is open and the wire is there. A model with the same bytes
 *   changes nothing; new bytes become a new file and the card shows them (the old file stays in the archive).
 *
 * Nothing new leaves Foundation here: every call is `call_app_tool`'s, through the saved app's address and the press a
 * person gave that tool on that board (apptools.ts). Until they press, the card waits and says so.
 */

import { createHash } from "node:crypto";
import { extname } from "node:path";
import { boardMaps, cadLinked, CAD_IN_PORT, CAD_OUT_PORT, type CadFeed, type PanelDoc, type Port } from "@foundation/protocol";
import { editBoard, getBoard, onBoardOpen, type Board } from "./boards.ts";
import { storeFile } from "./files.ts";
import { all, one, run } from "./db.ts";

/** the most an app may hand over in one file */
export const APP_FILE_MAX = 64 * 1024 * 1024;
export const CAD_REFRESH_MS = Number(process.env.FOUNDATION_CAD_REFRESH_MS) || 10 * 60_000;
const ORIGIN = "cadfeed";

/** a model the 3D card draws (apps/client/src/cad/model.ts) */
export const MODEL_EXT = [".stl", ".obj", ".glb", ".step", ".stp", ".iges", ".igs"];
const MIME_EXT: Record<string, string> = { "model/stl": ".stl", "application/sla": ".stl", "application/vnd.ms-pki.stl": ".stl", "model/obj": ".obj", "model/gltf-binary": ".glb", "model/step": ".step", "application/step": ".step", "model/iges": ".iges" };
const EXT_MIME: Record<string, string> = { ".stl": "model/stl", ".obj": "model/obj", ".glb": "model/gltf-binary", ".step": "model/step", ".stp": "model/step", ".iges": "model/iges", ".igs": "model/iges" };

export interface AppFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

/** a resource's name: the last part of its address, given the extension its type says when it has none */
export function nameOfResource(uri: string | undefined, mime: string | undefined, n: number): string {
  let base = "";
  try {
    base = decodeURIComponent(new URL(uri ?? "").pathname.split("/").filter(Boolean).at(-1) ?? "");
  } catch {
    base = (uri ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  }
  base = base.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || `file-${n + 1}`;
  if (!extname(base) && mime && MIME_EXT[mime.toLowerCase()]) base += MIME_EXT[mime.toLowerCase()];
  return base;
}

export const isModel = (name: string) => MODEL_EXT.includes(extname(name).toLowerCase());

/** the files in an MCP tool's answer (embedded resources with bytes), kept in the board's files */
export async function filesFromContent(content: unknown, at: { boardId: string; userId: string; app: string }): Promise<AppFile[]> {
  const out: AppFile[] = [];
  if (!Array.isArray(content)) return out;
  for (const [i, b] of content.entries()) {
    const r = (b as { type?: string; resource?: { uri?: string; mimeType?: string; blob?: string } }).resource;
    if ((b as { type?: string }).type !== "resource" || !r || typeof r.blob !== "string") continue;
    // base64 grows by a third: refuse before decoding anything too big
    if (r.blob.length > Math.ceil((APP_FILE_MAX * 4) / 3) + 4) throw new Error(`${at.app} sent a file over ${APP_FILE_MAX / 1024 / 1024} MB; nothing was kept`);
    const body = Buffer.from(r.blob, "base64");
    if (!body.length) continue;
    const name = nameOfResource(r.uri, r.mimeType, i);
    const mime = EXT_MIME[extname(name).toLowerCase()] ?? (r.mimeType || "application/octet-stream");
    const row = await storeFile(body, { name, mime, boardId: at.boardId, userId: at.userId, about: `from the app ${at.app}${r.uri ? ` (${r.uri.slice(0, 200)})` : ""}` });
    out.push({ id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256 });
  }
  return out;
}

/** the app card gets its `cad` out port, the CAD card its `model` in port, and the wire between them (once) */
export function wireCad(boardId: string, appId: string, cardId: string, actor: string) {
  editBoard(boardId, "agent", (doc) => {
    const m = boardMaps(doc);
    const ensure = (id: string, port: Port) => {
      const p = m.objects.get(id) as PanelDoc | undefined;
      if (p?.kind !== "panel") throw new Error(`no card ${id}`);
      if (!p.ports.some((x) => x.id === port.id)) m.objects.set(id, { ...p, ports: [...p.ports, port] });
    };
    ensure(appId, { id: CAD_OUT_PORT, name: "CAD", dir: "out", type: "cad" });
    ensure(cardId, { id: CAD_IN_PORT, name: "model", dir: "in", type: "cad" });
    if ([...m.links.values()].some((l) => l.from.panel === appId && l.to.panel === cardId && l.to.port === CAD_IN_PORT)) return;
    const id = `lnk_cad_${cardId}`;
    m.links.set(id, { id, from: { panel: appId, port: CAD_OUT_PORT }, to: { panel: cardId, port: CAD_IN_PORT }, label: "CAD", createdBy: actor });
  });
}

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** write what a fetch found onto the card: a new model, the same one, or why there's none */
export function settleFeed(boardId: string, cardId: string, found: { file?: AppFile; note?: string; state: CadFeed["state"] }): CadFeed | null {
  return editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    const p = m.objects.get(cardId) as PanelDoc | undefined;
    if (p?.kind !== "panel" || !p.feed) return null;
    const now = Date.now();
    const changed = Boolean(found.file && found.file.sha256 !== p.feed.sha);
    const feed: CadFeed = { ...p.feed, state: found.state, checkedAt: now, ...(changed ? { sha: found.file!.sha256, changedAt: now } : {}) };
    if (found.note) feed.note = found.note;
    else delete feed.note;
    m.objects.set(cardId, { ...p, ...(changed ? { fileId: found.file!.id, mime: found.file!.mime } : {}), feed });
    return feed;
  });
}

// ---------- what a card asks, and as whom: the server's record ----------

/**
 * A card's `feed` lives in the board, where anyone who can edit it can write it: it is only shown. What a refresh asks
 * (which app card, which tool, which arguments) and in whose name is this row, written by add_cad alone. A copied card,
 * or one whose `feed` was written by hand, has no row and is never asked.
 */
export interface FeedRecord {
  app: string;
  tool: string;
  args: Record<string, unknown>;
  by: string;
}
export function recordFeed(boardId: string, cardId: string, r: FeedRecord) {
  run(
    "insert into cad_feeds (board_id, card_id, app_id, tool, args_json, by, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(board_id, card_id) do update set app_id = excluded.app_id, tool = excluded.tool, args_json = excluded.args_json, by = excluded.by",
    boardId, cardId, r.app, r.tool, JSON.stringify(r.args ?? {}), r.by, Date.now(),
  );
}
export function feedRecord(boardId: string, cardId: string): FeedRecord | null {
  const r = one<{ app_id: string; tool: string; args_json: string; by: string }>("select app_id, tool, args_json, by from cad_feeds where board_id = ? and card_id = ?", boardId, cardId);
  return r ? { app: r.app_id, tool: r.tool, args: JSON.parse(r.args_json) as Record<string, unknown>, by: r.by } : null;
}
/** is the card wired from the app its record names (not the one its `feed` claims)? */
export function recordLinked(boardId: string, cardId: string, rec: FeedRecord): boolean {
  const m = boardMaps(getBoard(boardId).doc);
  return cadLinked(m.links.values(), { id: cardId, feed: { app: rec.app } as CadFeed });
}

// ---------- asked again while wired ----------

type Refresher = (boardId: string, cardId: string) => Promise<unknown>;
let refresher: Refresher | null = null;
/** tools.ts registers how a refresh runs (through runTool, so it is gated and audited like any call) */
export function setCadRefresher(fn: Refresher) {
  refresher = fn;
}

const followed = new Map<string, Board>();
const busy = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** the fed CAD cards on a board (by the server's record) that are still wired to their app */
export function fedCards(boardId: string): string[] {
  const m = boardMaps(getBoard(boardId).doc);
  return all<{ card_id: string }>("select card_id from cad_feeds where board_id = ?", boardId)
    .map((r) => r.card_id)
    .filter((id) => m.objects.get(id)?.kind === "panel" && recordLinked(boardId, id, feedRecord(boardId, id)!));
}

function refreshSoon(boardId: string, cardId: string) {
  const key = `${boardId}|${cardId}`;
  if (busy.has(key) || !refresher) return;
  busy.add(key);
  refresher(boardId, cardId)
    .catch((e) => console.error(`  cad feed           ${cardId} on ${boardId}: ${(e as Error).message}`))
    .finally(() => busy.delete(key));
}

function follow(board: Board) {
  followed.set(board.id, board);
  board.doc.on("destroy", () => {
    if (followed.get(board.id) === board) followed.delete(board.id);
  });
  const m = boardMaps(board.doc);
  // a wire made again into a fed card (a person's ⌘Z, or by hand): ask the app at once
  m.links.observe((e, tr) => {
    if (tr.origin === ORIGIN) return;
    for (const [key, change] of e.changes.keys) {
      if (change.action !== "add") continue;
      const l = m.links.get(key);
      if (!l || l.to.port !== CAD_IN_PORT || tr.origin === "agent") continue;
      const rec = feedRecord(board.id, l.to.panel);
      if (rec && rec.app === l.from.panel) refreshSoon(board.id, l.to.panel);
    }
  });
  if (!timer) {
    timer = setInterval(() => {
      for (const b of followed.values()) for (const id of fedCards(b.id)) refreshSoon(b.id, id);
    }, CAD_REFRESH_MS);
    timer.unref?.();
  }
}
onBoardOpen(follow);

export function stopCadFeeds() {
  if (timer) clearInterval(timer);
  timer = null;
  followed.clear();
}
