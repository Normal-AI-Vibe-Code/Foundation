/**
 * Today — the first thing a person meets. It is a place inside Foundation (2026-11-15), not a
 * page of its own: the top bar and the side menu stay, and where a grid would be, the Shiba (the
 * agent's face, Vision's ethereal shiba) fills the paper and answers in large type, with a voice
 * and a field to talk to it. On the right, drawn in white straight over the room, the Today
 * panel: your todos (what wants you, then your goals) and the company's apps. The Shiba reads
 * the same page (the `today` tool), points at what it's talking about, and changes your goals
 * when you ask, so its words and the page never disagree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { UserInfo } from "@foundation/protocol";
import { createShiba, type OrbMood } from "@foundation/ui/shiba";
import { listen, voiceAvailable, type Listening } from "../lib/voice";
import { api } from "../lib/api";
import { floorInsets, useUi } from "../state/ui";
import { ask, loadToday, newConversation, restoreConversation, saveGoal, setHeard, stopAsking, useToday, wordsLevel, type CompanyApp, type FocusItem, type Goal, type Mood } from "./model";
import "./today.css";

// ---------- the Shiba ----------

/** Vision's shiba, filling its host; a CSS glow of the same colours without WebGL2 */
export function ShibaRoom({ mood, maxFps = 30, levels }: { mood: Mood; maxFps?: number; levels?: () => { level: number; low: number; mid: number; high: number } }) {
  const host = useRef<HTMLDivElement>(null);
  const shiba = useRef<ReturnType<typeof createShiba>>(null);
  const [gl, setGl] = useState(true);
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  useEffect(() => {
    if (!host.current) return;
    const o = createShiba(host.current, { fit: "cover", maxFps });
    shiba.current = o;
    setGl(Boolean(o));
    o?.follow(() => levelsRef.current?.() ?? { level: 0, low: 0, mid: 0, high: 0 });
    return () => {
      o?.dispose();
      shiba.current = null;
    };
  }, [maxFps]);
  useEffect(() => shiba.current?.setMood(mood as OrbMood), [mood, gl]);
  return (
    <div ref={host} className="shiba-room" data-mood={mood} data-gl={gl || undefined} role="img" aria-label={`The Shiba is ${mood === "idle" ? "resting" : mood}`}>
      {!gl && <div className="shiba-fallback" aria-hidden />}
    </div>
  );
}

// ---------- the state beside it ----------

const KIND_GLYPH: Record<FocusItem["kind"], string> = { ask: "?", stage: "◆", mention: "@", file: "⇪", changes: "↻", related: "∿" };
const KIND_LABEL: Record<FocusItem["kind"], string> = { ask: "Asked of you", stage: "Your stage", mention: "Tagged", file: "New file", changes: "Changed", related: "Your work" };

/** where a focus item opens: its place on the board (this app), or the file */
export function focusHref(f: Pick<FocusItem, "id" | "board" | "objectId" | "kind" | "href">) {
  if (f.objectId || f.kind === "changes" || f.kind === "mention" || f.kind === "stage" || f.kind === "ask") return `/?board=${encodeURIComponent(f.board)}${f.objectId ? `&focus=${encodeURIComponent(f.objectId)}` : ""}`;
  if (f.id.startsWith("file:")) return `/files/${f.id.slice(5)}`;
  return f.href;
}

export function FocusRow({ item, pointed }: { item: FocusItem; pointed?: boolean }) {
  return (
    <a className="today-row" href={focusHref(item)} data-kind={item.kind} data-tone={item.tone} data-pointed={pointed || undefined}>
      <span className="today-glyph" aria-hidden>
        {KIND_GLYPH[item.kind]}
      </span>
      <span className="today-row-text">
        <span className="today-row-title">{item.title}</span>
        <span className="today-row-why">{item.why}</span>
      </span>
      <span className="today-row-board" title={KIND_LABEL[item.kind]}>
        {item.boardName}
      </span>
    </a>
  );
}

