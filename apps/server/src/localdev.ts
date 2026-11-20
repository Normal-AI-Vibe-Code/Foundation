/**
 * This computer: the projects being built on the computer the server runs on, as a grid (protocol localdev.ts).
 *
 * Read, never written: Claude Code's transcripts (`~/.claude/projects/<folder>/<session>.jsonl`, the same files the
 * desktop app's Code tab and the CLI write), T3 / Vision Code's thread store (t3.ts, read-only) and each project's
 * git checkout (`git status`, `git log`). A project is a git repository: sessions that run in one of its worktrees
 * fold into it. A dev server a project declares in `.claude/launch.json` is knocked on (a TCP connect to localhost),
 * never fetched.
 *
 * Rules (tested in test/localdev.test.ts):
 *  - **Only an admin, as a person, connects or stops it.** An agent's bearer can't: the transcripts are a person's
 *    conversations. Connecting starts the watch; the watch runs git, a program on this computer, so it never
 *    starts on its own: at boot it resumes only a watch a person started and didn't stop.
 *  - **The grid is the person's who connected it**: it's made members-only with them as its owner (admins pass, as
 *    on any board). Its two maps (`local`, `localWatch`) are the server's alone (boards.ts SERVER_MAPS).
 *  - **Nothing in a project is written.** The one thing kept is the newest screenshot a session saw of the work,
 *    copied into the archive (content-addressed, archived never deleted, like any upload) for the preview card.
 *  - Temporary folders and Foundation's own data are never projects.
 *  - Stopping keeps the grid as it was; it says it stopped.
 *
 * Cost: a transcript is read once and then only from where it was left (its new bytes); git runs only for a
 * project whose sessions moved, or once a minute; the board is written only where something changed, with a
 * heartbeat every 30 s at most.
 */

import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  LOCAL_GRID_ID,
  LOCAL_GRID_NAME,
  LOCAL_NODES,
  boardMaps,
  localKey,
  logActivity,
  uid,
  type LocalCommit,
  type LocalFile,
  type LocalNode,
  type LocalProject,
  type LocalSession,
  type LocalStep,
  type LocalWatch,
  type PanelDoc,
  type SectionDoc,
  type UserInfo,
} from "@foundation/protocol";
import { config } from "./config.ts";
import { db, one, run } from "./db.ts";
import { editBoard, ensureBoardRow, getBoard } from "./boards.ts";
import { HttpError } from "./http.ts";
import { audit } from "./audit.ts";
import { setMember } from "./members.ts";
import { storeFile } from "./files.ts";
import { childOptions, execFileText, type ExecFileOptions } from "./child.ts";
import { t3Threads } from "./t3.ts";

db.exec(`
  create table if not exists local_watch (
    id text primary key, by_id text not null, by_name text not null, since integer not null, on_flag integer not null
  );
`);

const env = (k: string, d: number) => Number(process.env[k] ?? "") || d;
const SCAN_MS = () => env("FOUNDATION_LOCAL_SCAN_MS", 10_000);
const DAYS = () => env("FOUNDATION_LOCAL_DAYS", 7);
/** Claude Code's home: CLAUDE_CONFIG_DIR, or ~/.claude */
const CLAUDE_HOME = () => process.env.FOUNDATION_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const MAX_PROJECTS = 12;
const MAX_SESSIONS = 6;
const WORKING_MS = 120_000;
/** a screenshot smaller than this (base64 characters) is an icon or a crop, not a picture of the work */
const MIN_IMAGE = 24_000;
const HEARTBEAT_MS = 30_000;

// ---------- reading a transcript, from where it was left ----------

/** what one session's transcript has said so far */
export interface SessionAcc {
  id: string;
  file: string;
  cwd?: string;
  branch?: string;
  entry?: string;
  title?: string;
  named?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  recap?: string;
  steps: LocalStep[];
  edits: Set<string>;
  pr?: { number: number; url: string };
  /** where in the file the newest screenshot's line starts, and when it was taken */
  image?: { offset: number; at: number };
  mtime: number;
  /** bytes read so far, and what's left of a line not yet ended */
  offset: number;
  tail: Buffer;
}

export function newAcc(id: string, file: string): SessionAcc {
  return { id, file, steps: [], edits: new Set(), mtime: 0, offset: 0, tail: Buffer.alloc(0) };
}

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const stepState = (s: unknown): LocalStep["state"] => (s === "completed" || s === "done" ? "done" : s === "in_progress" || s === "doing" ? "doing" : "todo");

