/**
 * The Slack board: one section for every channel the Slack app can see, each
 * kept current with its channel.
 *
 * A section holds three things, all ordinary cards anyone can move or edit:
 *   - "Summary": what the channel is about right now. The server writes a
 *     plain digest (counts, the most discussed messages); once a person turns
 *     agents on, a crew agent rewrites it in words and keeps it current.
 *   - "Latest": the newest top-level messages (who, when, what, replies).
 *   - the latest images posted there, copied into Foundation's archive (so
 *     everyone on the board can see them and search finds them; like every
 *     file here they're archived, never deleted) and laid out newest first.
 *
 * Which channel a section follows, and how that connection stands, is in the
 * board's `slack` map (protocol: SlackSectionState), written here alone, so
 * the mark on the section says the same thing to everyone:
 *   live     Slack sends what's posted as it's posted. The Slack app's own
 *            process (apps/slack-agent, Socket Mode) forwards each event to
 *            POST /api/slack/events and checks in every few seconds.
 *   polling  no word from the Slack app lately: channels are read in turn
 *            while someone has the board open.
 *   waiting  the app isn't in the channel, so it can't be read.
 *   offline  Slack isn't connected, or wouldn't answer; the detail says why.
 *
 * Agents. Reading Slack and placing cards costs nothing and needs no model.
 * Writing a summary is an agent turn (the person's subscription, or API
 * credits), so nothing starts one until a person turns agents on for the
 * board (from their browser; a bearer token can't). From then on a crew agent
 * (a name and a cursor, like any other) is called to a section when its
 * channel has something new: at most one at a time, at most once per channel
 * every FOUNDATION_SLACK_CURATE_MIN_MS (10 min), at most
 * FOUNDATION_SLACK_CURATE_PER_HOUR (20) an hour, as that person, until
 * someone turns it off. Agents never post to Slack.
 */

import * as Y from "yjs";
import { DEFAULT_COL_W, DEFAULT_ROW_H, boardMaps, logActivity, putNote, readTracks, setNoteText, slackSectionOf, uid, type AgentEvent, type MediaDoc, type SectionDoc, type SlackSectionState, type UserInfo } from "@foundation/protocol";
import { all, db, one, run } from "./db.ts";
import { createBoardRow, editBoard, getBoard, listBoards } from "./boards.ts";
import { storeFile } from "./files.ts";
import { imageSize } from "./construct.ts";
import { canWrite } from "./roles.ts";
import { SlackError, channelItems, downloadFile, forgetChannels, joinChannel, lendToken, listChannels, slackConfigured, slackStatus, type ChannelItem, type SlackChannel, type SlackFileRef } from "./slack.ts";

db.exec(`
  create table if not exists slack_boards (
    board_id text primary key,
    made_by text not null,
    made_at integer not null,
    agents_by text,
    agents_at integer
  );
  create table if not exists slack_sections (
    board_id text not null,
    channel text not null,
    section_id text not null,
    name text not null,
    last_ts text,
    curated_ts text,
    curated_at integer,
    primary key (board_id, channel)
  );
  create table if not exists slack_images (
    board_id text not null,
    slack_file text not null,
    channel text not null,
    card_id text not null,
    file_id text not null,
    ts text not null,
    x integer,
    y integer,
    primary key (board_id, slack_file)
  );
`);

interface BoardRow {
  board_id: string;
  made_by: string;
  made_at: number;
  agents_by: string | null;
  agents_at: number | null;
}
interface SectionRow {
  board_id: string;
  channel: string;
  section_id: string;
  name: string;
  last_ts: string | null;
  curated_ts: string | null;
  curated_at: number | null;
}
interface ImageRow {
  board_id: string;
  slack_file: string;
  channel: string;
  card_id: string;
  file_id: string;
  ts: string;
  x: number | null;
  y: number | null;
}

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// ---------- where things sit in a section ----------

const GAP = 24;
const NOTE_W = 440;
const SUMMARY_H = 320;
const LATEST_H = 560;
const IMG_X = NOTE_W + GAP;
const IMG_W = 320;
const IMG_COLS = 3;
/** how many of a channel's latest images come in the first time it's read */
const firstImages = () => num("FOUNDATION_SLACK_FIRST_IMAGES", 12);
const LATEST_COUNT = 12;
const IMAGE = /^image\/(png|jpe?g|gif|webp|avif)$/;

// ---------- the connection ----------

