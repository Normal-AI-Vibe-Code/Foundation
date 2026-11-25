/**
 * ChatForm's history (docs/chatform.md §1 "History comes with us", package I1). Josh: "be able to download
 * the chats that we have so far … and have a seamless transition."
 *
 * In:
 *  - a Slack export (Workspace settings → Import/Export → Export): a zip, or the folder it unzips to.
 *    `users.json`, `channels.json` (public), `groups.json` (private), `dms.json`, `mpims.json`, and a folder
 *    per conversation of `YYYY-MM-DD.json` day files. The zip is read from disk entry by entry (its central
 *    directory, zip64 included) and inflated as a stream: a 2 GB export never sits in memory, one day file
 *    at a time does.
 *  - Slack's Web API with a token (`SLACK_USER_TOKEN`, else `SLACK_BOT_TOKEN`): users.list,
 *    conversations.list / history / replies / members, cursor pages, Retry-After honoured. For plans whose
 *    export leaves out DMs and private channels, and to top up after an export.
 *  Both land through one mapping, with the same origins (`slack` + channel id, `slack` + `<channel>:<ts>`),
 *  so an export and an API pull never double anything, and bringing either in twice adds nothing.
 *
 * Out: everything a person can see, as one zip: `channels.json`, `people.json`, each conversation as JSON
 * and Markdown, and (optionally) its files.
 *
 * People: a Slack user whose email is a Foundation user's *is* that person (the ghost row is linked:
 * `chat_ghosts.user_id`); everyone else is a ghost of service `slack`, bots flagged in their handle
 * (`bot:<id>`) and name ("… (bot)"). `linkGhostsByEmail(user)` turns a person's ghost into them when they
 * arrive later (their messages, memberships and reactions become theirs).
 *
 * Bringing history in writes in other people's names, so it is an admin's, as a person (`requirePerson`).
 *
 * Tables of its own (made at import, like chat.ts): import jobs and their reports, the Slack people seen
 * (with their emails, for linking later), the Slack files seen (stored, or why not).
 */

import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { once } from "node:events";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, crc32, deflateRawSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import {
  CHAT_GROUP_MAX,
  chatHandle,
  chatMembersKey,
  chatSlug,
  chatTitle,
  slackEmoji,
  slackToMarkdown,
  slackTsMs,
  type ChatChannel,
  type ChatChannelKind,
  type ChatMessageType,
  type ChatParty,
  type UserInfo,
} from "@foundation/protocol";
import { config } from "./config.ts";
import { all, db, one, run } from "./db.ts";
import { HttpError, readJson, type Req, type Router } from "./http.ts";
import { requirePerson, requireUser } from "./auth.ts";
import { canSeeBoard } from "./members.ts";
import { storeFile } from "./files.ts";
import { getPlace, resolveInPlace } from "./places.ts";
import { slackBotToken } from "./slack.ts";
import {
  CHAT_BOARD,
  SYSTEM_PARTY,
  addMember,
  canSeeChannel,
  canSeeChatFile,
  channelByOrigin,
  channelView,
  createChannel,
  exportChannel,
  exportMarkdown,
  getChannel,
  ghostParty,
  personParty,
  postMessage,
} from "./chat.ts";

db.exec(`
create table if not exists chat_import_jobs (
  id text primary key,
  kind text not null,
  dry_run integer not null default 0,
  state text not null,
  source text not null,
  started_by text,
  started_at integer not null,
  finished_at integer,
  progress_json text,
  report_json text,
  error text,
  request_id text
);
create table if not exists chat_import_people (
  service text not null,
  external_id text not null,
  email text,
  name text not null,
  is_bot integer not null default 0,
  ghost_id text,
  user_id text,
  primary key (service, external_id)
);
create index if not exists chat_import_people_email on chat_import_people(email);
create table if not exists chat_import_files (
  service text not null,
  external_id text not null,
  file_id text,
  state text not null,
  why text,
  name text not null,
  size integer,
  url text,
  primary key (service, external_id)
);
`);

/** whoever stored a brought-in file: nobody's, so a file opens only for those who can read a message carrying it */
const IMPORT_UPLOADER = "slack-import";
const DEFAULT_MAX_FILE = 100 * 1024 * 1024;
const BATCH = 400;
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// =====================================================================================================
// zip: read (central directory, zip64, stored + deflate, streamed from disk) and write (streamed, zip64)
// =====================================================================================================

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  csize: number;
  usize: number;
  offset: number;
}

const u64 = (b: Buffer, at: number) => Number(b.readBigUInt64LE(at));

/** a zip on disk, read by its central directory: entries are streamed from their offsets, never the whole file */
export class ZipReader {
  private constructor(
    readonly path: string,
    readonly entries: Map<string, ZipEntry>,
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const fh = await open(path, "r");
    try {
      const size = (await fh.stat()).size;
      const tailLen = Math.min(size, 65_557 + 20);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new HttpError(400, "That isn't a zip (no central directory). Slack's export is a .zip; bring the file as it downloaded.");
      let count = tail.readUInt16LE(eocd + 10);
      let cdSize = tail.readUInt32LE(eocd + 12);
      let cdOffset = tail.readUInt32LE(eocd + 16);
      // zip64: a locator sits just before the end record
      if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
        const z64At = u64(tail, eocd - 20 + 8);
        const z = Buffer.alloc(56);
        await fh.read(z, 0, 56, z64At);
        if (z.readUInt32LE(0) !== 0x06064b50) throw new HttpError(400, "That zip's zip64 record is damaged.");
        count = u64(z, 32);
        cdSize = u64(z, 40);
        cdOffset = u64(z, 48);
      }
      if (cdSize > 1024 * 1024 * 1024) throw new HttpError(400, "That zip's directory is too big to be a Slack export.");
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries = new Map<string, ZipEntry>();
      let p = 0;
      for (let i = 0; i < count && p + 46 <= cd.length; i++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) break;
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const e: ZipEntry = {
          flags: cd.readUInt16LE(p + 8),
          method: cd.readUInt16LE(p + 10),
          csize: cd.readUInt32LE(p + 20),
          usize: cd.readUInt32LE(p + 24),
          offset: cd.readUInt32LE(p + 42),
          name: cd.toString("utf8", p + 46, p + 46 + nameLen),
        };
        // zip64 extra field (0x0001): the sizes and offset that didn't fit, in that order
        let x = p + 46 + nameLen;
        const xEnd = x + extraLen;
        while (x + 4 <= xEnd) {
          const id = cd.readUInt16LE(x);
          const len = cd.readUInt16LE(x + 2);
          if (id === 1) {
            let q = x + 4;
            if (e.usize === 0xffffffff) {
              e.usize = u64(cd, q);
              q += 8;
            }
            if (e.csize === 0xffffffff) {
              e.csize = u64(cd, q);
              q += 8;
            }
            if (e.offset === 0xffffffff) e.offset = u64(cd, q);
          }
          x += 4 + len;
        }
        entries.set(e.name.replace(/\\/g, "/"), e);
        p = xEnd + commentLen;
      }
      return new ZipReader(path, entries);
    } finally {
      await fh.close();
    }
  }

  /** one entry's bytes, as a stream (inflated when deflated) */
  async stream(e: ZipEntry): Promise<Readable> {
    if (e.flags & 1) throw new Error(`${e.name} is encrypted`);
    if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name} uses a compression this reader doesn't know (${e.method})`);
    const fh = await open(this.path, "r");
    let start: number;
    try {
      const h = Buffer.alloc(30);
      await fh.read(h, 0, 30, e.offset);
      if (h.readUInt32LE(0) !== 0x04034b50) throw new Error(`${e.name}: damaged entry`);
      start = e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    } finally {
      await fh.close();
    }
    if (e.csize === 0) return Readable.from([]);
    const raw = createReadStream(this.path, { start, end: start + e.csize - 1 });
    if (e.method === 0) return raw;
    const inflate = createInflateRaw();
    raw.on("error", (err) => inflate.destroy(err));
    return raw.pipe(inflate);
  }

  async text(name: string, max = 512 * 1024 * 1024): Promise<string> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`no ${name} in the zip`);
    if (e.usize > max) throw new Error(`${name} is too big to read (${e.usize} bytes)`);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of await this.stream(e)) {
      n += (c as Buffer).length;
      if (n > max) throw new Error(`${name} is too big to read`);
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

function dosStamp(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface WrittenEntry {
  name: Buffer;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

/**
 * A zip written front to back onto a stream (an HTTP response, a file): each entry's sizes follow it in a
 * data descriptor, and zip64 records are written when sizes, offsets or the count need them (or always,
 * with `zip64: true`). Text is deflated; streamed files are stored as they are.
 */
export class ZipWriter {
  private offset = 0;
  private written: WrittenEntry[] = [];
  private stamp = dosStamp();
  constructor(
    private out: Writable,
    private opts: { zip64?: boolean } = {},
  ) {}

  private async write(b: Buffer) {
    this.offset += b.length;
    if (!this.out.write(b)) await once(this.out, "drain");
  }

  private header(name: Buffer, method: number) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(45, 4);
    h.writeUInt16LE(0x0808, 6); // utf-8 names, sizes in a data descriptor
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt16LE(name.length, 26);
    return Buffer.concat([h, name]);
  }

  private descriptor(crc: number, csize: number, usize: number) {
    const big = this.opts.zip64 || csize >= 0xffffffff || usize >= 0xffffffff;
    const d = Buffer.alloc(big ? 24 : 16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    if (big) {
      d.writeBigUInt64LE(BigInt(csize), 8);
      d.writeBigUInt64LE(BigInt(usize), 16);
    } else {
      d.writeUInt32LE(csize, 8);
      d.writeUInt32LE(usize, 12);
    }
    return d;
  }

  /** text or small bytes, deflated */
  async add(name: string, data: string | Buffer) {
    const raw = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const offset = this.offset;
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);
    await this.write(this.header(nameBuf, 8));
    await this.write(packed);
    await this.write(this.descriptor(crc, packed.length, raw.length));
    this.written.push({ name: nameBuf, method: 8, crc, csize: packed.length, usize: raw.length, offset });
  }

  /** a stream (a file from the archive), stored */
  async addStream(name: string, src: Readable) {
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const offset = this.offset;
    await this.write(this.header(nameBuf, 0));
    let crc = 0;
    let size = 0;
    for await (const c of src) {
      const b = c as Buffer;
      crc = crc32(b, crc);
      size += b.length;
      await this.write(b);
    }
    await this.write(this.descriptor(crc, size, size));
    this.written.push({ name: nameBuf, method: 0, crc, csize: size, usize: size, offset });
  }

  async finish() {
    const cdStart = this.offset;
    const force = Boolean(this.opts.zip64);
    for (const e of this.written) {
      const needU = force || e.usize >= 0xffffffff;
      const needC = force || e.csize >= 0xffffffff;
      const needO = force || e.offset >= 0xffffffff;
      const extraParts: Buffer[] = [];
      const push64 = (v: number) => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(v));
        extraParts.push(b);
      };
      if (needU) push64(e.usize);
      if (needC) push64(e.csize);
      if (needO) push64(e.offset);
      let extra = Buffer.alloc(0);
      if (extraParts.length) {
        const body = Buffer.concat(extraParts);
        const head = Buffer.alloc(4);
        head.writeUInt16LE(1, 0);
        head.writeUInt16LE(body.length, 2);
        extra = Buffer.concat([head, body]);
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(45, 4);
      c.writeUInt16LE(45, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(this.stamp.time, 12);
      c.writeUInt16LE(this.stamp.date, 14);
      c.writeUInt32LE(e.crc >>> 0, 16);
      c.writeUInt32LE(needC ? 0xffffffff : e.csize, 20);
      c.writeUInt32LE(needU ? 0xffffffff : e.usize, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE(needO ? 0xffffffff : e.offset, 42);
      await this.write(Buffer.concat([c, e.name, extra]));
    }
    const cdSize = this.offset - cdStart;
    const n = this.written.length;
    const z64 = force || n >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (z64) {
      const recAt = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4);
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(n), 24);
      r.writeBigUInt64LE(BigInt(n), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      const l = Buffer.alloc(20);
      l.writeUInt32LE(0x07064b50, 0);
      l.writeBigUInt64LE(BigInt(recAt), 8);
      l.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([r, l]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(z64 ? 0xffff : n, 8);
    end.writeUInt16LE(z64 ? 0xffff : n, 10);
    end.writeUInt32LE(z64 ? 0xffffffff : cdSize, 12);
    end.writeUInt32LE(z64 ? 0xffffffff : cdStart, 16);
    await this.write(end);
  }
}

// =====================================================================================================
// Slack's shapes (what an export's JSON and the Web API hand over; only what's used)
// =====================================================================================================

interface SlackProfile {
  real_name?: string;
  display_name?: string;
  email?: string;
  image_72?: string;
  image_192?: string;
  bot_id?: string;
}
export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: SlackProfile;
}
export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  mode?: string;
  is_external?: boolean;
}
interface SlackAttachment {
  fallback?: string;
  pretext?: string;
  author_name?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: Array<{ title?: string; value?: string }>;
  footer?: string;
  image_url?: string;
  from_url?: string;
  original_url?: string;
}
interface SlackBlockElement {
  type: string;
  text?: string | { type?: string; text?: string };
  url?: string;
  user_id?: string;
  channel_id?: string;
  usergroup_id?: string;
  name?: string;
  unicode?: string;
  range?: string;
  style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean } | string;
  elements?: SlackBlockElement[];
  indent?: number;
  fields?: Array<{ type?: string; text?: string }>;
  timestamp?: number;
}
export interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; users?: string[]; count?: number }>;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  blocks?: SlackBlockElement[];
  edited?: { user?: string; ts?: string };
  user_profile?: { real_name?: string; display_name?: string; name?: string; image_72?: string };
  bot_profile?: { name?: string; icons?: { image_72?: string; image_48?: string } };
  icons?: { image_72?: string; image_48?: string };
  pinned_to?: string[];
  topic?: string;
  purpose?: string;
  name?: string;
  old_name?: string;
  room?: { name?: string; date_start?: number; date_end?: number; participant_history?: string[]; participants?: string[] };
  metadata?: { event_type?: string };
}
export interface SlackConversation {
  id: string;
  kind: ChatChannelKind;
  name: string;
  created?: number;
  creator?: string;
  archived?: boolean;
  members: string[];
  topic: string;
  purpose: string;
  pins: Set<string>;
}

