/**
 * The Foundation agent: one conversation per person per board, able to run
 * the whole grid through the board tools (tools.ts). Which runtime a run uses
 * follows from its seat's kind (agentkinds.ts; docs/agent-harness.md §1), with
 * no falling from one to another:
 *
 * - "subscription" (claude-account): Claude Code on this machine, headless
 *   (`claude -p --output-format stream-json`), with Foundation's MCP endpoint
 *   attached for the board. The plan signed in there pays; never an API key.
 *   Sessions resume, so the conversation carries over.
 * - "api" (claude-api): the Anthropic Messages API on the key an admin stored,
 *   streaming, a manual tool loop so every step streams to the grid.
 * - "federated" (claude-federated): the same loop, on a short-lived token
 *   exchanged from the organization's identity provider.
 *
 * Either way each step arrives at the client as AgentEvents over SSE (its
 * reasoning as `thinking`), every board write shows up live to everyone through
 * the board's Y.Doc, and the run's presence carries its plan and latest thought.
 * A run that says nothing for FOUNDATION_AGENT_SILENCE_MS ends with an error
 * that says why, and anything thrown anywhere in a run ends as an `error`.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentKind } from "@foundation/protocol";
import { apiClient, apiKey, defaultKind, defaultModel, federationState, runtimeOfKind, scrub } from "./agentkinds.ts";
import { childOptions, execFileChild, execFileSyncChild, execFileText, spawnChild, type ChildOptions, type ChildProcess, type ExecFileOptions, type ExecFileSyncOptions, type SpawnOptions } from "./child.ts";
import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentEvent, AgentRuntime, UserInfo } from "@foundation/protocol";
import { config } from "./config.ts";
import { all, one, run } from "./db.ts";
import { boardDigest, editBoard } from "./boards.ts";
import { runTool, toolContent, TOOLS, type ToolCtx } from "./tools.ts";
import { CODE_MODE_TOOLS } from "./codemode.ts";
import { audit } from "./audit.ts";
import { canWrite } from "./roles.ts";
import { createSession, revokeSession } from "./auth.ts";
import { logActivity } from "@foundation/protocol";
import { todayDigest, todayFor } from "./today.ts";

/**
 * The Shiba: the same agent, wearing the face people meet first (Today). It
 * speaks to one person about their day, so its words are set in large type
 * on the page; it keeps the page in step with what it says (point_today, set_goal).
 */
const SHIBA = `

You are speaking as the Shiba — the guide people meet on Foundation's Today page before the boards. The page shows the company's goals, the person's own goals, what wants their attention today (with ids) and the company's apps; your answer is set in large type beside them, so:
- Answer in plain spoken sentences: one to three short ones, never more than about 60 words. No markdown, no lists, no headings, no ids or URLs in what you say.
- What they need is usually already in <today>. Call the today tool only to refresh after a change.
- Whenever your answer is about particular items, call point_today with their ids so the page lights them up while you talk.
- When they ask to add, finish, drop or update a goal, do it with set_goal, then say what changed. A goal for the whole company (or one someone carries for it) is set_company_goal: only when <today> says this person can set them; otherwise say who can. When they tell you about their role or work, save it with set_profile.
- Here you're not on a board, so you have no cursor: point_at, bring_view and call_in_help don't apply; point_today is how you point.
- You can still use the board tools when they ask for something on a board; say where it is.
- Warm, calm, direct. You're a companion, not a cheerleader.`;

/** what the agent is told about where it is: the board, or (the Shiba) the person's Today */
function contextBlock(opts: { boardId: string; user: UserInfo; persona?: "shiba"; chat?: ChatTurn }) {
  if (opts.chat) return opts.chat.context;
  const access = canWrite(opts.user.id, opts.boardId) ? "" : ' access="view only — read and answer; do not try to change the board"';
  if (opts.persona === "shiba") return `<today person="${opts.user.name}"${access}>\n${todayDigest(todayFor(opts.user))}\n</today>`;
  return `<board name="${opts.boardId}" person="${opts.user.name}"${access}>\n${boardDigest(opts.boardId)}\n</board>`;
}
import { describeCrewWork, joinCrew, leaveCrew, setDoing, setThought, type CrewMember, seatName } from "./crew.ts";
import { setHelperStarter } from "./tools.ts";
import { runScript } from "./script.ts";
import { CLAUDE_CODE_ENV, claudeCommand, here, type Runtime } from "./rea.ts";
import { workFolder } from "./childenv.ts";

/** a ChatForm turn (chatagents.ts): the agent's name, the chat it's in (replaces the board context) and how to speak there; no board cursor */
export interface ChatTurn {
  agent: string;
  context: string;
  system: string;
  /** a huddle's turn (chatagents.ts huddleReply): what it writes is said aloud */
  spoken?: boolean;
}

const SYSTEM = `You are the Foundation agent — the company brain of Form Industries, living inside Foundation, a shared grid where the team keeps its projects, files, designs, running apps and agents together.

You work with the people on the board, not for show. You can read and change the board with your tools: organize cards into sections, open apps and web pages as live panels, find an app's GitHub repo and MCP tools, wire one app's outputs into another's inputs, read live company systems (Vision, BomForm, FactoryForm, the Airform Data Room, Creation), search everything (board, files, Slack, GitHub), brief Vision on a design, queue reverse-engineering with REA, open huddles (video rooms on the board) and read what was said in them, put Slack channels on the board and read them (people post; you read), and — through Hermes — ask teammates for what the work needs, above all the latest CAD files.

Design pipelines carry a part from idea to release, panel by panel: Brief → Concept → CAD → Simulate → Review → Release (start_design_pipeline). Each stage collects artifacts; stage_request runs its hand-off (Vision briefs, Hermes CAD asks, review asks); complete_stage sends its output down the wire to the next. Only complete a stage when its work is really done.

How you work:
- Read the board first when the ask touches it. Refer to cards by name, not id.
- Make the change, then say in one or two sentences what you did and where it is. Use focus to point at the card you made.
- Ask before deleting anything or acting on someone else's work in a way they would not expect. Deletes need confirm: true.
- Nothing that spends money or runs third-party tooling starts on its own: reverse-engineering jobs wait for a person to press Run, machines wait for a person's Start, and a command you want run in a running machine (machine_run) waits for a person to press Run on its card. If they decline or don't answer, nothing ran: say so, don't work around it.
- When a design needs CAD or a decision you don't have, use ask_person rather than guessing.
- Building pages: when asked to lay out, gather, or make a board, page or document of things ("lay out all the images from Slack about the Airform PTHP"), call find_images, choose what belongs, then lay_out with a fitting style (grid for a set, board for a mood board, document to be read top to bottom with captions, timeline when the order in time matters) and a short intro. Say how many you placed and where, and what you couldn't search (e.g. Slack not connected).
- Unless the ask is a single question, call set_plan first (the goal and two to six short steps; reading and then writing is already two), and again as each step starts and finishes. Everyone on the grid sees it as a card beside you while you work, and the person follows along in the session tab.
- A part's 3D model out of an app on the grid (CAD, STL): app_tools on its card to find the tool that gives a part's model, then add_cad with from: { panel, tool, args } for each part (named for the part, in the section the person said): the card draws it in 3D and stays wired to the app, so it follows the part. An app whose card has no MCP address can't be reached that way: say so plainly, and what would open it (its MCP address saved in Foundation's app registry).
- Be brief and concrete. No preamble.

You are one of the crew: people see you on the board as a named cursor (your name is in <you>), moving to whatever you're working on, and every change you make is signed with your name. So work in the open:
- Go where the work is. Each write moves your cursor there first; make things in the section they belong to.
- Make the primitives the ask needs: sections (add_section, rename_section), notes, tables with real data (add_table), live panels and company connectors as data sources (add_panel, connect), and organize what's there (update_card to move a card, arrange_section to tidy a section's order).
- When what you made is somewhere the person isn't looking, finish with bring_view on it (once, at the end; not for every step).
- When you explain something precise (a number in a table, where a wire plugs in), point_at that cell or port as you say it.
- If the ask has parts that can run at the same time in different places (a second data source, a separate section), call_in_help with exact instructions for one part, and do the rest yourself. Most asks need no helper. Set your plan before you call one in: your helpers get it.
- Called in as a helper (your <you> says by whom), you start with your part, the lead's plan and what the crew has made so far. Call crew_work before you make each thing, and don't make what a teammate has made or is making: build on it, or say it's there.`;

