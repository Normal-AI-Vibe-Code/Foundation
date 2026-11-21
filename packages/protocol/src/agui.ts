/**
 * AG-UI (https://docs.ag-ui.com, spec 1.0): the one wire between Foundation's
 * agents and whatever shows them. A run is a stream of typed events (text,
 * reasoning, tool calls, activities) that any AG-UI client can read; the live
 * stream, the stored transcript and the public endpoint (POST /api/agui) are
 * all this vocabulary. Event types come from `@ag-ui/core`, never copied.
 *
 * What's here is pure (no I/O, no DOM), so the server, the page and a sibling
 * app (Vision, Control) can share it:
 * - AguiWriter: what an agent runtime calls. It opens and closes messages,
 *   reasoning, tool calls and steps in the order the spec demands.
 * - applyAgui: the reducer a client folds events into (a RunView to draw).
 * - upgradeLegacy / LegacyDowngrade: transcripts and clients from before.
 *
 * Foundation's additions ride in AG-UI's own extension points (docs/agui.md):
 * - ACTIVITY "plan": the goal and steps (set_plan), replaced in place.
 * - ACTIVITY "ui": a Foundation primitive drawn in the conversation (show).
 * - ACTIVITY "approval": something that waits for a person.
 * - CUSTOM "foundation.crew" / "foundation.helper": who is working.
 */

import { EventType } from "@ag-ui/core";
import type { Event as AguiEvent, Interrupt, JsonPatchOperation, RunAgentInput, RunFinishedOutcome, TokenUsage } from "@ag-ui/core";
import type { AgentEvent, AgentRuntime } from "./index.ts";

export { EventType };
export type { AguiEvent, Interrupt, RunAgentInput, RunFinishedOutcome, TokenUsage };

export const AGUI_VERSION = "1.0";

export const ACTIVITY_PLAN = "plan";
export const ACTIVITY_UI = "ui";
export const ACTIVITY_APPROVAL = "approval";
/** A2UI surfaces, as the a2ui-middleware carries them (not drawn yet: shown as a note that says so) */
export const ACTIVITY_A2UI = "a2ui-surface";
export const CUSTOM_CREW = "foundation.crew";
export const CUSTOM_HELPER = "foundation.helper";

/** the agent's goal and steps (shared with Vision: its PlanStep) */
export interface PlanActivity {
  goal?: string;
  steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
}

/** something that waits for a person (shared with Vision: its LiveApproval) */
export interface ApprovalActivity {
  requestId: string;
  summary: string;
  detail?: string | null;
  kind?: string | null;
  tool?: string | null;
  status: "pending" | "accepted" | "declined";
}

/** a Foundation primitive drawn in the conversation rather than put on the board */
export type UiActivity =
  | { kind: "note"; title?: string; markdown: string }
  | { kind: "table"; title?: string; columns: string[]; rows: Array<Array<string | number>> }
  /** a question with a few answers; the person's pick comes back as the next turn (an AG-UI interrupt) */
  | { kind: "choice"; id: string; question: string; options: Array<{ label: string; detail?: string }> }
  /** cards on the board, by id: a press frames one */
  | { kind: "cards"; title?: string; ids: string[]; note?: string };

export interface CrewInfo {
  id: string;
  name: string;
  hue: number;
  lead?: string;
  leadName?: string;
}
export interface HelperInfo {
  name: string;
  runId: string;
  threadId: string;
}

// ---------- the producer ----------

export interface FinishOpts {
  runtime?: AgentRuntime;
  usage?: TokenUsage[];
  outcome?: RunFinishedOutcome;
}

/**
 * What a runtime calls as it works. Every method may be called at any time:
 * the writer closes what has to be closed first (a text message before a tool
 * call, reasoning before text, everything before the end), and says nothing
 * after the run has ended.
 */
export class AguiWriter {
  private text_: string | null = null;
  private reasoning_: string | null = null;
  private step_: string | null = null;
  private tools = new Map<string, { name: string; open: boolean; done: boolean }>();
  private n = 0;
  started = false;
  ended = false;

  constructor(
    private out: (e: AguiEvent) => void,
    readonly ids: { threadId: string; runId: string },
  ) {}