// =====================================================================================================
// the report and the job
// =====================================================================================================

export interface ImportConversationReport {
  slackId: string;
  name: string;
  kind: ChatChannelKind;
  channel?: string;
  merged?: boolean;
  messages: number;
  already: number;
  replies: number;
  files: number;
  filesMissing: number;
  skipped: number;
  note?: string;
}

export interface ImportReport {
  kind: "export" | "api";
  dryRun: boolean;
  source: string;
  startedAt: number;
  finishedAt?: number;
  conversations: ImportConversationReport[];
  people: { matched: Array<{ slackId: string; name: string; email: string; user: string; userName: string }>; ghosts: number; bots: number; total: number };
  totals: { conversations: number; open: number; private: number; dm: number; group: number; messages: number; already: number; replies: number; reactions: number; pins: number; files: number; filesBytes: number; filesMissing: number; filesSkipped: number };
  skipped: Array<{ why: string; count: number; examples: string[] }>;
  warnings: string[];
}

export interface ImportProgress {
  state: ImportJobState;
  channel: string;
  done: number;
  total: number;
  messages: number;
  files: number;
  skipped: Array<{ why: string; count: number }>;
}

export type ImportJobState = "running" | "done" | "failed" | "interrupted";

export interface ImportJob {
  id: string;
  kind: "export" | "api";
  dryRun: boolean;
  state: ImportJobState;
  source: string;
  startedBy: string | null;
  startedAt: number;
  finishedAt: number | null;
  progress: ImportProgress;
  error?: string;
}

export function emptyReport(kind: "export" | "api", dryRun: boolean, source: string): ImportReport {
  return {
    kind,
    dryRun,
    source,
    startedAt: Date.now(),
    conversations: [],
    people: { matched: [], ghosts: 0, bots: 0, total: 0 },
    totals: { conversations: 0, open: 0, private: 0, dm: 0, group: 0, messages: 0, already: 0, replies: 0, reactions: 0, pins: 0, files: 0, filesBytes: 0, filesMissing: 0, filesSkipped: 0 },
    skipped: [],
    warnings: [],
  };
}

function skip(report: ImportReport, why: string, example?: string) {
  let s = report.skipped.find((x) => x.why === why);
  if (!s) report.skipped.push((s = { why, count: 0, examples: [] }));
  s.count++;
  if (example && s.examples.length < 5 && !s.examples.includes(example)) s.examples.push(example);
}

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** the report as a page a person reads (and downloads) */
export function reportMarkdown(r: ImportReport): string {
  const iso = (t?: number) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "not finished");
  const t = r.totals;
  const L: string[] = [];
  L.push(`# Slack history: ${r.dryRun ? "what would come in" : "what came in"}`, "");
  L.push(`${r.kind === "export" ? "Export" : "Slack API"}: ${r.source}  `, `Started ${iso(r.startedAt)} · finished ${iso(r.finishedAt)}${r.dryRun ? " · **dry run: nothing was written**" : ""}`, "");
  L.push("## Totals", "");
  L.push(`- ${t.conversations} conversations: ${t.open} channels, ${t.private} private channels, ${t.dm} direct messages, ${t.group} groups`);
  L.push(`- ${t.messages} messages${r.dryRun ? " to bring in" : " brought in"} (${t.replies} of them thread replies)${t.already ? `; ${t.already} were already here and were left as they are` : ""}`);
  L.push(`- ${t.reactions} reactions, ${t.pins} pins`);
  L.push(`- Files: ${t.files} ${r.dryRun ? "to fetch" : "brought in"} (${mb(t.filesBytes)})${t.filesMissing ? `; ${t.filesMissing} kept as named placeholders (Slack wouldn't hand them over)` : ""}${t.filesSkipped ? `; ${t.filesSkipped} skipped` : ""}`, "");
  L.push("## People", "");
  L.push(`${r.people.total} people in Slack: ${r.people.matched.length} matched to Foundation by email, ${r.people.ghosts} brought in as Slack people (ghosts), ${r.people.bots} bots.`, "");
  for (const m of r.people.matched) L.push(`- ${m.name} (${m.email}) → ${m.userName}`);
  if (r.people.matched.length) L.push("");
  if (r.people.ghosts) L.push("A ghost becomes its person the first time someone signs in to Foundation with the same email.", "");
  L.push("## Skipped or changed", "");
  if (!r.skipped.length) L.push("Nothing.", "");
  for (const s of r.skipped) L.push(`- ${s.why}: ${s.count}${s.examples.length ? ` (e.g. ${s.examples.join(", ")})` : ""}`);
  if (r.skipped.length) L.push("");
  if (r.warnings.length) {
    L.push("## Warnings", "");
    for (const w of r.warnings) L.push(`- ${w}`);
    L.push("");
  }
  L.push("## Conversations", "", "| Conversation | Kind | Messages | Already here | Replies | Files | Missing files | Skipped |", "|---|---|---:|---:|---:|---:|---:|---:|");
  for (const c of r.conversations) L.push(`| ${c.name.replace(/\|/g, "/")}${c.merged ? " (merged)" : ""}${c.note ? ` (${c.note})` : ""} | ${c.kind} | ${c.messages} | ${c.already} | ${c.replies} | ${c.files} | ${c.filesMissing} | ${c.skipped} |`);
  L.push("");
  return L.join("\n");
}

// =====================================================================================================
// people
// =====================================================================================================

function slackName(u: SlackUser | undefined): string {
  if (!u) return "";
  return (u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || "").trim();
}

const isBotUser = (id: string, u?: SlackUser) => id === "USLACKBOT" || Boolean(u?.is_bot) || Boolean(u?.profile?.bot_id);

const userByEmail = (email: string) => one<UserInfo>("select id, email, name, color, role from users where lower(email) = ?", email.toLowerCase());

/**
 * One ghost becomes one person: the ghost row is linked, and what it wrote, where it was a member and what
 * it reacted becomes theirs. A dm or group keyed by the ghost is keyed by the person (unless a dm of
 * theirs with the same people exists already; then the brought-in one keeps its key).
 */
function linkGhost(ghostId: string, user: Pick<UserInfo, "id" | "name" | "color">): boolean {
  const g = one<{ id: string; user_id: string | null }>("select id, user_id from chat_ghosts where id = ?", ghostId);
  if (!g) return false;
  const person = personParty(user);
  const pj = JSON.stringify(person);
  const changed =
    g.user_id !== user.id ||
    Boolean(one("select 1 from chat_messages where author_kind = 'ghost' and author_id = ? limit 1", ghostId)) ||
    Boolean(one("select 1 from chat_members where party_kind = 'ghost' and party_id = ? limit 1", ghostId));
  if (!changed) return false;
  db.exec("savepoint chatimport_link");
  try {
    run("update chat_ghosts set user_id = ? where id = ?", user.id, ghostId);
    run("update chat_messages set author_kind = 'person', author_id = ?, author_json = ?, updated_at = ? where author_kind = 'ghost' and author_id = ?", user.id, pj, Date.now(), ghostId);
    for (const m of all<{ channel_id: string }>("select channel_id from chat_members where party_kind = 'ghost' and party_id = ?", ghostId)) {
      if (one("select 1 from chat_members where channel_id = ? and party_kind = 'person' and party_id = ?", m.channel_id, user.id)) {
        run("delete from chat_members where channel_id = ? and party_kind = 'ghost' and party_id = ?", m.channel_id, ghostId);
      } else {
        run("update chat_members set party_kind = 'person', party_id = ?, name = ?, party_json = ? where channel_id = ? and party_kind = 'ghost' and party_id = ?", user.id, user.name, pj, m.channel_id, ghostId);
      }
      const ch = one<{ id: string; members_key: string | null }>("select id, members_key from chat_channels where id = ?", m.channel_id);
      if (ch?.members_key) {
        const keys = all<{ party_kind: string; party_id: string }>("select party_kind, party_id from chat_members where channel_id = ?", ch.id).map((r) => (r.party_kind === "person" ? r.party_id : `${r.party_kind}:${r.party_id}`));
        const key = chatMembersKey(keys);
        if (key !== ch.members_key && !one("select 1 from chat_channels where members_key = ?", key)) run("update chat_channels set members_key = ? where id = ?", key, ch.id);
      }
    }
    run(
      "insert or ignore into chat_reactions (message_id, emoji, party_kind, party_id, name, at) select message_id, emoji, 'person', ?, ?, at from chat_reactions where party_kind = 'ghost' and party_id = ?",
      user.id, user.name, ghostId,
    );
    run("delete from chat_reactions where party_kind = 'ghost' and party_id = ?", ghostId);
    run("update chat_import_people set user_id = ? where ghost_id = ?", user.id, ghostId);
    db.exec("release chatimport_link");
  } catch (e) {
    db.exec("rollback to chatimport_link");
    db.exec("release chatimport_link");
    throw e;
  }
  return true;
}

/**
 * Slack people whose email is this Foundation user's become them (call it when someone signs in; the
 * importer calls it for everyone after each run). Without a user: every Slack person whose email has
 * arrived since. Answers how many ghosts became people.
 */
export function linkGhostsByEmail(user?: Pick<UserInfo, "id" | "email" | "name" | "color">): number {
  const rows = user
    ? all<{ ghost_id: string; email: string }>("select ghost_id, email from chat_import_people where email = ? and ghost_id is not null and is_bot = 0", user.email.toLowerCase())
    : all<{ ghost_id: string; email: string }>("select ghost_id, email from chat_import_people where email is not null and ghost_id is not null and is_bot = 0");
  let n = 0;
  for (const r of rows) {
    const u = user ?? userByEmail(r.email);
    if (u && linkGhost(r.ghost_id, u)) n++;
  }
  return n;
}

// =====================================================================================================
// files from Slack
// =====================================================================================================

const SLACK_FILE_HOST = /(^|\.)(slack\.com|slack-edge\.com|slack-files\.com|slack-redir\.net)$/i;

/** in tests only, Slack's file hosts are answered by a stand-in (CHATIMPORT_TEST_FILE_ORIGIN, under node --test) */
function testOrigin(): string | null {
  return process.env.NODE_TEST_CONTEXT && process.env.CHATIMPORT_TEST_FILE_ORIGIN ? process.env.CHATIMPORT_TEST_FILE_ORIGIN : null;
}

function slackFileUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || !SLACK_FILE_HOST.test(u.hostname)) return null;
  const t = testOrigin();
  if (t) {
    const o = new URL(t);
    u.protocol = o.protocol;
    u.host = o.host;
  }
  return u;
}

