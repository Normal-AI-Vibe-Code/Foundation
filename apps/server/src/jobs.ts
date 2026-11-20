/**
 * Jobs: long-running work a person starts from a card — reverse engineering
 * with REA today. Agents may queue a job; only a person presses Run (nothing
 * that executes third-party tooling or spends money runs implicitly).
 *
 * REA (github.com/morluto/rea, npm `rea-agents`, MIT) analyses websites,
 * JavaScript/Electron apps, binaries, APKs and more through MCP. Foundation
 * runs it in one of two ways (rea.ts checks the target and works out the
 * command per platform; never through a shell):
 *  - a local directory or .asar → `rea-agents analyze-javascript-application <path> --json`
 *  - anything else (a URL, a binary, a repo) → a Claude Code session on this
 *    machine with REA's MCP server, told the goal and to report findings
 *    with evidence. Run `npx rea-agents@6.9.0 setup` once to register REA with
 *    Claude Code.
 * rea-agents is pinned (rea.ts REA_AGENTS) and checked against npm's registry
 * before it starts; each job runs in its own folder under the work folder with
 * an environment from an allowlist (childenv.ts, started through child.ts; ADR-001 G13).
 *
 * What runs is what a person saw: a local target must be inside an approved
 * place (rea.ts localTargetRefusal); the card and its confirmation show the
 * whole target and goal; queueing stores a hash of them (`shown_hash`), and
 * Run is refused unless the press names that hash and the row still matches it.
 * The output on the card says which program wrote it.
 */

import { startHandoff } from "./vision.ts";
import { childOptions, spawnChild, type ChildOptions, type ChildProcess, type SpawnOptions } from "./child.ts";
import { workFolder } from "./childenv.ts";
import { createHash, randomBytes } from "node:crypto";
import { boardMaps, logActivity } from "@foundation/protocol";
import { all, one, run } from "./db.ts";
import { editBoard } from "./boards.ts";
import { config } from "./config.ts";
import { checkReaIntegrity, checkTarget, CLAUDE_CODE_ENV, here, REA_REGISTRY, reaCommand, type Runtime } from "./rea.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCtx } from "./tools.ts";
import { audit } from "./audit.ts";
import { approvedRoots } from "./places.ts";
import { HttpError } from "./http.ts";

export interface JobRow {
  id: string;
  kind: string;
  target: string;
  goal: string;
  board_id: string | null;
  status: "queued" | "running" | "done" | "error";
  output: string;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
  /** sha256 of what the card shows (kind, target, goal) when it was queued: Run must name it */
  shown_hash?: string | null;
}

/** the hash of what a job's card shows: its kind, its whole target and its whole goal */
export const shownHash = (job: Pick<JobRow, "kind" | "target" | "goal">) => createHash("sha256").update(JSON.stringify([job.kind, job.target, job.goal])).digest("hex");

/** what the card and its confirmation show (the job's own row, never the card's text) and the hash a Run must name */
export function jobShown(job: JobRow) {
  return { target: job.target, goal: job.goal, program: jobProgram(job), shown: job.shown_hash ?? shownHash(job) };
}

/** the program a job would start, in words (null: it would be refused before anything starts) */
export function jobProgram(job: Pick<JobRow, "kind" | "target">): string | null {
  if (job.kind === "vision") return "Vision Code";
  const t = checkTarget(job.target, jobRuntime());
  return !t.ok ? null : t.kind === "app" ? "rea-agents" : "Claude Code";
}

export function queueJob(ctx: ToolCtx, kind: string, target: string, goal: string): JobRow {
  const id = `job_${randomBytes(6).toString("hex")}`;
  run(
    "insert into jobs (id, kind, target, goal, board_id, status, created_by, created_at, shown_hash) values (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
    id,
    kind,
    target,
    goal,
    ctx.boardId,
    ctx.actor,
    Date.now(),
    shownHash({ kind, target, goal }),
  );
  return one<JobRow>("select * from jobs where id = ?", id)!;
}

export function getJob(id: string) {
  return one<JobRow>("select * from jobs where id = ?", id);
}

export function listJobs() {
  return all<JobRow>("select * from jobs order by created_at desc limit 100");
}

