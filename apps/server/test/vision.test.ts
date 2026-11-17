/**
 * The Vision loop (Phase 2), against a stand-in Vision Code: a fake `t3` CLI
 * that mints and revokes sessions (and records that it did), and a fake T3
 * WebSocket speaking its RPC. A brief becomes a hand-off a person starts;
 * the thread starts Supervised with the brief and where to put its work; the
 * session is revoked; exports come back as cards; reviewers are asked once.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { png } from "./fixtures/png.ts";

const dir = mkdtempSync(join(tmpdir(), "foundation-test-"));
process.env.FOUNDATION_DATA_DIR = dir;
const log = join(dir, "t3-cli.log");
const cliPath = join(dir, "t3.cjs");
writeFileSync(
  cliPath,
  `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "auth" && process.argv[4] === "issue") console.log(JSON.stringify({ sessionId: "ses-1", token: "tok-1" }));
`,
);
chmodSync(cliPath, 0o755);
process.env.T3_CLI = cliPath;
process.env.T3CODE_HOME = join(dir, "t3home");

let http: Server;
let wss: WebSocketServer;
const commands: Array<Record<string, unknown>> = [];
const auth: string[] = [];
let shellProjects: Array<{ id: string; workspaceRoot: string }> = [];

before(async () => {
  http = createServer((req, res) => {
    if (req.url === "/.well-known/t3/environment") return res.end(JSON.stringify({ environmentId: "env-1" }));
    res.writeHead(404).end();
  });
  wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws, req) => {
    auth.push(String(req.headers.authorization));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { _tag: string; id: string; tag: string; payload: Record<string, unknown> };
      if (m._tag !== "Request") return;
      if (m.tag === "orchestration.subscribeShell") return ws.send(JSON.stringify({ _tag: "Chunk", requestId: m.id, values: [{ projects: shellProjects }] }));
      if (m.tag === "orchestration.dispatchCommand") {
        commands.push(m.payload);
        if (m.payload.type === "project.create") shellProjects.push({ id: String(m.payload.projectId), workspaceRoot: String(m.payload.workspaceRoot) });
        return ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Success", value: null } }));
      }
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  process.env.T3_URL = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(() => {
  wss.close();
  http.close();
});

const { runTool } = await import("../src/tools.ts");
const { getJob, startJob } = await import("../src/jobs.ts");
const { getHandoff, pollHandoffs, turnStart, findProject } = await import("../src/vision.ts");
const { getBoard, closeBoards } = await import("../src/boards.ts");
const { run } = await import("../src/db.ts");
const { boardMaps, appendSection } = await import("@foundation/protocol");
after(() => closeBoards());

run("insert or ignore into users (id, email, name, color, role, created_at) values ('u', 'u@formindustries.com', 'Ada', '#325bb4', 'member', 0)");
const ctx = { boardId: "vis", actor: "Ada", userId: "u" };
const asked: Array<[string, string]> = [];
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("a thread starts Supervised, on Claude, with the brief as its first message", () => {
  const c = turnStart("t1", "p1", "Fan", "hello") as unknown as { runtimeMode: string; message: { text: string }; bootstrap: { createThread: { projectId: string; runtimeMode: string } } };
  assert.equal(c.runtimeMode, "approval-required");
  assert.equal(c.bootstrap.createThread.runtimeMode, "approval-required");
  assert.equal(c.bootstrap.createThread.projectId, "p1");
  assert.equal(c.message.text, "hello");
  assert.equal(findProject({ deep: [{ id: "x", workspaceRoot: "/A/B/" }] }, "/a/b"), "x");
});

test("vision_brief writes the brief and a hand-off that waits for a person; nobody is asked yet", async () => {
  const doc = getBoard("vis").doc;
  doc.transact(() => appendSection(doc, "Design"));
  const out = (await runTool(ctx, "vision_brief", { title: "Quieter rim fan", goal: "-3 dB at the same flow", simulate: "CFD at 1200 rpm", reviewers: ["kai@formindustries.com"], section: "Design" })) as { handoff: string };
  const card = boardMaps(doc).objects.get(out.handoff) as { sessionId: string; panel: string };
  assert.equal(card.panel, "agent");
  const h = getHandoff(card.sessionId)!;
  assert.equal(h.status, "queued");
  assert.match(readFileSync(join(dir, "handoffs", h.folder, "BRIEF.md"), "utf8"), /-3 dB at the same flow/);
  assert.ok(existsSync(join(dir, "handoffs", h.folder, "exports")));
  const asks = [...boardMaps(doc).objects.values()].filter((o) => o.kind === "panel" && o.panel === "ask");
  assert.equal(asks.length, 0, "reviewers are asked when results come back, not before");
  assert.equal(commands.length, 0, "nothing started on its own");
});

test("Run starts the thread with a short-lived session that's revoked after; exports come back; reviewers asked once", async () => {
  const doc = getBoard("vis").doc;
  const jobId = getHandoff([...boardMaps(doc).objects.values()].map((o) => (o as { sessionId?: string }).sessionId).find(Boolean)!)!.id;
  startJob(jobId, "vis", "Ada");
  await until(() => !!getHandoff(jobId)?.thread_id);
  const h = getHandoff(jobId)!;

  // T3's own pattern: issue a labelled, expiring session; use it as a bearer; revoke it
  const calls = readFileSync(log, "utf8");
  assert.match(calls, /auth session issue --ttl 10m --label Foundation hand-off --json/);
  assert.match(calls, /auth session revoke ses-1/);
  assert.deepEqual(auth, ["Bearer tok-1"]);
  // the project (made once) and the thread, Supervised, told where its work goes
  assert.equal(commands[0].type, "project.create");
  const start = commands[1] as { type: string; runtimeMode: string; message: { text: string } };
  assert.equal(start.type, "thread.turn.start");
  assert.equal(start.runtimeMode, "approval-required");
  assert.match(start.message.text, new RegExp(`\\./${h.folder}/exports/`));
  assert.match(start.message.text, /-3 dB at the same flow/);
  assert.equal(h.thread_url, `${process.env.T3_URL}/env-1/${h.thread_id}`);
  assert.equal(getJob(jobId)!.status, "running");

  // Vision writes its work into exports/ (written a moment ago so the size has settled)
  const ex = join(dir, "handoffs", h.folder, "exports");
  writeFileSync(join(ex, "render.png"), png(64, 48, [50, 91, 180]));
  writeFileSync(join(ex, "REPORT.md"), "# Rim fan\n\nCFD says -2.6 dB.");
  writeFileSync(join(ex, "fan.step"), "ISO-10303-21;\nHEADER;\nFILE_NAME('fan.step');\nENDSEC;\n");
  const past = new Date(Date.now() - 5000);
  for (const f of ["render.png", "REPORT.md", "fan.step"]) (await import("node:fs")).utimesSync(join(ex, f), past, past);

  // the thread is still running: the work comes back, nobody is asked yet
  await pollHandoffs((hh, r) => asked.push([hh.title, r]), async () => "running");
  const m = boardMaps(doc);
  const back = [...m.objects.values()].filter((o) => o.sectionId === h.section_id && (o.kind === "media" || (o.kind === "panel" && o.panel === "file")));
  assert.deepEqual(back.map((o) => o.name).sort(), ["REPORT.md", "fan.step", "render.png · Vision"]);
  const img = back.find((o) => o.kind === "media") as { w: number; h: number };
  assert.equal(Math.round((img.w / img.h) * 100), Math.round((64 / 48) * 100), "the render keeps its shape");
  assert.equal(asked.length, 0);

  // it settles: the reviewers are asked, once
  await pollHandoffs((hh, r) => asked.push([hh.title, r]), async () => "idle");
  await pollHandoffs((hh, r) => asked.push([hh.title, r]), async () => "idle");
  assert.deepEqual(asked, [["Quieter rim fan", "kai@formindustries.com"]]);
  assert.equal(getHandoff(jobId)!.status, "done");
});

/** a fresh hand-off, Run pressed, and the card once it has failed */
async function runFails(title: string) {
  const doc = getBoard("vis").doc;
  const out = (await runTool(ctx, "vision_brief", { title, goal: "g", reviewers: [], section: "Design" })) as { handoff: string };
  const jobId = (boardMaps(doc).objects.get(out.handoff) as { sessionId: string }).sessionId;
  const before = commands.length;
  startJob(jobId, "vis", "Ada");
  await until(() => getJob(jobId)?.status === "error");
  assert.equal(commands.length, before, "Vision Code was never reached");
  return boardMaps(doc).objects.get(out.handoff) as { status: string; text: string };
}