type Fetched = { ok: true; body: Buffer; mime: string } | { ok: false; why: string; missing: boolean };

/** a Slack file's bytes: https, Slack's own hosts only (every hop), at most `max` bytes; the token goes only to Slack */
async function fetchSlackFile(raw: string, max: number, token?: string): Promise<Fetched> {
  let url = slackFileUrl(raw);
  if (!url) return { ok: false, why: "not on Slack's file host over https", missing: false };
  for (let hop = 0; hop < 4; hop++) {
    const headers: Record<string, string> = { "user-agent": "ChatForm history import" };
    if (token && !url.searchParams.has("t")) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      return { ok: false, why: `couldn't reach Slack (${(e as Error).message})`, missing: true };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = slackFileUrl(new URL(res.headers.get("location")!, url).toString());
      await res.body?.cancel();
      if (!next) return { ok: false, why: "Slack sent it somewhere else", missing: true };
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, why: res.status === 403 || res.status === 401 ? `the link has expired (HTTP ${res.status})` : `Slack answered HTTP ${res.status}`, missing: true };
    }
    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    if (/^text\/html/.test(mime)) {
      await res.body?.cancel();
      return { ok: false, why: "Slack answered with a sign-in page (the link's token has expired)", missing: true };
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > max) {
      await res.body?.cancel();
      return { ok: false, why: `over the ${mb(max)} cap`, missing: false };
    }
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of res.body ?? Readable.from([])) {
      n += (c as Uint8Array).length;
      if (n > max) return { ok: false, why: `over the ${mb(max)} cap`, missing: false };
      chunks.push(Buffer.from(c as Uint8Array));
    }
    return { ok: true, body: Buffer.concat(chunks), mime };
  }
  return { ok: false, why: "too many redirects", missing: true };
}

// =====================================================================================================
// mrkdwn's company: attachments and blocks as readable markdown
// =====================================================================================================

function richText(els: SlackBlockElement[] | undefined, who: (id: string) => string, where: (id: string) => string | undefined): string {
  let out = "";
  for (const el of els ?? []) {
    switch (el.type) {
      case "text": {
        let t = typeof el.text === "string" ? el.text : "";
        const s = typeof el.style === "object" ? el.style : undefined;
        if (s?.code) t = `\`${t}\``;
        else {
          const lead = /^\s*/.exec(t)![0];
          const trail = /\s*$/.exec(t)![0];
          let core = t.trim();
          if (core) {
            if (s?.bold) core = `**${core}**`;
            if (s?.italic) core = `_${core}_`;
            if (s?.strike) core = `~~${core}~~`;
          }
          t = lead + core + (core ? trail : "");
        }
        out += t;
        break;
      }
      case "link":
        out += el.text && typeof el.text === "string" && el.text !== el.url ? `[${el.text}](${el.url})` : (el.url ?? "");
        break;
      case "user":
        out += `@${who(el.user_id ?? "")}`;
        break;
      case "channel":
        out += `#${where(el.channel_id ?? "") ?? el.channel_id ?? ""}`;
        break;
      case "usergroup":
        out += "@group";
        break;
      case "broadcast":
        out += el.range === "here" ? "@here" : "@channel";
        break;
      case "emoji":
        out += el.unicode ? String.fromCodePoint(...el.unicode.split("-").map((h) => parseInt(h, 16))) : slackEmoji(el.name ?? "");
        break;
      case "date":
        out += typeof el.text === "string" ? el.text : el.timestamp ? new Date(el.timestamp * 1000).toISOString().slice(0, 10) : "";
        break;
      default:
        if (el.elements) out += richText(el.elements, who, where);
        else if (typeof el.text === "string") out += el.text;
    }
  }
  return out;
}

function blocksMarkdown(blocks: SlackBlockElement[] | undefined, who: (id: string) => string, where: (id: string) => string | undefined): string {
  const parts: string[] = [];
  const md = (t: string | undefined) => slackToMarkdown(t ?? "", who, where);
  for (const b of blocks ?? []) {
    const txt = typeof b.text === "object" ? b.text?.text : typeof b.text === "string" ? b.text : undefined;
    if (b.type === "rich_text") {
      const segs: string[] = [];
      for (const el of b.elements ?? []) {
        if (el.type === "rich_text_section") segs.push(richText(el.elements, who, where).replace(/\s+$/, ""));
        else if (el.type === "rich_text_list") {
          const ordered = el.style === "ordered";
          const pad = "  ".repeat(el.indent ?? 0);
          segs.push((el.elements ?? []).map((item, i) => `${pad}${ordered ? `${i + 1}.` : "-"} ${richText(item.elements, who, where)}`).join("\n"));
        } else if (el.type === "rich_text_preformatted") segs.push("```\n" + richText(el.elements, who, where) + "\n```");
        else if (el.type === "rich_text_quote") segs.push(richText(el.elements, who, where).split("\n").map((l) => `> ${l}`).join("\n"));
        else segs.push(richText(el.elements, who, where));
      }
      parts.push(segs.join("\n").replace(/\n{3,}/g, "\n\n").trim());
    } else if (b.type === "header") parts.push(`**${(txt ?? "").trim()}**`);
    else if (b.type === "section") {
      if (txt) parts.push(md(txt));
      for (const f of b.fields ?? []) if (f.text) parts.push(md(f.text));
    } else if (b.type === "context") parts.push((b.elements ?? []).map((e) => (typeof e.text === "string" ? md(e.text) : typeof e.text === "object" ? md(e.text?.text) : "")).filter(Boolean).join(" · "));
    else if (b.type === "divider") parts.push("---");
  }
  return parts.filter((p) => p.trim()).join("\n\n");
}