  private id(kind: string) {
    return `${kind}_${this.ids.runId}_${(this.n++).toString(36)}`;
  }
  private send(e: AguiEvent) {
    if (!this.ended) this.out(e);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.send({ type: EventType.RUN_STARTED, threadId: this.ids.threadId, runId: this.ids.runId, protocolVersion: AGUI_VERSION });
  }

  private closeText() {
    if (this.text_) this.send({ type: EventType.TEXT_MESSAGE_END, messageId: this.text_ });
    this.text_ = null;
  }
  private closeReasoning() {
    if (!this.reasoning_) return;
    this.send({ type: EventType.REASONING_MESSAGE_END, messageId: this.reasoning_ });
    this.send({ type: EventType.REASONING_END, messageId: this.reasoning_ });
    this.reasoning_ = null;
  }

  /** the agent's words, a token or a paragraph at a time */
  text(delta: string) {
    if (!delta) return;
    this.start();
    this.closeReasoning();
    if (!this.text_) {
      this.text_ = this.id("msg");
      this.send({ type: EventType.TEXT_MESSAGE_START, messageId: this.text_, role: "assistant" });
    }
    this.send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: this.text_, delta });
  }
  /** this message is whole: the next text starts a new one */
  endText() {
    this.closeText();
  }

  /** the agent's reasoning, as it thinks */
  reasoning(delta: string) {
    if (!delta) return;
    this.start();
    this.closeText();
    if (!this.reasoning_) {
      this.reasoning_ = this.id("rsn");
      this.send({ type: EventType.REASONING_START, messageId: this.reasoning_ });
      this.send({ type: EventType.REASONING_MESSAGE_START, messageId: this.reasoning_, role: "reasoning" });
    }
    this.send({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: this.reasoning_, delta });
  }
  endReasoning() {
    this.closeReasoning();
  }

  /** a tool call opens (its arguments may follow in pieces); returns its id */
  toolStart(name: string, id = this.id("call")): string {
    this.start();
    this.closeText();
    this.closeReasoning();
    if (this.tools.has(id)) return id;
    this.tools.set(id, { name, open: true, done: false });
    this.send({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name });
    return id;
  }
  toolArgs(id: string, delta: string) {
    if (delta && this.tools.get(id)?.open) this.send({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta });
  }
  toolEnd(id: string) {
    const t = this.tools.get(id);
    if (!t?.open) return;
    t.open = false;
    this.send({ type: EventType.TOOL_CALL_END, toolCallId: id });
  }
  /** a whole tool call at once; returns its id */
  tool(name: string, input: unknown, id?: string): string {
    const known = id !== undefined && this.tools.has(id);
    const call = this.toolStart(name, id);
    if (!known) this.toolArgs(call, JSON.stringify(input ?? {}));
    this.toolEnd(call);
    return call;
  }
  /** what a tool answered. `id` may be absent (a runtime that doesn't say): the oldest unanswered call takes it */
  toolResult(id: string | undefined, content: string, ok = true) {
    let call = id && this.tools.has(id) ? id : undefined;
    if (!call) for (const [k, t] of this.tools) if (!t.done) { call = k; break; }
    if (!call) return;
    const t = this.tools.get(call)!;
    if (t.done) return;
    this.toolEnd(call);
    t.done = true;
    this.send({ type: EventType.TOOL_CALL_RESULT, messageId: this.id("res"), toolCallId: call, content, role: "tool", ...(ok ? {} : { metadata: { foundation: { ok: false } } }) });
  }
  toolName(id: string) {
    return this.tools.get(id)?.name;
  }

  /** what the run is doing now ("thinking", "working"): one step open at a time */
  step(name: string) {
    this.start();
    if (this.step_ === name) return;
    if (this.step_) this.send({ type: EventType.STEP_FINISHED, stepName: this.step_ });
    this.step_ = name;
    this.send({ type: EventType.STEP_STARTED, stepName: name });
  }

  /** a structured piece of the conversation, replaced in place by its messageId */
  activity(messageId: string, activityType: string, content: Record<string, unknown>) {
    this.start();
    this.send({ type: EventType.ACTIVITY_SNAPSHOT, messageId, activityType, content, replace: true });
  }
  custom(name: string, value: unknown) {
    this.start();
    this.send({ type: EventType.CUSTOM, name, value });
  }

  private closeAll() {
    this.closeText();
    this.closeReasoning();
    for (const id of this.tools.keys()) this.toolEnd(id);
    if (this.step_) this.send({ type: EventType.STEP_FINISHED, stepName: this.step_ });
    this.step_ = null;
  }

  finish(opts: FinishOpts = {}) {
    if (this.ended) return;
    this.start();
    this.closeAll();
    this.send({
      type: EventType.RUN_FINISHED,
      threadId: this.ids.threadId,
      runId: this.ids.runId,
      ...(opts.runtime ? { result: { runtime: opts.runtime } } : {}),
      ...(opts.outcome ? { outcome: opts.outcome } : {}),
      ...(opts.usage?.length ? { usage: opts.usage } : {}),
    });
    this.ended = true;
  }
  /** the run failed: this ends it (whatever was open ends with it) */
  error(message: string, code?: string) {
    if (this.ended) return;
    this.start();
    this.send({ type: EventType.RUN_ERROR, message, ...(code ? { code } : {}) });
    this.ended = true;
  }
}

