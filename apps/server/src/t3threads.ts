/**
 * A T3 thread as someone on the board: a person asks one of this computer's
 * agents (Claude, Codex, Kimi, DeepSeek, …) for something in a section, and
 * that agent joins the section's group under its own name, like any of the
 * crew, for as long as its thread works (crew.ts gives it the presence; the
 * section's tab and the agents pane draw it).
 *
 * The thread runs in Foundation's own T3 (t3host.ts), supervised, in a folder
 * of its board (`<data>/t3-work/<board>`). It runs a model on someone's plan
 * or key, so it starts only from a person's press (index.ts: requirePerson
 * and a writer of the board).
 *
 * The board's tools: each ask gets a folder of its own
 * (`<data>/t3-work/<board>/<ask>`) holding a tool file that points the agent
 * at Foundation's tool server as this ask's crew member, for this person and
 * this board, with a session of its own that ends when the thread does. The
 * agent's launch line names that file (t3host.ts: BOARD_TOOL_ARGS), so a
 * Claude-driven agent (Claude, Kimi, DeepSeek) reads the board, makes cards
 * in the section it stands in under its own name, and aims its cursor like
 * any of the crew. An agent of another kind (Codex), or one whose launch line
 * a person changed, works in its folder only, and its brief says so.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardMaps, findSection, logActivity } from "@foundation/protocol";
import type { UserInfo } from "@foundation/protocol";
import { config } from "./config.ts";
import { createSession, revokeSession } from "./auth.ts";
import { boardDigest, editBoard, getBoard } from "./boards.ts";
import { aim, joinCrew, leaveCrew, seatName, setDoing, type CrewMember } from "./crew.ts";
import { HttpError } from "./http.ts";
import { audit } from "./audit.ts";
import { BOARD_TOOLS_FILE, interruptT3Thread, onT3Work, startT3Thread, t3Host, type T3Work } from "./t3host.ts";

interface Bound {
  threadId: string;
  boardId: string;
  sectionId: string;
  by: string;
  member: CrewMember;
  /** T3 has shown it at work: after that, at rest means done */
  worked: boolean;
  at: number;
  /** its pass to the board's tools (a session of its own), and the file that carries it */
  token?: string;
  toolsFile?: string;
}

/** how long an ask's pass to the board lasts at most (it ends with the thread) */
const PASS_MS = 12 * 3600_000;
let askSeq = 0;

/** what the agent is told before the ask: where it is, and what it has to work with */
export function t3Brief(o: { board: string; section: string; person: string; name: string; tools: boolean; digest: string; text: string }) {
  const where = `You are ${o.name}, working on the Foundation board "${o.board}" for ${o.person}, in the section “${o.section}”. Foundation is a shared grid: sections hold cards (notes, tables, files, apps), and everyone on the board sees them.`;
  const how = o.tools
    ? `Your board tools are the mcp__foundation__* tools. Read the board before you change it, put what you make in “${o.section}” as cards unless asked otherwise, and finish by saying in a line or two what you did. People see the board, not this folder: work that should be seen belongs on a card.`
    : `You have no board tools in this thread: you can't read or change the board. Work in this folder and say plainly in your answer what you made and where, so ${o.person} can bring it onto the board.`;
  return `${where}\n${how}\n\n<board name="${o.board}">\n${o.digest}\n</board>\n\n<ask from="${o.person}">\n${o.text}\n</ask>`;
}

const bound = new Map<string, Bound>();
/** a thread T3 never showed at work is let go after this long */
const NEVER_STARTED_MS = () => Number(process.env.FOUNDATION_T3_START_MS ?? "45000") || 45_000;