function attachmentsMarkdown(atts: SlackAttachment[] | undefined, who: (id: string) => string, where: (id: string) => string | undefined): string {
  const md = (t: string | undefined) => slackToMarkdown(t ?? "", who, where);
  const out: string[] = [];
  for (const a of atts ?? []) {
    const lines: string[] = [];
    if (a.pretext) lines.push(md(a.pretext));
    const quoted: string[] = [];
    if (a.author_name) quoted.push(`_${a.author_name}_`);
    if (a.title) quoted.push(a.title_link ? `**[${a.title.replace(/[[\]]/g, "")}](${a.title_link})**` : `**${a.title}**`);
    if (a.text) quoted.push(md(a.text));
    for (const f of a.fields ?? []) if (f.title || f.value) quoted.push(`**${f.title ?? ""}**${f.title && f.value ? ": " : ""}${md(f.value)}`);
    if (a.footer) quoted.push(`_${md(a.footer)}_`);
    if (!quoted.length && !lines.length && a.fallback) quoted.push(md(a.fallback));
    if (!quoted.length && (a.from_url || a.original_url)) continue; // an unfurl of a link the text already has
    if (quoted.length) lines.push(quoted.join("\n").split("\n").map((l) => `> ${l}`).join("\n"));
    if (lines.length) out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}

// =====================================================================================================
// the mapping: one importer for the export and for the API
// =====================================================================================================

const TEXT_SUBTYPES = new Set(["bot_message", "file_share", "thread_broadcast", "reply_broadcast", "me_message", "slackbot_response", "file_mention", "ekm_access_denied"]);
const SYSTEM_SUBTYPES = new Set([
  "bot_add", "bot_remove", "bot_enable", "bot_disable", "app_conversation_join", "app_conversation_leave", "channel_convert_to_private", "channel_convert_to_public",
  "reminder_add", "channel_posting_permissions", "joiner_notification", "joiner_notification_for_inviter", "channel_canvas_updated", "group_canvas_updated",
  "channel_unarchive", "group_unarchive", "slack_connect_channel_welcome", "share_shortcut", "channel_huddle_ended",
]);
const EVENT_SUBTYPES = new Set(["message_changed", "message_deleted", "message_replied", "assistant_app_thread"]);

interface ImportOptions {
  dryRun: boolean;
  files: boolean;
  maxFileBytes: number;
  token?: string;
}

export interface Prepared {
  author: ChatParty;
  type: ChatMessageType;
  text: string;
  files: string[];
  createdAt: number;
  editedAt?: number;
  pinned: boolean;
  threadTs?: string;
}

/** the one mapping from Slack to ChatForm (people, words, files, threads, reactions); the live Slack bridge (bridges/slack.ts) uses it too */
export class Importer {
  users = new Map<string, SlackUser>();
  /** a bot's bot id (on its messages) → its user id (in users.json), so a bot is one ghost however it posts */
  botUsers = new Map<string, string>();
  convNames = new Map<string, string>();
  private parties = new Map<string, ChatParty>();
  private fileCache = new Map<string, { id?: string; placeholder?: string }>();
  constructor(
    readonly report: ImportReport,
    readonly opts: ImportOptions,
    readonly onProgress: () => void,
    readonly progress: ImportProgress,
  ) {}

  loadUsers(list: SlackUser[]) {
    for (const u of list) if (u?.id) this.users.set(u.id, u);
    for (const u of this.users.values()) if (u.profile?.bot_id) this.botUsers.set(u.profile.bot_id, u.id);
    const p = this.report.people;
    p.matched = [];
    p.ghosts = p.bots = 0;
    p.total = this.users.size;
    for (const u of this.users.values()) {
      if (isBotUser(u.id, u)) {
        p.bots++;
        continue;
      }
      const email = u.profile?.email?.toLowerCase();
      const user = email ? userByEmail(email) : undefined;
      if (user && email) p.matched.push({ slackId: u.id, name: slackName(u) || u.id, email, user: user.id, userName: user.name });
      else p.ghosts++;
    }
  }

  private remember(id: string, name: string, email: string | null, bot: boolean, ghostId: string | null, userId: string | null) {
    if (this.opts.dryRun) return;
    run(
      `insert into chat_import_people (service, external_id, email, name, is_bot, ghost_id, user_id) values ('slack', ?, ?, ?, ?, ?, ?)
       on conflict (service, external_id) do update set email = coalesce(excluded.email, email), name = excluded.name, is_bot = excluded.is_bot, ghost_id = coalesce(excluded.ghost_id, ghost_id), user_id = coalesce(excluded.user_id, user_id)`,
      id, email, name, bot ? 1 : 0, ghostId, userId,
    );
  }

  private ghostIdOf(handle: string): string | null {
    return one<{ id: string }>("select id from chat_ghosts where service = 'slack' and handle = ?", handle.toLowerCase())?.id ?? null;
  }

  /** a bot: by its user id when it has one, else its bot id; its name says it's a bot */
  bot(key: string, name: string, avatar?: string): ChatParty {
    const k = `bot:${key}`;
    const label = `${(name || "App").replace(/\s*\(bot\)$/i, "")} (bot)`;
    const hit = this.parties.get(`${k}|${label}`);
    if (hit) return hit;
    let p: ChatParty;
    if (this.opts.dryRun) p = { kind: "ghost", id: `dry:${k}`, name: label, service: "slack", handle: k.toLowerCase() };
    else {
      p = ghostParty("slack", k, label, avatar);
      this.remember(k, label, null, true, p.kind === "ghost" ? p.id : this.ghostIdOf(k), null);
    }
    this.parties.set(`${k}|${label}`, p);
    return p;
  }

  /** a Slack user as a party here: the person with their email, else their ghost */
  party(id: string, profile?: SlackMessage["user_profile"]): ChatParty {
    const hit = this.parties.get(id);
    if (hit) return hit;
    const u = this.users.get(id);
    if (isBotUser(id, u)) {
      const p = this.bot(id, id === "USLACKBOT" ? "Slackbot" : slackName(u) || profile?.real_name || id, u?.profile?.image_72);
      this.parties.set(id, p);
      return p;
    }
    const name = slackName(u) || profile?.real_name || profile?.display_name || profile?.name || id;
    const email = u?.profile?.email?.toLowerCase() ?? null;
    const user = email ? userByEmail(email) : undefined;
    let p: ChatParty;
    if (this.opts.dryRun) p = user ? personParty(user) : { kind: "ghost", id: `dry:${id}`, name, service: "slack", handle: id.toLowerCase() };
    else {
      const g = ghostParty("slack", id, name, u?.profile?.image_72 ?? profile?.image_72);
      const ghostId = g.kind === "ghost" ? g.id : this.ghostIdOf(id);
      this.remember(id, name, email, false, ghostId, user?.id ?? null);
      if (user && ghostId) {
        linkGhost(ghostId, user);
        p = personParty(user);
      } else p = g;
    }
    this.parties.set(id, p);
    return p;
  }

  /** `<@U…>` here: the person's handle (so it mentions them), or the ghost's */
  who = (id: string): string => {
    if (!id) return "someone";
    if (!this.users.has(id) && !this.parties.has(id)) return id;
    return chatHandle(this.party(id).name.replace(/\s*\(bot\)$/, ""));
  };
  where = (id: string): string | undefined => this.convNames.get(id);

  private author(m: SlackMessage): ChatParty {
    // posted into Slack from Foundation ("Josh via Foundation"): that person
    const via = /^(.+) via Foundation$/.exec(m.username ?? "");
    if (via) {
      const u = one<UserInfo>("select id, email, name, color, role from users where name = ?", via[1]);
      if (u) return personParty(u);
    }
    const asBot = m.subtype === "bot_message" || (!m.user && m.bot_id);
    if (asBot) {
      const u = m.user ? this.users.get(m.user) : undefined;
      if (m.user && u && !isBotUser(m.user, u)) return this.party(m.user, m.user_profile);
      return this.bot((m.bot_id ? this.botUsers.get(m.bot_id) : undefined) ?? m.user ?? m.bot_id ?? "unknown", m.username || m.bot_profile?.name || slackName(u) || "App", m.icons?.image_72 ?? m.bot_profile?.icons?.image_72);
    }
    if (m.user) return this.party(m.user, m.user_profile);
    return this.bot("unknown", m.username || "Slack");
  }

  private nameOf(id?: string): string {
    return id ? this.party(id).name : "Someone";
  }

  /** a Slack message as a post here, or why it isn't one */
  prepare(m: SlackMessage, conv: SlackConversation, fileLines: string[], fileIds: string[]): Prepared | { skip: string } {
    const sub = m.subtype;
    const createdAt = slackTsMs(m.ts);
    const pinned = Boolean(m.pinned_to?.includes(conv.id) || conv.pins.has(m.ts));
    const threadTs = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined;
    const system = (text: string): Prepared => ({ author: SYSTEM_PARTY, type: "system", text, files: [], createdAt, pinned: false, threadTs });
    const md = (t: string | undefined) => slackToMarkdown(t ?? "", this.who, this.where);
    if (sub && EVENT_SUBTYPES.has(sub)) return { skip: `Slack event "${sub}" (not a message)` };
    switch (sub) {
      case "channel_join":
      case "group_join":
        return system(`${this.nameOf(m.user)} joined.`);
      case "channel_leave":
      case "group_leave":
        return system(`${this.nameOf(m.user)} left.`);
      case "channel_topic":
      case "group_topic":
        return system(m.topic ? `${this.nameOf(m.user)} set the topic: ${md(m.topic)}` : `${this.nameOf(m.user)} cleared the topic.`);
      case "channel_purpose":
      case "group_purpose":
        return system(m.purpose ? `${this.nameOf(m.user)} set the purpose: ${md(m.purpose)}` : `${this.nameOf(m.user)} cleared the purpose.`);
      case "channel_name":
      case "group_name":
        return system(`${this.nameOf(m.user)} renamed the channel${m.old_name ? ` from #${m.old_name}` : ""} to #${m.name ?? ""}.`);
      case "channel_archive":
      case "group_archive":
        return system(`${this.nameOf(m.user)} archived the channel.`);
      case "pinned_item":
        return system(`${this.nameOf(m.user)} pinned a message.`);
      case "unpinned_item":
        return system(`${this.nameOf(m.user)} unpinned a message.`);
      case "huddle_thread":
      case "sh_room_created": {
        const r = m.room;
        const people = (r?.participant_history ?? r?.participants ?? []).map((id) => this.nameOf(id));
        const mins = r?.date_start && r?.date_end ? Math.max(1, Math.round((r.date_end - r.date_start) / 60)) : 0;
        return system(`A huddle in Slack${r?.name ? `: ${r.name}` : ""}${mins ? ` · ${mins} min` : ""}${people.length ? ` · ${[...new Set(people)].join(", ")}` : ""}`);
      }
      case "tombstone":
        return { author: SYSTEM_PARTY, type: "system", text: "A message deleted in Slack (its thread is kept).", files: [], createdAt, pinned: false };
    }
    if (sub && SYSTEM_SUBTYPES.has(sub)) {
      const t = md(m.text).trim();
      return t ? system(t) : { skip: `Slack housekeeping "${sub}" with no text` };
    }
    const unknown = Boolean(sub && !TEXT_SUBTYPES.has(sub));
    let text = md(m.text).trim();
    if (!text && m.blocks?.length) text = blocksMarkdown(m.blocks, this.who, this.where);
    if (sub === "me_message" && text) text = `_${text}_`;
    const att = attachmentsMarkdown(m.attachments, this.who, this.where);
    text = [text, att, ...fileLines].filter((s) => s && s.trim()).join("\n\n");
    if (!text.trim() && !fileIds.length) return { skip: unknown ? `unknown subtype "${sub}" with nothing to show` : "empty message (no text, blocks, attachments or files)" };
    if (unknown) skip(this.report, `unknown subtype "${sub}": brought in as a plain message`, `${conv.name || conv.id} ${m.ts}`);
    const editedAt = m.edited?.ts ? slackTsMs(m.edited.ts) : undefined;
    return { author: this.author(m), type: "text", text, files: fileIds, createdAt, editedAt, pinned, threadTs };
  }

  /** a message's files: stored in the archive, or a named, sized placeholder line with its Slack link */
  async files(m: SlackMessage, convLabel: string): Promise<{ ids: string[]; lines: string[] }> {
    const ids: string[] = [];
    const lines: string[] = [];
    const t = this.report.totals;
    for (const f of m.files ?? []) {
      const key = f.id ?? `${m.ts}:${f.name}`;
      const name = (f.name || f.title || f.id || "file").slice(0, 240);
      const place = (why: string, counted: "missing" | "skipped") => {
        if (counted === "missing") t.filesMissing++;
        else t.filesSkipped++;
        const link = f.permalink ?? f.url_private;
        const line = `📎 **${name}**${f.size ? ` (${mb(f.size)})` : ""}: not brought in, ${why}.${link && /^https:\/\//.test(link) ? ` [Open in Slack](${link})` : ""}`;
        if (!this.opts.dryRun) {
          run(
            "insert into chat_import_files (service, external_id, file_id, state, why, name, size, url) values ('slack', ?, null, ?, ?, ?, ?, ?) on conflict (service, external_id) do update set state = excluded.state, why = excluded.why where file_id is null",
            key, counted, why, name, f.size ?? null, link ?? null,
          );
        }
        skip(this.report, counted === "missing" ? `file kept as a placeholder: ${why}` : `file skipped: ${why}`, `${convLabel}/${name}`);
        return line;
      };
      if (f.mode === "tombstone" || f.mode === "hidden_by_limit") {
        lines.push(place(f.mode === "tombstone" ? "it was deleted in Slack" : "Slack hides it on this plan", "skipped"));
        continue;
      }
      const cached = this.fileCache.get(key);
      if (cached) {
        if (cached.id) ids.push(cached.id);
        else if (cached.placeholder) lines.push(cached.placeholder);
        continue;
      }
      const stored = f.id ? one<{ file_id: string | null }>("select file_id from chat_import_files where service = 'slack' and external_id = ?", key) : undefined;
      if (stored?.file_id && one("select 1 from files where id = ?", stored.file_id)) {
        ids.push(stored.file_id);
        this.fileCache.set(key, { id: stored.file_id });
        continue;
      }
      if (!this.opts.files) {
        const line = place("files were left out of this import", "skipped");
        lines.push(line);
        this.fileCache.set(key, { placeholder: line });
        continue;
      }
      if (f.size && f.size > this.opts.maxFileBytes) {
        const line = place(`over the ${mb(this.opts.maxFileBytes)} cap`, "skipped");
        lines.push(line);
        this.fileCache.set(key, { placeholder: line });
        continue;
      }
      const url = f.url_private_download ?? f.url_private;
      if (f.is_external || !url) {
        const line = place(f.is_external ? "it lives outside Slack" : "Slack gave no link for it", "missing");
        lines.push(line);
        this.fileCache.set(key, { placeholder: line });
        continue;
      }
      if (this.opts.dryRun) {
        t.files++;
        t.filesBytes += f.size ?? 0;
        continue;
      }
      const got = await fetchSlackFile(url, this.opts.maxFileBytes, this.opts.token);
      if (!got.ok) {
        const line = place(got.why, got.missing ? "missing" : "skipped");
        lines.push(line);
        this.fileCache.set(key, { placeholder: line });
        continue;
      }
      const row = await storeFile(got.body, { name, mime: f.mimetype || got.mime, boardId: CHAT_BOARD, userId: IMPORT_UPLOADER, about: `From Slack · ${convLabel}` });
      run(
        "insert into chat_import_files (service, external_id, file_id, state, why, name, size, url) values ('slack', ?, ?, 'stored', null, ?, ?, ?) on conflict (service, external_id) do update set file_id = excluded.file_id, state = 'stored', why = null",
        key, row.id, name, row.size, f.permalink ?? null,
      );
      t.files++;
      t.filesBytes += row.size;
      this.progress.files++;
      ids.push(row.id);
      this.fileCache.set(key, { id: row.id });
    }
    return { ids, lines };
  }

  /** the channel this conversation lands in (made, found by its origin, or merged into an open one of the same name) */
  private landing(conv: SlackConversation, cr: ImportConversationReport): ChatChannel | null {
    const had = channelByOrigin("slack", conv.id);
    const members = [...new Map(conv.members.map((id) => this.party(id)).map((p) => [`${p.kind}:${p.id}`, p])).values()];
    let ch: ChatChannel | undefined = had;
    if (!ch) {
      const origin = { service: "slack" as const, externalId: conv.id };
      const createdAt = conv.created ? conv.created * 1000 : undefined;
      if (conv.kind === "open" || conv.kind === "private") {
        const slug = chatSlug(conv.name || conv.id) || conv.id.toLowerCase();
        const same = one<{ id: string; kind: string; origin_service: string | null; topic: string; purpose: string }>(
          "select id, kind, origin_service, topic, purpose from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null order by created_at limit 1",
          slug,
        );
        if (conv.kind === "open" && same && same.kind === "open" && !same.origin_service) {
          run("update chat_channels set origin_service = 'slack', origin_id = ? where id = ?", conv.id, same.id);
          if (!same.topic && conv.topic) run("update chat_channels set topic = ? where id = ?", conv.topic.slice(0, 250), same.id);
          if (!same.purpose && conv.purpose) run("update chat_channels set purpose = ? where id = ?", conv.purpose.slice(0, 250), same.id);
          cr.merged = true;
          ch = getChannel(same.id);
        } else {
          let name = slug;
          if (same) {
            name = `${slug}-slack`.slice(0, 80);
            for (let i = 2; one("select 1 from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null", name); i++) name = `${slug}-slack-${i}`.slice(0, 80);
            cr.note = `named #${name}: #${slug} was taken`;
          }
          const creator = conv.creator ? this.party(conv.creator) : SYSTEM_PARTY;
          ch = createChannel(creator.kind === "person" ? creator : SYSTEM_PARTY, { kind: conv.kind, name, topic: conv.topic, purpose: conv.purpose, members, origin, createdAt });
          if (creator.kind !== "person" && creator.kind !== "system") run("update chat_channels set created_by = ? where id = ?", creator.id, ch.id);
        }
      } else {
        if (!members.length) {
          cr.note = "nobody in it";
          return null;
        }
        if (members.length > CHAT_GROUP_MAX) {
          cr.note = `more than ${CHAT_GROUP_MAX} people: a private channel`;
          let name = chatSlug(conv.name || `group-${conv.id}`) || `group-${conv.id.toLowerCase()}`;
          for (let i = 2; one("select 1 from chat_channels where kind in ('open', 'private') and name = ? and archived_at is null", name); i++) name = `${chatSlug(conv.name || conv.id)}-${i}`;
          ch = createChannel(SYSTEM_PARTY, { kind: "private", name, topic: conv.topic, purpose: conv.purpose, members, origin, createdAt });
        } else {
          // a conversation with exactly these people already here (made in ChatForm): merged into it
          const key = chatMembersKey(members.map((p) => (p.kind === "person" ? p.id : `${p.kind}:${p.id}`)));
          if (one("select 1 from chat_channels where members_key = ?", key)) cr.merged = true;
          ch = createChannel(SYSTEM_PARTY, { kind: conv.kind, members, origin, createdAt });
          if (conv.topic && !ch.topic) run("update chat_channels set topic = ? where id = ?", conv.topic.slice(0, 250), ch.id);
        }
      }
    }
    if (!ch) return null;
    for (const p of members) addMember(ch.id, p, { silent: true });
    return getChannel(ch.id) ?? null;
  }

  /** one conversation: its channel, then its messages in batches (a day file, or a page of the API), oldest first */
  async conversation(conv: SlackConversation, batches: AsyncIterable<SlackMessage[]>) {
    const label = conv.kind === "open" || conv.kind === "private" ? `#${conv.name}` : conv.kind === "dm" ? `DM ${conv.members.map((id) => slackName(this.users.get(id)) || id).join(", ")}` : `group ${conv.name || conv.members.map((id) => slackName(this.users.get(id)) || id).join(", ")}`;
    const cr: ImportConversationReport = { slackId: conv.id, name: label, kind: conv.kind, messages: 0, already: 0, replies: 0, files: 0, filesMissing: 0, skipped: 0 };
    this.report.conversations.push(cr);
    this.progress.channel = label;
    this.onProgress();
    const t = this.report.totals;
    t.conversations++;
    if (conv.kind === "open") t.open++;
    else if (conv.kind === "private") t.private++;
    else if (conv.kind === "dm") t.dm++;
    else t.group++;

    const ch = this.opts.dryRun ? (channelByOrigin("slack", conv.id) ?? null) : this.landing(conv, cr);
    if (!this.opts.dryRun && !ch) {
      skip(this.report, "conversation with nobody in it", label);
      return;
    }
    if (ch) cr.channel = ch.id;
    const known = new Map<string, string>();
    if (ch) for (const r of all<{ id: string; origin_id: string }>("select id, origin_id from chat_messages where channel_id = ? and origin_service = 'slack'", ch.id)) known.set(r.origin_id, r.id);
    const hadBefore = ch ? (one<{ n: number }>("select count(*) as n from chat_messages where channel_id = ?", ch.id)?.n ?? 0) : 0;
    // what each member hadn't read before history arrived: that, and only that, is unread after it
    const lastBefore = ch ? (one<{ last_seq: number }>("select last_seq from chat_channels where id = ?", ch.id)?.last_seq ?? 0) : 0;
    const unreadBefore = ch && !this.opts.dryRun ? all<{ party_kind: string; party_id: string; read_seq: number }>("select party_kind, party_id, read_seq from chat_members where channel_id = ?", ch.id) : [];
    const filesBefore = { n: t.files, missing: t.filesMissing };

    try {
      for await (const batch of batches) {
        const msgs = batch.filter((m) => m && typeof m.ts === "string").sort((a, b) => Number(a.ts) - Number(b.ts));
        // files first (they're fetched; nothing is held open while they are)
        const fileOf = new Map<string, { ids: string[]; lines: string[] }>();
        for (const m of msgs) {
          if (known.has(`${conv.id}:${m.ts}`) || !m.files?.length) continue;
          fileOf.set(m.ts, await this.files(m, label));
        }
        for (let i = 0; i < msgs.length; i += BATCH) {
          const chunk = msgs.slice(i, i + BATCH);
          if (!this.opts.dryRun) db.exec("begin");
          try {
            for (const m of chunk) this.one(m, conv, ch, cr, known, fileOf.get(m.ts) ?? { ids: [], lines: [] }, label);
            if (!this.opts.dryRun) db.exec("commit");
          } catch (e) {
            if (!this.opts.dryRun) db.exec("rollback");
            throw e;
          }
          this.onProgress();
          await new Promise((r) => setImmediate(r));
        }
      }
    } catch (e) {
      const why = (e as { code?: string }).code ?? (e as Error).message;
      skip(this.report, `conversation stopped part way: ${why}`, label);
      cr.note = `stopped: ${why}`;
    }
    cr.files = t.files - filesBefore.n;
    cr.filesMissing = t.filesMissing - filesBefore.missing;

    if (!this.opts.dryRun && ch) {
      if (hadBefore > 0) resequence(ch.id);
      const lastNow = one<{ last_seq: number }>("select last_seq from chat_channels where id = ?", ch.id)!.last_seq;
      for (const m of unreadBefore) {
        const keep = Math.max(0, lastNow - Math.max(0, lastBefore - m.read_seq));
        run("update chat_members set read_seq = max(read_seq, ?) where channel_id = ? and party_kind = ? and party_id = ?", keep, ch.id, m.party_kind, m.party_id);
      }
      refreshLast(ch.id);
      if (conv.archived && !cr.merged) run("update chat_channels set archived_at = coalesce(archived_at, max(last_post_at, created_at)) where id = ?", ch.id);
    }
  }

  private one(m: SlackMessage, conv: SlackConversation, ch: ChatChannel | null, cr: ImportConversationReport, known: Map<string, string>, files: { ids: string[]; lines: string[] }, label: string) {
    const ext = `${conv.id}:${m.ts}`;
    const t = this.report.totals;
    if (known.has(ext)) {
      cr.already++;
      t.already++;
      return;
    }
    const p = this.prepare(m, conv, files.lines, files.ids);
    if ("skip" in p) {
      cr.skipped++;
      skip(this.report, p.skip, `${label} ${m.ts}`);
      return;
    }
    let root: string | null = null;
    if (p.threadTs) {
      root = known.get(`${conv.id}:${p.threadTs}`) ?? null;
      if (!root && !this.opts.dryRun && ch) root = one<{ id: string }>("select id from chat_messages where channel_id = ? and origin_service = 'slack' and origin_id = ?", ch.id, `${conv.id}:${p.threadTs}`)?.id ?? null;
      if (!root && this.opts.dryRun && known.has(`dry:${conv.id}:${p.threadTs}`)) root = "dry";
      if (!root) skip(this.report, "reply whose thread's first message isn't in the history: kept in the channel", `${label} ${m.ts}`);
    }
    // reactions: by the people who reacted, skin tones folded into one emoji
    const reactions = new Map<string, Set<string>>();
    for (const r of m.reactions ?? []) {
      const e = slackEmoji(r.name);
      const set = reactions.get(e) ?? new Set<string>();
      for (const u of r.users ?? []) set.add(u);
      reactions.set(e, set);
    }
    if (this.opts.dryRun) {
      known.set(`dry:${ext}`, "dry");
      cr.messages++;
      t.messages++;
      this.progress.messages++;
      if (root) {
        cr.replies++;
        t.replies++;
      }
      for (const s of reactions.values()) t.reactions += s.size;
      if (p.pinned) t.pins++;
      return;
    }
    const msg = postMessage(
      ch!.id,
      p.author,
      { text: p.text, files: p.files, root, type: p.type, origin: { service: "slack", externalId: ext }, createdAt: p.createdAt, editedAt: p.editedAt, pinned: p.pinned },
      { silent: true },
    );
    known.set(ext, msg.id);
    for (const [emoji, users] of reactions) {
      for (const uid of users) {
        const who = this.party(uid);
        run("insert or ignore into chat_reactions (message_id, emoji, party_kind, party_id, name, at) values (?, ?, ?, ?, ?, ?)", msg.id, emoji, who.kind, who.id, who.name, p.createdAt);
        t.reactions++;
      }
    }
    if (p.pinned) t.pins++;
    cr.messages++;
    t.messages++;
    this.progress.messages++;
    if (root) {
      cr.replies++;
      t.replies++;
    }
  }
}

/**
 * Seqs in time order again, after history arrived in a channel that already had messages (a merged
 * #general, an API top-up older than what was here). Read marks follow the message they pointed at; a
 * member who had read everything still has.
 */
function resequence(channelId: string): boolean {
  const rows = all<{ id: string; seq: number }>("select id, seq from chat_messages where channel_id = ? order by created_at, seq", channelId);
  if (rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq)) return false;
  const ch = one<{ last_seq: number }>("select last_seq from chat_channels where id = ?", channelId)!;
  const newSeq = new Map<number, number>();
  rows.forEach((r, i) => newSeq.set(r.seq, i + 1));
  const now = Date.now();
  db.exec("begin");
  try {
    run("update chat_messages set seq = -seq where channel_id = ?", channelId);
    rows.forEach((r, i) => run("update chat_messages set seq = ?, updated_at = ? where id = ?", i + 1, now, r.id));
    const last = Math.max(ch.last_seq, rows.length);
    run("update chat_channels set last_seq = ? where id = ?", last, channelId);
    for (const m of all<{ party_kind: string; party_id: string; read_seq: number }>("select party_kind, party_id, read_seq from chat_members where channel_id = ?", channelId)) {
      const to = m.read_seq >= ch.last_seq ? last : (newSeq.get(m.read_seq) ?? m.read_seq);
      run("update chat_members set read_seq = ? where channel_id = ? and party_kind = ? and party_id = ?", to, channelId, m.party_kind, m.party_id);
    }
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
  return true;
}

/** the list's line for a channel: its newest top-level message by time (history may have arrived after newer posts) */
export function refreshLast(channelId: string) {
  const m = one<{ author_json: string; author_kind: string; text: string; files_json: string; created_at: number }>(
    "select author_json, author_kind, text, files_json, created_at from chat_messages where channel_id = ? and root_id is null and type != 'system' and deleted_at is null order by created_at desc, seq desc limit 1",
    channelId,
  );
  if (!m) return;
  const author = parse<ChatParty | null>(m.author_json, null);
  const summary = m.text.replace(/\s+/g, " ").trim().slice(0, 140) || parse<Array<{ name: string }>>(m.files_json, [])[0]?.name || "";
  run("update chat_channels set last_text = ?, last_post_at = max(last_post_at, ?) where id = ?", summary ? `${author?.name ?? "Someone"}: ${summary}` : null, m.created_at, channelId);
}

// =====================================================================================================
// sources: a Slack export (zip or folder)
// =====================================================================================================

interface ExportSource {
  label: string;
  names: string[];
  has(name: string): boolean;
  text(name: string): Promise<string>;
}

async function openExport(path: string): Promise<ExportSource> {
  const st = await stat(path).catch(() => null);
  if (!st) throw new HttpError(404, `Nothing at ${path}`);
  let names: string[];
  let read: (name: string) => Promise<string>;
  if (st.isDirectory()) {
    names = [];
    const walk = async (dir: string, depth: number) => {
      for (const d of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, d.name);
        if (d.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (d.isFile() && d.name.endsWith(".json")) names.push(relative(path, full).split(sep).join("/"));
      }
    };
    await walk(path, 0);
    read = (name) => readFile(join(path, ...name.split("/")), "utf8");
  } else {
    const zip = await ZipReader.open(path);
    names = [...zip.entries.keys()].filter((n) => !n.endsWith("/"));
    read = (name) => zip.text(name);
  }
  // an export zipped with a folder around it
  let prefix = "";
  if (!names.includes("users.json") && !names.includes("channels.json")) {
    const inner = names.find((n) => /^[^/]+\/(users|channels)\.json$/.test(n));
    if (inner) prefix = inner.slice(0, inner.indexOf("/") + 1);
  }
  const rel = prefix ? names.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)) : names;
  const set = new Set(rel);
  if (!set.has("users.json") && !set.has("channels.json")) throw new HttpError(400, "That doesn't look like a Slack export: there's no users.json or channels.json in it.");
  return { label: path.split(/[\\/]/).pop() ?? path, names: rel, has: (n) => set.has(n), text: (n) => read(prefix + n) };
}