let bridgeAt = 0;
let bridgeTeam = "";
/** the Slack app's process checks in every 10 s; three missed and it's gone */
const BRIDGE_TTL = 35_000;
export const bridgeLive = () => Date.now() - bridgeAt < BRIDGE_TTL;

const pollMs = () => num("FOUNDATION_SLACK_POLL_MS", 5000);

function connection(members: number): Pick<SlackSectionState, "state" | "detail"> {
  if (!slackConfigured()) return { state: "offline", detail: "Slack isn't connected: run the Slack app (npm run slack), or set SLACK_BOT_TOKEN (SPEC §6)" };
  if (bridgeLive()) return { state: "live", detail: "Slack sends what's posted here as it's posted" };
  const every = Math.max(1, Math.round((Math.max(1, members) * pollMs()) / 1000));
  return { state: "polling", detail: `Read about every ${every} s while someone has this board open. The Slack app isn't running (npm run slack), so nothing is pushed` };
}

function notIn(ch: Pick<SlackChannel, "private">): Pick<SlackSectionState, "state" | "detail"> {
  return {
    state: "waiting",
    detail: ch.private ? "The Slack app isn't in this private channel: /invite it there in Slack" : "The Slack app isn't in this channel. Press to have it join (the channel will see it join), or /invite it in Slack",
  };
}

// ---------- the board ----------

export function slackBoards(): BoardRow[] {
  const known = new Set(listBoards().map((b) => b.id));
  return all<BoardRow>("select * from slack_boards order by made_at").filter((b) => known.has(b.board_id));
}

const boardRow = (boardId: string) => one<BoardRow>("select * from slack_boards where board_id = ?", boardId);
const sectionRows = (boardId: string) => all<SectionRow>("select * from slack_sections where board_id = ? order by name", boardId);
const sectionRow = (boardId: string, channel: string) => one<SectionRow>("select * from slack_sections where board_id = ? and channel = ?", boardId, channel);

/** the first free cell of the board's grid, row by row; a new row when it's full */
function freeCell(doc: Y.Doc): { c: number; r: number } {
  const m = boardMaps(doc);
  const tracks = readTracks(doc);
  const top = [...m.sections.values()].filter((s) => !s.parent);
  for (let r = 0; r < tracks.rows.length; r++)
    for (let c = 0; c < tracks.cols.length; c++) if (!top.some((s) => c >= s.c0 && c <= s.c1 && r >= s.r0 && r <= s.r1)) return { c, r };
  m.grid.set("tracks", { cols: tracks.cols, rows: [...tracks.rows, DEFAULT_ROW_H] });
  return { c: 0, r: tracks.rows.length };
}

function setState(doc: Y.Doc, sectionId: string, patch: Partial<SlackSectionState>) {
  const m = boardMaps(doc);
  const was = m.slack.get(sectionId);
  if (!was) return;
  const next = { ...was, ...patch };
  for (const k of Object.keys(next) as Array<keyof SlackSectionState>) if (next[k] === undefined) delete next[k];
  // a read that found nothing new isn't a change to the board: only the time moved, and that can wait a minute
  const { syncedAt: a, ...restA } = was;
  const { syncedAt: b, ...restB } = next;
  if (JSON.stringify(restA) === JSON.stringify(restB) && (b ?? 0) - (a ?? 0) < 60_000) return;
  m.slack.set(sectionId, next);
}

/**
 * Make sure every channel has its section (and every section its two notes),
 * and that each says how its connection stands. Returns the channels whose
 * sections were just made.
 */
