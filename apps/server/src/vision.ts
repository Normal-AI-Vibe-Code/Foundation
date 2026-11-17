/**
 * The Vision loop (Phase 2): a design brief on the board becomes a Vision
 * Code (T3) thread, what the thread makes comes back as file cards beside the
 * brief, and the reviewers are asked once it has.
 *
 * Starting a thread: T3's own pattern, the one its `project` CLI uses — mint
 * a short-lived session (`t3 auth session issue --ttl 10m --label …`), use it
 * for this one hand-off over T3's WebSocket API (orchestration.dispatchCommand
 * `thread.turn.start`, as Vision's Code hand-off does), then revoke it.
 * Nothing is stored; T3 lists the session while it lives.
 *
 * A thread runs a model on the person's plan, so it starts only when a person
 * presses Run on the hand-off card (jobs.ts), and it starts Supervised: every
 * tool call that changes something waits for approval in Vision Code.
 *
 * Coming back: each hand-off has a folder (BRIEF.md, exports/). The thread is
 * told to put its deliverables in exports/; Foundation watches that folder,
 * archives what lands (searchable, never deleted) and puts it on the board.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { boardMaps, logActivity, uid, type MediaDoc, type PanelDoc } from "@foundation/protocol";
import { config } from "./config.ts";
import { all, one, run } from "./db.ts";
import { editBoard } from "./boards.ts";
import { storeFile, isCad } from "./files.ts";
import { t3Thread } from "./t3.ts";
import { addressSaid, findT3Cli, findT3Home, notFoundMessage, t3Command, t3Url } from "./t3paths.ts";
import { imageSize } from "./construct.ts";

const HANDOFFS = () => join(config.dataDir, "handoffs");

/** T3's provider for a Claude thread (Vision's own defaults, handoff.ts) */
const PROVIDER = { instanceId: "claudeAgent", model: process.env.T3_MODEL ?? "claude-fable-5-1" };

// ---------- a session for one hand-off ----------

/**
 * Where Vision Code's CLI and home are (t3paths.ts), or why not: the message
 * a person sees on the hand-off card names every place looked and what to set.
 */
export function t3Where(): { cli: string; home: string } {
  const cli = findT3Cli();
  const home = findT3Home();
  if (!cli.found || !home.found) throw new Error(notFoundMessage(cli, home));
  return { cli: cli.found, home: home.found };
}

function cli(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    let where: { cli: string; home: string };
    let cmd: string;
    let pre: string[];
    try {
      where = t3Where();
      ({ cmd, pre } = t3Command(where.cli));
    } catch (e) {
      return fail(e as Error);
    }
    // no shell: the arguments go to the program as they are
    const child = spawn(cmd, [...pre, ...args, "--base-dir", where.home, "--log-level", "error"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b));
    child.stderr.on("data", (b: Buffer) => (err += b));
    child.on("error", (e) => fail(new Error(`Vision Code's CLI at ${where.cli} wouldn't start (${e.message}). If it lives elsewhere, set T3_CLI to its t3 program (t3.exe on Windows) where Foundation's server starts.`)));
    child.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`t3 ${args.slice(0, 3).join(" ")} failed: ${(err || out).slice(-400)}`))));
  });
}

async function withSession<T>(use: (token: string) => Promise<T>): Promise<T> {
  const issued = JSON.parse(await cli(["auth", "session", "issue", "--ttl", "10m", "--label", "Foundation hand-off", "--json"])) as { sessionId: string; token: string };
  try {
    return await use(issued.token);
  } finally {
    await cli(["auth", "session", "revoke", issued.sessionId]).catch(() => {});
  }
}

// ---------- T3's RPC over WebSocket (the protocol Vision's code/rpc.ts speaks) ----------

class Rpc {
  private next = 1;
  private waiting = new Map<string, { ok(v: unknown): void; fail(e: Error): void; chunk?(values: unknown[]): boolean }>();
  private constructor(private ws: WebSocket) {
    ws.on("message", (data) => this.receive(String(data)));
    ws.on("close", () => {
      for (const w of this.waiting.values()) w.fail(new Error("Vision Code closed the connection"));
      this.waiting.clear();
    });
  }