/**
 * What `claude -p` is started with for a board run: Foundation's tools and nothing of the person's own.
 * `--strict-mcp-config`: only the MCP server in Foundation's config (the board's tools), not the person's
 * user, project or plugin MCP servers (mail, docs, trackers). `--setting-sources ""`: none of their settings
 * files (user, project, local), so their permission allow-rules, hooks and env don't widen a board run.
 * `--tools=`: no built-in tools at all (`claude --help`: `--tools ""` disables all of them; the Agent SDK
 * 0.3.323 turns `tools: []` into this same `--tools=`), and `--disallowedTools=` naming every built-in as
 * a second fence, should a version ever bring one back. `--allowedTools` only pre-approves Foundation's.
 * Flag names as Claude Code 2.1.288's `claude --help` gives them.
 *
 * So its reasoning can be shown (docs/agent-harness.md §2): `--include-partial-messages` streams it (and its
 * words) as they come, and `--thinking-display summarized` asks for readable summaries of it (Claude Code
 * 2.1.331; without it, a `-p` run's thinking blocks arrive empty). A CLI too old for either is run again
 * without them (`live` false).
 */
export function subscriptionArgs(o: { prompt: string; mcpFile: string; system: string; live?: boolean }): string[] {
  return [
    "-p",
    o.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    o.mcpFile,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--append-system-prompt",
    o.system,
    "--allowedTools",
    "mcp__foundation__*",
    "--tools=",
    `--disallowedTools=${CLAUDE_BUILT_IN_TOOLS.join(",")}`,
    ...(o.live === false ? [] : LIVE_FLAGS),
  ];
}

/** what a run needs to show its reasoning as it comes (subscriptionArgs) */
export const LIVE_FLAGS = Object.freeze(["--include-partial-messages", "--thinking-display", "summarized"]);

/**
 * Claude Code's built-in tools, every one a board run is denied (subscriptionArgs): shells, files, the web,
 * sub-agents, tasks, worktrees, skills, schedules, messages. The same list Casey's SDK options deny.
 */
export const CLAUDE_BUILT_IN_TOOLS = Object.freeze([
  "Agent", "Task", "Bash", "BashOutput", "KillBash", "KillShell", "PowerShell", "Monitor",
  "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "TaskOutput", "TaskStop",
  "ExitPlanMode", "EnterPlanMode", "EnterWorktree", "ExitWorktree", "ListMcpResourcesTool", "ReadMcpResourceTool",
  "Skill", "SlashCommand", "ToolSearch", "AskUserQuestion", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
  "RemoteTrigger", "Workflow", "SendMessage", "Artifact", "PushNotification",
]);

const histories = new Map<string, Anthropic.MessageParam[]>();
const claudeSessions = new Map<string, string>();

export type ClaudeStart = { ok: true; cmd: string; pre: string[] } | { ok: false; reason: string };

/**
 * How to start Claude Code, and whether it answers `--version`. No shell: on
 * Windows an npm `claude.cmd` runs the cli.js it wraps under this Node and
 * claude.exe runs as is (rea.ts); macOS and Linux run the CLI as configured.
 */
export function resolveClaude(cli: string, rt: Runtime, exec: (cmd: string, args: string[]) => void): ClaudeStart {
  const c = claudeCommand(cli, rt);
  if (!c.ok) return c;
  try {
    exec(c.cmd, [...c.pre, "--version"]);
    return c;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ok: false, reason: `Claude Code (${cli}) isn't on this computer's PATH. Install it, or set FOUNDATION_CLAUDE_CLI to where it is, then start Foundation's server again.` };
    return { ok: false, reason: `Claude Code (${[c.cmd, ...c.pre].join(" ")}) didn't answer --version: ${err.message.split("\n")[0]}` };
  }
}

let claude: ClaudeStart | null = null;
/** Claude Code on this computer, checked once */
export function claudeStart(): ClaudeStart {
  // `claude --version` gets what Claude Code needs to start at all (CLAUDE_CODE_ENV: where its config is,
  // and Git Bash on Windows), never a key
  claude ??= resolveClaude(config.claudeCli, here(), (cmd, args) => execFileSyncChild(cmd, args, childOptions<ExecFileSyncOptions>({ extras: CLAUDE_CODE_ENV }, { stdio: "ignore", timeout: 5000, windowsHide: true })));
  return claude;
}

export function claudeCliAvailable(): boolean {
  return claudeStart().ok;
}

export function runtimes() {
  const c = claudeStart();
  const fed = federationState();
  return {
    subscription: c.ok,
    /** why the subscription runtime is off, when Claude Code was found wanting */
    subscriptionNote: c.ok ? null : c.reason,
    /** an API key is there for claude-api seats (stored by an admin, or the server's env) */
    api: Boolean(apiKey().key),
    /** federated identity is set up for claude-federated seats */
    federated: fed.configured,
    /** the default model of claude-api and claude-federated seats */
    model: defaultModel(),
  };
}

/** what a run's kind needs before anything starts, and what's missing when it isn't there */
export function runtimeFor(kind: AgentKind): { runtime: AgentRuntime } | { error: string } {
  // tests and e2e: a fixed playbook through the same tools, no model (never set in a real deployment)
  if (process.env.FOUNDATION_AGENT_SCRIPT === "1") return { runtime: "script" };
  const runtime = runtimeOfKind(kind);
  if (!runtime) return { error: "That seat is one of T3's agents: it runs through T3 on this computer, not here." };
  if (runtime === "subscription") {
    const c = claudeStart();
    return c.ok ? { runtime } : { error: `The subscription runtime can't start: ${c.reason}\nThis seat runs on the Claude sign-in on Foundation's server, and never falls back to an API key.` };
  }
  if (runtime === "api") return apiKey().key ? { runtime } : { error: "This seat runs on Foundation's Anthropic API key, and none is set: an admin adds one in Settings → Agents. It never falls back to the Claude subscription." };
  const fed = federationState();
  return fed.configured ? { runtime } : { error: fed.why ?? "Federated identity isn't set up." };
}