function ensureSections(boardId: string, channels: SlackChannel[]): string[] {
  const made: string[] = [];
  const row = boardRow(boardId);
  const members = channels.filter((c) => c.member).length;
  const conn = connection(members);
  const agents = row?.agents_by ? { by: userName(row.agents_by), at: row.agents_at ?? Date.now() } : undefined;
  editBoard(boardId, "slack", (doc) => {
    const m = boardMaps(doc);
    const top = () => [...m.sections.values()].filter((s) => !s.parent);
    // a new board gets a grid that fits every channel, as near square as it goes
    if (top().length === 0) {
      const cols = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(channels.length))));
      const rows = Math.max(1, Math.ceil(channels.length / cols));
      m.grid.set("tracks", { cols: new Array(cols).fill(DEFAULT_COL_W), rows: new Array(rows).fill(DEFAULT_ROW_H) });
    }
    for (const ch of channels) {
      let sr = sectionRow(boardId, ch.id);
      // a section someone removed stays removed: the channel is no longer followed here
      if (sr && !m.sections.has(sr.section_id)) {
        m.slack.delete(sr.section_id);
        continue;
      }
      if (!sr) {
        const at = freeCell(doc);
        const sec: SectionDoc = { id: uid("sec"), name: `#${ch.name}`, c0: at.c, r0: at.r, c1: at.c, r1: at.r };
        m.sections.set(sec.id, sec);
        const base = { sectionId: sec.id, float: true, bornAt: Date.now() };
        const summaryNote = uid("note");
        const latestNote = uid("note");
        putNote(doc, { ...base, id: summaryNote, kind: "note", name: "Summary", x: 0, y: 0, w: NOTE_W, h: SUMMARY_H, text: `## #${ch.name}\n\n${ch.topic ? `${ch.topic}\n\n` : ""}*Nothing read from the channel yet.*` });
        putNote(doc, { ...base, id: latestNote, kind: "note", name: "Latest", x: 0, y: SUMMARY_H + GAP, w: NOTE_W, h: LATEST_H, text: `**Latest in #${ch.name}**\n\n*Nothing read yet.*` });
        m.slack.set(sec.id, { channel: ch.id, name: ch.name, ...(ch.private ? { private: true } : {}), ...(ch.member ? conn : notIn(ch)), summaryNote, latestNote, ...(agents ? { agents } : {}) });
        run("insert into slack_sections (board_id, channel, section_id, name) values (?, ?, ?, ?)", boardId, ch.id, sec.id, ch.name);
        made.push(ch.id);
        continue;
      }
      // a renamed channel renames its section, unless a person already gave the section a name of their own
      if (sr.name !== ch.name) {
        const sec = m.sections.get(sr.section_id)!;
        if (sec.name === `#${sr.name}`) m.sections.set(sec.id, { ...sec, name: `#${ch.name}` });
        run("update slack_sections set name = ? where board_id = ? and channel = ?", ch.name, boardId, ch.id);
        sr = { ...sr, name: ch.name };
      }
      setState(doc, sr.section_id, { name: ch.name, private: ch.private || undefined, ...(ch.member ? conn : notIn(ch)), agents });
    }
    // a channel that was archived, or that the app can no longer see
    const seen = new Set(channels.map((c) => c.id));
    for (const sr of sectionRows(boardId)) {
      if (seen.has(sr.channel) || !m.sections.has(sr.section_id)) continue;
      setState(doc, sr.section_id, { state: "offline", detail: "Slack no longer lists this channel (archived, or the app was removed from it)" });
    }
  });
  return made;
}

function userName(id: string) {
  return one<{ name: string }>("select name from users where id = ?", id)?.name ?? "someone";
}

/**
 * Build the Slack board, or bring the one there is up to date: a section for
 * every channel the app can see (the ones it's in first), each read once.
 * There is one Slack board; making it again opens it.
 */
export async function buildSlackBoard(user: UserInfo): Promise<{ id: string; made: boolean; channels: number; reading: number; waiting: number }> {
  const status = await slackStatus();
  if (!status.connected) throw new SlackError("not_configured", status.reason ?? "Slack isn't connected");
  forgetChannels();
  const channels = await listChannels();
  let row = slackBoards()[0];
  const made = !row;
  if (!row) {
    const id = createBoardRow("Slack", { kind: "grid" });
    run("insert into slack_boards (board_id, made_by, made_at) values (?, ?, ?)", id, user.id, Date.now());
    row = boardRow(id)!;
    editBoard(id, "slack", (doc) => logActivity(doc, { who: user.name, role: "human", text: `made the Slack board: a section for each of ${channels.length} channels` }));
  }
  ensureSections(row.board_id, channels);
  const reading = channels.filter((c) => c.member);
  // read them in the background, a few at a time: the board opens at once and fills in
  void fill(row.board_id, reading.map((c) => c.id));
  return { id: row.board_id, made, channels: channels.length, reading: reading.length, waiting: channels.length - reading.length };
}

async function fill(boardId: string, channels: string[]) {
  const queue = [...channels];
  const worker = async () => {
    for (let ch = queue.shift(); ch; ch = queue.shift()) await syncChannel(boardId, ch).catch(() => {});
  };
  await Promise.all([worker(), worker(), worker()]);
}

