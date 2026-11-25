/**
 * Code mode (docs/agent-harness.md §3): two tools on the one tool surface.
 *
 *   search_tools { query, limit? }   the matching tools as TypeScript signatures
 *   run_code { code, request_id? }   a script, run in a QuickJS isolate, that calls
 *                                    foundation.<tool>(args) as a typed API
 *
 * The same pattern as UTCP's code-mode, built natively: their package runs the
 * model's code in Node's `vm`, which is not a boundary. Here each script gets
 * its own worker thread (codemode-worker.mjs) holding a fresh WebAssembly
 * instance of QuickJS, with an empty environment, no Node inside the isolate,
 * a memory and stack limit, and an interrupt at the deadline; this thread
 * terminates the worker at the deadline too, so a loop never holds up the
 * server. Only JSON crosses, both ways.
 *
 * Every inner call goes through runTool with the caller's own ToolCtx: the
 * board is named, a viewer's writes are refused, the external-send gate and
 * person-only checks are the tool's own, deletes still need confirm, and each
 * call is audited and shows in activity as it would alone. A script never
 * reaches run_code itself.
 */

import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
// types only: tools.ts hands this module the surface (codeTools), so the two never wait on each other while loading
import type { BoardTool, ToolCtx } from "./tools.ts";

/** results runTool never replays under their request_id (a failed script runs again; its own calls are idempotent) */
export const NO_REPLAY = new WeakSet<object>();

/** the one tool surface, as tools.ts hands it over */
interface Surface {
  tools: () => BoardTool[];
  run: (ctx: ToolCtx, name: string, input: unknown) => Promise<unknown>;
}
let surface: Surface | null = null;
function wired(): Surface {
  if (!surface) throw new Error("code mode isn't wired to the tool surface: import tools.ts");
  return surface;
}

export const CODE_LIMITS = {
  ms: 20_000,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  calls: 40,
  codeBytes: 64 * 1024,
  resultBytes: 256 * 1024,
  logLines: 200,
  logChars: 2000,
  /** one tool's answer, as JSON, handed into the isolate */
  callResultBytes: 1024 * 1024,
  /** scripts running at once on this server, and for one person */
  concurrent: 4,
  perUser: 2,
  /** after the deadline, how long the answer waits for tool calls already running to finish */
  settleMs: 10_000,
};

/** what /mcp?mode=code lists: the two code-mode tools and the few an agent calls alone */
export const CODE_MODE_TOOLS = ["search_tools", "run_code", "read_board", "read_card", "set_plan", "point_at", "bring_view"] as const;

export interface CodeCall {
  tool: string;
  ok: boolean;
  summary: string;
}
export type RunCodeResult =
  | { result: unknown; logs: string[]; calls: CodeCall[] }
  | { error: { message: string; line?: number }; logs: string[]; calls: CodeCall[] };

// ---------------------------------------------------------------------------
// JSON schema → TypeScript
// ---------------------------------------------------------------------------

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  default?: unknown;
  minItems?: number;
  maxItems?: number;
};