/** a runtime's name, as callers before kinds asked for one, to the kind that runs on it */
const KIND_OF_RUNTIME: Record<string, AgentKind> = { subscription: "claude-account", api: "claude-api", federated: "claude-federated" };

/** the runtime an ask with no seat would use (or one asked for by name), or null when it can't run */
export function pickRuntime(requested?: string): AgentRuntime | null {
  const kind = (requested && KIND_OF_RUNTIME[requested]) || defaultKind(claudeStart().ok);
  const r = runtimeFor(kind);
  return "runtime" in r ? r.runtime : null;
}

/** the silence that ends a run (FOUNDATION_AGENT_SILENCE_MS, 90 s) */
export function silenceMs() {
  const v = Number(process.env.FOUNDATION_AGENT_SILENCE_MS ?? "90000");
  return Number.isFinite(v) && v > 0 ? v : 90_000;
}

export async function runAgent(opts: {
  boardId: string;
  user: UserInfo;
  prompt: string;
  /** the seat's kind, as the server knows it (posted seat → kind). Absent: the server's own default (agentkinds.ts defaultKind) */
  kind?: AgentKind;
  /** a claude-api or claude-federated seat's own model (else the default) */
  model?: string;
  /** older callers and tests: a runtime by name ("subscription", "api"), read as its kind */
  runtime?: string;
  /** the session tab this turn belongs to: its own conversation (default: the person's one per board) */
  session?: string;
  /** "shiba": the Today page's guide (its own voice and context) */
  persona?: "shiba";
  /** a council seat's own name ("Zephyr"): its cursor goes by it (posted.ts) */
  as?: string;
  runId?: string;
  /** the visible agent doing this run */
  crew?: CrewMember;
  /** a ChatForm turn: speaks in a chat, not on a board */
  chat?: ChatTurn;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
}) {
  // everything a run does, from its first check to its last write, is inside this try: whatever throws
  // ends as an error event (and the crew's status), never an unhandled rejection
  let finish: ((status: "done" | "error" | "stopped") => void) | null = null;
  let emit: (e: AgentEvent) => void = opts.emit;
  try {
    const named = opts.kind ?? (opts.runtime ? KIND_OF_RUNTIME[opts.runtime] : undefined);
    const kind = named ?? defaultKind(claudeStart().ok);
    const picked = runtimeFor(kind);
    if (!("runtime" in picked)) {
      const c = claudeStart();
      // an ask from no seat, on a server with nothing set up: say what would set one up
      const nothing = !named && !c.ok && !apiKey().key && !federationState().configured;
      opts.emit({
        type: "error",
        message: nothing ? `No agent runtime: install Claude Code (\`claude\`) and sign in to use the subscription, or have an admin add an Anthropic API key in Settings → Agents.\n${c.ok ? "" : c.reason}`.trim() : picked.error,
      });
      return;
    }
    const runtime = picked.runtime;
    const runId = opts.runId ?? newRunId();
    run(
      "insert into agent_runs (id, board_id, runtime, prompt, status, created_by, created_at, session_id, crew_name) values (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
      runId, opts.boardId, runtime, opts.prompt, opts.user.id, Date.now(), opts.session ?? null, opts.crew?.name ?? null,
    );
    const transcript: AgentEvent[] = [];
    // the transcript is saved as the turn runs, so a reload mid-turn replays it
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const save = () => {
      saveTimer = null;
      run("update agent_runs set transcript_json = ? where id = ? and status = 'running'", JSON.stringify(transcript), runId);
    };
    const seen = crewFollower(opts.crew);
    emit = (e: AgentEvent) => {
      // streamed text and reasoning are stored as one event per run of it, not one per token
      const last = transcript[transcript.length - 1];
      if (e.type === "text" && last?.type === "text") transcript[transcript.length - 1] = { type: "text", text: last.text + e.text };
      else if (e.type === "thinking" && last?.type === "thinking") transcript[transcript.length - 1] = { type: "thinking", text: last.text + e.text };
      else transcript.push(e);
      opts.emit(e);
      seen(e);
      saveTimer ??= setTimeout(save, 1200);
    };
    finish = (status) => {
      finish = null;
      if (saveTimer) clearTimeout(saveTimer);
      run("update agent_runs set status = ?, transcript_json = ?, finished_at = ? where id = ?", status, JSON.stringify(transcript), Date.now(), runId);
    };
    // a viewer's question isn't a change to the board, so it doesn't go in its activity;
    // a helper's brief isn't the person's ask (call_in_help logs it, signed by the lead);
    // the Shiba's talk is the person's own, not the board's
    if (!opts.crew?.lead && opts.persona !== "shiba" && !opts.chat && canWrite(opts.user.id, opts.boardId)) editBoard(opts.boardId, "agent", (doc) => logActivity(doc, { who: opts.user.name, role: "human", text: `asked the agent: ${opts.prompt.slice(0, 140)}` }));
    if (runtime === "api" || runtime === "federated") await runApi(opts, emit, kind, runtime);
    else if (runtime === "script") await runScript(opts, emit, { boardId: opts.boardId, actor: opts.crew?.name ?? opts.chat?.agent ?? "Foundation Agent", userId: opts.user.id, crew: opts.crew?.id, door: "agent-run" });
    else await runSubscription(opts, emit, runId);
    finish?.(opts.signal.aborted ? "stopped" : "done");
  } catch (e) {
    if (opts.signal.aborted) return void finish?.("stopped");
    // an error the person was already told (as soon as it showed) isn't said twice
    if (!(e as { said?: boolean })?.said) emit({ type: "error", message: scrub((e as Error)?.message ?? String(e)) });
    finish?.("error");
  }
}

/**
 * A run's presence follows its stream, so the grid sees it work from the first moment: "reading the ask", then
 * "thinking" with its latest thought, "writing its answer" as words come, and (tools.ts) a line for each step.
 * A thought lasts until the next step or words; then the next stretch of reasoning starts fresh.
 */
function crewFollower(m: CrewMember | undefined): (e: AgentEvent) => void {
  if (!m) return () => {};
  let thinking = "";
  const early = () => m.state.crew.doing === "reading the ask" || m.state.crew.doing.startsWith("called in by ");
  return (e) => {
    if (m.left) return;
    if (e.type === "thinking") {
      thinking = (thinking + e.text).slice(-2000);
      if (early() || m.state.crew.doing === "writing its answer") setDoing(m, "thinking");
      setThought(m, thinking);
    } else if (e.type === "status" && (e.status === "thinking" || e.status === "working") && early()) {
      setDoing(m, "thinking");
    } else if (e.type === "text") {
      thinking = "";
      if (early() || m.state.crew.doing === "thinking") setDoing(m, "writing its answer");
    } else if (e.type === "tool") {
      thinking = "";
      setThought(m, null);
    }
  };
}

