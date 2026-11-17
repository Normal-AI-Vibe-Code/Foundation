/**
 * Agents run commands in a machine a person started, one command at a time,
 * each one approved by a person.
 *
 * An agent asks (`machine_run`): the command, and a few words on why. The
 * ask goes on the machine's card for everyone on the board (the board's
 * `machineAsks` map, written by the server alone) and the agent's tool call
 * waits. A person who can edit the board presses Run or Decline, from their
 * browser: a bearer token (an agent, MCP, the service token) can't answer,
 * and neither can a viewer. Run executes it in the machine (an exec through
 * the Engine API, no terminal, under a time limit) and the agent gets its
 * output and exit code. Declined, unanswered (the wait runs out) or withdrawn
 * (the agent stopped): nothing ran, and the agent is told so in words.
 *
 * The board's activity gets two lines per command: the ask (the agent, for
 * its person) and what became of it (who ran it and its exit code, who
 * declined it, or that nobody answered).
 *
 * What's waiting lives in this process: a server restart drops the waits
 * (the agents' calls end with it) and the card's waiting asks say withdrawn
 * once the server is back (sweepStaleAsks).
 */

import { boardMaps, logActivity, machineAsksOf, uid, type MachineAsk, type PanelDoc } from "@foundation/protocol";
import { editBoard, getBoard, onBoardOpen } from "./boards.ts";
import { execOnce } from "./machines.ts";
import { canWrite } from "./roles.ts";
import { HttpError } from "./http.ts";
import { aim, crewMember, setDoing } from "./crew.ts";

/** how long an ask waits for a person, by default and at most */
export function askWaitMs() {
  const v = Number(process.env.FOUNDATION_MACHINE_ASK_MS ?? "120000");
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}
const MAX_WAIT_S = 600;
/** asks kept on a card (waiting ones and the last few answered) */
const KEEP = 6;
/** waiting at once on one machine */
const MAX_WAITING = 3;
/** what the card shows of the output */
const CARD_OUTPUT = 1200;

type Decision = { kind: "run"; by: string } | { kind: "decline"; by: string } | { kind: "timeout" } | { kind: "withdrawn" };

interface Waiting {
  boardId: string;
  panelId: string;
  ask: MachineAsk;
  decide: (d: Decision) => void;
}

const waiting = new Map<string, Waiting>();

export interface AskResult {
  status: "done" | "declined" | "timed out" | "withdrawn" | "failed";
  /** what the agent should know, in words */
  message: string;
  exit_code?: number | null;
  output?: string;
  ran_by?: string;
  declined_by?: string;
  ms?: number;
}

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const code = (s: string) => `\`${short(s.replace(/\s+/g, " ").trim())}\``;

/** a machine card by id, or by its machine's or card's name */
export function findMachineCard(boardId: string, ref: string): PanelDoc | undefined {
  const objects = [...boardMaps(getBoard(boardId).doc).objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "machine");
  const needle = ref.trim().toLowerCase();
  return objects.find((o) => o.id === ref) ?? objects.find((o) => o.machine?.name === needle) ?? objects.find((o) => o.name.trim().toLowerCase() === needle);
}

function writeAsk(boardId: string, panelId: string, ask: MachineAsk, line?: { who: string; role: "human" | "agent"; text: string; for?: string }) {
  editBoard(boardId, "machines", (doc) => {
    const m = boardMaps(doc);
    const list = machineAsksOf(doc, panelId).filter((a) => a.id !== ask.id);
    list.push(ask);
    // keep every waiting one, then the newest answered ones
    const open = list.filter((a) => a.state === "waiting" || a.state === "running");
    const closed = list.filter((a) => a.state !== "waiting" && a.state !== "running").slice(-Math.max(0, KEEP - open.length));
    m.machineAsks.set(panelId, list.filter((a) => open.includes(a) || closed.includes(a)));
    if (line) logActivity(doc, { ...line, objectId: panelId });
  });
}