async function jsonOf<T>(src: ExportSource, name: string, fallback: T, report: ImportReport): Promise<T> {
  if (!src.has(name)) return fallback;
  try {
    return JSON.parse(await src.text(name)) as T;
  } catch (e) {
    report.warnings.push(`${name} couldn't be read (${(e as Error).message}); left out`);
    return fallback;
  }
}

type RawConv = { id: string; name?: string; created?: number; creator?: string; is_archived?: boolean; members?: string[]; topic?: { value?: string }; purpose?: { value?: string }; pins?: Array<{ id?: string }>; user?: string };

function toConv(c: RawConv, kind: ChatChannelKind): SlackConversation {
  return {
    id: c.id,
    kind,
    name: c.name ?? "",
    created: c.created,
    creator: c.creator,
    archived: Boolean(c.is_archived),
    members: [...new Set(c.members ?? [])],
    topic: c.topic?.value ?? "",
    purpose: c.purpose?.value ?? "",
    pins: new Set((c.pins ?? []).map((p) => p.id ?? "").filter(Boolean)),
  };
}

async function runExport(src: ExportSource, imp: Importer) {
  const r = imp.report;
  imp.loadUsers(await jsonOf<SlackUser[]>(src, "users.json", [], r));
  const convs: SlackConversation[] = [
    ...(await jsonOf<RawConv[]>(src, "channels.json", [], r)).map((c) => toConv(c, "open")),
    ...(await jsonOf<RawConv[]>(src, "groups.json", [], r)).map((c) => toConv(c, "private")),
    ...(await jsonOf<RawConv[]>(src, "dms.json", [], r)).map((c) => toConv(c, "dm")),
    ...(await jsonOf<RawConv[]>(src, "mpims.json", [], r)).map((c) => toConv(c, "group")),
  ].filter((c) => c?.id);
  for (const c of convs) if (c.name) imp.convNames.set(c.id, c.name);
  const canvases = await jsonOf<unknown[]>(src, "canvases.json", [], r);
  if (Array.isArray(canvases) && canvases.length) for (const c of canvases) skip(r, "canvas (canvases aren't brought in; open them in Slack)", (c as { name?: string; title?: string })?.title ?? (c as { name?: string })?.name);
  const logs = await jsonOf<unknown[]>(src, "integration_logs.json", [], r);
  if (Array.isArray(logs) && logs.length) {
    const s = { why: "integration log entry (the app installs history isn't brought in)", count: logs.length, examples: [] as string[] };
    r.skipped.push(s);
  }
  // day files by folder
  const days = new Map<string, string[]>();
  for (const n of src.names) {
    const m = /^([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/.exec(n);
    if (m) days.set(m[1], [...(days.get(m[1]) ?? []), n]);
  }
  const used = new Set<string>();
  imp.progress.total = convs.length;
  for (const conv of convs) {
    const folder = [conv.name, conv.id].find((f) => f && days.has(f));
    if (folder) used.add(folder);
    const files = folder ? days.get(folder)!.sort() : [];
    const batches = async function* () {
      for (const f of files) {
        let list: unknown;
        try {
          list = JSON.parse(await src.text(f));
        } catch (e) {
          r.warnings.push(`${f} couldn't be read (${(e as Error).message}); its messages were left out`);
          continue;
        }
        if (Array.isArray(list)) yield list as SlackMessage[];
      }
    };
    await imp.conversation(conv, batches());
    imp.progress.done++;
  }
  for (const f of days.keys()) if (!used.has(f)) skip(r, "folder with no conversation in channels/groups/dms/mpims.json", f);
}

// =====================================================================================================
// sources: Slack's Web API
// =====================================================================================================

export function slackImportToken(): { token: string; kind: "user" | "bot" } | null {
  if (process.env.SLACK_USER_TOKEN) return { token: process.env.SLACK_USER_TOKEN, kind: "user" };
  // the bot token as slack.ts holds it: stored from ChatForm's Slack guide, else the env's, else the Slack app's lent one
  const bot = slackBotToken();
  if (bot) return { token: bot, kind: "bot" };
  return null;
}

function slowedDown(report: ImportReport) {
  const i = report.warnings.findIndex((w) => w.startsWith("Slack asked us to slow down"));
  const n = i >= 0 ? Number(/(\d+) time/.exec(report.warnings[i])?.[1] ?? 1) + 1 : 1;
  const w = `Slack asked us to slow down ${n} time${n === 1 ? "" : "s"}; each time we waited as long as it said and carried on`;
  if (i >= 0) report.warnings[i] = w;
  else report.warnings.push(w);
}

class SlackApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function slackApi<T>(token: string, method: string, params: Record<string, string | number | boolean | undefined>, report?: ImportReport): Promise<T> {
  const base = (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]): [string, string] => [k, String(v)]));
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${base}/${method}?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429) {
      const wait = Math.min(60, Math.max(0, Number(res.headers.get("retry-after") ?? 1) || 1));
      await res.body?.cancel();
      if (report) slowedDown(report);
      await sleep(wait * 1000);
      continue;
    }
    const out = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as { ok: boolean; error?: string } & T;
    if (!out.ok) {
      if (out.error === "ratelimited") {
        await sleep(1000);
        continue;
      }
      throw new SlackApiError(out.error ?? "unknown_error");
    }
    return out;
  }
  throw new SlackApiError("ratelimited");
}

