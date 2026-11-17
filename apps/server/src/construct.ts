/**
 * Construction: the agent builds pages on the board from what it finds.
 * "Lay out all the images from Slack about the Airform PTHP" becomes two
 * tools: find_images (look in the archive, the board, and Slack) and
 * lay_out (a new section, its items placed as a grid, a mood board, a
 * document or a timeline, each image with a caption that says where it came
 * from).
 *
 * Slack's files are private links, so an image is copied into Foundation's
 * archive when it's laid out — everyone on the board can see it, it's
 * searchable, and (like every file here) it's archived, never deleted.
 */

import * as Y from "yjs";
import { appendSection, boardMaps, findSection, putNote, uid, type MediaDoc, type NoteDoc, type PanelDoc, type SectionDoc } from "@foundation/protocol";
import { all, one } from "./db.ts";
import { editBoard } from "./boards.ts";
import { storeFile, type FileRow } from "./files.ts";
import { searchLocal } from "./search.ts";

// ---------- finding ----------

export interface Found {
  /** what lay_out takes: file:<id> · slack:<file id> · media:<card id> */
  ref: string;
  source: "files" | "slack" | "board";
  title: string;
  /** where it came from: a channel and a person, or who uploaded it */
  from?: string;
  at?: number;
  /** a link that shows it now (Slack images show once laid out) */
  url?: string;
  permalink?: string;
}

const words = (q: string) => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
const matches = (text: string, ws: string[]) => {
  const t = text.toLowerCase();
  return ws.filter((w) => t.includes(w)).length;
};
const IMAGE = /^image\//;

function slackTokens() {
  return { user: process.env.SLACK_USER_TOKEN ?? "", bot: process.env.SLACK_BOT_TOKEN ?? "" };
}
function slackBase() {
  return (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
}

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  user?: string;
  username?: string;
  timestamp?: number;
  created?: number;
  permalink?: string;
  url_private?: string;
  url_private_download?: string;
  channels?: string[];
  initial_comment?: { comment?: string };
}

async function slackGet<T>(method: string, params: Record<string, string>, token: string): Promise<T> {
  const res = await fetch(`${slackBase()}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  const body = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error ?? "failed"}`);
  return body;
}