  /** `base` is the address in use, so a failure names it (and where it came from) */
  static open(token: string, base: string): Promise<Rpc> {
    const url = `${base.replace(/^http/, "ws")}/ws?orchestrationProtocol=1&clientSurface=desktop`;
    const where = () => `Vision Code at ${addressSaid()}`;
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      const t = setTimeout(() => (ws.terminate(), fail(new Error(`${where()} didn't answer. If it's somewhere else, set T3_URL for Foundation's server.`))), 8000);
      ws.on("open", () => (clearTimeout(t), ok(new Rpc(ws))));
      ws.on("error", (e) => (clearTimeout(t), fail(new Error(`${where()} refused the connection (${e.message}). If it's somewhere else, set T3_URL for Foundation's server.`))));
    });
  }

  private send(msg: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private receive(data: string) {
    let msg: { _tag?: string; requestId?: string; values?: unknown[]; exit?: { _tag: string; value?: unknown } };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg._tag === "Ping") return this.send({ _tag: "Pong" });
    const w = msg.requestId ? this.waiting.get(msg.requestId) : undefined;
    if (!w) return;
    if (msg._tag === "Chunk") {
      if (w.chunk?.(msg.values ?? [])) {
        this.waiting.delete(msg.requestId!);
        this.send({ _tag: "Interrupt", requestId: msg.requestId });
        w.ok(null);
      } else this.send({ _tag: "Ack", requestId: msg.requestId });
      return;
    }
    if (msg.exit) {
      this.waiting.delete(msg.requestId!);
      if (msg.exit._tag === "Success") w.ok(msg.exit.value);
      else w.fail(new Error(describe(msg.exit)));
    }
  }

  call(tag: string, payload: unknown, chunk?: (values: unknown[]) => boolean, ms = 15_000): Promise<unknown> {
    const id = String(this.next++);
    return new Promise((ok, fail) => {
      const t = setTimeout(() => (this.waiting.delete(id), fail(new Error(`Vision Code didn't answer ${tag}`))), ms);
      this.waiting.set(id, { ok: (v) => (clearTimeout(t), ok(v)), fail: (e) => (clearTimeout(t), fail(e)), chunk });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  close() {
    this.ws.close();
  }
}

function describe(exit: unknown) {
  const s = JSON.stringify(exit);
  const m = s.match(/"message":"([^"]{1,300})"/) ?? s.match(/"detail":"([^"]{1,300})"/);
  return m ? m[1] : s.slice(0, 300);
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** a live project with this root, anywhere in a shell snapshot (its exact shape isn't pinned) */
export function findProject(value: unknown, root: string): string | null {
  const want = norm(root);
  let found: string | null = null;
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.workspaceRoot === "string" && typeof o.id === "string" && norm(o.workspaceRoot) === want && !o.deletedAt) {
      found = o.id;
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(value, 0);
  return found;
}

/** the commands Vision's handoff.ts sends, for a Supervised Claude thread */
export function turnStart(threadId: string, projectId: string, title: string, text: string, at = new Date().toISOString()) {
  const modelSelection = { instanceId: PROVIDER.instanceId, model: PROVIDER.model };
  return {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    modelSelection,
    titleSeed: title,
    runtimeMode: "approval-required",
    interactionMode: "default",
    bootstrap: { createThread: { projectId, title, modelSelection, runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null, createdAt: at } },
    createdAt: at,
  };
}

async function environmentId(base: string): Promise<string | null> {
  try {
    const r = await fetch(`${base}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) });
    return ((await r.json()) as { environmentId?: string }).environmentId ?? null;
  } catch {
    return null;
  }
}

/** start a Supervised Vision Code thread working in `folder` (a subfolder of the hand-offs project) */
export async function startThread(folder: string, title: string, text: string): Promise<{ threadId: string; url: string | null }> {
  const root = HANDOFFS();
  return withSession(async (token) => {
    const base = t3Url(); // one address for the whole hand-off
    const rpc = await Rpc.open(token, base);
    try {
      let projectId: string | null = null;
      await rpc
        .call("orchestration.subscribeShell", {}, (values) => {
          for (const v of values) projectId ??= findProject(v, root);
          return true; // the first snapshot is enough
        }, 8000)
        .catch(() => {});
      if (!projectId) {
        projectId = randomUUID();
        await rpc.call("orchestration.dispatchCommand", { type: "project.create", commandId: randomUUID(), projectId, title: "Foundation hand-offs", workspaceRoot: root, createWorkspaceRootIfMissing: true, createdAt: new Date().toISOString() });
      }
      const threadId = randomUUID();
      await rpc.call("orchestration.dispatchCommand", turnStart(threadId, projectId, title, text));
      const env = await environmentId(base);
      void folder;
      return { threadId, url: env ? `${base}/${env}/${threadId}` : null };
    } finally {
      rpc.close();
    }
  });
}

// ---------- hand-offs ----------

export interface Handoff {
  id: string; // the job id
  board_id: string;
  section_id: string | null;
  brief_note: string | null;
  title: string;
  folder: string;
  thread_id: string | null;
  thread_url: string | null;
  reviewers_json: string;
  seen_json: string;
  reviewed: number;
  status: "queued" | "running" | "done" | "error";
  created_by: string;
  created_at: number;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "brief";

/** the text the thread starts with: the brief, and where its work goes */
export function handoffPrompt(title: string, brief: string, dir: string) {
  return `Design hand-off from Foundation (the company board): **${title}**.

The brief is in ./${dir}/BRIEF.md (also below). Work on it with Vision's tools.

Put everything you make for the team in ./${dir}/exports/ — renders and images, CAD (STEP/STL), results (CSV/JSON), and a short REPORT.md saying what you did, what you found, and what you'd do next. Foundation brings whatever lands in that folder back to the board beside the brief, and asks the reviewers once it has.

---

${brief}`;
}

/** a hand-off waiting for a person to press Run (the agent can't start a model run on its own) */
export function queueHandoff(h: { jobId: string; boardId: string; sectionId: string | null; briefNote: string | null; title: string; brief: string; reviewers: string[]; by: string }) {
  const dir = `${slug(h.title)}-${h.jobId.slice(-6)}`;
  const folder = join(HANDOFFS(), dir);
  mkdirSync(join(folder, "exports"), { recursive: true });
  writeFileSync(join(folder, "BRIEF.md"), `# ${h.title}\n\n${h.brief}\n`);
  run(
    "insert into vision_handoffs (id, board_id, section_id, brief_note, title, folder, reviewers_json, status, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
    h.jobId, h.boardId, h.sectionId, h.briefNote, h.title, dir, JSON.stringify(h.reviewers), h.by, Date.now(),
  );
}

export function getHandoff(id: string) {
  return one<Handoff>("select * from vision_handoffs where id = ?", id);
}

/** a person pressed Run: start the thread */
export async function startHandoff(id: string): Promise<Handoff> {
  const h = getHandoff(id);
  if (!h) throw new Error("no such hand-off");
  if (h.thread_id) return h;
  const brief = readFileSync(join(HANDOFFS(), h.folder, "BRIEF.md"), "utf8");
  const t = await startThread(h.folder, `Foundation · ${h.title}`, handoffPrompt(h.title, brief, h.folder));
  run("update vision_handoffs set thread_id = ?, thread_url = ?, status = 'running' where id = ?", t.threadId, t.url, id);
  return getHandoff(id)!;
}

// ---------- coming back ----------

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
  ".step": "model/step", ".stp": "model/step", ".stl": "model/stl", ".obj": "model/obj", ".glb": "model/gltf-binary",
};

/** what's new in a hand-off's exports/, archived and put on the board beside its brief */
export async function collectExports(h: Handoff): Promise<string[]> {
  const dir = join(HANDOFFS(), h.folder, "exports");
  if (!existsSync(dir)) return [];
  const seen = new Set<string>(JSON.parse(h.seen_json || "[]"));
  const fresh: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (name.startsWith(".") || !statSync(path).isFile()) continue;
    const key = `${name}:${statSync(path).size}:${statSync(path).mtimeMs}`;
    if (seen.has(key)) continue;
    // a file still being written: wait a beat for its size to settle
    if (Date.now() - statSync(path).mtimeMs < 1500) continue;
    seen.add(key);
    const ext = extname(name).toLowerCase();
    const body = readFileSync(path);
    const file = await storeFile(body, { name, mime: MIME[ext] ?? "application/octet-stream", boardId: h.board_id, userId: h.created_by, about: `from Vision Code for ${h.title}` });
    editBoard(h.board_id, "vision", (doc) => {
      const m = boardMaps(doc);
      const sectionId = h.section_id && m.sections.get(h.section_id) ? h.section_id : [...m.sections.keys()][0];
      const base = { sectionId, x: 0, y: 0, float: false, bornAt: Date.now() };
      if (IMAGE_EXT.has(ext)) {
        const size = imageSize(body) ?? { w: 4, h: 3 };
        const w = 440;
        const card: MediaDoc = { ...base, id: uid("media"), kind: "media", name: `${name} · Vision`, w, h: Math.round((w * size.h) / size.w), src: `/files/${file.id}`, media: "image", autoplay: false, muted: true };
        m.objects.set(card.id, card);
      } else {
        const card: PanelDoc = { ...base, id: uid("pnl"), kind: "panel", panel: "file", name, w: isCad(name) ? 460 : 420, h: isCad(name) ? 380 : 340, fileId: file.id, mime: file.mime, ports: [], createdBy: "Vision Code" };
        m.objects.set(card.id, card);
      }
      logActivity(doc, { who: "Vision Code", role: "agent", text: `sent back ${name} for “${h.title}”` });
    });
    fresh.push(name);
  }
  run("update vision_handoffs set seen_json = ? where id = ?", JSON.stringify([...seen]), h.id);
  return fresh;
}

type Ask = (h: Handoff, reviewer: string) => void;

/**
 * One pass over the running hand-offs: bring back new exports; once the
 * thread has settled with something to show, ask the reviewers (once).
 */
export async function pollHandoffs(ask: Ask, threadStatus: (threadId: string) => Promise<string | null> = defaultStatus) {
  for (const h of all<Handoff>("select * from vision_handoffs where status = 'running'")) {
    try {
      const fresh = await collectExports(h);
      const status = h.thread_id ? await threadStatus(h.thread_id) : null;
      const sent = JSON.parse(getHandoff(h.id)!.seen_json || "[]").length;
      if (!h.reviewed && sent > 0 && status !== "running") {
        for (const r of JSON.parse(h.reviewers_json) as string[]) ask(h, r);
        run("update vision_handoffs set reviewed = 1, status = 'done' where id = ?", h.id);
      }
      void fresh;
    } catch (e) {
      console.error(`vision hand-off ${h.id}:`, (e as Error).message);
    }
  }
}

async function defaultStatus(threadId: string) {
  return (await t3Thread(threadId))?.thread.status ?? null;
}