/**
 * Keep a run's events as few as they can be: streamed pieces of one message,
 * one reasoning or one tool call's arguments join the piece before them, so a
 * transcript holds a paragraph, not its tokens. Returns true when it joined.
 */
export function appendCompact(list: AguiEvent[], e: AguiEvent): boolean {
  const last = list[list.length - 1];
  if (last && last.type === e.type) {
    if ((e.type === EventType.TEXT_MESSAGE_CONTENT || e.type === EventType.REASONING_MESSAGE_CONTENT) && (last as typeof e).messageId === e.messageId) {
      list[list.length - 1] = { ...last, delta: (last as typeof e).delta + e.delta } as AguiEvent;
      return true;
    }
    if (e.type === EventType.TOOL_CALL_ARGS && (last as typeof e).toolCallId === e.toolCallId) {
      list[list.length - 1] = { ...last, delta: (last as typeof e).delta + e.delta } as AguiEvent;
      return true;
    }
  }
  list.push(e);
  return false;
}

// ---------- the consumer ----------

export type ViewItem =
  | { kind: "text"; id: string; text: string; streaming: boolean }
  | { kind: "reasoning"; id: string; text: string; streaming: boolean; from?: number; ms?: number }
  | { kind: "tool"; id: string; name: string; args: string; input?: unknown; state: "calling" | "running" | "ok" | "failed"; summary?: string }
  | { kind: "ui"; id: string; ui: UiActivity }
  | { kind: "approval"; id: string; approval: ApprovalActivity }
  /** an activity this client doesn't draw: named, so nothing arrives unseen */
  | { kind: "activity"; id: string; activityType: string; content: Record<string, unknown> }
  | { kind: "error"; id: string; text: string };

export interface RunView {
  threadId?: string;
  runId?: string;
  items: ViewItem[];
  status: "running" | "done" | "error" | "stopped" | "waiting";
  /** what it's doing now (the open step) */
  step?: string;
  runtime?: string;
  usage?: TokenUsage[];
  crew?: CrewInfo;
  helpers: HelperInfo[];
  plan?: PlanActivity;
  /** what the run ended waiting for */
  interrupts?: Interrupt[];
}

export function emptyRunView(): RunView {
  return { items: [], status: "running", helpers: [] };
}