/** images in Slack about the query: search.files with the user token, else the bot's files.list filtered by name */
async function slackImages(query: string, limit: number): Promise<{ found: Found[]; note?: string }> {
  const { user, bot } = slackTokens();
  if (!user && !bot) {
    return { found: [], note: "Slack isn't connected, so Slack wasn't searched. Set SLACK_USER_TOKEN (search:read) to search Slack's files, or SLACK_BOT_TOKEN with files:read (SPEC §6)." };
  }
  const toFound = (f: SlackFile): Found => ({
    ref: `slack:${f.id}`,
    source: "slack",
    title: f.title || f.name || f.id,
    from: [f.channels?.length ? `#${f.channels[0]}` : "", f.username ?? f.user ?? ""].filter(Boolean).join(" · ") || "Slack",
    at: (f.timestamp ?? f.created ?? 0) * 1000,
    permalink: f.permalink,
  });
  try {
    if (user) {
      // Slack's search wants every word; "all the images about X" wants anything that names X's distinctive parts too,
      // so search the whole phrase, then each word, and rank by how many words a file names
      const ws = words(query);
      const queries = [query, ...ws.filter((w) => w.length >= 3 && w !== query.toLowerCase())];
      const byId = new Map<string, SlackFile>();
      for (const q of queries) {
        const r = await slackGet<{ files?: { matches?: SlackFile[] } }>("search.files", { query: q, count: String(Math.min(100, limit * 2)), sort: "timestamp" }, user);
        for (const f of r.files?.matches ?? []) if (IMAGE.test(f.mimetype ?? "")) byId.set(f.id, f);
        if (byId.size >= limit * 2) break;
      }
      const text = (f: SlackFile) => `${f.title ?? ""} ${f.name ?? ""} ${f.initial_comment?.comment ?? ""}`;
      const ranked = [...byId.values()].sort((a, b) => matches(text(b), ws) - matches(text(a), ws) || (b.timestamp ?? 0) - (a.timestamp ?? 0));
      return { found: ranked.slice(0, limit).map(toFound) };
    }
    // the bot token can't search; it can list files it can see, newest first, and we match their names and comments
    const r = await slackGet<{ files?: SlackFile[] }>("files.list", { types: "images", count: "200" }, bot);
    const ws = words(query);
    const scored = (r.files ?? [])
      .map((f) => ({ f, n: matches(`${f.title ?? ""} ${f.name ?? ""} ${f.initial_comment?.comment ?? ""}`, ws) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
    return {
      found: scored.slice(0, limit).map((x) => toFound(x.f)),
      note: "Searched Slack by file names and comments (the bot token can't full-text search; set SLACK_USER_TOKEN for that).",
    };
  } catch (e) {
    return { found: [], note: `Slack: ${(e as Error).message}` };
  }
}

/** images Foundation already has: uploaded files (full text) and image cards on the board */
function archiveImages(query: string, boardId: string, limit: number): Found[] {
  const ws = words(query);
  const out = new Map<string, Found>();
  // full-text hits first (names, and where imported images came from)
  for (const h of searchLocal(query, boardId, 60)) {
    if (h.source !== "file") continue;
    const id = h.id.replace(/^file:/, "");
    const f = one<FileRow>("select * from files where id = ? and archived_at is null", id);
    if (f && IMAGE.test(f.mime)) out.set(`file:${f.id}`, { ref: `file:${f.id}`, source: "files", title: f.name, at: f.created_at, url: `/files/${f.id}` });
  }
  // then names, word by word (search wants every word; a name may have only some)
  for (const f of all<FileRow>("select * from files where archived_at is null and mime like 'image/%' order by created_at desc limit 500")) {
    if (out.has(`file:${f.id}`) || !ws.length || matches(f.name, ws) === 0) continue;
    out.set(`file:${f.id}`, { ref: `file:${f.id}`, source: "files", title: f.name, at: f.created_at, url: `/files/${f.id}` });
  }
  return [...out.values()].slice(0, limit);
}

function boardImages(doc: Y.Doc, query: string): Found[] {
  const ws = words(query);
  const m = boardMaps(doc);
  return [...m.objects.values()]
    .filter((o): o is MediaDoc => o.kind === "media" && o.media === "image" && (!ws.length || matches(`${o.name} ${m.sections.get(o.sectionId)?.name ?? ""}`, ws) > 0))
    .map((o) => ({ ref: `media:${o.id}`, source: "board" as const, title: o.name, from: `on the board, in “${m.sections.get(o.sectionId)?.name ?? "?"}”`, url: o.src }));
}

export async function findImages(doc: Y.Doc, boardId: string, query: string, sources: Array<"files" | "slack" | "board"> = ["files", "slack", "board"], limit = 40) {
  const notes: string[] = [];
  const found: Found[] = [];
  if (sources.includes("board")) found.push(...boardImages(doc, query));
  if (sources.includes("files")) found.push(...archiveImages(query, boardId, limit));
  if (sources.includes("slack")) {
    const s = await slackImages(query, limit);
    found.push(...s.found);
    if (s.note) notes.push(s.note);
  }
  // the same picture as a board card and as its file: keep one
  const seen = new Set<string>();
  const unique = found.filter((f) => {
    const key = f.url ?? f.ref;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { query, count: unique.length, images: unique.slice(0, limit), notes };
}

// ---------- bringing an image in ----------

/** an image's file in Foundation's archive, importing it from Slack if that's where it lives */
async function fileFor(ref: string, boardId: string, userId: string): Promise<{ file: FileRow; title?: string; from?: string; at?: number } | null> {
  if (ref.startsWith("file:")) {
    const file = one<FileRow>("select * from files where id = ?", ref.slice(5));
    return file ? { file } : null;
  }
  if (ref.startsWith("slack:")) {
    const { user, bot } = slackTokens();
    const token = bot || user;
    if (!token) throw new Error("Slack isn't connected (SLACK_BOT_TOKEN with files:read)");
    const { file: f } = await slackGet<{ file: SlackFile }>("files.info", { file: ref.slice(6) }, token);
    const url = f.url_private_download ?? f.url_private;
    if (!url || !IMAGE.test(f.mimetype ?? "")) return null;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Slack wouldn't hand over ${f.name ?? f.id} (${res.status})`);
    const body = Buffer.from(await res.arrayBuffer());
    const from = [f.channels?.length ? `#${f.channels[0]}` : "", f.username ?? f.user ?? ""].filter(Boolean).join(" · ");
    const file = await storeFile(body, {
      name: f.name ?? `${f.id}.png`,
      mime: f.mimetype ?? "image/png",
      boardId,
      userId,
      about: `from Slack ${from} ${f.title ?? ""} ${f.initial_comment?.comment ?? ""}`,
    });
    return { file, title: f.title || undefined, from: from ? `Slack · ${from}` : "Slack", at: (f.timestamp ?? f.created ?? 0) * 1000 || undefined };
  }
  return null;
}

/** an image's pixel size from its header (PNG, JPEG, GIF, WebP), so cards keep its shape */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const v = b.readUInt32LE(21);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

async function pixelSize(file: FileRow): Promise<{ w: number; h: number }> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { config } = await import("./config.ts");
    const head = await readFile(join(config.dataDir, "files", file.sha256));
    return imageSize(head) ?? { w: 4, h: 3 };
  } catch {
    return { w: 4, h: 3 };
  }
}

// ---------- laying out ----------

const day = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
/** where a piece came from and when: "Slack · #airform-pthp · noa · 3 Oct 2026" */
const caption = (from: string | undefined, at: number) => [from, at ? day(at) : ""].filter(Boolean).join(" · ");

export type LayoutStyle = "grid" | "board" | "document" | "timeline";

export interface LayoutItem {
  /** an image found with find_images (file:… / slack:… / media:…) */
  ref?: string;
  /** or a note: its markdown */
  markdown?: string;
  /** or a link, opened as a card */
  url?: string;
  title?: string;
  caption?: string;
}

const GAP = 24;
/** what fits across a new section (a default track, less its padding) */
const ROW_WIDTH = 1480;

/**
 * Lay items out in a section of their own: a grid (equal columns, masonry so
 * nothing gaps), a board (a looser mood board: every third image wide), a
 * document (one column: a heading, then each image with its caption, read
 * top to bottom), or a timeline (left to right in time order).
 */
export async function layOut(
  ctx: { boardId: string; actor: string; userId: string },
  opts: { title: string; section?: string; style?: LayoutStyle; items: LayoutItem[]; intro?: string; columns?: number },
) {
  const style = opts.style ?? "grid";
  // resolve every item first (imports from Slack happen here, outside the board edit)
  type Placed = { kind: "image"; file: FileRow; w: number; h: number; title: string; caption?: string; at: number } | { kind: "note"; title: string; markdown: string } | { kind: "link"; url: string; title: string };
  const placed: Placed[] = [];
  const skipped: string[] = [];
  const doc = (await import("./boards.ts")).getBoard(ctx.boardId).doc;
  for (const it of opts.items) {
    try {
      if (it.ref?.startsWith("media:")) {
        const o = boardMaps(doc).objects.get(it.ref.slice(6));
        const fileId = o?.kind === "media" ? /\/files\/(f_[a-z0-9]+)/.exec(o.src)?.[1] : undefined;
        const file = fileId ? one<FileRow>("select * from files where id = ?", fileId) : undefined;
        if (file) placed.push({ kind: "image", file, ...(await pixelSize(file)), title: it.title ?? file.name, caption: it.caption, at: file.created_at });
        else skipped.push(`${it.ref} (not a stored image)`);
      } else if (it.ref) {
        const got = await fileFor(it.ref, ctx.boardId, ctx.userId);
        if (!got) {
          skipped.push(`${it.ref} (not an image)`);
          continue;
        }
        const at = got.at ?? got.file.created_at;
        placed.push({ kind: "image", file: got.file, ...(await pixelSize(got.file)), title: it.title ?? got.title ?? got.file.name, caption: it.caption ?? caption(got.from, at), at });
      } else if (it.markdown) placed.push({ kind: "note", title: it.title ?? "Note", markdown: it.markdown });
      else if (it.url) placed.push({ kind: "link", url: it.url, title: it.title ?? new URL(it.url).host });
    } catch (e) {
      skipped.push(`${it.ref ?? it.url ?? "item"} (${(e as Error).message})`);
    }
  }
  if (style === "timeline") placed.sort((a, b) => (a.kind === "image" ? a.at : 0) - (b.kind === "image" ? b.at : 0));

  const made = editBoard(ctx.boardId, "agent", (d) => {
    const m = boardMaps(d);
    let sec: SectionDoc = (opts.section && findSection(d, opts.section)) || appendSection(d, opts.title);
    if (!opts.section && sec.name !== opts.title) sec = { ...sec, name: opts.title };
    m.sections.set(sec.id, sec);
    const ids: string[] = [];
    const add = (o: MediaDoc | PanelDoc | (NoteDoc & { text: string })) => {
      if (o.kind === "note") putNote(d, o as NoteDoc & { text: string });
      else m.objects.set(o.id, o);
      ids.push(o.id);
    };
    const base = { sectionId: sec.id, float: true, bornAt: Date.now() };
    const note = (x: number, y: number, w: number, h: number, name: string, text: string) =>
      add({ ...base, id: uid("note"), kind: "note", name, x, y, w, h, text });

    if (style === "document") {
      // one readable column: heading and intro, then each piece with its caption
      const W = 760;
      let y = 0;
      note(0, y, W, opts.intro ? 220 : 120, opts.title, `# ${opts.title}${opts.intro ? `\n\n${opts.intro}` : ""}`);
      y += (opts.intro ? 220 : 120) + GAP;
      for (const p of placed) {
        if (p.kind === "image") {
          const h = Math.round((W * p.h) / p.w);
          add({ ...base, id: uid("media"), kind: "media", name: p.title, x: 0, y, w: W, h, src: `/files/${p.file.id}`, media: "image", autoplay: false, muted: true });
          y += h + 8;
          note(0, y, W, 96, `${p.title} · caption`, `**${p.title}**${p.caption ? `  \n${p.caption}` : ""}`);
          y += 96 + GAP;
        } else if (p.kind === "note") {
          note(0, y, W, 260, p.title, p.markdown);
          y += 260 + GAP;
        } else {
          add({ ...base, id: uid("pnl"), kind: "panel", panel: "link", name: p.title, x: 0, y, w: W, h: 460, url: p.url, ports: [] });
          y += 460 + GAP;
        }
      }
    } else if (style === "timeline") {
      // left to right in time: each image over its caption, the row fitted to the section's width
      const images = placed.filter((p): p is Extract<Placed, { kind: "image" }> => p.kind === "image");
      const natural = (h: number) => images.reduce((sum, p) => sum + Math.min(560, Math.max(220, (h * p.w) / p.h)) + GAP, -GAP);
      const H = Math.max(140, Math.round(300 * Math.min(1, ROW_WIDTH / Math.max(1, natural(300)))));
      let x = 0;
      for (const p of images) {
        const w = Math.round(Math.min(560, Math.max(H * 0.73, (H * p.w) / p.h)));
        add({ ...base, id: uid("media"), kind: "media", name: p.title, x, y: 0, w, h: H, src: `/files/${p.file.id}`, media: "image", autoplay: false, muted: true });
        // the date leads, so the caption below it says only where it came from
        const where = p.caption?.replace(/ · \d{1,2} \w+ \d{4}$/, "");
        note(x, H + 8, w, 120, `${p.title} · caption`, `**${day(p.at)}**  \n${p.title}${where ? `  \n${where}` : ""}`);
        x += w + GAP;
      }
    } else {
      // grid / board: masonry columns — each piece goes in the shortest column
      const n = placed.length;
      const cols = Math.max(1, Math.min(6, opts.columns ?? (n <= 4 ? n : n <= 9 ? 3 : 4)));
      const W = cols <= 2 ? 520 : cols === 3 ? 440 : 340;
      const heights = new Array(cols).fill(opts.intro ? 0 : 0);
      if (opts.intro) {
        note(0, 0, cols * W + (cols - 1) * GAP, 128, opts.title, `# ${opts.title}\n\n${opts.intro}`);
        heights.fill(128 + GAP);
      }
      placed.forEach((p, i) => {
        // a mood board lets every third image run two columns wide — only where two columns end level, so no hole opens beside it
        let span = 1;
        if (style === "board" && p.kind === "image" && cols >= 3 && i % 3 === 0) {
          for (let c = 0; c + 1 < cols; c++) if (Math.abs(heights[c] - heights[c + 1]) <= 48) span = 2;
        }
        let col = 0;
        let best = Infinity;
        for (let c = 0; c + span <= cols; c++) {
          const top = Math.max(...heights.slice(c, c + span));
          // two columns wide only where they end level (else a hole opens under the shorter one)
          if (span === 2 && Math.abs(heights[c] - heights[c + 1]) > 48) continue;
          if (top < best) {
            best = top;
            col = c;
          }
        }
        const x = col * (W + GAP);
        const w = span * W + (span - 1) * GAP;
        let h: number;
        if (p.kind === "image") {
          h = Math.round((w * p.h) / p.w);
          add({ ...base, id: uid("media"), kind: "media", name: p.title, x, y: best, w, h, src: `/files/${p.file.id}`, media: "image", autoplay: false, muted: true });
          note(x, best + h + 6, w, 84, `${p.title} · caption`, `**${p.title}**${p.caption ? `  \n${p.caption}` : ""}`);
          h += 6 + 84;
        } else if (p.kind === "note") {
          h = 240;
          note(x, best, w, h, p.title, p.markdown);
        } else {
          h = 360;
          add({ ...base, id: uid("pnl"), kind: "panel", panel: "link", name: p.title, x, y: best, w, h, url: p.url, ports: [] });
        }
        for (let c = col; c < col + span; c++) heights[c] = best + h + GAP;
      });
    }
    return { section: sec.id, ids };
  });
  return { section: made.section, cards: made.ids.length, images: placed.filter((p) => p.kind === "image").length, skipped };
}