/** who the agent is, for the prompt */
function youTag(crew?: CrewMember) {
  return crew ? `\n\n<you name="${crew.name}"${crew.lead ? ` called_in_by="${crew.lead.name}"` : ""} />` : "";
}

const newRunId = () => `run_${randomBytes(6).toString("hex")}`;

// ---------- runs outlive the page that started them ----------
// A turn keeps going when its tab reloads or closes; the page reattaches by
// run id (replay, then live), and only Stop ends it early.

interface LiveRun {
  id: string;
  userId: string;
  boardId: string;
  events: AgentEvent[];
  listeners: Set<(e: AgentEvent) => void>;
  done: boolean;
  ctrl: AbortController;
  /** the kind it runs as (and a seat's own model): a helper it calls in runs the same way */
  kind?: AgentKind;
  model?: string;
}
const live = new Map<string, LiveRun>();

export function startRun(opts: Omit<Parameters<typeof runAgent>[0], "emit" | "signal" | "runId" | "crew"> & { lead?: CrewMember }): LiveRun {
  // a helper runs as its lead does: the same kind, the same model
  const leadRun = opts.lead ? live.get(opts.lead.runId) : undefined;
  if (leadRun && !opts.kind) opts = { ...opts, kind: leadRun.kind, model: opts.model ?? leadRun.model };
  const r: LiveRun = { id: newRunId(), userId: opts.user.id, boardId: opts.boardId, events: [], listeners: new Set(), done: false, ctrl: new AbortController(), kind: opts.kind, model: opts.model };
  live.set(r.id, r);
  const emit = (e: AgentEvent) => {
    const last = r.events[r.events.length - 1];
    if (e.type === "text" && last?.type === "text") r.events[r.events.length - 1] = { type: "text", text: last.text + e.text };
    else if (e.type === "thinking" && last?.type === "thinking") r.events[r.events.length - 1] = { type: "thinking", text: last.text + e.text };
    else r.events.push(e);
    for (const fn of r.listeners) fn(e);
  };
  const end = () => {
    r.done = true;
    for (const fn of r.listeners) fn({ type: "status", status: "ended" });
    r.listeners.clear();
    setTimeout(() => live.delete(r.id), 60_000).unref?.();
  };
  emit({ type: "run", id: r.id });
  // who started it: a person (the route asks requirePerson), a lead calling in help, or the Slack board's curator for the person who turned it on
  audit(
    opts.lead
      ? { actor_kind: "agent", actor_id: opts.lead.id, actor_name: opts.lead.name, for_person: opts.user.id, board_id: opts.boardId, door: "agent-run", action: "run.start", target: r.id, decision: "allowed", result: "ok" }
      : { actor_kind: "person", actor_id: opts.user.id, actor_name: opts.user.name, board_id: opts.boardId, door: "route", action: "run.start", target: r.id, decision: "allowed", approved_by: opts.user.id, result: "ok" },
  );
  // every board turn is someone you can see: a name, a colour, a cursor on the board.
  // The Shiba isn't on a board (it talks to one person on their Today), so it has no cursor
  let crew: CrewMember | undefined;
  if (opts.persona !== "shiba" && !opts.chat) {
    try {
      crew = joinCrew({ boardId: opts.boardId, userId: opts.user.id, userName: opts.user.name, runId: r.id, task: opts.prompt, lead: opts.lead, name: seatName(opts.as) });
    } catch (e) {
      emit({ type: "error", message: (e as Error).message });
      end();
      return r;
    }
    crewUsers.set(crew.id, opts.user);
    emit({ type: "crew", id: crew.id, name: crew.name, hue: crew.hue, lead: crew.lead?.id, leadName: crew.lead?.name });
  }
  // a helper starts with the lead's plan and what the crew has made so far (crew_work keeps it current)
  const sofar = opts.lead && crew ? describeCrewWork(crew) : "";
  const prompt = opts.lead
    ? `You were called in by ${opts.lead.name} to help with ${opts.user.name}'s ask. Your part:\n\n${opts.prompt}\n\n<crew>\n${sofar || "Nothing made yet."}\n</crew>\nDon't make what a teammate has made or is making: call crew_work before you make each thing, and build on what's there.`
    : opts.prompt;
  let failed = false;
  const watch = (e: AgentEvent) => {
    if (e.type === "error") failed = true;
    emit(e);
  };
  // runAgent ends every throw as an error event; this catch is the fence behind it, so nothing escapes as an unhandled rejection
  void runAgent({ ...opts, prompt, crew, runId: r.id, emit: watch, signal: r.ctrl.signal })
    .catch((e) => {
      if (!r.ctrl.signal.aborted) watch({ type: "error", message: scrub((e as Error)?.message ?? String(e)) });
    })
    .finally(() => {
      if (crew) {
        leaveCrew(crew, r.ctrl.signal.aborted ? "stopped" : failed ? "error" : "done");
        crewUsers.delete(crew.id);
      }
      end();
    });
  return r;
}

const crewUsers = new Map<string, UserInfo>();

// a lead's call_in_help: a run of its own (its own name, cursor and session tab), for the same person
setHelperStarter((lead, task) => {
  const user = crewUsers.get(lead.id);
  if (!user) throw new Error("the agent that called for help has finished");
  const session = `ses_${randomBytes(6).toString("hex")}`;
  const h = startRun({ boardId: lead.boardId, user, prompt: task, session, lead });
  const crewEv = h.events.find((e): e is Extract<AgentEvent, { type: "crew" }> => e.type === "crew");
  if (!crewEv) throw new Error((h.events.find((e) => e.type === "error") as { message?: string } | undefined)?.message ?? "no helper started");
  setDoing(lead, `called in ${crewEv.name}`);
  const leadRun = live.get(lead.runId);
  if (leadRun) {
    const ev: AgentEvent = { type: "helper", name: crewEv.name, runId: h.id, session };
    leadRun.events.push(ev);
    for (const fn of leadRun.listeners) fn(ev);
  }
  return { name: crewEv.name, runId: h.id };
});

/** a run this person may watch: replay what happened, then follow; returns a detach */
export function followRun(id: string, userId: string, send: (e: AgentEvent) => void, end: () => void): (() => void) | null {
  const r = live.get(id);
  if (!r || r.userId !== userId) return null;
  for (const e of r.events) send(e);
  if (r.done) {
    end();
    return () => {};
  }
  const fn = (e: AgentEvent) => (e.type === "status" && e.status === "ended" ? end() : send(e));
  r.listeners.add(fn);
  return () => r.listeners.delete(fn);
}

export function stopRun(id: string, userId: string) {
  const r = live.get(id);
  if (!r || r.userId !== userId) return false;
  r.ctrl.abort();
  audit({ actor_kind: "person", actor_id: userId, board_id: r.boardId, door: "route", action: "run.stop", target: id, decision: "allowed", result: "ok" });
  return true;
}

/**
 * The crew-wide stop: every run this person has going on this board, helpers
 * included (a helper runs as the person who asked). Returns how many stopped.
 */
