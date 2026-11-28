/**
 * The council's conversation, kept (council.ts; plan council-replies-in-panel).
 *
 *  - a line is kept per grid and place, oldest first, with who it went to; twice with one request_id is once;
 *  - each agent's answer comes back with the line, by the timeline's rule: everyone on the grid reads it when
 *    the run read only the grid; one that read beyond it is its person's alone, and others are told why;
 *  - a line can't be pointed at someone else's run: a session counts only for runs its author started here;
 *  - over HTTP, who said it is the session's (a name in the request is ignored) and a viewer reads but can't say.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.FOUNDATION_DATA_DIR = mkdtempSync(join(tmpdir(), "foundation-council-"));
process.env.FOUNDATION_ADMIN_EMAILS = "boss@formindustries.com";
process.env.FOUNDATION_AGENT_SCRIPT = "1";
process.env.FOUNDATION_SCRIPT_STEP_MS = "5";
process.env.FOUNDATION_CREW_TRAVEL_MS = "0";
process.env.FOUNDATION_STARTER_DIR = "";

const { upsertUser } = await import("../src/auth.ts");
const { createBoardRow, closeBoards, editBoard } = await import("../src/boards.ts");
const { startRun, followRun } = await import("../src/agent.ts");
const { _resetCrew } = await import("../src/crew.ts");
const timeline = await import("../src/timeline.ts");
const { addCouncilLine, councilLines } = await import("../src/council.ts");
const { appendSection } = await import("@foundation/protocol");

const ada = upsertUser("ada@formindustries.com", "Ada Lovelace");
const kai = upsertUser("kai@formindustries.com", "Kai Moreno");

const finish = (r: ReturnType<typeof startRun>, userId: string) => new Promise<void>((done) => followRun(r.id, userId, () => undefined, () => done()));

function grid(name: string) {
  const id = createBoardRow(name);
  const section = editBoard(id, "test", (doc) => appendSection(doc, "Design").id);
  return { id, section };
}

test("a line said to a council is kept with each agent's answer, and an answer that read beyond the grid is its person's alone", async () => {
  const g = grid("Council grid");
  // Ada says one line to two of the grid's agents: one run reads only the grid, the other reads beyond it ([private])
  const line = addCouncilLine(g.id, ada, { place: "board", text: "Lay out the supply section", to: [{ name: "Wren", session: "ses_wren" }, { name: "Pip", session: "ses_pip" }, { name: "Vision", }], all: true, request_id: "r1" });
  assert.equal(line.replies.length, 3);
  assert.deepEqual(line.replies.map((r) => r.state), ["waiting", "waiting", "elsewhere"], "before the runs: waiting; an agent with its own thread answers there");

  const open = startRun({ boardId: g.id, user: ada, prompt: "Make a section called “Supply” with the parts", section: g.section, session: "ses_wren" });
  const closed = startRun({ boardId: g.id, user: ada, prompt: "Make a section called “Quiet” [private]", section: g.section, session: "ses_pip" });
  await finish(open, ada.id);
  await finish(closed, ada.id);
  timeline.flushTimeline();

  const forAda = councilLines(g.id, "board", ada);
  assert.equal(forAda.length, 1);
  const [wren, pip, vision] = forAda[0].replies;
  assert.equal(forAda[0].by, "Ada Lovelace");
  assert.equal(forAda[0].mine, true);
  assert.equal(wren.state, "answered");
  assert.ok((wren.text ?? "").length > 0, "Wren's answer is there");
  assert.equal(pip.state, "answered");
  assert.ok((pip.text ?? "").length > 0, "its person reads the answer that read beyond the grid");
  assert.equal(vision.state, "elsewhere");
  assert.equal(wren.session, "ses_wren", "its author can open the session");

  const forKai = councilLines(g.id, "board", kai)[0];
  assert.equal(forKai.mine, false);
  assert.equal(forKai.text, "Lay out the supply section", "the line is the grid's: its author could change the grid");
  assert.equal(forKai.replies[0].text, wren.text, "an answer that read only the grid is everyone's");
  assert.equal(forKai.replies[1].text, undefined);
  assert.match(forKai.replies[1].withheld ?? "", /beyond the grid/);
  assert.equal(forKai.replies[0].session, undefined, "someone else's session isn't handed out");

  // twice with one request_id is once; another place is its own conversation
  addCouncilLine(g.id, ada, { place: "board", text: "Lay out the supply section", to: [], request_id: "r1" });
  assert.equal(councilLines(g.id, "board", ada).length, 1);
  addCouncilLine(g.id, ada, { place: g.section, text: "Just this section", to: [{ name: "Claude", session: "ses_x" }] });
  assert.equal(councilLines(g.id, "board", ada).length, 1);
  assert.deepEqual(councilLines(g.id, g.section, ada).map((l) => l.text), ["Just this section"]);
  assert.throws(() => addCouncilLine(g.id, ada, { place: "board", text: "  ", to: [] }), /Nothing was said/);
});

test("a line can't be pointed at someone else's run", async () => {
  const g = grid("Not yours");
  // Kai's own run, in a session Ada then names in her line
  const kais = startRun({ boardId: g.id, user: kai, prompt: "Make a section called “Kai's”", section: g.section, session: "ses_kai" });
  await finish(kais, kai.id);
  timeline.flushTimeline();
  const line = addCouncilLine(g.id, ada, { place: "board", text: "what did Kai's say?", to: [{ name: "Wren", session: "ses_kai" }] });
  assert.equal(line.replies[0].state, "waiting", "only runs Ada started count for Ada's line");
  assert.equal(line.replies[0].text, undefined);
});

// ---------- over HTTP ----------

const serverDir = resolve(import.meta.dirname, "..");
let child: ChildProcess;
let base = "";
const said = { out: "" };

before(async () => {
  const home = mkdtempSync(join(tmpdir(), "foundation-council-http-"));
  const port = await new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FOUNDATION_|SLACK_|ANTHROPIC_|GOOGLE_|GITHUB_|MESHY_|T3)/.test(k)) env[k] = v;
  Object.assign(env, {
    FOUNDATION_PORT: String(port),
    FOUNDATION_ROOT: home,
    FOUNDATION_EXIT_WITH_PARENT: "1",
    FOUNDATION_STARTER_DIR: "",
    FOUNDATION_DEV_LOGIN: "1",
    FOUNDATION_ALLOWLIST: "@example.test",
    FOUNDATION_ADMIN_EMAILS: "boss@example.test",
    FOUNDATION_AGENT_SCRIPT: "1",
    T3_CLI: join(home, "no-t3"),
    T3_URL: "http://127.0.0.1:9",
    FACTORYFORM_URL: "http://127.0.0.1:9",
  });
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdout!.on("data", (d) => (said.out += d));
  child.stderr!.on("data", (d) => (said.out += d));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 1200 && child.exitCode === null; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server didn't come up:\n${said.out}`);
});

after(() => {
  child?.stdin?.end();
  child?.kill();
  _resetCrew();
  closeBoards();
});

async function call(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) Object.assign(headers, { cookie: opts.cookie, origin: "http://localhost:1430" });
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
const signIn = async (email: string, name: string) => (await call("POST", "/auth/dev", { body: { email, name } })).cookie;

test("over HTTP: who said it is the session's, a viewer reads but can't say, and nobody signed out reads", async () => {
  const boss = await signIn("boss@example.test", "Boss");
  const ada = await signIn("ada@example.test", "Ada");
  const vic = await signIn("vic@example.test", "Vic");
  const board = (await call("POST", "/api/boards", { cookie: ada, body: { name: "Council over HTTP" } })).json.id as string;
  const said = await call("POST", `/api/boards/${board}/council`, { cookie: ada, body: { place: "board", text: "hello, council", to: [{ name: "Claude", session: "ses_h" }], by: "Boss", by_name: "Boss", request_id: "h1" } });
  assert.equal(said.status, 200);
  assert.equal(said.json.line.by, "Ada", "the session says who wrote it, not the request");

  const vicId = (await call("GET", "/api/me", { cookie: vic })).json.user.id as string;
  assert.equal((await call("POST", `/api/boards/${board}/people`, { cookie: boss, body: { userId: vicId, role: "viewer" } })).status, 200);
  const read = await call("GET", `/api/boards/${board}/council?place=board`, { cookie: vic });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.lines.map((l: { text: string }) => l.text), ["hello, council"]);
  assert.equal((await call("POST", `/api/boards/${board}/council`, { cookie: vic, body: { place: "board", text: "me too", to: [] } })).status, 403, "a viewer can't say");
  assert.equal((await call("GET", `/api/boards/${board}/council?place=board`)).status, 401);
});