export function t3Bound(threadId: string) {
  const b = bound.get(threadId);
  return b ? { boardId: b.boardId, sectionId: b.sectionId, by: b.by, crew: b.member.id } : undefined;
}

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** a person asks one of T3's agents for something in a section */
export async function askT3(user: UserInfo, input: { board: string; section: string; agent: string; model?: string; text: string; as?: string }) {
  const text = (input.text ?? "").trim();
  if (!text) throw new HttpError(400, "Say what you need.");
  if (t3Host().state !== "running") throw new HttpError(409, "T3 isn't running. Start it from the agents pane.");
  const doc = getBoard(input.board).doc;
  const section = findSection(doc, input.section);
  if (!section) throw new HttpError(404, "no such section on this board");
  const agent = t3Host().agents.find((a) => a.id === input.agent);
  if (!agent) throw new HttpError(404, `T3 has no agent "${input.agent}"`);
  // its place on the board first: a board that's full says so before anything is spent
  let member: CrewMember;
  try {
    member = joinCrew({ boardId: input.board, userId: user.id, userName: user.name, runId: `t3:${Date.now()}:${Math.random()}`, task: text, name: seatName(input.as) ?? agent.name, via: `t3:${agent.id}` });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  aim(member, { id: section.id, kind: "section" }, "starting");
  // a folder for this ask alone, so its tool file (and its pass) is this thread's and nobody else's
  const folder = join(config.dataDir, "t3-work", input.board.replace(/[^a-zA-Z0-9_-]/g, "_"), `${Date.now().toString(36)}-${(++askSeq).toString(36)}`);
  let token: string | undefined;
  let toolsFile: string | undefined;
  try {
    mkdirSync(folder, { recursive: true });
    if (agent.boardTools) {
      token = createSession(user.id, PASS_MS, "agent");
      toolsFile = join(folder, BOARD_TOOLS_FILE);
      writeFileSync(
        toolsFile,
        JSON.stringify({ mcpServers: { foundation: { type: "http", url: `http://${config.host}:${config.port}/mcp?board=${encodeURIComponent(input.board)}&crew=${encodeURIComponent(member.id)}`, headers: { Authorization: `Bearer ${token}` } } } }),
        { mode: 0o600 },
      );
    }
    const brief = t3Brief({ board: input.board, section: section.name, person: user.name, name: member.name, tools: agent.boardTools, digest: boardDigest(input.board), text });
    const started = await startT3Thread({ agent: agent.id, model: input.model, title: short(text.split("\n")[0], 80), text: brief, folder, projectTitle: `Foundation · ${input.board} · ${short(text.split("\n")[0], 40)}` });
    const b: Bound = { threadId: started.threadId, boardId: input.board, sectionId: section.id, by: user.id, member, worked: false, at: Date.now(), token, toolsFile };
    bound.set(started.threadId, b);
    audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, board_id: input.board, door: "route", action: "t3_thread.start", target: `${started.threadId} ${agent.id}`, provenance: "ours-local", service: `T3 · ${agent.id}`, decision: "allowed", approved_by: user.id, result: "ok" });
    setDoing(member, `starting on ${started.model}`);
    // T3 may have shown the thread at work before the start call came back: catch up
    const now = t3Host().work.find((w) => w.id === started.threadId);
    if (now) followT3Work(started.threadId, now);
    editBoard(input.board, "t3", (d) => logActivity(d, { who: member.name, role: "agent", text: `took “${short(text)}” (${started.model}, through T3)`, objectId: section.id, for: user.name }));
    setTimeout(() => {
      const still = bound.get(started.threadId);
      if (still && !still.worked) release(still, "error");
    }, NEVER_STARTED_MS()).unref?.();
    return { threadId: started.threadId, crew: member.id, name: member.name, model: started.model, boardTools: agent.boardTools };
  } catch (e) {
    endPass(token, toolsFile);
    leaveCrew(member, "error", 0);
    throw new HttpError(502, (e as Error).message);
  }
}

/** an ask's pass ends: its session is revoked and the file that carried it is removed */
function endPass(token?: string, file?: string) {
  if (token) revokeSession(token);
  if (file) rmSync(file, { force: true });
}

function release(b: Bound, how: "done" | "stopped" | "error") {
  bound.delete(b.threadId);
  endPass(b.token, b.toolsFile);
  leaveCrew(b.member, how);
}

/** a person stops a thread they asked for (an admin can stop anyone's) */
export async function stopT3Thread(user: UserInfo, threadId: string) {
  const b = bound.get(threadId);
  if (b && b.by !== user.id && user.role !== "admin") throw new HttpError(403, "Only the person who asked (or an admin) can stop it.");
  await interruptT3Thread(threadId).catch((e) => {
    throw new HttpError(502, (e as Error).message);
  });
  if (b) release(b, "stopped");
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, board_id: b?.boardId ?? null, door: "route", action: "t3_thread.stop", target: threadId, decision: "allowed", result: "ok" });
  return { stopped: true };
}

/** T3 says a thread changed: its agent's presence on the board follows */
export function followT3Work(threadId: string, work: T3Work | null) {
  const b = bound.get(threadId);
  if (!b) return;
  if (!work) return release(b, "stopped");
  if (work.state === "working") {
    b.worked = true;
    setDoing(b.member, "working");
  } else if (work.state === "waiting") {
    b.worked = true;
    setDoing(b.member, "waiting for a person in T3");
  } else if (work.state === "error") release(b, "error");
  else if (b.worked) release(b, "done");
}
onT3Work(followT3Work);

/** which of T3's threads belong to which section, for the pane (thread id → where and who) */
export function t3Bindings(boardId: string): Record<string, { section: string; sectionName: string; crew: string; by: string }> {
  const out: Record<string, { section: string; sectionName: string; crew: string; by: string }> = {};
  for (const b of bound.values()) {
    if (b.boardId !== boardId) continue;
    const s = boardMaps(getBoard(boardId).doc).sections.get(b.sectionId);
    out[b.threadId] = { section: b.sectionId, sectionName: (s as { name?: string } | undefined)?.name ?? "", crew: b.member.id, by: b.by };
  }
  return out;
}

export function _resetT3Threads() {
  for (const b of [...bound.values()]) release(b, "stopped");
}