test("T3_CLI wins even when it's wrong: the card says it wouldn't start and what to set", async () => {
  const keep = process.env.T3_CLI;
  process.env.T3_CLI = join(dir, "no-such-t3.exe");
  try {
    const card = await runFails("Wrong CLI");
    assert.equal(card.status, "error");
    assert.match(card.text, /Couldn't start Vision Code: Vision Code's CLI at .*no-such-t3\.exe wouldn't start/);
    assert.match(card.text, /set T3_CLI/);
  } finally {
    process.env.T3_CLI = keep;
  }
});

test("no Vision Code on this computer: Run's card lists where it looked and the env vars to set", async () => {
  const empty = mkdtempSync(join(tmpdir(), "no-vision-"));
  const names = ["T3_CLI", "T3CODE_HOME", "VISION_CODE_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "SystemDrive", "XDG_DATA_HOME", "PATH"];
  const keep = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  for (const k of ["T3_CLI", "T3CODE_HOME", "VISION_CODE_HOME", "XDG_DATA_HOME"]) delete process.env[k];
  for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "SystemDrive", "PATH"]) process.env[k] = empty;
  try {
    const card = await runFails("Nowhere");
    assert.match(card.text, /Vision Code's CLI isn't on this computer. Looked for:/);
    assert.match(card.text, /code-server/);
    assert.ok(card.text.includes(empty), "the paths tried are the ones under this (empty) home");
    assert.match(card.text, /t3 on PATH/);
    assert.match(card.text, /Vision Code's threads aren't on this computer/);
    assert.match(card.text, /T3_CLI.*T3CODE_HOME.*T3_URL/s);
  } finally {
    for (const [k, v] of Object.entries(keep)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test("no T3_URL: the hand-off goes where Vision Code's server-runtime.json says, and links there", async () => {
  // T3CODE_HOME stays pinned to this test's folder, so only this file is read, never the real one
  const standIn = process.env.T3_URL!;
  const runtime = join(process.env.T3CODE_HOME!, "userdata", "server-runtime.json");
  (await import("node:fs")).mkdirSync(join(process.env.T3CODE_HOME!, "userdata"), { recursive: true });
  writeFileSync(runtime, JSON.stringify({ version: 1, pid: 1, host: "127.0.0.1", port: Number(new URL(standIn).port), origin: standIn, startedAt: new Date().toISOString() }));
  delete process.env.T3_URL;
  try {
    const doc = getBoard("vis").doc;
    const out = (await runTool(ctx, "vision_brief", { title: "Moved port", goal: "g", reviewers: [], section: "Design" })) as { handoff: string };
    const jobId = (boardMaps(doc).objects.get(out.handoff) as { sessionId: string }).sessionId;
    const before = commands.length;
    startJob(jobId, "vis", "Ada");
    await until(() => !!getHandoff(jobId)?.thread_id || getJob(jobId)?.status === "error");
    assert.equal(getJob(jobId)!.status, "running", getJob(jobId)!.output ?? "");
    assert.equal(commands.at(-1)!.type, "thread.turn.start");
    assert.ok(commands.length > before, "the stand-in named by the file got the thread");
    assert.equal(getHandoff(jobId)!.thread_url, `${standIn}/env-1/${getHandoff(jobId)!.thread_id}`);
  } finally {
    process.env.T3_URL = standIn;
    (await import("node:fs")).rmSync(runtime, { force: true });
  }
});