/** the channel list changed (made, renamed, archived, the app joined or left): sections follow */
export async function refreshChannels() {
  if (!slackConfigured()) return;
  forgetChannels();
  let channels: SlackChannel[];
  try {
    channels = await listChannels();
  } catch {
    return;
  }
  for (const b of slackBoards()) {
    const before = new Map(sectionRows(b.board_id).map((s) => [s.channel, slackSectionOf(getBoard(b.board_id).doc, s.section_id)?.state]));
    const made = ensureSections(b.board_id, channels);
    // newly made, or just joined: read them now
    const fresh = channels.filter((c) => c.member && (made.includes(c.id) || before.get(c.id) === "waiting")).map((c) => c.id);
    if (fresh.length) void fill(b.board_id, fresh);
  }
}

/** every section says how the connection stands now (the Slack app came or went) */
function restate() {
  for (const b of slackBoards()) {
    const rows = sectionRows(b.board_id);
    const doc = getBoard(b.board_id).doc;
    const states = rows.map((r) => ({ r, st: slackSectionOf(doc, r.section_id) }));
    const conn = connection(states.filter((x) => x.st && x.st.state !== "waiting").length);
    editBoard(b.board_id, "slack", (d) => {
      for (const { r, st } of states) if (st && st.state !== "waiting") setState(d, r.section_id, conn);
    });
  }
}

// ---------- reading a channel into its section ----------

const day = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const images = (m: ChannelItem) => m.files.filter((f) => IMAGE.test(f.mime));

function latestMarkdown(name: string, items: ChannelItem[]): string {
  if (!items.length) return `**Latest in #${name}**\n\n*Nothing posted yet.*`;
  const lines = items.slice(0, LATEST_COUNT).map((m) => {
    const extra = [m.replies ? plural(m.replies, "reply").replace("replys", "replies") : "", images(m).length ? plural(images(m).length, "image") : "", m.files.length - images(m).length > 0 ? plural(m.files.length - images(m).length, "file") : ""].filter(Boolean).join(" · ");
    return `- **${m.name}** · ${day(m.at)} ${clock(m.at)}  \n  ${oneLine(m.text, 220) || "*(no words)*"}${extra ? `  \n  *${extra}*` : ""}`;
  });
  return `**Latest in #${name}**\n\n${lines.join("\n")}`;
}

/** what the server can say without a model: counts, and what drew the most replies */
function digestMarkdown(name: string, topic: string | undefined, items: ChannelItem[], imageCount: number, agentsOn: boolean): string {
  const head = `## #${name}\n\n${topic ? `${topic}\n\n` : ""}`;
  if (!items.length) return `${head}*Nothing posted yet.*`;
  const people = new Set(items.map((m) => m.name));
  const oldest = items[items.length - 1];
  const discussed = [...items].filter((m) => m.replies).sort((a, b) => (b.replies ?? 0) - (a.replies ?? 0)).slice(0, 3);
  const lines = [
    `**${plural(items.length, "message")}** from ${plural(people.size, "person").replace("persons", "people")} since ${day(oldest.at)}${imageCount ? ` · **${plural(imageCount, "image")}** here` : ""}`,
    ...(discussed.length ? ["", "Most discussed:", ...discussed.map((m) => `- ${m.name}: ${oneLine(m.text, 120)} *(${m.replies} ${m.replies === 1 ? "reply" : "replies"})*`)] : []),
    "",
    agentsOn ? "*A digest the server made from the channel. An agent will write this in words shortly.*" : "*A digest the server made from the channel, not a written summary. Turn agents on (the Slack mark on this section) and one will write and keep it.*",
  ];
  return head + lines.join("\n");
}

/** masonry: each image, newest first, goes in the shortest column */
function layoutImages(doc: Y.Doc, boardId: string, channel: string, sectionId: string) {
  const m = boardMaps(doc);
  const rows = all<ImageRow>("select * from slack_images where board_id = ? and channel = ? order by ts desc", boardId, channel);
  const heights = new Array(IMG_COLS).fill(0);
  for (const r of rows) {
    const o = m.objects.get(r.card_id);
    // a card someone moved, docked, carried to another section or removed is theirs now: it keeps its place
    if (!o || o.kind !== "media" || o.sectionId !== sectionId || !o.float || (r.x !== null && (o.x !== r.x || o.y !== r.y))) continue;
    let col = 0;
    for (let c = 1; c < IMG_COLS; c++) if (heights[c] < heights[col]) col = c;
    const x = IMG_X + col * (IMG_W + GAP);
    const y = heights[col];
    heights[col] += o.h + GAP;
    if (o.x !== x || o.y !== y) m.objects.set(o.id, { ...o, x, y });
    if (r.x !== x || r.y !== y) run("update slack_images set x = ?, y = ? where board_id = ? and slack_file = ?", x, y, boardId, r.slack_file);
  }
}