function parseArgs(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

function setActivity(v: RunView, id: string, activityType: string, content: Record<string, unknown>) {
  if (activityType === ACTIVITY_PLAN) {
    const p = content as Partial<PlanActivity>;
    if (Array.isArray(p.steps)) v.plan = { goal: typeof p.goal === "string" ? p.goal : undefined, steps: p.steps.filter((s) => s && typeof s.step === "string") };
    return;
  }
  const item: ViewItem =
    activityType === ACTIVITY_UI && typeof content.kind === "string"
      ? { kind: "ui", id, ui: content as unknown as UiActivity }
      : activityType === ACTIVITY_APPROVAL
        ? { kind: "approval", id, approval: content as unknown as ApprovalActivity }
        : { kind: "activity", id, activityType, content };
  const i = v.items.findIndex((x) => x.id === id);
  if (i >= 0) v.items[i] = item;
  else v.items.push(item);
}

/** RFC 6902 over plain JSON: enough for ACTIVITY_DELTA. Throws when a patch can't apply (the caller keeps what it had). */
export function applyPatch<T>(doc: T, patch: JsonPatchOperation[]): T {
  let root: unknown = structuredClone(doc);
  const parts = (p: string) => p.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const get = (path: string[]) => path.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root);
  const put = (path: string[], value: unknown, mode: "add" | "replace" | "remove") => {
    if (path.length === 0) {
      root = value;
      return;
    }
    const parent = get(path.slice(0, -1)) as Record<string, unknown> | unknown[];
    const key = path[path.length - 1];
    if (Array.isArray(parent)) {
      const i = key === "-" ? parent.length : Number(key);
      if (mode === "add") parent.splice(i, 0, value);
      else if (mode === "remove") parent.splice(i, 1);
      else parent[i] = value;
    } else if (mode === "remove") delete parent[key];
    else parent[key] = value;
  };
  for (const op of patch) {
    const path = parts(op.path);
    if (op.op === "add" || op.op === "replace") put(path, op.value, op.op);
    else if (op.op === "remove") put(path, undefined, "remove");
    else if (op.op === "move" || op.op === "copy") {
      const from = parts(op.from);
      const value = structuredClone(get(from));
      if (op.op === "move") put(from, undefined, "remove");
      put(path, value, "add");
    } else if (op.op === "test" && JSON.stringify(get(path)) !== JSON.stringify(op.value)) throw new Error("patch test failed");
  }
  return root as T;
}

/**
 * Fold one event into a view, in place. Unknown events are ignored (the spec:
 * drop what you don't know); `now` stamps how long a reasoning took.
 */