export function setCard(boardId: string, jobId: string, status: "running" | "done" | "error" | "idle", text?: string, who = "REA", what = "reverse-engineering") {
  editBoard(boardId, "jobs", (doc) => {
    const m = boardMaps(doc);
    for (const o of m.objects.values()) {
      if (o.kind === "panel" && o.sessionId === jobId) {
        m.objects.set(o.id, { ...o, status, ...(text ? { text } : {}) });
        if (status === "done" || status === "error") logActivity(doc, { who, role: "agent", text: `${what} ${status === "done" ? "finished" : "failed"}`, objectId: o.id });
      }
    }
  });
}

/**
 * A person pressed Run on the card that showed `shown` (jobShown). It runs only if that is what the job
 * was queued with and the row still says so: a target or goal changed since is never run unseen.
 */
export function startJob(id: string, boardId: string, by: string, shown: string, byId?: string) {
  const job = getJob(id);
  if (!job) throw new Error("no such job");
  if (job.status === "running") return job;
  const queued = job.shown_hash ?? shownHash(job);
  if (shown !== queued || shownHash(job) !== queued)
    throw new HttpError(409, "What this job would run isn't what its card showed. Open the card again and check the target and goal before pressing Run.");
  // a person's press (the route asks requirePerson); `by` is their name
  // the person who pressed, by id (their name is only what they are called): who did it, and whose press approved it
  audit({ actor_kind: "person", actor_id: byId ?? null, actor_name: by, board_id: boardId, door: "route", action: "job.start", target: `${job.id} ${job.kind}`, provenance: job.kind === "vision" ? "ours-local" : "external", service: job.kind === "vision" ? "Vision Code" : "REA (npm registry, Claude)", decision: "allowed", approved_by: byId ?? by, result: "ok" });
  if (job.kind === "vision") return startVisionJob(job, boardId, by);
  // the target is checked and the program resolved before anything runs: no shell, the target is one argument (rea.ts)
  const plan = reaCommand(job, config.claudeCli, jobRuntime());
  if (!plan.ok) return refuseJob(job, boardId, by, plan.reason);
  run("update jobs set status = 'running', output = '' where id = ?", id);
  setCard(boardId, id, "running");
  editBoard(boardId, "jobs", (doc) => logActivity(doc, { who: by, role: "human", text: `started reverse-engineering ${job.target}` }));
  // the pinned rea-agents starts only if npm's registry still says what was pinned (rea.ts REA_AGENTS)
  if (plan.route === "rea-agents") {
    void jobDeps
      .integrity()
      .then((refused) => (refused ? failJob(job, boardId, refused) : launch(job, boardId, plan)))
      .catch((e: Error) => failJob(job, boardId, e.message));
    return getJob(id)!;
  }
  launch(job, boardId, plan);
  return getJob(id)!;
}

/**
 * How a job's program is started, and how the pinned rea-agents is checked. Tests swap these
 * (setJobDeps) so nothing runs and nothing goes to the network.
 */
export const jobDeps: {
  spawn: (cmd: string, argv: string[], opts: ChildOptions<SpawnOptions>) => ChildProcess;
  integrity: () => Promise<string | null>;
  /** the folders a person approved, by their real location (places.ts) */
  places: () => string[];
} = { spawn: (cmd, argv, opts) => spawnChild(cmd, argv, opts), integrity: () => checkReaIntegrity(), places: () => approvedRoots() };
export function setJobDeps(d: Partial<typeof jobDeps>) {
  Object.assign(jobDeps, d);
}

/** this computer, with the places a person approved */
function jobRuntime(): Runtime {
  return { ...here(), places: jobDeps.places() };
}

/** what the card says above a finished job's output: whose words they are */
export function outputLabel(route: "rea-agents" | "claude") {
  return route === "claude" ? "Claude Code's output (a program's words, not Foundation's):" : "rea-agents' output (a program's words, not Foundation's):";
}

/**
 * What a job's program gets (ADR-001 G13): its own folder under the work folder, never `data/`, and an
 * environment from the allowlist, never the server's. rea-agents' static JavaScript analysis needs no
 * model and no key, so it gets BASE only (npx finds npm's cache through the home folders in it), and no npm
 * settings file at all, the person's or the machine's: npx reads an empty one in the job's folder, so no npm
 * sign-in goes with it and only the registry it was checked against is asked (rea.ts REA_REGISTRY, also on
 * its command line). The Claude Code route gets what Claude Code needs to find the person's login (CLAUDE_CODE_ENV),
 * and REA's MCP server is the one `npx rea-agents@6.9.0 setup` registered with it.
 */