/**
 * An agent asks to run a command; resolves when a person answers, nobody
 * does in time, or the agent stops. Runs it if a person pressed Run.
 */
export async function askToRun(
  ctx: { boardId: string; actor: string; userId: string; crew?: string; forName?: string },
  machineRef: string,
  command: string,
  opts: { why?: string; waitS?: number; timeoutS?: number } = {},
): Promise<AskResult> {
  const card = findMachineCard(ctx.boardId, machineRef);
  if (!card || !card.machine) throw new Error(`no machine called “${machineRef}” on this board (machines lists them)`);
  const name = card.machine.name;
  if (card.machine.state !== "running") {
    throw new Error(`${name} isn't running (${card.machine.state}). A person starts it from its card; propose_machine makes one.`);
  }
  const cmd = command.trim();
  if (!cmd) throw new Error("say the command to run");
  const doc = getBoard(ctx.boardId).doc;
  const open = machineAsksOf(doc, card.id).filter((a) => a.state === "waiting" && waiting.has(a.id));
  if (open.some((a) => a.by === ctx.actor)) throw new Error(`you already have a command waiting on ${name}; wait for its answer`);
  if (open.length >= MAX_WAITING) throw new Error(`${name} already has ${MAX_WAITING} commands waiting for a person`);

  const waitMs = opts.waitS ? Math.min(MAX_WAIT_S, opts.waitS) * 1000 : askWaitMs();
  const ask: MachineAsk = {
    id: uid("ask"),
    command: cmd,
    ...(opts.why ? { why: short(opts.why, 160) } : {}),
    by: ctx.actor,
    ...(ctx.forName ? { for: ctx.forName } : {}),
    state: "waiting",
    at: Date.now(),
    expiresAt: Date.now() + waitMs,
  };
  writeAsk(ctx.boardId, card.id, ask, { who: ctx.actor, role: "agent", text: `asked to run ${code(cmd)} in ${name}`, ...(ctx.forName ? { for: ctx.forName } : {}) });
  const member = crewMember(ctx.crew);
  if (member) {
    aim(member, { id: card.id, kind: "object" }, `waiting for a person to run ${short(cmd, 40)}`);
  }

  const decision = await new Promise<Decision>((resolve) => {
    let settled = false;
    const finish = (d: Decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      waiting.delete(ask.id);
      resolve(d);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), waitMs);
    // the agent stopped (Stop, Stop all, the run ended): withdraw the ask
    const watch = setInterval(() => {
      if (ctx.crew && !crewMember(ctx.crew)) finish({ kind: "withdrawn" });
    }, 500);
    timer.unref?.();
    watch.unref?.();
    waiting.set(ask.id, { boardId: ctx.boardId, panelId: card.id, ask, decide: finish });
  });

  const forLine = ctx.forName ? { for: ctx.forName } : {};
  if (decision.kind === "timeout") {
    writeAsk(ctx.boardId, card.id, { ...ask, state: "timed out", endedAt: Date.now() }, { who: ctx.actor, role: "agent", text: `nobody answered its ask to run ${code(cmd)} in ${name}; nothing ran`, ...forLine });
    return { status: "timed out", message: `Nobody pressed Run within ${Math.round(waitMs / 1000)} s, so nothing ran. Tell the person what you wanted to run and why, or ask again when they're there.` };
  }
  if (decision.kind === "withdrawn") {
    writeAsk(ctx.boardId, card.id, { ...ask, state: "withdrawn", endedAt: Date.now() });
    return { status: "withdrawn", message: "You stopped before anyone answered; nothing ran." };
  }
  if (decision.kind === "decline") {
    writeAsk(ctx.boardId, card.id, { ...ask, state: "declined", decidedBy: decision.by, decidedAt: Date.now(), endedAt: Date.now() }, { who: decision.by, role: "human", text: `declined ${ctx.actor}'s ${code(cmd)} in ${name}` });
    if (member) setDoing(member, `${decision.by.split(" ")[0]} declined it`);
    return { status: "declined", declined_by: decision.by, message: `${decision.by} declined it, so nothing ran. Don't run it another way; ask them what they'd like instead.` };
  }

  // a person pressed Run
  const running: MachineAsk = { ...ask, state: "running", decidedBy: decision.by, decidedAt: Date.now() };
  delete running.expiresAt;
  writeAsk(ctx.boardId, card.id, running);
  if (member) setDoing(member, `running ${short(cmd, 50)}`);
  try {
    const r = await execOnce(ctx.boardId, card.id, cmd, opts.timeoutS ?? 120);
    const exit = r.timedOut ? "timed out" : r.exitCode === null ? "no exit code" : `exit ${r.exitCode}`;
    writeAsk(
      ctx.boardId,
      card.id,
      { ...running, state: "done", ...(r.exitCode !== null ? { exitCode: r.exitCode } : {}), output: r.output.slice(-CARD_OUTPUT), endedAt: Date.now() },
      { who: decision.by, role: "human", text: `ran ${ctx.actor}'s ${code(cmd)} in ${name}: ${exit}` },
    );
    return {
      status: "done",
      ran_by: decision.by,
      exit_code: r.exitCode,
      output: (r.cut ? "…(earlier output cut)\n" : "") + r.output,
      ms: r.ms,
      message: r.timedOut ? `${decision.by} ran it; it was still going after its time limit and was stopped.` : `${decision.by} ran it: ${exit}.`,
    };
  } catch (e) {
    const why = (e as Error).message;
    writeAsk(ctx.boardId, card.id, { ...running, state: "failed", output: why.slice(0, CARD_OUTPUT), endedAt: Date.now() }, { who: decision.by, role: "human", text: `ran ${ctx.actor}'s ${code(cmd)} in ${name}; it couldn't start: ${short(why, 100)}` });
    return { status: "failed", ran_by: decision.by, message: `${decision.by} pressed Run, but it couldn't start: ${why}` };
  }
}