const syncing = new Map<string, Promise<void>>();

/** Read a channel and bring its section up to date. One read at a time per channel. */
export function syncChannel(boardId: string, channel: string): Promise<void> {
  const key = `${boardId}:${channel}`;
  const going = syncing.get(key);
  if (going) return going;
  const p = doSync(boardId, channel).finally(() => syncing.delete(key));
  syncing.set(key, p);
  return p;
}

async function doSync(boardId: string, channel: string) {
  const row = sectionRow(boardId, channel);
  const brow = boardRow(boardId);
  if (!row || !brow) return;
  const board = getBoard(boardId);
  const st = slackSectionOf(board.doc, row.section_id);
  if (!st || !boardMaps(board.doc).sections.has(row.section_id)) return;

  let items: ChannelItem[];
  try {
    items = await channelItems(channel, 60);
  } catch (e) {
    const code = e instanceof SlackError ? e.code : "";
    const patch: Partial<SlackSectionState> = code === "not_in_channel" ? notIn({ private: Boolean(st.private) }) : { state: "offline", detail: (e as Error).message };
    editBoard(boardId, "slack", (doc) => setState(doc, row.section_id, patch));
    return;
  }

  // images not here yet: the latest few the first time the channel is read, then whatever is posted after that
  const have = new Set(all<{ slack_file: string }>("select slack_file from slack_images where board_id = ? and channel = ?", boardId, channel).map((r) => r.slack_file));
  const since = row.last_ts ? Number(row.last_ts) : null;
  let fresh = items.flatMap((m) => images(m).map((f) => ({ f, m }))).filter((x) => !have.has(x.f.id) && (since === null || Number(x.m.ts) > since));
  if (since === null) fresh = fresh.slice(0, firstImages());
  let missed = false;
  const brought: Array<{ f: SlackFileRef; m: ChannelItem; fileId: string; w: number; h: number }> = [];
  for (const { f, m } of fresh.reverse()) {
    try {
      const body = await downloadFile(f);
      const size = imageSize(body) ?? { w: 4, h: 3 };
      const file = await storeFile(body, { name: f.name, mime: f.mime, boardId, userId: brow.made_by, about: `from Slack #${st.name} ${m.name} ${f.title ?? ""} ${m.text}` });
      brought.push({ f, m, fileId: file.id, w: size.w, h: size.h });
    } catch (e) {
      // one picture that won't come doesn't stop the channel; it's tried again on the next read
      missed = true;
      console.error(`slack: ${f.name} in #${st.name}: ${(e as Error).message}`);
    }
  }

  const newest = items[0]?.ts ?? null;
  const changed = newest !== row.last_ts || brought.length > 0;
  const conn = connection(sectionRows(boardId).length);
  editBoard(boardId, "slack", (doc) => {
    const m = boardMaps(doc);
    const now = slackSectionOf(doc, row.section_id);
    if (!now || !m.sections.has(row.section_id)) return;
    // an agent arranged this section (its cards are docked): new images join the flow instead of the server's columns
    const arranged = all<ImageRow>("select * from slack_images where board_id = ? and channel = ?", boardId, channel).some((r) => {
      const o = m.objects.get(r.card_id);
      return o && o.sectionId === row.section_id && !o.float;
    });
    for (const b of brought) {
      const w = IMG_W;
      const h = Math.max(60, Math.round((w * b.h) / b.w));
      const title = b.f.title && b.f.title !== b.f.name ? b.f.title : oneLine(b.m.text, 60) || b.f.name;
      const card: MediaDoc = { id: uid("media"), kind: "media", sectionId: row.section_id, name: `${title} · ${b.m.name} · ${day(b.m.at)}`, x: 0, y: 0, float: !arranged, bornAt: Date.now(), w, h, src: `/files/${b.fileId}`, media: "image", autoplay: false, muted: true };
      m.objects.set(card.id, card);
      run("insert or replace into slack_images (board_id, slack_file, channel, card_id, file_id, ts, x, y) values (?, ?, ?, ?, ?, ?, null, null)", boardId, b.f.id, channel, card.id, b.fileId, b.m.ts);
    }
    if (brought.length) layoutImages(doc, boardId, channel, row.section_id);
    const count = one<{ n: number }>("select count(*) as n from slack_images where board_id = ? and channel = ?", boardId, channel)?.n ?? 0;
    if (now.latestNote && m.objects.has(now.latestNote)) setNoteText(doc, now.latestNote, latestMarkdown(now.name, items));
    // the digest is the server's until an agent has written the summary; after that it's the agent's (and people's) to keep
    if (!now.summaryBy && now.summaryNote && m.objects.has(now.summaryNote)) setNoteText(doc, now.summaryNote, digestMarkdown(now.name, undefined, items, count, Boolean(now.agents)));
    setState(doc, row.section_id, { ...conn, syncedAt: Date.now(), lastAt: items[0]?.at, messages: items.length, images: count });
    if (brought.length) logActivity(doc, { who: "Slack", role: "agent", text: `brought ${plural(brought.length, "image")} from #${now.name}`, objectId: row.section_id });
  });
  // where the channel was read up to: not moved past a picture that didn't come, so the next read asks for it again
  if (newest && !missed) run("update slack_sections set last_ts = ? where board_id = ? and channel = ?", newest, boardId, channel);
  if (changed && newest) wantCurate(boardId, channel);
}