/** the desktop app's task list (`update_plan`): a whole list, or advance / done / start on the one it has */
export function applyPlan(steps: LocalStep[], input: Record<string, unknown>): LocalStep[] {
  if (Array.isArray(input.items)) {
    return input.items
      .map((i) => (i && typeof i === "object" ? (i as Record<string, unknown>) : null))
      .filter((i): i is Record<string, unknown> => !!i && typeof i.content === "string")
      .slice(0, 16)
      .map((i) => ({ text: short(String(i.content), 90), state: stepState(i.status) }));
  }
  const out = steps.map((s) => ({ ...s }));
  if (input.advance === true) {
    const at = out.findIndex((s) => s.state === "doing");
    if (at >= 0) out[at].state = "done";
    const next = out.findIndex((s, i) => i > at && s.state === "todo");
    if (next >= 0) out[next].state = "doing";
  }
  if (Array.isArray(input.done)) for (const n of input.done) if (typeof n === "number" && out[n - 1]) out[n - 1].state = "done";
  if (typeof input.start === "number" && out[input.start - 1]) {
    for (const s of out) if (s.state === "doing") s.state = "todo";
    out[input.start - 1].state = "doing";
  }
  return out;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** one line of a transcript into what the session has said (`at`: where the line starts in the file) */
/** the lines worth parsing: most of a transcript is the conversation itself, which the grid doesn't show */
const MARKS = ["\"custom-title\"", "\"agent-name\"", "\"last-prompt\"", "\"pr-link\"", "\"type\":\"summary\"", "update_plan", "TodoWrite", "wrap_up", "\"name\":\"Edit\"", "\"name\":\"Write\"", "\"name\":\"MultiEdit\"", "\"name\":\"NotebookEdit\""];
export function worthReading(acc: SessionAcc, line: string): boolean {
  if (!acc.cwd || !acc.firstPrompt) return true;
  if (line.includes("\"tool_result\"")) return line.length >= MIN_IMAGE && line.includes("\"type\":\"image\"");
  return MARKS.some((m) => line.includes(m));
}

export function readLine(acc: SessionAcc, line: string, at: number) {
  if (!line || line[0] !== "{" || !worthReading(acc, line)) return;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (j.isSidechain === true) return;
  if (typeof j.cwd === "string") acc.cwd = j.cwd;
  if (typeof j.gitBranch === "string" && j.gitBranch) acc.branch = j.gitBranch;
  if (typeof j.entrypoint === "string") acc.entry = j.entrypoint;
  const ts = typeof j.timestamp === "string" ? Date.parse(j.timestamp) || 0 : 0;
  switch (j.type) {
    case "custom-title":
      if (typeof j.customTitle === "string") acc.title = short(j.customTitle, 90);
      return;
    case "agent-name":
      if (typeof j.agentName === "string") acc.named = short(j.agentName, 90);
      return;
    case "summary":
      if (typeof j.summary === "string" && !acc.named) acc.named = short(j.summary, 90);
      return;
    case "last-prompt":
      if (typeof j.lastPrompt === "string") acc.lastPrompt = short(j.lastPrompt, 200);
      return;
    case "pr-link":
      if (typeof j.prNumber === "number" && typeof j.prUrl === "string" && /^https:\/\//.test(j.prUrl)) acc.pr = { number: j.prNumber, url: j.prUrl };
      return;
  }
  const msg = j.message as { content?: unknown } | undefined;
  const content = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : null;
  if (j.type === "user") {
    if (typeof msg?.content === "string" && !acc.firstPrompt) acc.firstPrompt = short(msg.content, 90);
    if (!content) return;
    for (const c of content) {
      if (c.type === "text" && typeof c.text === "string" && !acc.firstPrompt && !c.text.startsWith("<")) acc.firstPrompt = short(c.text, 90);
      // a screenshot a tool handed back (the browser, a preview): the work as the session saw it
      if (c.type === "tool_result" && Array.isArray(c.content)) {
        for (const x of c.content as Array<Record<string, unknown>>) {
          const src = x.source as { type?: string; data?: string; media_type?: string } | undefined;
          if (x.type === "image" && src?.type === "base64" && typeof src.data === "string" && src.data.length >= MIN_IMAGE && /^image\/(png|jpeg|webp)$/.test(src.media_type ?? "")) {
            acc.image = { offset: at, at: ts || acc.mtime };
          }
        }
      }
    }
    return;
  }
  if (j.type === "assistant" && content) {
    for (const c of content) {
      if (c.type !== "tool_use" || typeof c.name !== "string") continue;
      const input = (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>;
      if (c.name.endsWith("update_plan")) acc.steps = applyPlan(acc.steps, input);
      else if (c.name === "TodoWrite" && Array.isArray(input.todos)) acc.steps = applyPlan(acc.steps, { items: input.todos });
      else if (c.name.endsWith("wrap_up") && typeof input.recap === "string") acc.recap = short(input.recap, 300);
      else if (EDIT_TOOLS.has(c.name)) {
        const p = input.file_path ?? input.notebook_path;
        if (typeof p === "string") acc.edits.add(p);
      }
    }
  }
}

/** read what's new in a transcript since last time (a file that got shorter is read again from the start) */
export async function readNew(acc: SessionAcc, size: number, mtime: number) {
  if (size < acc.offset) Object.assign(acc, newAcc(acc.id, acc.file));
  acc.mtime = mtime;
  if (size === acc.offset) return;
  const fh = await open(acc.file, "r");
  try {
    const CHUNK = 8 * 1024 * 1024;
    let pos = acc.offset;
    while (pos < size) {
      const n = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, pos);
      if (!bytesRead) break;
      const data = acc.tail.length ? Buffer.concat([acc.tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const base = pos - acc.tail.length;
      let start = 0;
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
        readLine(acc, data.toString("utf8", start, i).trim(), base + start);
        start = i + 1;
      }
      acc.tail = Buffer.from(data.subarray(start));
      pos += bytesRead;
      // let the server breathe between big chunks (a first read can be tens of megabytes)
      await new Promise((r) => setImmediate(r));
    }
    acc.offset = pos;
  } finally {
    await fh.close();
  }
}

/** the screenshot on a transcript line, read again from the file when it's wanted */
async function imageAt(file: string, offset: number): Promise<{ data: Buffer; mime: string } | null> {
  const fh = await open(file, "r");
  try {
    const parts: Buffer[] = [];
    let pos = offset;
    for (;;) {
      const buf = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      parts.push(buf.subarray(0, nl === -1 ? bytesRead : nl));
      if (nl !== -1 || parts.length > 40) break;
      pos += bytesRead;
    }
    const j = JSON.parse(Buffer.concat(parts).toString("utf8")) as { message?: { content?: Array<{ content?: unknown }> } };
    let found: { data: Buffer; mime: string } | null = null;
    for (const c of j.message?.content ?? []) {
      if (!Array.isArray(c.content)) continue;
      for (const x of c.content as Array<{ type?: string; source?: { data?: string; media_type?: string } }>) {
        if (x.type === "image" && typeof x.source?.data === "string" && x.source.data.length >= MIN_IMAGE) found = { data: Buffer.from(x.source.data, "base64"), mime: x.source.media_type ?? "image/png" };
      }
    }
    return found;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// ---------- which project a folder belongs to ----------

const git = (args: string[], cwd: string, timeout = 5000) =>
  // git reads the checkout and needs nothing beyond the allowlist (it finds its settings in the home folder)
  execFileText("git", args, childOptions<ExecFileOptions>({ extras: [] }, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout })).then((r) => r.stdout);

/** a Claude worktree (`<repo>/.claude/worktrees/<name>`): the repository's folder and the worktree's name */
export function worktreeOf(cwd: string): { root: string; worktree: string } | null {
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/.exec(cwd);
  return m ? { root: m[1], worktree: m[2] } : null;
}

/** folders that are never a project: the temp folder, Foundation's own data */
export function ignoredFolder(cwd: string): boolean {
  const k = localKey(cwd);
  const under = (p: string) => {
    const b = localKey(p);
    return k === b || k.startsWith(`${b}/`);
  };
  return under(tmpdir()) || under(config.dataDir) || under(config.workDir);
}

const roots = new Map<string, Promise<{ root: string; worktree?: string }>>();
/** the project a session's folder belongs to: its git repository (worktrees fold into it), or the folder */
export function projectOf(cwd: string): Promise<{ root: string; worktree?: string }> {
  let p = roots.get(cwd);
  if (!p) {
    const wt = worktreeOf(cwd);
    p = wt
      ? Promise.resolve(wt)
      : !existsSync(cwd)
        ? Promise.resolve({ root: cwd })
        : git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], cwd, 3000)
            .then((out) => {
              const [common, top] = out.trim().split(/\r?\n/);
              const root = common && /[\\/]\.git$/.test(common) ? dirname(common) : top || cwd;
              const worktree = top && localKey(top) !== localKey(root) ? basename(top) : undefined;
              return { root: root.replace(/\//g, cwd.includes("\\") ? "\\" : "/"), worktree };
            })
            .catch(() => ({ root: cwd }));
    roots.set(cwd, p);
  }
  return p;
}

// ---------- git, and a dev server ----------

/** `git status --porcelain=v1 -b` → the branch, how far from upstream, and the changed files */
export function parseStatus(out: string): { branch: string; ahead: number; behind: number; dirty: number; files: LocalFile[] } {
  const lines = out.split(/\r?\n/).filter(Boolean);
  let branch = "";
  let ahead = 0;
  let behind = 0;
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  if (head) {
    branch = head.replace(/^No commits yet on /, "").split("...")[0].split(" ")[0];
    ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
    behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
  }
  const files = lines.map((l) => ({ status: l.slice(0, 2).trim() || "M", path: l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()! }));
  return { branch, ahead, behind, dirty: files.length, files: files.slice(0, 14) };
}

export function parseLog(out: string): LocalCommit[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split("\x1f"))
    .filter((p) => p.length >= 3)
    .map(([sha, subject, at]) => ({ sha, subject: short(subject, 90), at: Number(at) * 1000 || 0 }));
}

async function gitOf(root: string): Promise<LocalProject["git"]> {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const [st, log] = await Promise.all([git(["status", "--porcelain=v1", "-b", "--untracked-files=normal"], root), git(["log", "-5", "--format=%h%x1f%s%x1f%ct"], root).catch(() => "")]);
    return { ...parseStatus(st), commits: parseLog(log) };
  } catch {
    return undefined;
  }
}

/** knock on a port of this computer (a TCP connect, nothing sent) */
function answers(port: number, ms = 400): Promise<boolean> {
  return new Promise((done) => {
    const s = createConnection({ host: "127.0.0.1", port });
    const end = (ok: boolean) => (s.destroy(), done(ok));
    s.setTimeout(ms, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

/** the first dev server a project declares in `.claude/launch.json` (its launch configurations) */
async function serverOf(root: string): Promise<LocalProject["server"]> {
  try {
    const j = JSON.parse(await readFile(join(root, ".claude", "launch.json"), "utf8")) as { configurations?: Array<{ name?: string; port?: number }> };
    const c = (j.configurations ?? []).find((x) => Number.isInteger(x.port) && x.port! > 0 && x.port! < 65536);
    if (!c) return undefined;
    return { name: String(c.name ?? "dev"), port: c.port!, url: `http://localhost:${c.port}`, live: await answers(c.port!) };
  } catch {
    return undefined;
  }
}

// ---------- the watch ----------

const accs = new Map<string, SessionAcc>();
const gitCache = new Map<string, { at: number; moved: number; git: LocalProject["git"]; server: LocalProject["server"] }>();
const stored = new Map<string, string>(); // `${file}@${offset}` → file id
let timer: NodeJS.Timeout | null = null;
let scanning: Promise<unknown> | null = null;
let lastBeat = 0;

interface WatchRow {
  by_id: string;
  by_name: string;
  since: number;
  on_flag: number;
}
const row = () => one<WatchRow>("select by_id, by_name, since, on_flag from local_watch where id = 'this'");

/** the transcripts written in the last few days */
async function transcripts(): Promise<Array<{ id: string; file: string; size: number; mtime: number }>> {
  const dir = join(CLAUDE_HOME(), "projects");
  const since = Date.now() - DAYS() * 86_400_000;
  const out: Array<{ id: string; file: string; size: number; mtime: number }> = [];
  let folders: string[];
  try {
    folders = await readdir(dir);
  } catch {
    return out;
  }
  for (const f of folders) {
    let names: string[];
    try {
      names = await readdir(join(dir, f));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = join(dir, f, n);
      try {
        const s = await stat(file);
        if (s.isFile() && s.mtimeMs >= since) out.push({ id: n.slice(0, -6), file, size: s.size, mtime: s.mtimeMs });
      } catch {
        /* gone between the listing and the look */
      }
    }
  }
  return out;
}

function sessionOf(a: SessionAcc, worktree: string | undefined, now: number): LocalSession {
  return {
    id: a.id,
    title: a.title ?? a.named ?? a.firstPrompt ?? "Untitled session",
    source: a.entry === "claude-desktop" ? "claude-desktop" : "claude-cli",
    state: now - a.mtime < WORKING_MS ? "working" : "idle",
    at: Math.round(a.mtime),
    ...(a.branch ? { branch: a.branch } : {}),
    ...(worktree ? { worktree } : {}),
    ...(a.steps.length ? { steps: a.steps } : {}),
    ...(a.recap || a.lastPrompt ? { recap: a.recap ?? `Asked: ${a.lastPrompt}` } : {}),
    ...(a.pr ? { pr: a.pr } : {}),
    edits: a.edits.size,
  };
}

/** look once: read what's new, gather it by project, and write what changed into the grid */
export async function scanOnce(now = Date.now()): Promise<{ projects: LocalProject[]; note?: string }> {
  const w = row();
  const by = w?.by_id ?? "system";
  const files = await transcripts();
  const claude = files.length > 0;
  for (const f of files) {
    let a = accs.get(f.file);
    if (!a) accs.set(f.file, (a = newAcc(f.id, f.file)));
    if (a.offset !== f.size || a.mtime !== f.mtime) {
      try {
        await readNew(a, f.size, f.mtime);
      } catch {
        /* a transcript being rewritten: next time */
      }
    }
  }
  const seen = new Set(files.map((f) => f.file));
  for (const k of accs.keys()) if (!seen.has(k)) accs.delete(k);

  // by project
  const groups = new Map<string, { root: string; list: Array<{ a: SessionAcc; worktree?: string }> }>();
  for (const a of accs.values()) {
    if (!a.cwd || ignoredFolder(a.cwd)) continue;
    const p = await projectOf(a.cwd);
    if (ignoredFolder(p.root) || localKey(p.root) === localKey(homedir())) continue;
    const key = localKey(p.root);
    const g = groups.get(key) ?? { root: p.root, list: [] };
    g.list.push({ a, worktree: p.worktree });
    groups.set(key, g);
  }

  // T3 / Vision Code threads, by project name
  let t3 = false;
  let note: string | undefined;
  const t3ByName = new Map<string, LocalSession[]>();
  try {
    const r = await t3Threads(40);
    t3 = r.available;
    for (const t of r.threads) {
      const k = t.project.trim().toLowerCase();
      if (!k) continue;
      const list = t3ByName.get(k) ?? [];
      list.push({ id: t.id, title: short(t.title || "Untitled thread", 90), source: "t3", state: t.status === "running" ? "working" : t.status, at: t.updatedAt, edits: 0 });
      t3ByName.set(k, list);
    }
  } catch {
    /* T3 isn't here */
  }
  if (!claude) note = `No Claude Code sessions in the last ${DAYS()} days under ${join(CLAUDE_HOME(), "projects")}.`;

  const projects: LocalProject[] = [];
  const ranked = [...groups.entries()]
    .map(([key, g]) => ({ key, g, at: Math.max(...g.list.map((x) => x.a.mtime)) }))
    .sort((x, y) => y.at - x.at)
    .slice(0, MAX_PROJECTS);
  let gitOk = false;
  for (const { key, g, at } of ranked) {
    const name = basename(g.root) || g.root;
    const sessions = [...g.list.map((x) => sessionOf(x.a, x.worktree, now)), ...(t3ByName.get(name.toLowerCase()) ?? [])].sort((x, y) => y.at - x.at).slice(0, MAX_SESSIONS);
    const cached = gitCache.get(key);
    let gitNow = cached?.git;
    let server = cached?.server;
    if (!cached || cached.moved !== at || now - cached.at > 60_000) {
      [gitNow, server] = await Promise.all([gitOf(g.root), serverOf(g.root)]);
      gitCache.set(key, { at: now, moved: at, git: gitNow, server });
    }
    if (gitNow) gitOk = true;
    // the newest screenshot any of its sessions saw, kept in the archive once
    let preview: LocalProject["preview"];
    const shot = g.list.filter((x) => x.a.image).sort((x, y) => y.a.image!.at - x.a.image!.at)[0];
    if (shot) {
      const id = `${shot.a.file}@${shot.a.image!.offset}`;
      let fileId = stored.get(id);
      let mime = "image/png";
      if (!fileId) {
        const img = await imageAt(shot.a.file, shot.a.image!.offset);
        if (img) {
          mime = img.mime;
          const f = await storeFile(img.data, { name: `${name} · preview.${mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1]}`, mime, boardId: LOCAL_GRID_ID, userId: by, about: `A screenshot from a session on this computer, of ${name}` });
          fileId = f.id;
          stored.set(id, fileId);
        }
      }
      if (fileId) preview = { fileId, at: shot.a.image!.at, session: sessionOf(shot.a, shot.worktree, now).title, mime };
    }
    projects.push({
      key,
      name,
      path: g.root,
      ...(gitNow ? { git: gitNow } : {}),
      ...(server ? { server } : {}),
      ...(preview ? { preview } : {}),
      sessions,
      at: Math.round(Math.max(at, ...sessions.map((s) => s.at))),
      ...(existsSync(g.root) ? {} : { gone: true }),
    });
  }

  write(projects, { claude, t3, git: gitOk }, now, note);
  return { projects, note };
}

// ---------- the grid ----------

/** a project's section: one cell of a two-column grid, each holding the three cards */
export const LOCAL_COL_W = 1760;
export const LOCAL_ROW_H = 640;
const CARD: Record<LocalNode, { w: number; h: number; name: string }> = {
  preview: { w: 760, h: 500, name: "Preview" },
  progress: { w: 440, h: 500, name: "Progress" },
  changes: { w: 440, h: 500, name: "Changes" },
};

/** lay a section and its three cards for each project that has none yet; true when something was laid */
export function layOut(doc: Parameters<typeof boardMaps>[0], projects: LocalProject[]): boolean {
  const m = boardMaps(doc);
  const have = new Set<string>();
  for (const o of m.objects.values()) if (o.kind === "panel" && o.panel === "local" && o.source) have.add(o.source);
  const fresh = projects.filter((p) => !have.has(p.key));
  if (!fresh.length) return false;
  const taken = new Set([...m.sections.values()].filter((s) => !s.parent).map((s) => `${s.c0},${s.r0}`));
  const tracks = m.grid.get("tracks") ?? { cols: [] as number[], rows: [] as number[] };
  const cols = tracks.cols.length ? [...tracks.cols] : [LOCAL_COL_W, LOCAL_COL_W];
  const rows = [...tracks.rows];
  const names = new Set([...m.sections.values()].map((s) => s.name));
  let n = 0;
  for (const p of fresh) {
    while (taken.has(`${n % cols.length},${Math.floor(n / cols.length)}`)) n++;
    const c = n % cols.length;
    const r = Math.floor(n / cols.length);
    taken.add(`${c},${r}`);
    while (rows.length <= r) rows.push(LOCAL_ROW_H);
    const name = names.has(p.name) ? `${p.name} · ${basename(dirname(p.path)) || p.path}` : p.name;
    names.add(name);
    const sec: SectionDoc = { id: uid("sec"), name, c0: c, r0: r, c1: c, r1: r };
    m.sections.set(sec.id, sec);
    for (const node of LOCAL_NODES) {
      const card: PanelDoc = { id: uid("pnl"), kind: "panel", panel: "local", node, source: p.key, sectionId: sec.id, name: CARD[node].name, x: 0, y: 0, float: false, bornAt: Date.now(), w: CARD[node].w, h: CARD[node].h, ports: [], createdBy: "This computer" };
      m.objects.set(card.id, card);
    }
  }
  m.grid.set("tracks", { cols, rows });
  return true;
}

/** a project without the moving parts, to tell whether it changed */
const sameProject = (a: LocalProject | undefined, b: LocalProject) => !!a && JSON.stringify(a) === JSON.stringify(b);

function write(projects: LocalProject[], sources: LocalWatch["sources"], now: number, note?: string) {
  const w = row();
  if (!w) return;
  const board = getBoard(LOCAL_GRID_ID);
  const m = boardMaps(board.doc);
  const changed = projects.filter((p) => !sameProject(m.local.get(p.key), p));
  const before = m.localWatch.get("state");
  const watch: LocalWatch = {
    by: w.by_id,
    byName: w.by_name,
    since: w.since,
    on: w.on_flag === 1,
    scannedAt: now,
    every: SCAN_MS(),
    projects: projects.length,
    working: projects.reduce((n, p) => n + p.sessions.filter((s) => s.state === "working").length, 0),
    sources,
    ...(note ? { note } : {}),
  };
  const watchMoved = !before || before.on !== watch.on || before.projects !== watch.projects || before.working !== watch.working || before.note !== watch.note || JSON.stringify(before.sources) !== JSON.stringify(watch.sources);
  const needsLayout = projects.some((p) => ![...m.objects.values()].some((o) => o.kind === "panel" && o.panel === "local" && o.source === p.key));
  if (!changed.length && !watchMoved && !needsLayout && now - lastBeat < HEARTBEAT_MS) return;
  lastBeat = now;
  editBoard(LOCAL_GRID_ID, "local", (doc) => {
    for (const p of changed) m.local.set(p.key, p);
    m.localWatch.set("state", watch);
    if (layOut(doc, projects)) logActivity(doc, { who: LOCAL_GRID_NAME, role: "system", text: `laid out ${projects.length} project${projects.length === 1 ? "" : "s"} being built on this computer` });
  });
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, SCAN_MS());
  timer.unref?.();
}

function tick() {
  if (row()?.on_flag !== 1) return;
  if (!scanning) {
    scanning = scanOnce()
      .catch((e: Error) => console.warn(`[local] couldn't look: ${e.message}`))
      .finally(() => {
        scanning = null;
      });
  }
  schedule();
}

/** where the watch stands, for anyone who can see the grid */
export function localStatus(user: UserInfo, person: boolean) {
  const w = row();
  const state = w ? boardMaps(getBoard(LOCAL_GRID_ID).doc).localWatch.get("state") ?? null : null;
  return { grid: LOCAL_GRID_ID, connected: !!w, on: w?.on_flag === 1, by: w?.by_name ?? null, watch: state, canConnect: user.role === "admin" && person };
}

/** an admin, in person, connects this computer: the grid is made (members-only, theirs) and the watch starts */
export async function connectLocal(user: UserInfo, person: boolean) {
  if (user.role !== "admin") throw new HttpError(403, "Only an admin can connect this computer: its sessions are someone's conversations.");
  if (!person) throw new HttpError(403, "Connecting this computer needs a person, from their own browser.");
  ensureBoardRow(LOCAL_GRID_ID, LOCAL_GRID_NAME);
  // a grid opened by its id before it was connected (a tab kept on a device) has a row named after its id
  run("update boards set name = ? where id = ? and name = ?", LOCAL_GRID_NAME, LOCAL_GRID_ID, LOCAL_GRID_ID);
  setMember(LOCAL_GRID_ID, user.id, "owner", "local");
  const w = row();
  if (w) run("update local_watch set on_flag = 1 where id = 'this'");
  else run("insert into local_watch (id, by_id, by_name, since, on_flag) values ('this', ?, ?, ?, 1)", user.id, user.name, Date.now());
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, board_id: LOCAL_GRID_ID, door: "route", action: "local.connect", target: CLAUDE_HOME(), decision: "allowed", result: "ok" });
  lastBeat = 0;
  // the first look reads days of transcripts (seconds): it runs on, and the grid fills as it lands
  if (!scanning) scanning = scanOnce().catch((e: Error) => console.warn(`[local] couldn't look: ${e.message}`)).finally(() => (scanning = null));
  schedule();
  return localStatus(user, person);
}

/** stop watching: the grid stays as it was and says it stopped */
export function stopLocal(user: UserInfo, person: boolean) {
  if (user.role !== "admin" || !person) throw new HttpError(403, "Only an admin, in person, stops watching this computer.");
  run("update local_watch set on_flag = 0 where id = 'this'");
  if (timer) clearTimeout(timer);
  timer = null;
  const board = getBoard(LOCAL_GRID_ID);
  const st = boardMaps(board.doc).localWatch.get("state");
  if (st) editBoard(LOCAL_GRID_ID, "local", (doc) => boardMaps(doc).localWatch.set("state", { ...st, on: false }));
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, board_id: LOCAL_GRID_ID, door: "route", action: "local.stop", target: CLAUDE_HOME(), decision: "allowed", result: "ok" });
  return localStatus(user, person);
}

/** at boot: carry on a watch a person started and didn't stop */
export function resumeLocal() {
  if (row()?.on_flag === 1) {
    timer = setTimeout(tick, 2000);
    timer.unref?.();
  }
}

/** for tests: forget what was read */
export function resetLocal() {
  accs.clear();
  gitCache.clear();
  stored.clear();
  roots.clear();
  lastBeat = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** the look under way, if one is (tests wait on it) */
export const localScanning = () => scanning;