/** The server is going (the desktop app quit): end every running turn, so no agent process outlives it. */
export function stopEveryRun(): number {
  let n = 0;
  for (const r of live.values()) {
    if (r.done || r.ctrl.signal.aborted) continue;
    r.ctrl.abort();
    n++;
  }
  return n;
}

export function stopAllRuns(boardId: string, userId: string): number {
  let n = 0;
  for (const r of live.values()) {
    if (r.done || r.userId !== userId || r.boardId !== boardId || r.ctrl.signal.aborted) continue;
    r.ctrl.abort();
    audit({ actor_kind: "person", actor_id: userId, board_id: boardId, door: "route", action: "run.stop", target: r.id, decision: "allowed", result: "ok" });
    n++;
  }
  return n;
}

/** runs left "running" by a server that stopped can't finish: say so */
export function settleOrphanRuns() {
  run("update agent_runs set status = 'error', finished_at = ? where status = 'running'", Date.now());
}

// ---------- API runtime (credits) ----------

/**
 * Which tools a run is given (FOUNDATION_AGENT_TOOLS): "code", the few a model calls alone plus search_tools and
 * run_code, through which it reaches every other tool as an API (docs/agent-harness.md §3); or "all", every tool
 * listed. The default is the one the real turns in docs/evidence/2026-11-24_council-harness/REAL-TURN.md favoured.
 */
export const DEFAULT_AGENT_TOOLS: "code" | "all" = "all";
export function agentToolsMode(): "code" | "all" {
  const v = (process.env.FOUNDATION_AGENT_TOOLS ?? "").trim().toLowerCase();
  return v === "code" || v === "all" ? v : DEFAULT_AGENT_TOOLS;
}

/** the MCP address a claude-account run is given: its board, its crew member, a chat agent's name, and code mode when that's the setting */
export function runMcpUrl(o: { boardId: string; crew?: string; as?: string; mode?: "code" | "all" }): string {
  const mode = o.mode ?? agentToolsMode();
  return `${selfBase()}/mcp?board=${encodeURIComponent(o.boardId)}${o.crew ? `&crew=${encodeURIComponent(o.crew)}` : ""}${o.as ? `&as=${encodeURIComponent(o.as)}` : ""}${mode === "code" ? "&mode=code" : ""}`;
}

/** what the system prompt adds in code mode, so the model knows where the rest of its tools are */
const CODE_MODE_NOTE = "\nMost of your board tools are reached through run_code: find them with search_tools (it gives each one's signature), then call several in one script as `await foundation.<tool>({ … })`. read_board, read_card, set_plan, point_at and bring_view you call directly.";

export function apiTools(mode: "code" | "all" = agentToolsMode()): Anthropic.Tool[] {
  const only = mode === "code" ? new Set<string>(CODE_MODE_TOOLS) : null;
  return TOOLS.filter((t) => !only || only.has(t.name)).map((t) => {
    const schema = zodToJsonSchema(t.schema, { $refStrategy: "none" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema as Anthropic.Tool.InputSchema };
  });
}

/** one conversation per person per board, or per session tab */
const convKey = (opts: { boardId: string; user: UserInfo; session?: string }) => `${opts.boardId}:${opts.user.id}${opts.session ? `:${opts.session}` : ""}`;

/**
 * What to ask a model for so its reasoning can be shown (the claude-api skill, Thinking & Effort): adaptive
 * thinking on the 4.6+ and 5 families, with the readable summary asked for on those whose default is to omit
 * it (4.7 and later); a budget on older ones (Haiku 4.5), which take no effort setting.
 */
export function thinkingFor(model: string): { thinking: Record<string, unknown>; output_config?: { effort: string } } {
  if (/^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model) || /^claude-opus-4-[78]/.test(model)) return { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "medium" } };
  if (/^claude-(opus|sonnet)-4-6/.test(model)) return { thinking: { type: "adaptive" }, output_config: { effort: "medium" } };
  return { thinking: { type: "enabled", budget_tokens: 8000 } };
}

/** the models the API's own refusal fallback is asked for on (the claude-api skill: `fallbacks: "default"`) */
const FALLBACK_MODELS = /^claude-(fable-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/;

/** a timer that ends a run that has said nothing for `ms`; paused while a tool of ours runs (that's our silence, not its) */
function silenceWatch(ms: number, onSilent: () => void) {
  let t: ReturnType<typeof setTimeout> | null = null;
  let paused = false;
  const arm = () => {
    if (t) clearTimeout(t);
    t = paused ? null : setTimeout(onSilent, ms);
    t?.unref?.();
  };
  arm();
  return {
    poke: arm,
    pause(on: boolean) {
      paused = on;
      arm();
    },
    stop() {
      if (t) clearTimeout(t);
      t = null;
      paused = true;
    },
  };
}

/** an error that was already shown to the person (runAgent doesn't say it twice) */
class SaidError extends Error {
  said = true;
}

async function runApi(opts: Parameters<typeof runAgent>[0], emit: (e: AgentEvent) => void, kind: AgentKind, runtime: "api" | "federated") {
  const client = apiClient(kind);
  const model = opts.model || defaultModel();
  const key = convKey(opts);
  const history = histories.get(key) ?? [];
  history.push({
    role: "user",
    content: `${opts.prompt}${youTag(opts.crew)}\n\n${contextBlock(opts)}`,
  });
  const ctx: ToolCtx = { boardId: opts.boardId, actor: opts.crew?.name ?? opts.chat?.agent ?? "Foundation Agent", userId: opts.user.id, crew: opts.crew?.id, door: "agent-run" };
  const toolsMode = agentToolsMode();
  const tools = apiTools(toolsMode);
  let usage = { input: 0, output: 0 };
  const quiet = silenceMs();

  for (let step = 0; step < 24; step++) {
    if (opts.signal.aborted) throw new Error("stopped");
    emit({ type: "status", status: step === 0 ? "thinking" : "working" });
    // the request ends with the run, or when Anthropic says nothing for the silence
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    opts.signal.addEventListener("abort", stop, { once: true });
    let silent = false;
    const watch = silenceWatch(quiet, () => {
      silent = true;
      ctrl.abort();
    });
    const fallback = FALLBACK_MODELS.test(model);
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        system: [{ type: "text", text: SYSTEM + (opts.persona === "shiba" ? SHIBA : "") + (opts.chat?.system ?? "") + (toolsMode === "code" ? CODE_MODE_NOTE : ""), cache_control: { type: "ephemeral" } }],
        ...thinkingFor(model),
        tools,
        messages: history,
        // a refusal is answered by the next model rather than ending the turn (server-side; billed at that model's rates)
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      } as never,
      { signal: ctrl.signal },
    );
    stream.on("streamEvent", () => watch.poke());
    stream.on("text", (t) => emit({ type: "text", text: t }));
    stream.on("thinking", (t) => {
      if (t) emit({ type: "thinking", text: t });
    });
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      if (silent) throw new Error(`The Anthropic API sent nothing for ${Math.round(quiet / 1000)} s, so the run was stopped. Anthropic may be slow or down; try again in a moment.`);
      throw new Error(apiFailure(e, kind));
    } finally {
      watch.stop();
      opts.signal.removeEventListener("abort", stop);
    }
    usage = { input: usage.input + msg.usage.input_tokens, output: usage.output + msg.usage.output_tokens };
    history.push({ role: "assistant", content: msg.content as unknown as Anthropic.ContentBlockParam[] });

    if (msg.stop_reason === "refusal") throw new Error("The model declined this request.");
    if (msg.stop_reason === "pause_turn") continue;
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || calls.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      calls.map(async (c) => {
        emit({ type: "tool", name: c.name, input: c.input });
        try {
          const out = await runTool(ctx, c.name, c.input);
          // a picture in the result (a machine's screen) goes to the model as a picture, the rest as text
          const { text, image } = toolContent(out, false);
          emit({ type: "tool_result", name: c.name, ok: true, summary: text.slice(0, 200) });
          if (image) {
            return {
              type: "tool_result" as const,
              tool_use_id: c.id,
              content: [
                { type: "image" as const, source: { type: "base64" as const, media_type: image.mime as "image/png", data: image.base64 } },
                { type: "text" as const, text: text.slice(0, 60_000) },
              ],
            };
          }
          return { type: "tool_result" as const, tool_use_id: c.id, content: text.slice(0, 60_000) };
        } catch (e) {
          const message = (e as Error).message;
          emit({ type: "tool_result", name: c.name, ok: false, summary: message });
          return { type: "tool_result" as const, tool_use_id: c.id, content: message, is_error: true };
        }
      }),
    );
    history.push({ role: "user", content: results });
  }
  // keep the conversation bounded; older turns fall off whole
  while (history.length > 40) history.splice(0, 2);
  histories.set(key, history);
  emit({ type: "done", runtime, usage });
}