// ---------- what Slack sends (through the Slack app's process) ----------

const pending = new Map<string, ReturnType<typeof setTimeout>>();
function soon(key: string, ms: number, fn: () => void) {
  const was = pending.get(key);
  if (was) clearTimeout(was);
  const t = setTimeout(() => {
    pending.delete(key);
    fn();
  }, ms);
  t.unref?.();
  pending.set(key, t);
}

const CHANNEL_EVENTS = new Set(["channel_created", "channel_rename", "channel_archive", "channel_unarchive", "channel_deleted", "channel_left", "group_rename", "group_archive", "group_unarchive", "group_left", "member_joined_channel", "member_left_channel"]);

export interface BridgeMessage {
  type: "hello" | "heartbeat" | "event";
  team?: string;
  /** the app's bot token, so Foundation can read what the event points at (loopback only; kept in memory) */
  bot_token?: string;
  event?: { type?: string; channel?: string | { id?: string }; subtype?: string };
}

/** A word from the Slack app's process: it's there, and maybe something happened. */
export function fromBridge(msg: BridgeMessage, opts: { loopback: boolean }): { ok: true; boards: number } {
  const wasLive = bridgeLive();
  const wasConfigured = slackConfigured();
  bridgeAt = Date.now();
  sawLive = true;
  if (msg.team) bridgeTeam = msg.team;
  if (msg.bot_token && opts.loopback) lendToken(msg.bot_token);
  const boards = slackBoards();
  if (!wasLive || !wasConfigured) {
    restate();
    // it may have been away a while: catch up on what was posted meanwhile
    if (boards.length) soon("refresh", 200, () => void refreshChannels().then(() => boards.forEach((b) => void fill(b.board_id, sectionRows(b.board_id).filter((r) => slackSectionOf(getBoard(b.board_id).doc, r.section_id)?.state !== "waiting").map((r) => r.channel)))));
  }
  const ev = msg.type === "event" ? msg.event : undefined;
  if (ev?.type === "message") {
    const channel = typeof ev.channel === "string" ? ev.channel : ev.channel?.id;
    if (channel) for (const b of boards) if (sectionRow(b.board_id, channel)) soon(`sync:${b.board_id}:${channel}`, num("FOUNDATION_SLACK_EVENT_MS", 600), () => void syncChannel(b.board_id, channel).catch(() => {}));
  } else if (ev?.type && CHANNEL_EVENTS.has(ev.type)) {
    soon("refresh", 1500, () => void refreshChannels());
  }
  return { ok: true, boards: boards.length };
}

// ---------- the watch: notice when the Slack app goes quiet, and read in turn while it is ----------

let ticker: ReturnType<typeof setInterval> | null = null;
let sawLive = false;
const turn = new Map<string, number>();

export function startSlackLive() {
  if (ticker) return;
  ticker = setInterval(() => void tick().catch(() => {}), pollMs());
  ticker.unref?.();
}
export function stopSlackLive() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

export async function tick() {
  const live = bridgeLive();
  if (sawLive !== live) {
    sawLive = live;
    restate();
  }
  if (live || !slackConfigured()) return;
  for (const b of slackBoards()) {
    const board = getBoard(b.board_id);
    if (board.conns.size === 0) continue; // nobody looking: nothing to keep fresh
    const rows = sectionRows(b.board_id).filter((r) => {
      const st = slackSectionOf(board.doc, r.section_id);
      return st && st.state !== "waiting";
    });
    if (!rows.length) continue;
    const i = (turn.get(b.board_id) ?? 0) % rows.length;
    turn.set(b.board_id, i + 1);
    await syncChannel(b.board_id, rows[i].channel).catch(() => {});
  }
}

