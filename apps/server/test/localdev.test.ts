/**
 * This computer (localdev.ts): the projects being built here, read from Claude Code's transcripts and git into a
 * grid of their own.
 *
 *  - only an admin, as a person, connects or stops it; the grid is members-only, its connector's;
 *  - a session in a worktree folds into its repository's section; a temporary folder is never a project;
 *  - the plan steps (update_plan's whole list and its advance, TodoWrite), the wrap-up, the PR and the title are read;
 *  - the newest screenshot is kept in the archive for the preview card; git's branch and changes are read;
 *  - a section with three local cards is laid once per project, and looking again lays nothing new;
 *  - nothing in the project is written; the transcript is read on from where it was left;
 *  - its two maps are the server's alone; stopping keeps the grid and says so.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserInfo } from "@foundation/protocol";

const base = mkdtempSync(join(tmpdir(), "foundation-local-"));
// the temp folder is never a project: move it aside, so the test's project (beside it) can be one
const temp = join(base, "tmp");
mkdirSync(temp);
process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp;
process.env.FOUNDATION_DATA_DIR = join(base, "data");
process.env.FOUNDATION_CLAUDE_HOME = join(base, "claude");
process.env.FOUNDATION_LOCAL_SCAN_MS = "3600000";

const { boardMaps, LOCAL_GRID_ID, localKey } = await import("@foundation/protocol");
const { closeBoards, getBoard, SERVER_MAPS } = await import("../src/boards.ts");
const { run, one } = await import("../src/db.ts");
const { canSeeBoard } = await import("../src/members.ts");
const local = await import("../src/localdev.ts");

after(() => {
  local.resetLocal();
  closeBoards?.();
});

const admin: UserInfo = { id: "u-admin", email: "ada@formindustries.com", name: "Ada", color: "#000", role: "admin" };
const member: UserInfo = { id: "u-kai", email: "kai@formindustries.com", name: "Kai", color: "#000", role: "member" };
for (const u of [admin, member]) run("insert or ignore into users (id, email, name, color, role, created_at) values (?, ?, ?, ?, ?, ?)", u.id, u.email, u.name, u.color, u.role, Date.now());

// a project: a git checkout with one change and a declared dev server
const proj = join(base, "Dev", "Gizmo");
mkdirSync(join(proj, ".claude"), { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: proj, stdio: "ignore" });
git("init", "-q", "-b", "main");
writeFileSync(join(proj, "readme.md"), "# Gizmo\n");
writeFileSync(join(proj, ".claude", "launch.json"), JSON.stringify({ configurations: [{ name: "web", port: 1 }] }));
git("add", ".");
git("commit", "-q", "-m", "First light");
writeFileSync(join(proj, "readme.md"), "# Gizmo\nnow with wheels\n");
const before = statSync(join(proj, "readme.md")).mtimeMs;

// its transcripts, where Claude Code keeps them
const folder = join(base, "claude", "projects", "C--Dev-Gizmo");
mkdirSync(folder, { recursive: true });
const line = (o: object) => `${JSON.stringify(o)}\n`;
const at = (i: number) => new Date(Date.now() - (100 - i) * 1000).toISOString();
const shot = Buffer.alloc(20_000, 7).toString("base64");
const main = join(folder, "s-main.jsonl");
writeFileSync(
  main,
  [
    line({ type: "user", cwd: proj, gitBranch: "main", entrypoint: "claude-desktop", timestamp: at(1), message: { role: "user", content: "Make the wheels turn" } }),
    line({ type: "custom-title", customTitle: "Wheels that turn" }),
    line({ type: "assistant", cwd: proj, timestamp: at(2), message: { content: [{ type: "tool_use", name: "mcp__ccd_turn__update_plan", input: { items: [{ content: "Read the axle", status: "in_progress" }, { content: "Turn the wheels", status: "pending" }, { content: "Check it", status: "pending" }] } }] } }),
    line({ type: "assistant", cwd: proj, timestamp: at(3), message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(proj, "readme.md") } }, { type: "tool_use", name: "mcp__ccd_turn__update_plan", input: { advance: true } }] } }),
    line({ type: "user", cwd: proj, timestamp: at(4), message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: shot } }] }] } }),
    line({ type: "pr-link", prNumber: 7, prUrl: "https://github.com/example/gizmo/pull/7" }),
  ].join(""),
);
// a session in one of its worktrees (CLI, a TodoWrite list)
writeFileSync(
  join(folder, "s-wt.jsonl"),
  line({ type: "user", cwd: join(proj, ".claude", "worktrees", "spokes-1a2b"), gitBranch: "claude/spokes", entrypoint: "sdk-cli", timestamp: at(5), message: { role: "user", content: "Add spokes" } }) +
    line({ type: "assistant", cwd: join(proj, ".claude", "worktrees", "spokes-1a2b"), message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Draw spokes", status: "completed" }, { content: "Ship", status: "in_progress" }] } }] } }),
);
// and one in the temp folder, which is never a project
writeFileSync(join(folder, "s-tmp.jsonl"), line({ type: "user", cwd: join(temp, "scratch"), message: { role: "user", content: "hello" } }));

test("only an admin, as a person, connects this computer, and the grid is theirs", async () => {
  await assert.rejects(async () => local.connectLocal(member, true), /Only an admin/);
  await assert.rejects(async () => local.connectLocal(admin, false), /needs a person/);
  assert.equal(local.localStatus(member, true).connected, false);
  // someone's device opened the grid by its id before it was connected: the row is named after the id
  getBoard(LOCAL_GRID_ID);
  const st = await local.connectLocal(admin, true);
  assert.equal(st.on, true);
  await local.localScanning();
  assert.equal(canSeeBoard(member, LOCAL_GRID_ID), false);
  assert.equal(canSeeBoard({ ...member, role: "member", id: admin.id }, LOCAL_GRID_ID), true);
  assert.equal(one<{ name: string }>("select name from boards where id = ?", LOCAL_GRID_ID)?.name, "This computer");
  assert.equal(one<{ role: string }>("select role from board_members where board_id = ? and user_id = ?", LOCAL_GRID_ID, admin.id)?.role, "owner");
});

test("a project's sessions, plan, screenshot and changes are read, worktrees folded in, temp ignored", async () => {
  const { projects } = await local.scanOnce();
  assert.deepEqual(
    projects.map((p) => p.name),
    ["Gizmo"],
  );
  const p = projects[0];
  assert.equal(p.key, localKey(proj));
  assert.equal(p.sessions.length, 2);
  const lead = p.sessions.find((s) => s.id === "s-main")!;
  assert.equal(lead.title, "Wheels that turn");
  assert.equal(lead.source, "claude-desktop");
  assert.deepEqual(
    lead.steps!.map((s) => s.state),
    ["done", "doing", "todo"],
  );
  assert.deepEqual(lead.pr, { number: 7, url: "https://github.com/example/gizmo/pull/7" });
  assert.equal(lead.edits, 1);
  const wt = p.sessions.find((s) => s.id === "s-wt")!;
  assert.equal(wt.worktree, "spokes-1a2b");
  assert.equal(wt.source, "claude-cli");
  assert.deepEqual(
    wt.steps!.map((s) => s.state),
    ["done", "doing"],
  );
  assert.equal(p.git?.branch, "main");
  assert.equal(p.git?.dirty, 1);
  assert.equal(p.git?.commits[0]?.subject, "First light");
  assert.equal(p.server?.port, 1);
  assert.equal(p.server?.live, false);
  // the screenshot is in the archive, for this grid
  assert.ok(p.preview);
  const f = one<{ board_id: string; mime: string; size: number }>("select board_id, mime, size from files where id = ?", p.preview!.fileId);
  assert.equal(f?.board_id, LOCAL_GRID_ID);
  assert.equal(f?.size, 20_000);
  // nothing in the project was written
  assert.equal(statSync(join(proj, "readme.md")).mtimeMs, before);
  assert.deepEqual(readdirSync(join(proj, ".claude")), ["launch.json"]);
});

test("a section with three cards is laid once, and the maps are the server's", async () => {
  const m = boardMaps(getBoard(LOCAL_GRID_ID).doc);
  const cards = () => [...m.objects.values()].filter((o) => o.kind === "panel" && o.panel === "local");
  assert.equal(m.sections.size, 1);
  assert.deepEqual(cards().map((c) => (c.kind === "panel" ? c.node : "")).sort(), ["changes", "preview", "progress"]);
  assert.equal(m.local.get(localKey(proj))?.name, "Gizmo");
  assert.equal(m.localWatch.get("state")?.on, true);
  await local.scanOnce();
  assert.equal(m.sections.size, 1);
  assert.equal(cards().length, 3);
  assert.ok((SERVER_MAPS as readonly string[]).includes("local") && (SERVER_MAPS as readonly string[]).includes("localWatch"));
});

test("a transcript is read on from where it was left", async () => {
  appendFileSync(main, line({ type: "assistant", cwd: proj, message: { content: [{ type: "tool_use", name: "mcp__ccd_turn__wrap_up", input: { recap: "The wheels turn. Not pushed." } }] } }));
  const { projects } = await local.scanOnce();
  const lead = projects[0].sessions.find((s) => s.id === "s-main")!;
  assert.equal(lead.recap, "The wheels turn. Not pushed.");
  assert.equal(lead.steps!.length, 3);
});

test("stopping keeps the grid and says it stopped; only an admin in person stops it", () => {
  assert.throws(() => local.stopLocal(member, true), /Only an admin/);
  const st = local.stopLocal(admin, true);
  assert.equal(st.on, false);
  const m = boardMaps(getBoard(LOCAL_GRID_ID).doc);
  assert.equal(m.localWatch.get("state")?.on, false);
  assert.equal(m.sections.size, 1);
});

test("plan steps: a whole list, advance, done and start", () => {
  let s = local.applyPlan([], { items: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }, { content: "c", status: "pending" }] });
  s = local.applyPlan(s, { advance: true });
  assert.deepEqual(s.map((x) => x.state), ["done", "doing", "todo"]);
  s = local.applyPlan(s, { done: [2], start: 3 });
  assert.deepEqual(s.map((x) => x.state), ["done", "done", "doing"]);
  assert.deepEqual(local.parseStatus("## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts\n"), { branch: "main", ahead: 2, behind: 1, dirty: 2, files: [{ status: "M", path: "a.ts" }, { status: "??", path: "b.ts" }] });
  assert.deepEqual(local.worktreeOf("C:\\Dev\\Vision\\.claude\\worktrees\\motor-lab"), { root: "C:\\Dev\\Vision", worktree: "motor-lab" });
});