/** what an API failure means for the person, in words (the SDK's typed errors; never the key) */
function apiFailure(e: unknown, kind: AgentKind): string {
  const who = kind === "claude-api" ? "the API key an admin stored" : "the organization's federated identity";
  if (e instanceof Anthropic.AuthenticationError) return `Anthropic didn't accept ${who} (401). ${kind === "claude-api" ? "An admin can put in a new key in Settings → Agents." : "Check the federation rule and the identity token."}`;
  if (e instanceof Anthropic.PermissionDeniedError) return `Anthropic refused ${who} for this (403): ${scrub(e.message).slice(0, 300)}`;
  if (e instanceof Anthropic.NotFoundError) return `Anthropic doesn't know this model (404): ${scrub(e.message).slice(0, 300)}. An admin can pick another in Settings → Agents.`;
  if (e instanceof Anthropic.RateLimitError) return "Anthropic is rate-limiting this key right now (429). Try again in a minute.";
  if (e instanceof Anthropic.APIError) return `The Anthropic API answered ${e.status ?? "with an error"}: ${scrub(e.message).slice(0, 400)}`;
  return scrub((e as Error)?.message ?? String(e));
}

// ---------- subscription runtime (Claude Code, T3-style session) ----------

/**
 * Where and with what Claude Code runs (ADR-001 G13). One folder under the work folder for every
 * subscription turn, never `data/`: Claude Code keeps its sessions per working folder, and `--resume`
 * finds a session only from the folder it was made in, so the folder stays the same from turn to turn.
 * Its environment is the allowlist plus CLAUDE_CODE_ENV (its login), never ANTHROPIC_API_KEY or any
 * other key: with that key set, `claude -p` would bill it instead of the person's plan.
 */
