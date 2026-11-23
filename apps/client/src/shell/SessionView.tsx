/**
 * A session tab, on the floor beside the grid: the goal and its steps at the
 * top (the plan the agent keeps with set_plan), the conversation under it —
 * what was asked, what it said, every tool step — and the composer. The grid
 * stays live to the right; the cards the session touched wear a violet ring,
 * and a step that names a card frames it.
 *
 * A Vision Code thread opens the same way, read from T3's own store: its
 * messages, tool steps and proposed plan. Continuing it happens in Vision Code.
 */

import { ErrorCard } from "../components/ErrorCard";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@foundation/protocol";
import { api } from "../lib/api";
import { getState, requestSnap, useObjectSetVersion } from "../state/store";
import { WIDTHS, getUi, newSession, openSession, setUi, useUi, type SessionTab } from "../state/ui";
import { keys } from "../lib/keys";
import { READ_ONLY, TOOL_WORDS, loadSession, refreshLists, useLists, objectIn, planOf, sendToSession, stopSession, touchedBy, useSession, type Plan, type Turn } from "../state/sessions";
import { renderMarkdown } from "../utils/markdown";
import { listen, type Listening } from "../lib/voice";
import { FloorEdge } from "./FloorEdge";
import { ago } from "./SidePane";

const SUGGESTIONS = [
  "What's going on across the company right now?",
  "Organize this board into sections by project",
  "Find the repo behind each app on the board and pin it",
  "Start a design pipeline for a quieter rim-drive fan",
];

export function SessionView() {
  const ui = useUi();
  const tab = ui.sessions.find((t) => t.id === ui.session);
  if (!tab || ui.presenting) return null;
  return (
    <section className="session floor-pane" style={{ left: ui.pane ? ui.paneW : 0, width: ui.sessionW }} aria-label={tab.title}>
      {tab.kind === "agent" ? <AgentSession key={tab.id} tab={tab} /> : <T3Session key={tab.id} tab={tab} />}
      <FloorEdge side="right" value={ui.sessionW} {...WIDTHS.session} onChange={(w) => setUi({ sessionW: w })} label="Session" />
    </section>
  );
}

// ---------- the column's own tools: earlier sessions, a new one, put it away ----------

function SessionTools() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="session-tools">
        <button className={`top-btn${open ? " is-on" : ""}`} onClick={() => setOpen((o) => !o)} aria-label="Earlier sessions" data-tip="Earlier sessions and Vision Code threads">
          ◷
        </button>
        <button className="top-btn" onClick={() => newSession()} aria-label="New session" data-tip="New session">
          ＋
        </button>
        <button className="top-btn" onClick={() => setUi({ session: null })} aria-label="Put the conversation away" data-tip="Put the conversation away" data-kbd={keys("mod+J")}>
          ✕
        </button>
      </span>
      {open && <SessionHistory onPick={() => setOpen(false)} />}
    </>
  );
}