async function* slackPages<T>(token: string, method: string, params: Record<string, string | number | boolean | undefined>, key: string, report?: ImportReport): AsyncGenerator<T[]> {
  let cursor: string | undefined;
  for (let page = 0; page < 100_000; page++) {
    const r = await slackApi<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(token, method, { ...params, cursor }, report);
    yield ((r[key] as T[]) ?? []) as T[];
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
}

async function collect<T>(it: AsyncIterable<T[]>): Promise<T[]> {
  const out: T[] = [];
  for await (const page of it) out.push(...page);
  return out;
}

type ApiConv = RawConv & { is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean; is_channel?: boolean };

async function runApi(token: string, imp: Importer) {
  const r = imp.report;
  const me = await slackApi<{ user_id?: string; team?: string }>(token, "auth.test", {}, r);
  imp.loadUsers(await collect(slackPages<SlackUser>(token, "users.list", { limit: 200 }, "members", r)));
  const raw = await collect(slackPages<ApiConv>(token, "conversations.list", { types: "public_channel,private_channel,mpim,im", exclude_archived: false, limit: 200 }, "channels", r));
  const convs: SlackConversation[] = [];
  for (const c of raw) {
    const kind: ChatChannelKind = c.is_im ? "dm" : c.is_mpim ? "group" : c.is_private || c.is_group ? "private" : "open";
    const conv = toConv({ ...c, name: c.is_im ? "" : c.name }, kind);
    if (kind === "dm") conv.members = [...new Set([me.user_id, c.user].filter((x): x is string => Boolean(x)))];
    else {
      try {
        conv.members = [...new Set(await collect(slackPages<string>(token, "conversations.members", { channel: c.id, limit: 200 }, "members", r)))];
      } catch (e) {
        r.warnings.push(`couldn't list who is in ${c.name || c.id} (${(e as Error).message})`);
      }
    }
    convs.push(conv);
    if (conv.name) imp.convNames.set(conv.id, conv.name);
  }
  imp.progress.total = convs.length;
  for (const conv of convs) {
    const had = channelByOrigin("slack", conv.id);
    // a top-up starts two weeks before the newest message already here (threads that grew meanwhile come too)
    const newest = had ? one<{ id: string | null }>("select max(cast(substr(origin_id, instr(origin_id, ':') + 1) as real)) as id from chat_messages where channel_id = ? and origin_service = 'slack'", had.id)?.id : null;
    const oldest = newest ? String(Number(newest) - 14 * 86400) : undefined;
    const batches = async function* () {
      const top = await collect(slackPages<SlackMessage>(token, "conversations.history", { channel: conv.id, limit: 200, oldest }, "messages", r));
      const all: SlackMessage[] = [...top];
      for (const m of top) {
        if (!m.reply_count || m.thread_ts !== m.ts) continue;
        const replies = await collect(slackPages<SlackMessage>(token, "conversations.replies", { channel: conv.id, ts: m.ts, limit: 200 }, "messages", r));
        for (const x of replies) if (x.ts !== m.ts) all.push(x);
      }
      all.sort((a, b) => Number(a.ts) - Number(b.ts));
      for (let i = 0; i < all.length; i += 1000) yield all.slice(i, i + 1000);
    };
    await imp.conversation(conv, batches());
    imp.progress.done++;
  }
}

// =====================================================================================================
// jobs
// =====================================================================================================

interface JobRow {
  id: string;
  kind: "export" | "api";
  dry_run: number;
  state: ImportJobState;
  source: string;
  started_by: string | null;
  started_at: number;
  finished_at: number | null;
  progress_json: string | null;
  report_json: string | null;
  error: string | null;
  request_id: string | null;
}

const live = new Map<string, { job: ImportJob; report: ImportReport; done: Promise<void> }>();

function jobOf(row: JobRow): ImportJob {
  const hot = live.get(row.id);
  if (hot) return { ...hot.job, progress: { ...hot.job.progress, skipped: hot.report.skipped.map((s) => ({ why: s.why, count: s.count })) } };
  return {
    id: row.id,
    kind: row.kind,
    dryRun: Boolean(row.dry_run),
    state: row.state,
    source: row.source,
    startedBy: row.started_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    progress: parse<ImportProgress>(row.progress_json, { state: row.state, channel: "", done: 0, total: 0, messages: 0, files: 0, skipped: [] }),
    ...(row.error ? { error: row.error } : {}),
  };
}

export function getJob(id: string): ImportJob | undefined {
  const row = one<JobRow>("select * from chat_import_jobs where id = ?", id);
  return row ? jobOf(row) : undefined;
}

export function jobReport(id: string): ImportReport | undefined {
  const hot = live.get(id);
  if (hot) return hot.report;
  const row = one<JobRow>("select report_json from chat_import_jobs where id = ?", id);
  return row ? parse<ImportReport | undefined>(row.report_json, undefined) : undefined;
}

export function recentJobs(limit = 10): ImportJob[] {
  return all<JobRow>("select * from chat_import_jobs where kind != 'upload' order by started_at desc limit ?", limit).map(jobOf);
}

/** a job's end, for the CLI and tests */
export function jobDone(id: string): Promise<void> {
  return live.get(id)?.done ?? Promise.resolve();
}

export interface StartImport {
  kind: "export" | "api";
  /** export: a zip or a folder on this machine */
  path?: string;
  source?: string;
  dryRun?: boolean;
  files?: boolean;
  maxFileBytes?: number;
  requestId?: string;
  onProgress?: (p: ImportProgress) => void;
}

/**
 * Start bringing history in. One at a time: asked again while one runs, it answers the running one; asked
 * again with the same request id, the job that id started.
 */
export function startImport(by: Pick<UserInfo, "id"> | null, s: StartImport): { job: ImportJob; already: boolean } {
  if (s.requestId && by) {
    const had = one<JobRow>("select * from chat_import_jobs where request_id = ? and started_by = ?", s.requestId.slice(0, 120), by.id);
    if (had) return { job: jobOf(had), already: true };
  }
  for (const hot of live.values()) if (hot.job.state === "running") return { job: getJob(hot.job.id)!, already: true };
  const token = slackImportToken();
  if (s.kind === "api" && !token) throw new HttpError(409, "No Slack token: set SLACK_USER_TOKEN (or SLACK_BOT_TOKEN) in the server's .env, then try again.");
  if (s.kind === "export" && !s.path) throw new HttpError(400, "which export?");
  const id = newId("imp");
  const dryRun = Boolean(s.dryRun);
  const source = s.source ?? (s.kind === "api" ? `Slack API (${token!.kind} token)` : (s.path ?? "").split(/[\\/]/).pop() ?? "export");
  const report = emptyReport(s.kind, dryRun, source);
  const progress: ImportProgress = { state: "running", channel: "", done: 0, total: 0, messages: 0, files: 0, skipped: [] };
  const job: ImportJob = { id, kind: s.kind, dryRun, state: "running", source, startedBy: by?.id ?? null, startedAt: report.startedAt, finishedAt: null, progress };
  run(
    "insert into chat_import_jobs (id, kind, dry_run, state, source, started_by, started_at, progress_json, request_id) values (?, ?, ?, 'running', ?, ?, ?, ?, ?)",
    id, s.kind, dryRun ? 1 : 0, source, by?.id ?? null, job.startedAt, JSON.stringify(progress), s.requestId?.slice(0, 120) ?? null,
  );
  let lastSave = 0;
  const save = (force = false) => {
    progress.skipped = report.skipped.map((x) => ({ why: x.why, count: x.count }));
    s.onProgress?.(progress);
    if (!force && Date.now() - lastSave < 1000) return;
    lastSave = Date.now();
    run("update chat_import_jobs set progress_json = ? where id = ?", JSON.stringify(progress), id);
  };
  const imp = new Importer(report, { dryRun, files: s.files !== false, maxFileBytes: s.maxFileBytes ?? DEFAULT_MAX_FILE, token: token?.token }, () => save(), progress);
  const done = (async () => {
    try {
      if (s.kind === "export") await runExport(await openExport(s.path!), imp);
      else await runApi(token!.token, imp);
      if (!dryRun) linkGhostsByEmail();
      job.state = progress.state = "done";
    } catch (e) {
      job.state = progress.state = "failed";
      job.error = e instanceof SlackApiError ? `Slack said ${e.code}` : (e as Error).message;
      report.warnings.push(`stopped: ${job.error}`);
    } finally {
      job.finishedAt = report.finishedAt = Date.now();
      save(true);
      run("update chat_import_jobs set state = ?, finished_at = ?, report_json = ?, error = ? where id = ?", job.state, job.finishedAt, JSON.stringify(report), job.error ?? null, id);
      live.delete(id);
    }
  })();
  live.set(id, { job, report, done });
  return { job: getJob(id)!, already: false };
}

// =====================================================================================================
// out: everything a person can see, as one zip
// =====================================================================================================

/** write the asker's ChatForm (channels they can see, the people in them, each conversation as JSON and Markdown, optionally files) as a zip */
export async function exportWorkspace(user: UserInfo, out: Writable, opts: { files?: boolean; zip64?: boolean } = {}): Promise<{ channels: number; messages: number; files: number }> {
  const zip = new ZipWriter(out, { zip64: opts.zip64 });
  const rows = all<{ id: string }>("select id from chat_channels order by created_at");
  const channels: ReturnType<typeof channelView>[] = [];
  const people = new Map<string, ChatParty>();
  for (const u of all<UserInfo>("select id, email, name, color, role from users order by name")) people.set(`person:${u.id}`, personParty(u));
  let messages = 0;
  const fileIds = new Map<string, { name: string }>();
  const used = new Set<string>();
  for (const r of rows) {
    const c = getChannel(r.id);
    if (!c || !canSeeChannel(user, c)) continue;
    channels.push(channelView(user, c));
    const data = exportChannel(c.id);
    messages += data.messages.length;
    for (const m of data.messages) {
      if (m.author.kind !== "system") people.set(`${m.author.kind}:${m.author.id}`, m.author);
      for (const f of m.files) fileIds.set(f.id, { name: f.name });
    }
    for (const p of c.members ?? []) people.set(`${p.kind}:${p.id}`, p);
    let base = chatSlug(c.kind === "open" || c.kind === "private" ? c.name : chatTitle(c, user.id)) || c.kind;
    if (used.has(base)) base = `${base}-${c.id.slice(-6)}`;
    used.add(base);
    await zip.add(`channels/${base}/messages.json`, JSON.stringify(data, null, 2));
    await zip.add(`channels/${base}/messages.md`, exportMarkdown(data));
  }
  await zip.add("channels.json", JSON.stringify(channels, null, 2));
  await zip.add("people.json", JSON.stringify([...people.values()], null, 2));
  let files = 0;
  if (opts.files) {
    for (const [id, f] of fileIds) {
      const row = one<{ sha256: string; board_id: string | null }>("select sha256, board_id from files where id = ?", id);
      if (!row) continue;
      if (row.board_id === CHAT_BOARD ? !canSeeChatFile(user, id) : row.board_id ? !canSeeBoard(user, row.board_id) : false) continue;
      const path = join(config.dataDir, "files", row.sha256);
      if (!existsSync(path)) continue;
      await zip.addStream(`files/${id}-${f.name.replace(/[\\/:*?"<>|]/g, "_")}`, createReadStream(path));
      files++;
    }
  }
  await zip.add(
    "README.md",
    [
      "# ChatForm export",
      "",
      `For ${user.name}, ${new Date().toISOString()}: ${channels.length} conversations, ${messages} messages${opts.files ? `, ${files} files` : ""}.`,
      "",
      "- `channels.json`: every conversation you can see, as ChatForm lists it",
      "- `people.json`: the people, agents and outside people (ghosts) in them",
      "- `channels/<name>/messages.json`: the conversation, every message (threads by `root`)",
      "- `channels/<name>/messages.md`: the same, to read",
      opts.files ? "- `files/<id>-<name>`: the files on those messages" : "- files are left out (ask with files to include them)",
      "",
    ].join("\n"),
  );
  await zip.finish();
  return { channels: channels.length, messages, files };
}

// =====================================================================================================
// HTTP
// =====================================================================================================

/** bringing history in writes in other people's names: an admin, as a person */
function requireImporter(req: Req): UserInfo {
  const u = requirePerson(req, "Bringing in Slack history");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin brings in Slack history (it writes in other people's names).");
  return u;
}

function uploadsDir() {
  const dir = join(config.dataDir, "chat-imports");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const UPLOAD_MAX = 64 * 1024 * 1024 * 1024;

export function chatImportRoutes(r: Router) {
  // the server stopped mid-import: those jobs say so (bringing the same history in again carries on where it stopped)
  run("update chat_import_jobs set state = 'interrupted', finished_at = ? where state = 'running' and kind != 'upload'", Date.now());
  // someone signed in since the last import with a Slack person's email: they're themselves now
  try {
    linkGhostsByEmail();
  } catch (e) {
    console.error("chat import: linking people failed", e);
  }

  /** what the history screen needs: may this person bring history in, is there a token, the recent jobs */
  r.get("/api/chat/history", (req) => {
    const user = requireUser(req);
    let canImport = true;
    let why: string | undefined;
    try {
      requireImporter(req);
    } catch (e) {
      canImport = false;
      why = (e as Error).message;
    }
    const token = slackImportToken();
    linkGhostsByEmail(user);
    return { canImport, ...(why ? { why } : {}), token: { configured: Boolean(token), kind: token?.kind ?? null }, jobs: canImport ? recentJobs() : [] };
  });

  /** the export zip, streamed straight to disk (it is kept there, beside the database: the import's source) */
  r.post("/api/chat/history/upload", async (req) => {
    const user = requireImporter(req);
    const name = (req.query.get("name") || "slack-export.zip").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    const id = newId("up");
    const dest = join(uploadsDir(), `${id}.zip`);
    const part = `${dest}.part`;
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > UPLOAD_MAX) return cb(new HttpError(413, "That's bigger than any Slack export we expect (64 GB)."));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(part));
    } catch (e) {
      await unlink(part).catch(() => undefined);
      throw e instanceof HttpError ? e : new HttpError(400, `The upload stopped: ${(e as Error).message}`);
    }
    if (!size) {
      await unlink(part).catch(() => undefined);
      throw new HttpError(400, "empty file");
    }
    await rename(part, dest);
    run(
      "insert into chat_import_jobs (id, kind, dry_run, state, source, started_by, started_at, finished_at, progress_json) values (?, 'upload', 0, 'done', ?, ?, ?, ?, ?)",
      id, name, user.id, Date.now(), Date.now(), JSON.stringify({ size }),
    );
    return { upload: { id, name, size } };
  });

  /** bring an export in (or rehearse it: dryRun): an upload, an archived file, or a path inside an approved place */
  r.post("/api/chat/history/import", async (req) => {
    const user = requireImporter(req);
    const body = await readJson<{ upload?: string; fileId?: string; place?: string; path?: string; dryRun?: boolean; files?: boolean; maxFileMb?: number; request_id?: string }>(req);
    let path: string;
    let source: string;
    if (body.upload) {
      if (!/^up_[0-9a-f]{16}$/.test(body.upload)) throw new HttpError(400, "no such upload");
      path = join(uploadsDir(), `${body.upload}.zip`);
      if (!existsSync(path)) throw new HttpError(404, "no such upload");
      source = one<{ source: string }>("select source from chat_import_jobs where id = ?", body.upload)?.source ?? "slack-export.zip";
    } else if (body.fileId) {
      const f = one<{ sha256: string; name: string; board_id: string | null }>("select sha256, name, board_id from files where id = ? and archived_at is null", body.fileId);
      if (!f || (f.board_id === CHAT_BOARD ? !canSeeChatFile(user, body.fileId) : f.board_id ? !canSeeBoard(user, f.board_id) : false)) throw new HttpError(404, "no such file");
      path = join(config.dataDir, "files", f.sha256);
      source = f.name;
    } else if (body.place) {
      path = resolveInPlace(getPlace(body.place), body.path ?? "");
      source = path.split(/[\\/]/).pop() ?? path;
    } else throw new HttpError(400, "which export? (upload, fileId, or place + path)");
    const maxFileBytes = typeof body.maxFileMb === "number" && body.maxFileMb > 0 ? Math.min(body.maxFileMb, 4096) * 1048576 : undefined;
    const { job, already } = startImport(user, { kind: "export", path, source, dryRun: body.dryRun === true, files: body.files !== false, maxFileBytes, requestId: body.request_id });
    return { job, already };
  });

  /** top up from Slack's API with the server's token */
  r.post("/api/chat/history/pull", async (req) => {
    const user = requireImporter(req);
    const body = await readJson<{ dryRun?: boolean; files?: boolean; request_id?: string }>(req);
    const { job, already } = startImport(user, { kind: "api", dryRun: body.dryRun === true, files: body.files !== false, requestId: body.request_id });
    return { job, already };
  });

  r.get("/api/chat/history/jobs/:id", (req) => {
    requireImporter(req);
    const job = getJob(req.params.id);
    if (!job || (job.kind as string) === "upload") throw new HttpError(404, "no such import");
    return { job, report: jobReport(job.id) ?? null };
  });

  r.get("/api/chat/history/jobs/:id/report", (req, res: ServerResponse) => {
    requireImporter(req);
    const report = jobReport(req.params.id);
    if (!report) throw new HttpError(404, "no report for that import (yet)");
    const md = req.query.get("format") !== "json";
    const out = md ? reportMarkdown(report) : JSON.stringify(report, null, 2);
    const day = new Date(report.startedAt).toISOString().slice(0, 10);
    res.writeHead(200, {
      "content-type": md ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="slack-import-${day}${report.dryRun ? "-dry-run" : ""}.${md ? "md" : "json"}"`,
      "content-length": Buffer.byteLength(out),
    });
    res.end(out);
  });

  /** link Slack people to whoever has their email now (admin) */
  r.post("/api/chat/history/link", (req) => {
    requireImporter(req);
    return { linked: linkGhostsByEmail() };
  });

  /** everything the asker can see, as one zip (?files=1 with the files) */
  r.get("/api/chat/history/export", async (req, res: ServerResponse) => {
    const user = requireUser(req);
    const day = new Date().toISOString().slice(0, 10);
    res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="chatform-${day}.zip"`, "cache-control": "no-store" });
    try {
      await exportWorkspace(user, res, { files: req.query.get("files") === "1" });
    } catch (e) {
      console.error("chat export failed", e);
      res.destroy(e as Error);
      return;
    }
    res.end();
  });
}