export function subscriptionSpawnOptions(): ChildOptions<SpawnOptions> {
  return childOptions<SpawnOptions>({ extras: CLAUDE_CODE_ENV }, { cwd: workFolder("agent"), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/**
 * Where a run's Claude Code reaches this server's MCP endpoint: the address it listens on, except that one
 * listening on every address (0.0.0.0, ::) is reached on loopback — "http://0.0.0.0:…" is no address to
 * connect to (on Windows it fails outright, and the run is left with no tools).
 */
export function selfBase(host: string = config.host, port: number = config.port): string {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (!h || h === "0.0.0.0" || h === "::") return `http://127.0.0.1:${port}`;
  return h.includes(":") ? `http://[${h}]:${port}` : `http://${h}:${port}`;
}

/** what Claude Code says when it isn't signed in, or its sign-in has lapsed */
const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error|credit balance is too low/i;
const signedOutWords = (said: string) =>
  `Claude Code on Foundation's server isn't signed in, or its sign-in has expired: on that computer, run \`claude\` and sign in (/login), then ask again. It said: ${scrub(said).slice(0, 300)}`;

/** what a Claude Code too old for the live flags says when it refuses them */
const OLD_CLI = /unknown option|unrecognized option|invalid (value|choice|argument)|allowed choices|is not one of|not a valid/i;

/** how long a run's Claude Code has to go after SIGTERM before SIGKILL (not Windows: there it's the tree at once) */
function killMs() {
  const v = Number(process.env.FOUNDATION_AGENT_KILL_MS ?? "5000");
  return Number.isFinite(v) && v >= 0 ? v : 5000;
}

/** end a child and everything it started (Windows: taskkill /T /F, as t3host.ts does) */
function killTree(c: ChildProcess) {
  if (c.pid && process.platform === "win32") execFileChild("taskkill", ["/pid", String(c.pid), "/T", "/F"], childOptions<ExecFileOptions>({ extras: [] }, { windowsHide: true }));
  else c.kill("SIGKILL");
}

/** Claude Code too old for the live flags (subscriptionArgs): run again without them, and remember */
let liveFlags = true;

/** the last run's word on the sign-in, for GET /api/agents/claude when `claude auth status` can't say */
let lastAccount: { signedIn: boolean; at: number; why?: string } | null = null;

async function runSubscription(opts: Parameters<typeof runAgent>[0], emit: (e: AgentEvent) => void, runId: string) {
  const c = claudeStart();
  if (!c.ok) throw new Error(`The subscription runtime can't start: ${c.reason}`);
  const key = convKey(opts);
  // a short-lived session for this person, so the agent's writes are theirs
  const token = createSession(opts.user.id, 2 * 3600_000, "agent");
  audit({ actor_kind: "service", actor_id: "server", actor_name: "Foundation", for_person: opts.user.id, board_id: opts.boardId, door: "agent-run", action: "agent_token.mint", target: runId, decision: "allowed", reason: "a run's own MCP bearer, 2 hours", result: "ok" });
  // the run's pass to the board, in a folder of the run's own (not data/, not the folder Claude Code works in), gone when it ends
  const runDir = workFolder("runs", /^[A-Za-z0-9_-]+$/.test(runId) ? runId : `run_${randomBytes(6).toString("hex")}`);
  try {
    const mcpFile = join(runDir, "mcp.json");
    const toolsMode = agentToolsMode();
    const mcpUrl = runMcpUrl({ boardId: opts.boardId, crew: opts.crew?.id, as: opts.chat?.agent, mode: toolsMode });
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { foundation: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
    const prompt = `${opts.prompt}${youTag(opts.crew)}\n\n${contextBlock(opts)}`;
    const system = SYSTEM + (opts.persona === "shiba" ? SHIBA : "") + (opts.chat?.system ?? "") + "\nYour board tools are the mcp__foundation__* tools." + (toolsMode === "code" ? CODE_MODE_NOTE : "");
    // the Claude Code session to continue: this server's memory, else the last run of this tab
    const resume =
      claudeSessions.get(key) ??
      (opts.session
        ? one<{ claude_session: string }>("select claude_session from agent_runs where session_id = ? and created_by = ? and claude_session is not null order by created_at desc limit 1", opts.session, opts.user.id)?.claude_session
        : undefined);
    emit({ type: "status", status: "thinking" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const argv = subscriptionArgs({ prompt, mcpFile, system, live: liveFlags });
      if (resume) argv.push("--resume", resume);
      const said = await claudeTurn({ cmd: c.cmd, argv: [...c.pre, ...argv], key, runId, emit, signal: opts.signal, mcpBase: selfBase(), live: liveFlags });
      if (said !== "old-cli") return;
      liveFlags = false;
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    revokeSession(token);
  }
}

type StreamLine = {
  type: string;
  subtype?: string;
  session_id?: string;
  mcp_servers?: Array<{ name: string; status: string }>;
  event?: { type: string; message?: { id?: string }; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string } };
  message?: { id?: string; content?: Array<{ type: string; id?: string; tool_use_id?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }> };
  usage?: { input_tokens?: number; output_tokens?: number };
  result?: string;
  is_error?: boolean;
};

/** one `claude -p` child, to its end: its stream turned into AgentEvents, watched for silence and for a lost sign-in */
function claudeTurn(o: { cmd: string; argv: string[]; key: string; runId: string; emit: (e: AgentEvent) => void; signal: AbortSignal; mcpBase: string; live: boolean }): Promise<void | "old-cli"> {
  const { emit } = o;
  return new Promise<void | "old-cli">((resolve, reject) => {
    // no shell: the prompt is one argument, whatever it holds
    const child = spawnChild(o.cmd, o.argv, subscriptionSpawnOptions());
    // Stop and the silence end it for sure: on Windows the whole tree at once (taskkill /T /F; SIGTERM there would
    // end only claude.exe and leave what it started holding the pipes); elsewhere SIGTERM, then SIGKILL after
    // FOUNDATION_AGENT_KILL_MS (5 s) for one that ignores it. Either way its pipes are let go a second after it
    // exits, so the run ends, its folder is removed and its MCP pass revoked.
    let killing = false;
    const kill = () => {
      if (killing) return;
      killing = true;
      if (process.platform === "win32") return killTree(child);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, killMs()).unref?.();
    };
    child.on("exit", () => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 1000).unref?.();
    });
    o.signal.addEventListener("abort", kill, { once: true });
    let buf = "";
    let err = "";
    let spoke = false;
    let silent = false;
    /** an error the person has already been told (a lost sign-in, an unreachable MCP, Claude Code's own error result) */
    let told: string | null = null;
    const pending = new Set<string>();
    const watch = silenceWatch(silenceMs(), () => {
      silent = true;
      kill();
    });
    const tell = (message: string) => {
      if (told) return;
      told = message;
      emit({ type: "error", message });
    };
    // which streamed messages already gave their words and reasoning as they came (--include-partial-messages)
    let current = "";
    const streamedText = new Set<string>();
    const streamedThinking = new Set<string>();

    child.stdout!.on("data", (b: Buffer) => {
      spoke = true;
      watch.poke();
      buf += b.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr!.on("data", (b: Buffer) => {
      watch.poke();
      const chunk = b.toString("utf8");
      err = (err + chunk).slice(-4000);
      // a lost sign-in says so as soon as it shows, not when the run gives up
      for (const l of chunk.split("\n")) {
        if (l.trim() && SIGNED_OUT.test(l)) {
          lastAccount = { signedIn: false, at: Date.now(), why: scrub(l.trim()).slice(0, 200) };
          tell(signedOutWords(l.trim()));
        }
      }
    });
    const handleLine = (line: string) => {
      let ev: StreamLine;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.session_id && claudeSessions.get(o.key) !== ev.session_id) {
        claudeSessions.set(o.key, ev.session_id);
        run("update agent_runs set claude_session = ? where id = ?", ev.session_id, o.runId);
      }
      if (ev.type === "system" && ev.subtype === "init") {
        // its tools are Foundation's MCP: without them the run can only talk, so it stops and says why
        const mcp = ev.mcp_servers?.find((s) => s.name === "foundation");
        if (mcp && (mcp.status === "failed" || mcp.status === "needs-auth")) {
          tell(`Claude Code couldn't reach Foundation's board tools at ${o.mcpBase}/mcp (it says “${mcp.status}”), so it was stopped before it could only talk. Is the server listening there?`);
          kill();
        }
      } else if (ev.type === "stream_event" && ev.event) {
        const e = ev.event;
        if (e.type === "message_start") current = e.message?.id ?? "";
        else if (e.type === "content_block_start" && e.content_block?.type === "thinking") emit({ type: "status", status: "thinking" });
        else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
          streamedThinking.add(current);
          emit({ type: "thinking", text: e.delta.thinking });
        } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          streamedText.add(current);
          emit({ type: "text", text: e.delta.text });
        }
      } else if (ev.type === "assistant") {
        const id = ev.message?.id ?? "";
        for (const b of ev.message?.content ?? []) {
          if (b.type === "thinking" && b.thinking && !streamedThinking.has(id)) emit({ type: "thinking", text: b.thinking });
          if (b.type === "text" && b.text && !streamedText.has(id)) emit({ type: "text", text: b.text });
          if (b.type === "tool_use") {
            if (b.id) pending.add(b.id);
            // Claude Code's own plumbing (tool search) isn't a step people need to see
            if (b.name !== "ToolSearch") emit({ type: "tool", name: (b.name ?? "").replace(/^mcp__foundation__/, ""), input: b.input });
          }
        }
        // while a tool of ours runs, the silence is ours (a person's Run press, a long read), not Claude Code's
        watch.pause(pending.size > 0);
        emit({ type: "status", status: "working" });
      } else if (ev.type === "user") {
        for (const b of ev.message?.content ?? []) {
          if (b.type === "tool_result") {
            if (b.tool_use_id) pending.delete(b.tool_use_id);
            if (typeof b.content !== "string" && JSON.stringify(b.content).includes('"tool_reference"')) continue;
            const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
            emit({ type: "tool_result", name: "", ok: !b.is_error, summary: text.slice(0, 200) });
          }
        }
        watch.pause(pending.size > 0);
      } else if (ev.type === "result") {
        const failed = ev.is_error || (ev.subtype ?? "success") !== "success";
        if (failed) {
          const said = ev.result || ev.subtype || "Claude Code reported an error";
          if (SIGNED_OUT.test(said)) {
            lastAccount = { signedIn: false, at: Date.now(), why: scrub(said).slice(0, 200) };
            tell(signedOutWords(said));
          } else tell(`Claude Code reported an error: ${scrub(said).slice(0, 600)}`);
        } else lastAccount = { signedIn: true, at: Date.now() };
        // one ending per run: an error, or done
        if (!failed) emit({ type: "done", runtime: "subscription", usage: { input: ev.usage?.input_tokens ?? 0, output: ev.usage?.output_tokens ?? 0 } });
      }
    };
    const end = () => {
      watch.stop();
      o.signal.removeEventListener("abort", kill);
    };
    child.on("error", (e) => {
      end();
      reject(e);
    });
    child.on("close", (code) => {
      end();
      const tail = scrub(err.trim()).slice(-600);
      // one ending per run: what was already said stands, a silence after it adds nothing
      if (told) return o.signal.aborted && !silent ? resolve() : reject(new SaidError(told));
      if (silent) return reject(new Error(silenceWords(silenceMs(), spoke, err, tail)));
      if (o.signal.aborted) return resolve();
      if (code === 0) return resolve();
      // a Claude Code older than the live flags: once more without them
      // (an option it doesn't know, or a value of one it won't take); runSubscription retries once at most
      if (o.live && !spoke && OLD_CLI.test(err)) return resolve("old-cli");
      reject(new Error(`Claude Code exited ${code}${tail ? `: ${tail}` : " and said nothing"}`));
    });
  });
}

/** why a run went quiet, as best the server can tell, and what Claude Code's error output said */
function silenceWords(ms: number, spoke: boolean, err: string, tail: string): string {
  const s = Math.round(ms / 1000);
  const cause = SIGNED_OUT.test(err)
    ? "its sign-in has expired (on the server's computer, run `claude` and sign in with /login)"
    : !spoke
      ? "it never started: it may be waiting on a prompt it can't show here (a first-run question, a sign-in, a trust prompt). Run `claude` once on the server's computer to see"
      : "the model stopped answering (Anthropic slow or down), or Claude Code is waiting on a prompt it can't show here";
  return `Claude Code said nothing for ${s} s, so the run was stopped. Likely: ${cause}. Its error output: ${tail || "nothing"}`;
}

/**
 * Whether the Claude sign-in on the server's computer is there, without spending anything: `claude auth status`
 * (its JSON says loggedIn), asked at most once a minute; else what the last run showed; else "unknown".
 */
let accountCache: { at: number; value: { installed: boolean; version?: string; signedIn: boolean | "unknown"; why?: string } } | null = null;
export async function claudeAccount(): Promise<{ installed: boolean; version?: string; signedIn: boolean | "unknown"; why?: string }> {
  if (accountCache && Date.now() - accountCache.at < 60_000) return accountCache.value;
  const c = claudeStart();
  if (!c.ok) return { installed: false, signedIn: false, why: c.reason };
  const opts = childOptions<ExecFileOptions>({ extras: CLAUDE_CODE_ENV }, { timeout: 10_000, windowsHide: true, maxBuffer: 256 * 1024 });
  let version: string | undefined;
  try {
    version = (await execFileText(c.cmd, [...c.pre, "--version"], opts)).stdout.trim().split(/\s/)[0] || undefined;
  } catch {
    /* it answered once, at start; a version is nice to have */
  }
  let value: { installed: boolean; version?: string; signedIn: boolean | "unknown"; why?: string };
  try {
    const { stdout } = await execFileText(c.cmd, [...c.pre, "auth", "status", "--json"], opts);
    const st = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string };
    value = typeof st.loggedIn === "boolean" ? { installed: true, version, signedIn: st.loggedIn, ...(st.loggedIn ? {} : { why: "Claude Code on the server isn't signed in: on that computer, run `claude` and sign in with /login." }) } : { installed: true, version, signedIn: "unknown" };
  } catch {
    value = lastAccount ? { installed: true, version, signedIn: lastAccount.signedIn, ...(lastAccount.why ? { why: lastAccount.why } : {}) } : { installed: true, version, signedIn: "unknown", why: "This Claude Code can't say whether it's signed in; the next run will." };
  }
  accountCache = { at: Date.now(), value };
  return value;
}