// ---------- people's buttons ----------

/** the app joins a public channel so its section can be read. A person presses this: the channel sees it join. */
export async function joinFor(boardId: string, channel: string, user: UserInfo) {
  const row = sectionRow(boardId, channel);
  if (!row) throw new SlackError("channel_not_found", "That channel has no section on this board");
  await joinChannel(channel);
  editBoard(boardId, "slack", (doc) => {
    setState(doc, row.section_id, connection(sectionRows(boardId).length));
    logActivity(doc, { who: user.name, role: "human", text: `had the Slack app join #${row.name}`, objectId: row.section_id });
  });
  await syncChannel(boardId, channel);
}

/** Turn agents on or off for the Slack board. On is a person's decision: each summary is an agent turn. */
export function setAgents(boardId: string, user: UserInfo, on: boolean) {
  const row = boardRow(boardId);
  if (!row) throw new SlackError("not_a_slack_board", "That isn't the Slack board");
  run("update slack_boards set agents_by = ?, agents_at = ? where board_id = ?", on ? user.id : null, on ? Date.now() : null, boardId);
  const agents = on ? { by: user.name, at: Date.now() } : undefined;
  editBoard(boardId, "slack", (doc) => {
    for (const r of sectionRows(boardId)) setState(doc, r.section_id, { agents });
    logActivity(doc, { who: user.name, role: "human", text: on ? "turned agents on for the Slack board: they write each section's summary and keep it" : "turned agents off for the Slack board" });
  });
  if (!on) {
    queue.length = 0;
    return { on: false };
  }
  // every channel that has something to say gets its summary written, in turn
  for (const r of sectionRows(boardId)) if (r.last_ts && r.last_ts !== r.curated_ts) wantCurate(boardId, r.channel);
  return { on: true };
}

// ---------- agents keep the sections ----------

type Curator = (opts: { boardId: string; user: UserInfo; prompt: string; session: string }) => { events: AgentEvent[]; done: boolean; listeners: Set<(e: AgentEvent) => void> };
let curator: Curator | null = null;
/** agent.ts's startRun, handed in by index.ts (and by tests), so this module doesn't pull the runtime in */
export function setCurator(fn: Curator | null) {
  curator = fn;
}

const queue: Array<{ boardId: string; channel: string }> = [];
let working = false;
const started: number[] = [];
const curateMin = () => num("FOUNDATION_SLACK_CURATE_MIN_MS", 10 * 60_000);
const perHour = () => num("FOUNDATION_SLACK_CURATE_PER_HOUR", 20);

function wantCurate(boardId: string, channel: string) {
  const b = boardRow(boardId);
  if (!b?.agents_by || !curator) return;
  if (queue.some((q) => q.boardId === boardId && q.channel === channel)) return;
  const row = sectionRow(boardId, channel);
  if (!row) return;
  // not more often than the minimum per channel: a busy channel is summarised when it pauses, not per message
  const wait = Math.max(0, (row.curated_at ?? 0) + curateMin() - Date.now());
  soon(`curate:${boardId}:${channel}`, wait + num("FOUNDATION_SLACK_SETTLE_MS", 4000), () => {
    queue.push({ boardId, channel });
    void work();
  });
}

async function work() {
  if (working) return;
  working = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const hourAgo = Date.now() - 3600_000;
      while (started.length && started[0] < hourAgo) started.shift();
      if (started.length >= perHour()) {
        // the hour's turns are spent: what's waiting is picked up when the oldest one ages out
        queue.unshift(job);
        soon("curate:resume", started[0] + 3600_000 - Date.now() + 1000, () => void work());
        return;
      }
      await curate(job.boardId, job.channel).catch((e) => console.error(`slack: agent for ${job.channel}: ${(e as Error).message}`));
    }
  } finally {
    working = false;
  }
}