export function jobSpawnOptions(job: { id: string }, plan: { route: "rea-agents" | "claude" }): ChildOptions<SpawnOptions> {
  const cwd = workFolder("jobs", job.id);
  if (plan.route === "claude") return childOptions<SpawnOptions>({ extras: CLAUDE_CODE_ENV }, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const none = join(cwd, "npmrc-none");
  writeFileSync(none, "");
  return childOptions<SpawnOptions>(
    { extras: [], set: { npm_config_userconfig: none, npm_config_globalconfig: none, npm_config_registry: REA_REGISTRY } },
    { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
}

function launch(job: JobRow, boardId: string, plan: { route: "rea-agents" | "claude"; cmd: string; argv: string[] }) {
  const id = job.id;
  let child: ChildProcess;
  try {
    child = jobDeps.spawn(plan.cmd, plan.argv, jobSpawnOptions(job, plan));
  } catch (e) {
    return failJob(job, boardId, `couldn't start ${plan.cmd}: ${(e as Error).message}`);
  }
  let out = "";
  const append = (b: Buffer) => {
    out += b.toString("utf8");
    if (out.length > 400_000) out = out.slice(-400_000);
  };
  child.stdout!.on("data", append);
  child.stderr!.on("data", append);
  const flush = setInterval(() => run("update jobs set output = ? where id = ?", out, id), 1500);
  child.on("error", (e) => {
    out += `\n${e.message}`;
  });
  child.on("close", (code) => {
    clearInterval(flush);
    const ok = code === 0;
    run("update jobs set status = ?, output = ?, finished_at = ? where id = ?", ok ? "done" : "error", out, Date.now(), id);
    setCard(boardId, id, ok ? "done" : "error", `${outputLabel(plan.route)}\n${ok ? out.slice(0, 4000) : `failed (${code}): ${out.slice(-800)}`}`);
  });
  return getJob(id)!;
}

/** a job that didn't start: the card says why, and nothing ran */
function refuseJob(job: JobRow, boardId: string, by: string, reason: string) {
  run("update jobs set status = 'error', output = ?, finished_at = ? where id = ?", reason, Date.now(), job.id);
  setCard(boardId, job.id, "error", `Didn't start: ${reason}`);
  editBoard(boardId, "jobs", (doc) => logActivity(doc, { who: by, role: "human", text: `pressed Run on reverse-engineering ${job.target}; it didn't start` }));
  return getJob(job.id)!;
}

function failJob(job: JobRow, boardId: string, reason: string) {
  run("update jobs set status = 'error', output = ?, finished_at = ? where id = ?", reason, Date.now(), job.id);
  setCard(boardId, job.id, "error", `failed: ${reason}`);
  return getJob(job.id)!;
}

/** a Vision hand-off: a person pressed Run, so the Supervised Vision Code thread starts (vision.ts) */
function startVisionJob(job: JobRow, boardId: string, by: string) {
  run("update jobs set status = 'running' where id = ?", job.id);
  setCard(boardId, job.id, "running", "Starting a Vision Code thread…", "Vision Code", "the hand-off");
  editBoard(boardId, "jobs", (doc) => logActivity(doc, { who: by, role: "human", text: `started Vision on ${job.target}` }));
  void startHandoff(job.id)
    .then((h) => {
      run("update jobs set output = ? where id = ?", h.thread_url ?? h.thread_id ?? "", job.id);
      setCard(boardId, job.id, "running", `Running in Vision Code (Supervised: changes wait for approval there).${h.thread_url ? ` Open the thread: ${h.thread_url}` : ""} What it puts in exports/ comes back here.`, "Vision Code", "the hand-off");
    })
    .catch((e: Error) => {
      run("update jobs set status = 'error', output = ?, finished_at = ? where id = ?", e.message, Date.now(), job.id);
      setCard(boardId, job.id, "error", `Couldn't start Vision Code: ${e.message}`, "Vision Code", "the hand-off");
    });
  return getJob(job.id)!;
}