const IDENT = /^[A-Za-z_$][\w$]*$/;
const comment = (s: string) => s.replace(/\*\//g, "*\\/").replace(/\s+/g, " ").trim();
const wrapUnion = (t: string) => (/[|&]/.test(t) && !/^[{[(]/.test(t) ? `(${t})` : t);

function tsOf(s: JsonSchema | boolean | undefined, docs: boolean): string {
  if (s === undefined || s === true) return "unknown";
  if (s === false) return "never";
  const alts = s.anyOf ?? s.oneOf;
  if (alts?.length) return [...new Set(alts.map((a) => tsOf(a, docs)))].join(" | ");
  if (s.allOf?.length) return s.allOf.map((a) => wrapUnion(tsOf(a, docs))).join(" & ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(s.type)) return [...new Set(s.type.map((t) => tsOf({ ...s, type: t }, docs)))].join(" | ");
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (Array.isArray(s.items)) return `[${s.items.map((i) => tsOf(i, docs)).join(", ")}]`;
      return `${wrapUnion(tsOf(s.items, docs))}[]`;
    }
    case "object": {
      const props = Object.entries(s.properties ?? {});
      const extra = s.additionalProperties;
      if (!props.length) return extra && typeof extra === "object" ? `Record<string, ${tsOf(extra, docs)}>` : "Record<string, unknown>";
      const req = new Set(s.required ?? []);
      const fields = props.map(([k, v]) => {
        const doc = docs && typeof v === "object" && v.description ? `/** ${comment(v.description)} */ ` : "";
        return `${doc}${IDENT.test(k) ? k : JSON.stringify(k)}${req.has(k) ? "" : "?"}: ${tsOf(v, docs)}`;
      });
      if (extra && typeof extra === "object") fields.push(`[key: string]: ${tsOf(extra, docs)}`);
      return `{ ${fields.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

const schemaCache = new Map<string, JsonSchema>();
function jsonSchemaOf(t: BoardTool): JsonSchema {
  let s = schemaCache.get(t.name);
  if (!s) {
    s = zodToJsonSchema(t.schema, { $refStrategy: "none" }) as JsonSchema;
    schemaCache.set(t.name, s);
  }
  return s;
}

/** one tool as a method of `foundation`: `add_table(args: { … }): Promise<unknown>` */
export function toolSignature(t: BoardTool, docs = true): string {
  const s = jsonSchemaOf(t);
  const args = tsOf(s, docs);
  const optional = !(s.required ?? []).length;
  return `${t.name}(args${optional ? "?" : ""}: ${args}): Promise<unknown>`;
}

/** the tools a script can call: every tool but run_code (no recursion) */
export function scriptTools(): BoardTool[] {
  return wired().tools().filter((t) => t.name !== "run_code");
}

/** the whole surface a script sees, as one declaration file */
export function toolApiDts(): string {
  const lines = scriptTools().map((t) => `  /** ${comment(t.description)} */\n  ${toolSignature(t)};`);
  return `/** Foundation's tools, as run_code's scripts call them: await foundation.<tool>({ … }) */\ndeclare const foundation: {\n${lines.join("\n")}\n};\n`;
}

// ---------------------------------------------------------------------------
// search_tools
// ---------------------------------------------------------------------------

const STOP = new Set(["a", "an", "the", "to", "of", "and", "or", "for", "in", "on", "with", "it", "is", "by", "from", "at", "as", "my", "me", "i", "some", "that", "this"]);
const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);

const CATEGORIES: Array<[string, RegExp]> = [
  ["Code mode", /^(search_tools|run_code)$/],
  ["Chat", /^chat_/],
  ["Machines, desktops and browsers", /^(machines?|machine_run|propose_machine|desktop_\w+|browser_\w+)$/],
  ["Collections", /^(read_collection|collection_\w+|add_character_pipeline)$/],
  ["Design pipeline and characters", /^(start_design_pipeline|pipeline_status|stage_\w+|complete_stage|add_character|vision_brief|reverse_engineer)$/],
  ["Company data, files, repos and apps", /^(company|flowform|read_file|bring_file|place_file|places|find_repo|read_repo|app_tools|call_app_tool|slack_read|add_slack_channel)$/],
  ["People and Today", /^(today|set_goal|set_company_goal|set_profile|point_today|ask_person)$/],
  ["Huddles and replays", /^(open_huddle|huddle_transcript|replay_timeline|add_replay)$/],
  ["Agents: plan, crew, pointing", /^(set_plan|crew_work|call_in_help|point_at|bring_view|focus|write_digest)$/],
];
const categoryOf = (name: string) => CATEGORIES.find(([, re]) => re.test(name))?.[0] ?? "Board: sections, cards and tables";
const TOP = ["read_board", "search", "add_section", "add_note", "add_table", "update_card"];

export function searchTools(query: string, limit = 5) {
  const TOOLS = wired().tools();
  const n = Math.max(1, Math.min(20, Math.floor(limit) || 5));
  const q = words(query ?? "");
  const entry = (t: BoardTool) => ({ name: t.name, description: t.description, signature: toolSignature(t) });
  if (!q.length) {
    const cats = new Map<string, string[]>();
    for (const t of TOOLS) {
      const c = categoryOf(t.name);
      cats.set(c, [...(cats.get(c) ?? []), t.name]);
    }
    return {
      categories: [...cats].map(([name, tools]) => ({ name, count: tools.length, tools })),
      top: TOP.map((name) => TOOLS.find((t) => t.name === name)).filter((t): t is BoardTool => Boolean(t)).map(entry),
    };
  }
  const scored = TOOLS.map((t) => {
    const nameWords = new Set(words(t.name.replace(/_/g, " ")));
    const descWords = words(t.description);
    const desc = new Set(descWords);
    const props = new Set(words(Object.keys(jsonSchemaOf(t).properties ?? {}).join(" ")));
    let score = 0;
    for (const w of q) {
      if (nameWords.has(w)) score += 4;
      if (desc.has(w)) score += 1 + Math.min(2, descWords.filter((d) => d === w).length - 1) * 0.25;
      if (props.has(w)) score += 1;
      if (!nameWords.has(w) && [...nameWords].some((x) => x.startsWith(w) || w.startsWith(x))) score += 1;
    }
    if (t.name === query.trim()) score += 10;
    return { t, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return { matches: scored.slice(0, n).map((x) => entry(x.t)), more: Math.max(0, scored.length - n) };
}

// ---------------------------------------------------------------------------
// run_code
// ---------------------------------------------------------------------------

let running = 0;
const runningFor = new Map<string, number>();

/** a script's identity for request ids: the same id with different code is a different request */
export function codeHash(code: string) {
  return createHash("sha256").update(code).digest("hex").slice(0, 12);
}

/** for tests: runs inside the slot, before the worker starts */
export const codeModeHooks: { beforeSpawn: null | (() => void) } = { beforeSpawn: null };

/** a short line on what a call gave back, for the caller's record */
function summarize(out: unknown): string {
  if (typeof out === "string") return out.slice(0, 120);
  if (Array.isArray(out)) return `${out.length} items`;
  if (out && typeof out === "object") {
    const o = out as Record<string, unknown>;
    const bits = ["id", "name", "title"].filter((k) => typeof o[k] === "string").map((k) => `${k} ${String(o[k]).slice(0, 60)}`);
    return bits.length ? bits.join(", ") : `{ ${Object.keys(o).slice(0, 6).join(", ")} }`;
  }
  return String(out).slice(0, 120);
}

/** a tool's answer as the script gets it: JSON, with any picture left out (a script can't look at one) */
function forScript(out: unknown): string | undefined {
  if (out === undefined) return undefined;
  if (out && typeof out === "object" && !Array.isArray(out) && "_image" in out) {
    const { _image, ...rest } = out as Record<string, unknown>;
    void _image;
    out = { ...rest, picture: "left out: a script can't see pictures; call this tool directly to look" };
  }
  return JSON.stringify(out);
}

/** where the worker file is: beside this one, from source and in the bundle */
const WORKER_URL = new URL("./codemode-worker.mjs", import.meta.url);

export async function runCode(ctx: ToolCtx, input: { code: string; request_id?: string }): Promise<RunCodeResult> {
  const logs: string[] = [];
  const calls: CodeCall[] = [];
  const fail = (message: string, line?: number): RunCodeResult => {
    const r: RunCodeResult = { error: line ? { message, line } : { message }, logs, calls };
    NO_REPLAY.add(r); // a failed script runs again under the same request_id; its inner writes are idempotent by their own
    return r;
  };
  if (Buffer.byteLength(input.code) > CODE_LIMITS.codeBytes) return fail(`the script is longer than ${CODE_LIMITS.codeBytes / 1024} KB`);
  if (running >= CODE_LIMITS.concurrent) return fail(`busy: ${CODE_LIMITS.concurrent} scripts are already running on this server; try again in a moment`);
  const mine = runningFor.get(ctx.userId) ?? 0;
  if (mine >= CODE_LIMITS.perUser) return fail(`busy: ${CODE_LIMITS.perUser} of this person's scripts are already running; wait for one to finish`);
  running++;
  runningFor.set(ctx.userId, mine + 1);
  let worker: Worker | null = null;
  try {
    return await runInWorker(ctx, input, logs, calls, fail, (w) => (worker = w));
  } finally {
    running--;
    const left = (runningFor.get(ctx.userId) ?? 1) - 1;
    if (left > 0) runningFor.set(ctx.userId, left);
    else runningFor.delete(ctx.userId);
    void (worker as Worker | null)?.terminate();
  }
}

async function runInWorker(
  ctx: ToolCtx,
  input: { code: string; request_id?: string },
  logs: string[],
  calls: CodeCall[],
  fail: (message: string, line?: number) => RunCodeResult,
  started: (w: Worker) => void,
): Promise<RunCodeResult> {
  codeModeHooks.beforeSpawn?.();
  const names = scriptTools().map((t) => t.name);
  const allowed = new Set(names);
  // inner request ids carry the script's hash: a different script under the same id never replays this one's calls
  const scope = input.request_id ? `${input.request_id}:${codeHash(input.code)}` : null;
  const deadline = Date.now() + CODE_LIMITS.ms;
  let n = 0;
  let closed = false; // the script has ended (or run out of time): no new calls start
  const inflight = new Map<Promise<unknown>, string>();
  const worker = new Worker(WORKER_URL, {
    workerData: {
      code: input.code,
      names,
      deadline,
      memoryBytes: CODE_LIMITS.memoryBytes,
      stackBytes: CODE_LIMITS.stackBytes,
      maxCalls: CODE_LIMITS.calls,
      maxLogLines: CODE_LIMITS.logLines,
      maxLogChars: CODE_LIMITS.logChars,
    },
    env: {}, // nothing of the server's environment
    execArgv: [], // no loaders or flags of the server's
    stdout: true, // the isolate has no way to print, and the thread's own output goes nowhere
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  started(worker);
  const reply = (m: { id: number; ok: boolean; value?: string; message?: string }) => {
    try {
      worker.postMessage({ t: "reply", ...m });
    } catch {
      /* the worker has ended */
    }
  };
  const onCall = async (id: number, name: string, args: string) => {
    const i = ++n;
    if (closed || Date.now() > deadline) {
      calls.push({ tool: String(name).slice(0, 40), ok: false, summary: "refused: the script had run out of time" });
      return reply({ id, ok: false, message: "the script ran past its time limit; no more tool calls" });
    }
    if (i > CODE_LIMITS.calls) {
      calls.push({ tool: name, ok: false, summary: `refused: a script makes at most ${CODE_LIMITS.calls} tool calls` });
      return reply({ id, ok: false, message: `limit: a script makes at most ${CODE_LIMITS.calls} tool calls` });
    }
    if (!allowed.has(name)) {
      calls.push({ tool: String(name).slice(0, 40), ok: false, summary: "no such tool here" });
      return reply({ id, ok: false, message: name === "run_code" ? "run_code can't be called from inside a script" : `unknown tool ${String(name).slice(0, 40)}` });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      calls.push({ tool: name, ok: false, summary: "arguments weren't one JSON object" });
      return reply({ id, ok: false, message: `foundation.${name} takes one object of arguments` });
    }
    const a = parsed as Record<string, unknown>;
    // a retried script doesn't write twice: each call's request_id is the script's own, numbered by call order
    if (typeof a.request_id !== "string" && scope) a.request_id = `${scope}:${i}`;
    try {
      const out = await wired().run(ctx, name, a);
      const json = forScript(out);
      if (json !== undefined && json.length > CODE_LIMITS.callResultBytes) {
        calls.push({ tool: name, ok: true, summary: `${summarize(out)} (too large to hand to the script)` });
        return reply({ id, ok: false, message: `${name}'s answer is over ${CODE_LIMITS.callResultBytes / 1024 / 1024} MB, too large for a script; call it directly` });
      }
      calls.push({ tool: name, ok: true, summary: summarize(out) });
      reply({ id, ok: true, value: json });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      calls.push({ tool: name, ok: false, summary: message.slice(0, 200) });
      reply({ id, ok: false, message });
    }
  };

  try {
    const done = await new Promise<{ ok: true; result: string | null } | { ok: false; error: { message: string; line?: number } }>((resolve) => {
      const kill = setTimeout(() => resolve({ ok: false, error: { message: "the script ran past its time limit and was stopped" } }), CODE_LIMITS.ms + 1000);
      const end = (v: Parameters<typeof resolve>[0]) => {
        clearTimeout(kill);
        resolve(v);
      };
      worker.on("message", (m: { t: string; [k: string]: unknown }) => {
        if (m?.t === "call") {
          const p = onCall(Number(m.id), String(m.name), String(m.args));
          inflight.set(p, String(m.name).slice(0, 40));
          void p.finally(() => inflight.delete(p));
        } else if (m?.t === "over") {
          calls.push({ tool: String(m.name).slice(0, 40), ok: false, summary: `refused: a script makes at most ${CODE_LIMITS.calls} tool calls` });
        } else if (m?.t === "log") {
          if (logs.length < CODE_LIMITS.logLines) logs.push(String(m.line));
        } else if (m?.t === "done") {
          end(m.ok ? { ok: true, result: (m.result as string | null) ?? null } : { ok: false, error: m.error as { message: string; line?: number } });
        }
      });
      worker.on("error", (e) => end({ ok: false, error: { message: e instanceof RangeError ? "the script recursed too deeply (stack overflow)" : `the sandbox stopped: ${e.message}` } }));
      worker.on("exit", () => end({ ok: false, error: { message: "the sandbox stopped" } }));
    });
    closed = true;
    // calls already running finish before the answer (and before the slot frees), so nothing lands after it
    // and `calls` is whole; bounded, and what was still running is named
    if (inflight.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...inflight.keys()]), new Promise((r) => (timer = setTimeout(r, Math.max(0, deadline + CODE_LIMITS.settleMs - Date.now()))))]);
      clearTimeout(timer);
    }
    if (inflight.size) {
      const still = [...inflight.values()];
      const why = done.ok ? "the script finished" : (done.error?.message ?? "the script failed");
      return fail(`${why}, but ${still.length === 1 ? "a tool call was" : `${still.length} tool calls were`} still running when the answer had to go (${still.join(", ")}): ${still.length === 1 ? "its" : "their"} change may land after this; read the board before running it again`);
    }
    if (!done.ok) return fail(done.error?.message ?? "the script failed", done.error?.line);
    if (done.result !== null && Buffer.byteLength(done.result) > CODE_LIMITS.resultBytes) return fail(`the script's result is over ${CODE_LIMITS.resultBytes / 1024} KB; return less (or a summary)`);
    let result: unknown = null;
    if (done.result !== null) {
      try {
        result = JSON.parse(done.result);
      } catch {
        return fail("the script's result isn't JSON");
      }
    }
    return { result, logs, calls };
  } finally {
    closed = true;
  }
}

// ---------------------------------------------------------------------------
// the two tools: tools.ts lists them, handing over the surface they reach.
// runTool audits run_code as it does every call: the arguments' hash and
// length, never the script's text.
// ---------------------------------------------------------------------------

export function codeTools(s: Surface): BoardTool[] {
  surface = s;
  return [
    {
      name: "search_tools",
      description:
        "Find Foundation's tools by what they do: the best matches for a few words (“table with rows”, “move a card”), each with its description and a TypeScript signature to call it with inside run_code. An empty query lists the categories with their tools.",
      schema: z.object({ query: z.string().max(200).describe("a few words on what you want to do"), limit: z.number().int().min(1).max(20).optional() }),
      run: (_ctx: ToolCtx, i: { query: string; limit?: number }) => searchTools(i.query, i.limit),
    } as BoardTool,
    {
      name: "run_code",
      description: [
        "Run a JavaScript script that calls Foundation's tools as an API, so many steps take one call. Find tools with search_tools first; inside the script every tool is `await foundation.<tool>({ ...args })`, returning its result (a failed call throws its error, which you can catch). The script is the body of an async function: `return` a JSON value to get it back, `console.log` is kept. No network, files, timers or imports. Limits: 20 s, 40 tool calls, 64 KB of code, 256 KB of result. Each call is checked as if you made it yourself (deletes still need confirm: true). Pass request_id so re-running the same script doesn't write twice (changed code counts as a new script).",
        "Example:",
        "const b = await foundation.read_board({});",
        'const t = await foundation.add_table({ section: "Parts", name: "Stock", columns: ["Part", "Qty"], rows: [] });',
        'for (const p of ["Vane", "Hub"]) await foundation.add_note({ section: "Parts", title: p, markdown: "in stock" });',
        "return { table: t.id };",
      ].join("\n"),
      schema: z.object({
        code: z.string().min(1).max(CODE_LIMITS.codeBytes).describe("the body of an async function; foundation.<tool>(args) and console.log are in scope"),
        request_id: z.string().max(200).optional(),
      }),
      run: (ctx: ToolCtx, i: { code: string; request_id?: string }) => runCode(ctx, i),
    } as BoardTool,
  ];
}