// ---------- sessions (the tabs) ----------

export interface SessionSummary {
  id: string;
  title: string;
  board: string;
  runs: number;
  status: "running" | "done" | "error";
  updatedAt: number;
}

/** this person's agent sessions on a board, newest first */
export function listSessions(boardId: string, userId: string, limit = 30): SessionSummary[] {
  const rows = all<{ session_id: string; first: string; runs: number; updated: number; board_id: string }>(
    `select session_id, board_id, count(*) as runs, max(created_at) as updated,
            (select prompt from agent_runs b where b.session_id = a.session_id order by created_at asc limit 1) as first
       from agent_runs a
      where board_id = ? and created_by = ? and session_id is not null and session_id not like 'ses_shiba%' and session_id not like 'ses_chat%'
      group by session_id order by updated desc limit ?`,
    boardId, userId, limit,
  );
  return rows.map((r) => {
    const last = one<{ status: string }>("select status from agent_runs where session_id = ? order by created_at desc limit 1", r.session_id);
    return { id: r.session_id, title: titleOf(r.first), board: r.board_id, runs: r.runs, status: (last?.status ?? "done") as SessionSummary["status"], updatedAt: r.updated };
  });
}

/** a session's turns, as the tab replays them */
export function sessionTurns(sessionId: string, userId: string) {
  return all<{ id: string; prompt: string; status: string; runtime: string; transcript_json: string; created_at: number }>(
    "select id, prompt, status, runtime, transcript_json, created_at from agent_runs where session_id = ? and created_by = ? order by created_at asc",
    sessionId, userId,
  ).map((r) => ({ id: r.id, prompt: r.prompt, status: r.status, runtime: r.runtime, at: r.created_at, events: JSON.parse(r.transcript_json) as AgentEvent[] }));
}

/**
 * A council seat's last runs for this person, newest first (2026-11-25, Josh: "one of the agents tried and failed, but
 * there was no trace"): matched by the name its cursor wore (the seat's own, or "<name> 2" beside another). Only the
 * person's own runs: the transcript holds its full reasoning and what it read, which is the asker's alone.
 */
export function seatRuns(boardId: string, userId: string, name: string, limit = 3) {
  const n = name.trim().slice(0, 80);
  if (!n) return [];
  return all<{ id: string; session_id: string | null; prompt: string; status: string; runtime: string; transcript_json: string | null; created_at: number; finished_at: number | null }>(
    `select id, session_id, prompt, status, runtime, transcript_json, created_at, finished_at from agent_runs
      where board_id = ? and created_by = ? and (crew_name = ? or crew_name like ? escape '\\')
      order by created_at desc limit ?`,
    boardId, userId, n, `${n.replace(/[\\%_]/g, (c) => `\\${c}`)} %`, Math.max(1, Math.min(10, limit)),
  ).map((r) => ({ id: r.id, session: r.session_id, prompt: r.prompt, status: r.status, runtime: r.runtime, at: r.created_at, finishedAt: r.finished_at, events: JSON.parse(r.transcript_json ?? "[]") as AgentEvent[] }));
}

export function titleOf(prompt: string) {
  const line = prompt.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
