/**
 * Background: what is running for you without a window of its own (2026-11-16), in the agents panel.
 * Two kinds of work, one list: the sessions of this computer's agents (T3: one thread per ask, named
 * for it; Foundation's small view of T3) and the server's own agents at work on this grid. Each says
 * who, on what, and how it stands, and can be opened or stopped. T3 itself, whole, is one press away.
 */

import { useEffect } from "react";
import { api } from "../lib/api";
import { refreshAvailable, useAvailable } from "../lib/agentsAvailable";
import { useCrew } from "../lib/crewWatch";
import { ProviderMark, providerOf } from "../characters/providers";
import { crewAsk, stopSession } from "../state/sessions";
import { openSession, toast, useUi } from "../state/ui";
import { followCrew } from "./Crew";
import { ago } from "./SidePane";

const WORD = { working: "working", waiting: "waiting for a person", idle: "at rest", error: "hit a problem" } as const;

export function BackgroundTasks() {
  const ui = useUi();
  const { host, t3 } = useAvailable();
  const crew = useCrew();
  useEffect(() => {
    void refreshAvailable();
    const t = setInterval(() => void refreshAvailable(), 3000);
    return () => clearInterval(t);
  }, []);
  const said = (e: unknown) => toast((e as Error).message, "bad");
  const openT3 = (thread?: string) =>
    void api<{ url: string }>("/api/t3host/open", { method: "POST", json: thread ? { thread } : {} })
      .then((r) => window.open(r.url, "_blank", "noopener"))
      .catch(said);
  const work = host?.work ?? [];
  const own = crew.filter((p) => (p.crew.via ?? "claude") === "claude");
  const viewer = ui.role === "viewer";
  return (
    <div className="bg-tasks" data-bg-tasks>
      <section className="bg-group">
        <header className="bg-head">
          <b>This computer's agents</b>
          <span className="bg-state">{t3 === "running" ? `T3 ${host?.version ?? ""} · ${work.length} session${work.length === 1 ? "" : "s"}` : t3 === "starting" ? "starting…" : "off"}</span>
          {t3 === "running" && (
            <button type="button" className="f-pill bg-open" onClick={() => openT3()} data-tip="T3, whole, in a tab of its own">
              Open T3 ↗
            </button>
          )}
        </header>
        {t3 !== "running" && <p className="agents-empty">This computer's agents are off, so nothing of theirs is running. Adding one starts them.</p>}
        {t3 === "running" && work.length === 0 && <p className="agents-empty">No sessions yet. An agent you add or speak to gets one, named for what it was asked.</p>}
        {work.map((w) => {
          const agent = host?.agents.find((a) => a.id === w.agent);
          return (
            <div key={w.id} className={`bg-task is-${w.state}`} data-bg-task={w.id}>
              <ProviderMark provider={providerOf(agent ?? { name: w.agent })} where={agent?.where} size={22} />
              <div className="bg-task-text">
                <b>{w.title || "Untitled session"}</b>
                <span>
                  {agent?.name ?? w.agent} · {w.model} · {WORD[w.state]} · {ago(Date.parse(w.updatedAt) || Date.now())} ago
                </span>
              </div>
              <span className="bg-task-acts">
                <button type="button" className="crew-row-btn" onClick={() => openT3(w.id)}>
                  Open
                </button>
                {!viewer && (w.state === "working" || w.state === "waiting") && (
                  <button type="button" className="crew-row-btn is-stop" onClick={() => void api(`/api/t3host/threads/${encodeURIComponent(w.id)}/stop`, { method: "POST" }).then(() => refreshAvailable()).catch(said)}>
                    Stop
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </section>

      <section className="bg-group">
        <header className="bg-head">
          <b>The server's own agents</b>
          <span className="bg-state">{own.length ? `${own.length} at work on this grid` : "none at work"}</span>
        </header>
        {own.length === 0 && <p className="agents-empty">Nothing is running. What you ask from ✦ Ask, the voice sheet or a council shows here while it works.</p>}
        {own.map((p) => {
          const mine = crewAsk(p.crew.id);
          return (
            <div key={p.crew.id} className={`bg-task is-${p.crew.status === "working" ? "working" : "idle"}`} data-bg-task={p.crew.id}>
              <ProviderMark provider="claude" where="cloud" size={22} />
              <div className="bg-task-text">
                <b>{p.crew.task || "An ask"}</b>
                <span>
                  {p.user.name} · {p.crew.doing || p.crew.status} · for {p.crew.askerName}
                </span>
              </div>
              <span className="bg-task-acts">
                <button type="button" className="crew-row-btn" onClick={() => followCrew(p.crew.id)}>
                  Follow
                </button>
                {mine && (
                  <>
                    <button type="button" className="crew-row-btn" onClick={() => openSession({ id: mine.session, kind: "agent", title: p.crew.task.slice(0, 40) || "Session" })}>
                      Open
                    </button>
                    <button type="button" className="crew-row-btn is-stop" onClick={() => stopSession(mine.session)}>
                      Stop
                    </button>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </section>
    </div>
  );
}