export function applyAgui(v: RunView, e: AguiEvent, now = Date.now()): RunView {
  const find = <K extends ViewItem["kind"]>(kind: K, id: string) => v.items.find((x): x is Extract<ViewItem, { kind: K }> => x.kind === kind && x.id === id);
  switch (e.type) {
    case EventType.RUN_STARTED:
      v.threadId = e.threadId;
      v.runId = e.runId;
      v.status = "running";
      break;
    case EventType.RUN_FINISHED: {
      const outcome = e.outcome;
      for (const it of v.items) if ((it.kind === "text" || it.kind === "reasoning") && it.streaming) it.streaming = false;
      v.status = outcome?.type === "cancelled" ? "stopped" : outcome?.type === "interrupt" ? "waiting" : "done";
      if (outcome?.type === "interrupt") v.interrupts = outcome.interrupts;
      const runtime = (e.result as { runtime?: unknown } | undefined)?.runtime;
      if (typeof runtime === "string") v.runtime = runtime;
      if (e.usage) v.usage = e.usage;
      v.step = undefined;
      break;
    }
    case EventType.RUN_ERROR:
      for (const it of v.items) {
        if ((it.kind === "text" || it.kind === "reasoning") && it.streaming) it.streaming = false;
        if (it.kind === "tool" && (it.state === "calling" || it.state === "running")) it.state = "failed";
      }
      v.items.push({ kind: "error", id: `err_${v.items.length}`, text: e.message });
      v.status = "error";
      v.step = undefined;
      break;
    case EventType.STEP_STARTED:
      v.step = e.stepName;
      break;
    case EventType.STEP_FINISHED:
      if (v.step === e.stepName) v.step = undefined;
      break;
    case EventType.TEXT_MESSAGE_START:
      if (!find("text", e.messageId)) v.items.push({ kind: "text", id: e.messageId, text: "", streaming: true });
      break;
    case EventType.TEXT_MESSAGE_CONTENT: {
      const it = find("text", e.messageId);
      if (it) it.text += e.delta;
      else v.items.push({ kind: "text", id: e.messageId, text: e.delta, streaming: true });
      break;
    }
    case EventType.TEXT_MESSAGE_END: {
      const it = find("text", e.messageId);
      if (it) it.streaming = false;
      break;
    }
    case EventType.REASONING_MESSAGE_START:
      if (!find("reasoning", e.messageId)) v.items.push({ kind: "reasoning", id: e.messageId, text: "", streaming: true, from: e.timestamp ?? now });
      break;
    case EventType.REASONING_MESSAGE_CONTENT: {
      const it = find("reasoning", e.messageId);
      if (it) it.text += e.delta;
      else v.items.push({ kind: "reasoning", id: e.messageId, text: e.delta, streaming: true, from: e.timestamp ?? now });
      break;
    }
    case EventType.REASONING_MESSAGE_END: {
      const it = find("reasoning", e.messageId);
      if (it) {
        it.streaming = false;
        if (it.from !== undefined) it.ms = Math.max(0, (e.timestamp ?? now) - it.from);
      }
      break;
    }
    case EventType.TOOL_CALL_START:
      if (!find("tool", e.toolCallId)) v.items.push({ kind: "tool", id: e.toolCallId, name: e.toolCallName, args: "", state: "calling" });
      break;
    case EventType.TOOL_CALL_ARGS: {
      const it = find("tool", e.toolCallId);
      if (it) it.args += e.delta;
      break;
    }
    case EventType.TOOL_CALL_END: {
      const it = find("tool", e.toolCallId);
      if (it) {
        it.input = parseArgs(it.args);
        if (it.state === "calling") it.state = "running";
      }
      break;
    }
    case EventType.TOOL_CALL_RESULT: {
      const it = find("tool", e.toolCallId);
      if (it) {
        if (it.input === undefined) it.input = parseArgs(it.args);
        const failed = (e.metadata as { foundation?: { ok?: boolean } } | undefined)?.foundation?.ok === false;
        it.state = failed ? "failed" : "ok";
        it.summary = typeof e.content === "string" ? e.content : e.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join(" ");
      }
      break;
    }
    case EventType.ACTIVITY_SNAPSHOT:
      setActivity(v, e.messageId, e.activityType, e.content as Record<string, unknown>);
      break;
    case EventType.ACTIVITY_DELTA: {
      // a delta needs its snapshot; one that doesn't apply leaves what was there (the next snapshot resynchronises)
      const it = v.items.find((x) => x.id === e.messageId);
      const cur = e.activityType === ACTIVITY_PLAN ? v.plan : it?.kind === "ui" ? it.ui : it?.kind === "approval" ? it.approval : it?.kind === "activity" ? it.content : undefined;
      if (!cur) break;
      try {
        setActivity(v, e.messageId, e.activityType, applyPatch(cur as unknown as Record<string, unknown>, e.patch));
      } catch {
        /* kept as it was */
      }
      break;
    }
    case EventType.CUSTOM:
      if (e.name === CUSTOM_CREW) v.crew = e.value as CrewInfo;
      else if (e.name === CUSTOM_HELPER) v.helpers.push(e.value as HelperInfo);
      break;
    default:
      break;
  }
  return v;
}

export function viewOf(events: AguiEvent[]): RunView {
  const v = emptyRunView();
  for (const e of events) applyAgui(v, e, 0);
  return v;
}

/** the words the agent said in a run, joined (for a caller that only wants the answer) */
export function textOf(v: RunView): string {
  return v.items
    .filter((x): x is Extract<ViewItem, { kind: "text" }> => x.kind === "text")
    .map((x) => x.text)
    .join("\n\n");
}

// ---------- before AG-UI ----------

const usageOf = (runtime: AgentRuntime | undefined, u?: { input: number; output: number }): TokenUsage[] | undefined =>
  u ? [{ provider: runtime === "script" ? "script" : "anthropic", inputTokens: u.input, outputTokens: u.output }] : undefined;

/** a transcript stored before AG-UI isn't AG-UI: its event types are lower-case words */
export function isLegacyTranscript(events: unknown[]): events is AgentEvent[] {
  const t = (events[0] as { type?: unknown } | undefined)?.type;
  return typeof t === "string" && t !== t.toUpperCase();
}

/**
 * A transcript from before AG-UI, as AG-UI. `status` is how the run ended
 * (the old stream didn't always say): a stopped run closes as cancelled.
 */