/**
 * A person answers an ask on the card. Only from their browser (the route
 * checks requirePerson) and only if they can edit the board.
 */
export function answerAsk(boardId: string, panelId: string, askId: string, person: { id: string; name: string }, verdict: "run" | "decline"): MachineAsk {
  if (!canWrite(person.id, boardId)) throw new HttpError(403, `View only: someone who can edit “${boardId}” answers an agent's command`);
  const w = waiting.get(askId);
  if (!w || w.boardId !== boardId || w.panelId !== panelId) throw new HttpError(404, "That command isn't waiting any more (it was answered, ran out of time, or its agent stopped)");
  w.decide(verdict === "run" ? { kind: "run", by: person.name } : { kind: "decline", by: person.name });
  return w.ask;
}

/** for tests: the asks waiting for a person */
export function waitingAsks() {
  return [...waiting.values()].map((w) => ({ ...w.ask, boardId: w.boardId, panelId: w.panelId }));
}

/**
 * A board loaded after a restart may show asks as waiting (or running) that
 * no agent waits on any more: they say withdrawn, so nobody presses Run on
 * nothing.
 */
function sweepStaleAsks(boardId: string) {
  const doc = getBoard(boardId).doc;
  const m = boardMaps(doc);
  const stale: Array<[string, MachineAsk[]]> = [];
  for (const [panelId, list] of m.machineAsks.entries()) {
    if (list.some((a) => (a.state === "waiting" || a.state === "running") && !waiting.has(a.id))) {
      stale.push([panelId, list.map((a) => ((a.state === "waiting" || a.state === "running") && !waiting.has(a.id) ? { ...a, state: "withdrawn" as const, endedAt: Date.now() } : a))]);
    }
  }
  if (stale.length) editBoard(boardId, "machines", () => stale.forEach(([id, list]) => m.machineAsks.set(id, list)));
}

let swept = false;
/** start sweeping stale asks on each board as it loads (index.ts) */
export function startMachineAsks() {
  if (swept) return;
  swept = true;
  onBoardOpen((b) => queueMicrotask(() => sweepStaleAsks(b.id)));
}