export function GoalRow({ goal, pointed, onDone }: { goal: Goal; pointed?: boolean; onDone?: () => void }) {
  const done = goal.status === "done";
  const due = goal.dueAt ? new Date(goal.dueAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : null;
  return (
    <div className="today-goal" data-done={done || undefined} data-pointed={pointed || undefined}>
      <button className="today-check" aria-pressed={done} aria-label={done ? `${goal.title} is done` : `Mark “${goal.title}” done`} data-tip={done ? "Done" : "Mark done"} onClick={onDone} disabled={done || !onDone || goal.source !== "foundation"}>
        {done ? "✓" : ""}
      </button>
      <div className="today-goal-text">
        <span className="today-goal-title">{goal.title}</span>
        {(goal.detail || due) && (
          <span className="today-goal-detail">
            {due && <b>{due}</b>}
            {due && goal.detail ? " · " : ""}
            {goal.detail}
          </span>
        )}
        <span className="today-bar" aria-label={`${Math.round(goal.progress * 100)}%`}>
          <span style={{ width: `${Math.round(goal.progress * 100)}%` }} />
        </span>
      </div>
      <span className="today-goal-pct">{Math.round(goal.progress * 100)}%</span>
    </div>
  );
}

/** a company app as a row of the Today panel: its mark, its name, what it's for, whether it answers */
export function AppRow({ app, status, pointed }: { app: CompanyApp; status?: "ok" | "warn" | "unknown"; pointed?: boolean }) {
  const body = (
    <>
      <span className="today-glyph" aria-hidden>
        {app.glyph}
      </span>
      <span className="today-row-text">
        <span className="today-row-title">{app.name}</span>
        <span className="today-row-why">{app.url ? app.role : `${app.role} · not linked yet`}</span>
      </span>
      {app.url && status && status !== "unknown" ? <i className="today-dot" data-tone={status} title={status === "ok" ? "Live" : "Not answering"} /> : <span />}
    </>
  );
  if (!app.url)
    return (
      <span className="today-row today-app" data-unlinked data-pointed={pointed || undefined} data-tip="Not linked yet: ask an admin (or the Shiba) where it lives" tabIndex={0}>
        {body}
      </span>
    );
  return (
    <a className="today-row today-app" href={app.url} target="_blank" rel="noreferrer" data-pointed={pointed || undefined}>
      {body}
    </a>
  );
}

/** a company app, one press away (the chip form: the Chrome popup and `#/design`) */
export function AppChip({ app, status, pointed }: { app: CompanyApp; status?: "ok" | "warn" | "unknown"; pointed?: boolean }) {
  const tip = app.url ? `${app.role}${status === "warn" ? " · not answering" : status === "ok" ? " · live" : ""}` : `${app.role} · not linked yet: ask an admin (or the Shiba) where it lives`;
  const body = (
    <>
      <span className="today-chip-glyph" aria-hidden>
        {app.glyph}
      </span>
      {app.name}
      {app.url && status && status !== "unknown" && <i className="today-dot" data-tone={status} />}
    </>
  );
  if (!app.url)
    return (
      <span className="today-chip" data-unlinked data-pointed={pointed || undefined} data-tip={tip} tabIndex={0}>
        {body}
      </span>
    );
  const internal = app.id === "foundation";
  return (
    <a className="today-chip" href={internal ? "#/board" : app.url} target={internal ? undefined : "_blank"} rel="noreferrer" data-pointed={pointed || undefined} data-tip={tip}>
      {body}
    </a>
  );
}

// ---------- the page ----------

function greeting(first: string, n: number) {
  const h = new Date().getHours();
  const part = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const wants = n === 0 ? "Nothing is waiting on you." : n === 1 ? "One thing wants you today." : `${n} things want you today.`;
  return `${part}, ${first}.\n${wants}`;
}

const MOOD_WORD: Record<Mood, string> = { idle: "Shiba", listening: "Listening", thinking: "Thinking", speaking: "Shiba" };

export function Today({ user }: { user: UserInfo }) {
  const t = useToday();
  const insets = floorInsets(useUi());
  // under 760 px of open paper the room goes on top and the panel follows it in one scroll
  const room = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!room.current) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 760));
    ro.observe(room.current);
    return () => ro.disconnect();
  }, []);
  const [draft, setDraft] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [status, setStatus] = useState<Record<string, "ok" | "warn">>({});
  const listening = useRef<Listening | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadToday();
    void restoreConversation();
    const i = setInterval(() => document.hidden || void loadToday(), 60_000);
    return () => clearInterval(i);
  }, []);
  // which apps answer (the company's connectors), once on arrival
  useEffect(() => {
    void api<{ connectors: Array<{ id: string; state: { ok: boolean } }> }>("/api/company")
      .then((c) => setStatus(Object.fromEntries(c.connectors.map((x) => [x.id, x.state.ok ? "ok" : "warn"]))))
      .catch(() => {});
  }, []);
  // "/" talks by typing; V by voice
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]");
      if (typing) return;
      if (e.key === "/") (e.preventDefault(), input.current?.focus());
      else if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey) (e.preventDefault(), toggleVoice());
      else if (e.key === "Escape" && listening.current) (listening.current.cancel(), (listening.current = null), setHeard(null));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const toggleVoice = () => {
    if (listening.current) return listening.current.stop();
    setHeard("");
    listening.current = listen({
      heard: (w) => setHeard(w),
      done: (w) => {
        listening.current = null;
        setHeard(null);
        if (w.trim()) void ask(w);
      },
      failed: (m) => {
        listening.current = null;
        setHeard(null);
        setDraft(m);
      },
    });
    if (!listening.current) setHeard(null);
  };

  const today = t.today;
  // the room speaks of this visit; earlier visits sit in the history above
  const lastAny = t.exchanges[t.exchanges.length - 1];
  const last = lastAny && !lastAny.restored ? lastAny : undefined;
  const running = last?.status === "running";
  const pointed = useMemo(() => new Set(t.pointed), [t.pointed]);
  const active = today?.goals.filter((g) => g.status === "active") ?? [];
  const first = today?.person.first ?? user.name.split(/\s+/)[0];

  // the words in the room
  let eyebrow = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  let line = today ? greeting(first, today.focus.filter((f) => f.kind !== "related").length) : `Hello, ${first}.`;
  let sub: string | null = "Ask me about your day, your goals, or anything on the boards. Press / to type, V to talk.";
  if (t.heard !== null) {
    eyebrow = "Listening";
    line = t.heard || "I'm listening.";
    sub = "Stop talking and I'll answer. Esc drops it.";
  } else if (last) {
    eyebrow = MOOD_WORD[t.mood];
    if (last.status === "error") {
      eyebrow = "I couldn't answer";
      line = last.error ?? "Something went wrong.";
      sub = null;
    } else if (!last.answer) {
      eyebrow = "Thinking";
      line = `“${last.ask}”`;
      sub = last.steps.length ? `${last.steps[last.steps.length - 1]}…` : null;
    } else {
      line = last.answer.trim();
      sub = running && last.steps.length ? `${last.steps[last.steps.length - 1]}…` : null;
    }
  } else if (t.loadError) {
    eyebrow = "Offline";
    line = "I can't reach Foundation right now.";
    sub = t.loadError;
  }
  const earlier = t.exchanges.slice(-4, last ? -1 : undefined);

  return (
    <div ref={room} className={`today${narrow ? " is-narrow" : ""}`} data-mood={t.mood} style={{ left: insets.left, top: insets.top, right: insets.right }}>
      <ShibaRoom mood={t.mood} levels={wordsLevel} />
      <div className="today-veil" aria-hidden />

      <main className="today-words">
        {earlier.length > 0 && (
          <ol className="today-stream" aria-label="Earlier in this conversation">
            {earlier.map((x, i) => (
              <li key={x.id} style={{ ["--age" as string]: earlier.length - i }}>
                <span className="today-said">{x.ask}</span>
                {x.answer && <span className="today-answered">{x.answer.trim()}</span>}
              </li>
            ))}
          </ol>
        )}
        <p className="today-eyebrow" data-mood={t.mood}>
          {eyebrow}
        </p>
        <h1 className="today-line" aria-live="polite">
          {line}
        </h1>
        {sub && <p className="today-sub">{sub}</p>}

        <form
          className="today-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (running) return void stopAsking();
            const text = draft;
            setDraft("");
            void ask(text);
          }}
        >
          <button type="button" className="today-mic" aria-pressed={t.heard !== null} onClick={toggleVoice} disabled={!voiceAvailable()} data-tip={voiceAvailable() ? "Talk to the Shiba" : "This browser can't listen"} data-kbd="V">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
              <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            </svg>
          </button>
          <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Ask the Shiba, ${first}…`} aria-label="Ask the Shiba" />
          <button type="submit" className={`f-pill ${running ? "" : "is-agent"}`} disabled={!running && !draft.trim()}>
            {running ? "Stop" : "Ask"}
          </button>
        </form>
        {t.exchanges.length > 0 && (
          <button className="today-ghost" onClick={newConversation} data-tip="Start a new conversation with the Shiba">
            New conversation
          </button>
        )}
      </main>

      <aside className="today-state" aria-label="Today">
        <h2 className="today-panel-title">Today</h2>
        <section className="today-group">
          <h2 className="f-eyebrow">
            Todos <span className="today-count">{today ? today.focus.length + active.length : "…"}</span>
          </h2>
          {today && today.focus.length === 0 && <p className="today-empty">Nothing is waiting on you. Asks, notes that tag you, stages you own and new files on your boards will show up here.</p>}
          {today?.focus.map((f) => <FocusRow key={f.id} item={f} pointed={pointed.has(f.id)} />)}
          {today?.goals.map((g) => <GoalRow key={g.id} goal={g} pointed={pointed.has(g.id)} onDone={() => void saveGoal({ id: g.id, status: "done", progress: 1 })} />)}
          <form
            className="today-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!goalDraft.trim()) return;
              const title = goalDraft;
              setGoalDraft("");
              void saveGoal({ title });
            }}
          >
            <input value={goalDraft} onChange={(e) => setGoalDraft(e.target.value)} placeholder="Add a todo…" aria-label="Add a todo" />
          </form>
          {today && <p className="today-source" data-connected={today.sources.dataroom.connected || undefined}>{today.sources.dataroom.note}</p>}
        </section>

        <section className="today-group">
          <h2 className="f-eyebrow">Apps</h2>
          {today?.apps.filter((a) => a.id !== "foundation").map((a) => <AppRow key={a.id} app={a} status={a.connector ? (status[a.connector] ?? "unknown") : undefined} pointed={pointed.has(a.id)} />)}
        </section>
      </aside>
    </div>
  );
}