export function upgradeLegacy(events: AgentEvent[], ids: { threadId: string; runId: string }, status: string = "done"): AguiEvent[] {
  const out: AguiEvent[] = [];
  const w = new AguiWriter((e) => appendCompact(out, e), ids);
  w.start();
  for (const e of events) feedLegacy(w, e);
  if (!w.ended && status !== "running") w.finish(status === "stopped" ? { outcome: { type: "cancelled" } } : {});
  return out;
}

/** one old event, said through a writer */
export function feedLegacy(w: AguiWriter, e: AgentEvent) {
  if (e.type === "text") w.text(e.text);
  else if (e.type === "tool") w.tool(e.name, e.input);
  else if (e.type === "tool_result") w.toolResult(undefined, e.summary, e.ok);
  else if (e.type === "status") w.step(e.status);
  else if (e.type === "crew") w.custom(CUSTOM_CREW, { id: e.id, name: e.name, hue: e.hue, lead: e.lead, leadName: e.leadName } satisfies CrewInfo);
  else if (e.type === "helper") w.custom(CUSTOM_HELPER, { name: e.name, runId: e.runId, threadId: e.session } satisfies HelperInfo);
  else if (e.type === "done") w.finish({ runtime: e.runtime, usage: usageOf(e.runtime, e.usage) });
  else if (e.type === "error") w.error(e.message);
}

/**
 * AG-UI said the old way, for a client from before (POST /api/agent): text,
 * tool steps, status, done and error. Reasoning and activities have no old
 * word and are left out, except the plan, which the old client reads from
 * the set_plan tool call it still gets.
 */
export class LegacyDowngrade {
  private calls = new Map<string, { name: string; args: string }>();
  private spoke = false;

  push(e: AguiEvent): AgentEvent[] {
    switch (e.type) {
      case EventType.RUN_STARTED:
        return [{ type: "run", id: e.runId }];
      case EventType.STEP_STARTED:
        return [{ type: "status", status: e.stepName }];
      case EventType.TEXT_MESSAGE_START: {
        // a new message after another: the old stream joined them, so keep a paragraph between
        const gap = this.spoke;
        this.spoke = true;
        return gap ? [{ type: "text", text: "\n\n" }] : [];
      }
      case EventType.TEXT_MESSAGE_CONTENT:
        return [{ type: "text", text: e.delta }];
      case EventType.TOOL_CALL_START:
        this.calls.set(e.toolCallId, { name: e.toolCallName, args: "" });
        this.spoke = false;
        return [];
      case EventType.TOOL_CALL_ARGS: {
        const c = this.calls.get(e.toolCallId);
        if (c) c.args += e.delta;
        return [];
      }
      case EventType.TOOL_CALL_END: {
        const c = this.calls.get(e.toolCallId);
        return c ? [{ type: "tool", name: c.name, input: parseArgs(c.args) ?? {} }] : [];
      }
      case EventType.TOOL_CALL_RESULT: {
        const c = this.calls.get(e.toolCallId);
        const failed = (e.metadata as { foundation?: { ok?: boolean } } | undefined)?.foundation?.ok === false;
        return [{ type: "tool_result", name: c?.name ?? "", ok: !failed, summary: typeof e.content === "string" ? e.content : "" }];
      }
      case EventType.CUSTOM: {
        if (e.name === CUSTOM_CREW) return [{ type: "crew", ...(e.value as CrewInfo) }];
        if (e.name === CUSTOM_HELPER) {
          const h = e.value as HelperInfo;
          return [{ type: "helper", name: h.name, runId: h.runId, session: h.threadId }];
        }
        return [];
      }
      case EventType.RUN_FINISHED: {
        const runtime = ((e.result as { runtime?: AgentRuntime } | undefined)?.runtime ?? "api") as AgentRuntime;
        const u = e.usage?.[0];
        return [{ type: "done", runtime, ...(u ? { usage: { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0 } } : {}) }];
      }
      case EventType.RUN_ERROR:
        return [{ type: "error", message: e.message }];
      default:
        return [];
    }
  }
}

// ---------- the request ----------

/** the last thing the person said in a RunAgentInput (text parts only) */
export function promptOf(input: Pick<RunAgentInput, "messages">): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
  return "";
}

/** Foundation's own part of a RunAgentInput: `forwardedProps.foundation` */
export interface FoundationProps {
  board?: string;
  runtime?: string;
  persona?: string;
  as?: string;
}