/** this space's agent sessions and Vision Code's threads; a press shows one in the column */
function SessionHistory({ onPick }: { onPick(): void }) {
  const ui = useUi();
  const lists = useLists();
  useEffect(() => {
    void refreshLists();
  }, []);
  const pick = (t: SessionTab) => {
    openSession(t);
    onPick();
  };
  return (
    <div className="session-history">
      <div className="pane-eyebrow is-agent">Sessions on this grid</div>
      {lists.sessions.length === 0 && <div className="pane-empty">None yet. What you ask here is kept, with its goal, its steps and what it changed.</div>}
      {lists.sessions.slice(0, 10).map((s) => (
        <button key={s.id} className={`pane-row is-session${ui.session === s.id ? " is-current" : ""}`} onClick={() => pick({ id: s.id, kind: "agent", title: s.title })}>
          <span className={`f-dot ${s.status === "running" ? "is-agent is-pulse" : s.status === "error" ? "is-bad" : "is-agent-dim"}`} />
          <span className="pane-label">{s.title}</span>
          <span className="pane-when">{ago(s.updatedAt)}</span>
        </button>
      ))}
      <div className="pane-eyebrow">Vision Code</div>
      {lists.t3Available === false && <div className="pane-empty is-paths">{lists.t3Missing ?? "Vision Code isn't on this computer (or its store moved). Set T3CODE_HOME on the server to point at it."}</div>}
      {lists.t3.slice(0, 8).map((t) => (
        <button key={t.id} className={`pane-row is-session${ui.session === `t3:${t.id}` ? " is-current" : ""}`} onClick={() => pick({ id: `t3:${t.id}`, kind: "t3", title: t.title })} title={`${t.project} · ${t.title}`}>
          <span className={`f-dot ${t.status === "running" ? "is-live is-pulse" : t.status === "waiting" ? "is-warn" : t.status === "error" ? "is-bad" : ""}`} />
          <span className="pane-label">{t.title}</span>
          <span className="pane-when">{t.pending > 0 ? `${t.pending} ask` : ago(t.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- a Foundation agent session ----------


type Step = { name: string; input: unknown; ok?: boolean; summary?: string };
type Item = { kind: "text"; text: string } | { kind: "steps"; steps: Step[] } | { kind: "error"; text: string };

function itemsOf(events: AgentEvent[]): Item[] {
  const out: Item[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === "text") {
      if (last?.kind === "text") last.text += e.text;
      else out.push({ kind: "text", text: e.text });
    } else if (e.type === "tool") {
      const step = { name: e.name, input: e.input };
      if (last?.kind === "steps") last.steps.push(step);
      else out.push({ kind: "steps", steps: [step] });
    } else if (e.type === "tool_result") {
      for (let i = out.length - 1; i >= 0; i--) {
        const it = out[i];
        if (it.kind !== "steps") continue;
        const open = it.steps.find((s) => s.ok === undefined && (!e.name || s.name === e.name));
        if (open) {
          open.ok = e.ok;
          open.summary = e.summary;
          break;
        }
      }
    } else if (e.type === "error") out.push({ kind: "error", text: e.message });
  }
  return out;
}

function AgentSession({ tab }: { tab: SessionTab }) {
  const ui = useUi();
  const run = useSession(tab.id);
  const [draft, setDraft] = useState("");
  const [runtime, setRuntime] = useState<string>(() => localStorage.getItem("foundation-runtime") ?? "auto");
  const [avail, setAvail] = useState<{ subscription: boolean; api: boolean; model: string } | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const rec = useRef<Listening | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => rec.current?.cancel(), []);

  useEffect(() => {
    void loadSession(tab.id);
    api<{ subscription: boolean; api: boolean; model: string }>("/api/agent/runtimes").then(setAvail).catch(() => {});
    requestAnimationFrame(() => field.current?.focus());
  }, [tab.id]);

  // "ask the agent" from anywhere lands here
  useEffect(() => {
    if (!ui.draft) return;
    setDraft(ui.draft);
    setUi({ draft: "" });
    requestAnimationFrame(() => {
      const f = field.current;
      if (f) {
        f.focus();
        f.setSelectionRange(f.value.length, f.value.length);
      }
    });
  }, [ui.draft]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [run.turns]);

  // what it touched, ringed on the grid (again once the board has synced, after a reload)
  const objects = useObjectSetVersion();
  const touched = useMemo(() => touchedBy(run.turns), [run.turns, objects]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cur = getUi().touched;
    if (cur.length !== touched.length || cur.some((id, i) => id !== touched[i])) setUi({ touched });
  }, [touched]);

  const plan = planOf(run.turns);
  const send = (text: string) => {
    if (!text.trim() || run.busy) return;
    setDraft("");
    void sendToSession(tab.id, text, runtime === "auto" ? undefined : runtime);
  };

  /** talk instead of typing: the composer fills as you speak, and sends when you stop */
  const talk = () => {
    if (rec.current) return rec.current.stop();
    setVoiceNote(null);
    setListening(true);
    rec.current = listen({
      heard: setDraft,
      done: (t) => {
        rec.current = null;
        setListening(false);
        if (t) send(t);
      },
      failed: (m) => {
        rec.current = null;
        setListening(false);
        setVoiceNote(m);
      },
    });
    if (!rec.current) setListening(false);
  };

  return (
    <>
      <header className="session-head">
        <span className="session-mark">✦</span>
        <span className="session-title">{tab.title}</span>
        <select
          className="session-runtime"
          value={runtime}
          onChange={(e) => {
            localStorage.setItem("foundation-runtime", e.target.value);
            setRuntime(e.target.value);
          }}
          title="Where the agent runs"
        >
          <option value="auto">Auto</option>
          <option value="subscription" disabled={avail ? !avail.subscription : false}>
            Subscription
          </option>
          <option value="api" disabled={avail ? !avail.api : false}>
            API credits
          </option>
        </select>
        <SessionTools />
      </header>

      {plan && <PlanCard plan={plan} running={run.busy} />}

      <div className="session-list" ref={list}>
        {run.turns.length === 0 && (
          <div className="session-empty">
            <div className="pane-eyebrow is-agent">New session</div>
            <p>Tell it what to do on this board. It lays out a goal and steps, works through them with the board's tools, and everything it changes shows up on the grid beside you.</p>
            {avail && !avail.subscription && !avail.api && <p className="session-warn">No runtime yet — install Claude Code (subscription) or set ANTHROPIC_API_KEY on the server (credits).</p>}
            <div className="session-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="f-pill" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {run.turns.map((t, i) => (
          <TurnView key={i} turn={t} last={i === run.turns.length - 1} />
        ))}
      </div>

      <form
        className="session-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          ref={field}
          value={draft}
          rows={2}
          placeholder={listening ? "Listening…" : run.busy ? "Working… you can type the next ask" : "Ask, or tell it what to build…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
            if (e.key === "Escape") (e.target as HTMLElement).blur();
          }}
        />
        {voiceNote && <div className="session-voice-note">{voiceNote}</div>}
        <div className="session-actions">
          <button type="button" className={`f-pill session-mic${listening ? " is-agent is-listening" : ""}`} onClick={talk} title={listening ? "Stop listening" : "Talk (sends when you stop)"} aria-pressed={listening}>
            <MicGlyph />
            {listening ? "Listening" : ""}
          </button>
          <span className="session-actions-gap" />
          {run.busy ? (
            <button type="button" className="f-pill" onClick={() => stopSession(tab.id)}>
              Stop
            </button>
          ) : (
            <button className="f-pill is-primary" disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </>
  );
}

function PlanCard({ plan, running }: { plan: Plan; running: boolean }) {
  const done = plan.steps.filter((s) => s.status === "done").length;
  return (
    <div className="plan">
      <div className="plan-head">
        <span className="pane-eyebrow is-agent">Goal</span>
        <span className="plan-count">
          {done}/{plan.steps.length}
        </span>
      </div>
      {plan.goal && <div className="plan-goal">{plan.goal}</div>}
      <ol className="plan-steps">
        {plan.steps.map((s, i) => (
          <li key={i} className={`plan-step is-${s.status}${s.status === "active" && running ? " is-running" : ""}`}>
            <span className="plan-box" aria-hidden>
              {s.status === "done" ? "✓" : ""}
            </span>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TurnView({ turn, last }: { turn: Turn; last: boolean }) {
  const items = itemsOf(turn.events);
  const status = [...turn.events].reverse().find((e) => e.type === "status") as Extract<AgentEvent, { type: "status" }> | undefined;
  return (
    <div className="s-turn">
      <div className="s-ask">{turn.prompt}</div>
      {items.map((it, i) =>
        it.kind === "text" ? (
          <div key={i} className="s-text note-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(it.text) }} />
        ) : it.kind === "steps" ? (
          <div key={i} className="s-steps">
            {it.steps.map((s, j) => (
              <StepRow key={j} step={s} />
            ))}
          </div>
        ) : (
          <ErrorCard key={i} message={it.text} fixed />
        ),
      )}
      {turn.status === "running" && last && (
        <div className="s-status">
          <span className="thinking-dots">
            <i />
            <i />
            <i />
          </span>
          {status?.status ?? "thinking"}
        </div>
      )}
      {turn.status === "stopped" && <div className="s-meta">Stopped</div>}
      {turn.status === "done" && turn.runtime && <div className="s-meta">{turn.runtime === "api" ? "API credits" : "Subscription"}</div>}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  useObjectSetVersion(); // the card it names may arrive after the step does
  const target = READ_ONLY.has(step.name) ? null : objectIn(`${JSON.stringify(step.input ?? "")} ${step.summary ?? ""}`);
  const detail = describeInput(step);
  return (
    <button
      className={`s-step${step.ok === false ? " is-bad" : step.ok ? " is-ok" : " is-run"}${target ? " is-link" : ""}`}
      title={step.summary}
      onClick={() => target && requestSnap({ kind: target.startsWith("sec_") ? "section" : "object", id: target })}
      disabled={!target}
    >
      <span className="step-dot" />
      <span className="s-step-name">{TOOL_WORDS[step.name] ?? step.name}</span>
      {detail && <span className="s-step-detail">{detail}</span>}
      {target && <span className="s-step-go">↗</span>}
    </button>
  );
}

/** the one input worth showing beside a step's name */
function describeInput(step: Step): string {
  const i = (step.input ?? {}) as Record<string, unknown>;
  const v = i.title ?? i.name ?? i.query ?? i.section ?? i.text ?? i.person ?? i.url;
  return typeof v === "string" ? (v.length > 48 ? `${v.slice(0, 45)}…` : v) : "";
}

// ---------- a Vision Code thread (read-only) ----------

interface T3Item {
  kind: "user" | "assistant" | "reasoning" | "tool" | "error";
  text: string;
  at: number;
  ok?: boolean;
}
interface T3Data {
  thread: { title: string; project: string; status: string; pending: number; updatedAt: number; url: string | null };
  items: T3Item[];
  plan: string | null;
}

function T3Session({ tab }: { tab: SessionTab }) {
  const id = tab.id.replace(/^t3:/, "");
  const [data, setData] = useState<T3Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setUi({ touched: [] });
    let alive = true;
    const load = () =>
      api<T3Data>(`/api/t3/threads/${encodeURIComponent(id)}`)
        .then((d) => alive && (setData(d), setErr(null)))
        .catch((e) => alive && setErr((e as Error).message));
    void load();
    const t = setInterval(load, 4000); // a running thread keeps moving
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  const count = data?.items.length ?? 0;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [count]);

  return (
    <>
      <header className="session-head">
        <span className="session-mark is-t3">⌥</span>
        <span className="session-title">{tab.title}</span>
        {data?.thread.url && (
          <a className="f-pill" href={data.thread.url} target="_blank" rel="noopener" title="Continue this thread in Vision Code">
            Open in Vision Code ↗
          </a>
        )}
        <SessionTools />
      </header>
      {data && (
        <div className="session-sub">
          <span>{data.thread.project}</span>
          <span>·</span>
          <span>{data.thread.status === "waiting" ? `waiting on you (${data.thread.pending})` : data.thread.status}</span>
          <span>·</span>
          <span>{ago(data.thread.updatedAt)} ago</span>
        </div>
      )}
      {data?.plan && (
        <div className="plan">
          <div className="plan-head">
            <span className="pane-eyebrow">Proposed plan</span>
          </div>
          <div className="plan-md note-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.plan) }} />
        </div>
      )}
      <div className="session-list" ref={list}>
        {err && <ErrorCard message={err} />}
        {!data && !err && <div className="session-empty">Reading the thread…</div>}
        {data?.items.map((it, i) =>
          it.kind === "user" ? (
            <div key={i} className="s-ask">
              {it.text}
            </div>
          ) : it.kind === "assistant" ? (
            <div key={i} className="s-text note-rendered" dangerouslySetInnerHTML={{ __html: renderMarkdown(it.text) }} />
          ) : it.kind === "reasoning" ? (
            <div key={i} className="s-reasoning">
              {it.text}
            </div>
          ) : it.kind === "tool" ? (
            <div key={i} className={`s-step is-t3${it.ok === false ? " is-bad" : it.ok ? " is-ok" : " is-run"}`}>
              <span className="step-dot" />
              <span className="s-step-name">{it.text}</span>
            </div>
          ) : (
            <ErrorCard key={i} message={it.text} fixed />
          ),
        )}
      </div>
      <div className="session-foot">Read from Vision Code's own store — reply there to continue the thread.</div>
    </>
  );
}

/** rings on the cards the showing session touched (DESIGN.md → Sessions) */
export function TouchedRings() {
  const ui = useUi();
  if (!ui.session || ui.touched.length === 0) return null;
  const st = getState();
  // a hosted app is its section: ring the section
  const home = (id: string) => (st.panels[id] && st.sections[st.panels[id].sectionId]?.host === id ? st.panels[id].sectionId : id);
  const sel = (id: string) => `[data-obj-id="${CSS.escape(id)}"] .frame-card, [data-section-id="${CSS.escape(id)}"]`;
  return <style>{`${[...new Set(ui.touched.map(home))].map(sel).join(",\n")} { box-shadow: 0 0 0 2px var(--color-agent), 0 0 0 7px var(--color-agent-dim); }`}</style>;
}

function MicGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <rect x="5.5" y="1.5" width="5" height="9" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" strokeLinecap="round" />
    </svg>
  );
}