export function curatePrompt(st: SlackSectionState, sectionId: string, cards: Array<{ id: string; name: string }>): string {
  return [
    `Keep the section “#${st.name}” (section id ${sectionId}) on this board current with its Slack channel (channel id ${st.channel}).`,
    "",
    `1. Read the channel: slack_read { channel: "${st.channel}", limit: 60 }.`,
    `2. Rewrite the note “Summary” (card id ${st.summaryNote}) with update_card { id, markdown }: a heading “## #${st.name}”, then what the channel is about right now, what was decided, what is still open and who is waiting on whom. Short markdown, at most 12 lines, people by name, dates where they matter. End with one line in italics saying how many messages it was written from.`,
    cards.length
      ? `3. The channel's images are cards in this section: ${cards.map((c) => `${c.id} (“${c.name}”)`).join(", ")}. Where a name doesn't say what the picture shows, give it a short one that does, from the message it came with (update_card { id, name }).`
      : "3. There are no images from the channel here yet.",
    `4. Put what matters most first: arrange_section { section: "${sectionId}", order: [...] } with the Summary (${st.summaryNote}), then Latest (${st.latestNote}), then the image cards in the order you choose (the newest and most relevant first).`,
    "",
    "Don't post to Slack, don't delete anything, and don't make new sections or cards. Say in one line what you changed.",
  ].join("\n");
}

async function curate(boardId: string, channel: string) {
  const b = boardRow(boardId);
  const row = sectionRow(boardId, channel);
  if (!b?.agents_by || !row || !curator) return;
  const user = one<UserInfo>("select id, email, name, color, role from users where id = ?", b.agents_by);
  // the person who turned agents on has left, or can no longer change this board: nobody to run them for
  if (!user || !canWrite(user.id, boardId)) {
    run("update slack_boards set agents_by = null, agents_at = null where board_id = ?", boardId);
    editBoard(boardId, "slack", (doc) => sectionRows(boardId).forEach((r) => setState(doc, r.section_id, { agents: undefined })));
    return;
  }
  const doc = getBoard(boardId).doc;
  const st = slackSectionOf(doc, row.section_id);
  if (!st || st.state === "waiting" || !st.summaryNote || !row.last_ts || row.last_ts === row.curated_ts) return;
  const m = boardMaps(doc);
  const cards = all<ImageRow>("select * from slack_images where board_id = ? and channel = ? order by ts desc", boardId, channel)
    .map((r) => m.objects.get(r.card_id))
    .filter((o): o is MediaDoc => Boolean(o) && o!.kind === "media" && o!.sectionId === row.section_id)
    .map((o) => ({ id: o.id, name: o.name }));
  const upTo = row.last_ts;
  started.push(Date.now());
  const r = curator({ boardId, user, prompt: curatePrompt(st, row.section_id, cards), session: `slack-${channel}` });
  await new Promise<void>((done) => {
    if (r.done) return done();
    r.listeners.add((e) => e.type === "status" && e.status === "ended" && done());
  });
  const failed = r.events.some((e) => e.type === "error");
  const crew = r.events.find((e): e is Extract<AgentEvent, { type: "crew" }> => e.type === "crew");
  // a turn that failed is tried again after the minimum wait, not at once (an expired sign-in would spin)
  run("update slack_sections set curated_at = ?, curated_ts = case when ? then curated_ts else ? end where board_id = ? and channel = ?", Date.now(), failed ? 1 : 0, upTo, boardId, channel);
  if (!failed) editBoard(boardId, "slack", (d) => setState(d, row.section_id, { summaryBy: crew?.name ?? "an agent", summaryAt: Date.now() }));
}

// ---------- what Settings and the API say ----------

export async function slackLiveStatus() {
  const status = await slackStatus();
  return {
    connected: status.connected,
    team: status.team ?? (bridgeTeam || undefined),
    reason: status.reason,
    /** the Slack app's own process is checking in: events are pushed */
    app: bridgeLive() ? { live: true as const, seenAt: bridgeAt } : { live: false as const, seenAt: bridgeAt || null },
    boards: slackBoards().map((b) => {
      const doc = getBoard(b.board_id).doc;
      const states = sectionRows(b.board_id).map((r) => slackSectionOf(doc, r.section_id)).filter((s): s is SlackSectionState => Boolean(s));
      const count = (s: SlackSectionState["state"]) => states.filter((x) => x.state === s).length;
      return { id: b.board_id, sections: states.length, live: count("live"), polling: count("polling"), waiting: count("waiting"), offline: count("offline"), agents: b.agents_by ? { by: userName(b.agents_by), at: b.agents_at } : null };
    }),
  };
}

/** tests only: the Slack app's process stopped checking in */
export function _bridgeGone() {
  bridgeAt = 0;
}

/** tests only */
export function _resetSlackLive() {
  bridgeAt = 0;
  sawLive = false;
  queue.length = 0;
  started.length = 0;
  working = false;
  stopSlackLive();
}
