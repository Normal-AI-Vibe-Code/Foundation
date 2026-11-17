/**
 * The agents pane, on the right (it takes search's place; search takes its).
 * A section's agent group, opened large: every agent at work on the board, by
 * the section it's in, with what it's doing, the ask it's on, and whether it
 * works with anyone.
 *
 * Working together is shown, not just said: a lead and the helpers it called
 * in are one block, held by a rule in the lead's colour, lead first. Agents on
 * separate asks in one section stand apart, and the section's heading says
 * how many teams met there.
 *
 * The section the pane was opened from is listed first (and stays listed while
 * it's empty, so the pane you opened answers the question you asked). Press a
 * section's name to go to it; Follow rides your view along with an agent;
 * Open and Stop are for the ones you asked.
 *
 * Under the board's agents: **this computer's agents**, from Foundation's own
 * T3 instance (apps/server/src/t3host.ts), the harness that runs Claude,
 * Codex (OpenAI) and the others from one place. Off until a person starts it
 * (it's a third-party program); running, it lists each agent T3 has with how
 * it stands (ready and on which plan, needs sign-in, not installed) and the
 * threads each is working on, in two groups: **in the cloud** (what you ask
 * goes to a service, on a plan or a key) and **on this computer** (a local
 * model server; nothing leaves it). **Ask** on a ready agent starts a
 * supervised thread on it for the section the pane was opened from; the agent
 * joins that section's group under its own name. An admin can add Kimi or
 * DeepSeek, to either group.
 */

import { CouncilTalk } from "./CouncilTalk";
import { AddAgent } from "./AddAgent";
import { BackgroundTasks } from "./BackgroundTasks";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { crewTeams, togetherWords, type CrewTeam } from "../lib/sectionCrew";
import { crewSection, useCrew } from "../lib/crewWatch";
import { CrewFaceView, type CrewFace } from "../components/SectionCrew";
import { getState, requestSnap, subscribe } from "../state/store";
import { crewAsk, stopSession, titleOf, useSession } from "../state/sessions";
import { WIDTHS, openSession, setUi, toast, useUi } from "../state/ui";
import { followCrew, useFollowing, type CrewPeer } from "./Crew";
import { FloorEdge } from "./FloorEdge";
import { useActiveBoard } from "./Presence";
import { activeBoard } from "../sync/board";

export interface AgentRowData extends CrewFace {
  task: string;
  mine: boolean;
}

export interface AgentsPlace {
  /** a section's id; null: agents that haven't aimed anywhere yet */
  id: string | null;
  name: string;
  /** the section the pane was opened from */
  at: boolean;
  teams: CrewTeam<AgentRowData>[];
}

const allSectionsOf = () => getState().allSections;
const activeBoardId = () => activeBoard()?.boardId ?? null;
/** where an ask from the pane goes: the section it was opened from, else the one in use */
const activeSectionOf = () => getState().activeSectionId;
function askSection(at: string | null, sections: Record<string, { id: string; name: string }>, active: string): { id: string; name: string } | null {
  const s = (at && sections[at]) || sections[active];
  return s ? { id: s.id, name: s.name } : null;
}

export const rowOf = (p: CrewPeer, me: string | undefined): AgentRowData => ({
  id: p.crew.id,
  name: p.user.name,
  hue: p.crew.hue,
  status: p.crew.status,
  doing: p.crew.doing,
  askerName: p.crew.askerName,
  lead: p.crew.lead,
  leadName: p.crew.leadName,
  task: p.crew.task,
  mine: p.crew.asker === me,
});

/** the agents by where they are: the section asked about first, then sections in the order agents came to them */
export function agentPlaces(rows: Array<{ row: AgentRowData; section: string | null }>, names: (id: string) => string | undefined, at: string | null): AgentsPlace[] {
  const by = new Map<string | null, AgentRowData[]>();
  if (at && names(at) !== undefined) by.set(at, []);
  for (const r of rows) {
    const list = by.get(r.section) ?? [];
    list.push(r.row);
    by.set(r.section, list);
  }
  const places = [...by.entries()].map(([id, list]) => ({
    id,
    name: id ? (names(id) ?? "A section") : "Not in a section yet",
    at: id !== null && id === at,
    teams: crewTeams(list, (r) => ({ id: r.id, lead: r.lead, target: null })),
  }));
  // the ones still finding their place go last
  return [...places.filter((p) => p.id !== null), ...places.filter((p) => p.id === null)];
}

export function AgentsPane() {
  const ui = useUi();
  const board = useActiveBoard();
  const crew = useCrew();
  const sections = useSyncExternalStore(subscribe, allSectionsOf);
  // an ask from the pane goes to the section in use: the pane follows it
  const active = useSyncExternalStore(subscribe, activeSectionOf);
  if (!ui.agents || ui.presenting) return null;
  const me = board?.user.id;
  const places = agentPlaces(
    crew.map((p) => ({ row: rowOf(p, me), section: crewSection(p) })),
    (id) => sections[id]?.name,
    ui.agentsAt,
  );
  const tabs = (
    <nav className="agents-tabs" role="tablist" aria-label="The agents panel">
      {(["council", "agents", "add", "tasks"] as const).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={ui.agentsTab === t} className={`agents-tab${ui.agentsTab === t ? " is-on" : ""}`} data-agents-tab={t} onClick={() => setUi({ agentsTab: t })}>
          {t === "council" ? "Council" : t === "agents" ? "At work" : t === "add" ? "＋ Add" : "Background"}
        </button>
      ))}
      <button className="top-btn" onClick={() => setUi({ agents: false })} aria-label="Close the agents panel" data-tip="Close">
        ✕
      </button>
    </nav>
  );
  if (ui.agentsTab !== "agents")
    return (
      <aside className="agents-pane floor-pane" style={{ width: ui.agentsW }} aria-label="Agents" data-agents-pane={ui.agentsTab}>
        <FloorEdge side="left" value={ui.agentsW} {...WIDTHS.agents} onChange={(w) => setUi({ agentsW: w })} label="Agents" />
        {tabs}
        {ui.agentsTab === "council" ? <CouncilTalk viewer={ui.role === "viewer"} /> : <div className="agents-scroll">{ui.agentsTab === "add" ? <AddAgent onDone={() => setUi({ agentsTab: "council" })} /> : <BackgroundTasks />}</div>}
      </aside>
    );
  return (
    <aside className="agents-pane floor-pane" style={{ width: ui.agentsW }} aria-label="Agents" data-agents-pane="agents">
      <FloorEdge side="left" value={ui.agentsW} {...WIDTHS.agents} onChange={(w) => setUi({ agentsW: w })} label="Agents" />
      {tabs}
      <AgentsPaneBody places={places} count={crew.length} onClose={() => setUi({ agents: false })} onGo={(id) => requestSnap({ kind: "section", id })} live foot={<T3Block viewer={ui.role === "viewer"} admin={ui.role === "admin"} section={askSection(ui.agentsAt, sections, active)} />} />
    </aside>
  );
}

/** the pane's contents, for the pane and the design page */
export function AgentsPaneBody({ places, count, onClose, onGo, live = false, foot }: { places: AgentsPlace[]; count: number; onClose?: () => void; onGo?: (sectionId: string) => void; live?: boolean; foot?: React.ReactNode }) {
  return (
    <>
      <header className="agents-head">
        Agents
        <span className="agents-head-n">{count === 0 ? "none at work" : `${count} on the board`}</span>
        <button className="top-btn" onClick={onClose} aria-label="Close the agents pane" data-tip="Close">
          ✕
        </button>
      </header>
      <div className="agents-scroll">
        {count === 0 && places.length === 0 && (
          <p className="agents-empty">
            No agents are at work on this board. Hold <span className="f-kbd">Space</span> and say what you need: the agent that takes it shows here, in the section it works in.
          </p>
        )}
        {places.map((place) => {
          const n = place.teams.reduce((a, t) => a + t.members.length, 0);
          const words = togetherWords(place.teams);
          return (
            <section key={place.id ?? "nowhere"} className={`agents-place${place.at ? " is-at" : ""}`} data-agents-place={place.name}>
              <div className="agents-place-head">
                <button className="agents-place-name" disabled={!place.id || !onGo} onClick={() => place.id && onGo?.(place.id)} data-tip={place.id ? "Go to this section" : undefined}>
                  {place.name}
                </button>
                <span className="agents-place-words">{n === 0 ? "" : words || "1 agent"}</span>
              </div>
              {n === 0 && <div className="agents-place-none">No agents here. One that comes in joins this group.</div>}
              {place.teams.map((t) => (
                <ul key={t.id} className={`agents-team${t.together ? " is-together" : ""}`} style={{ ["--crew" as string]: `var(--color-crew-${t.members[0].hue % 6})` }}>
                  {t.together && (
                    <li className="agents-team-label">
                      Working together <span>· one ask{t.members[0].askerName ? `, for ${t.members[0].askerName.split(" ")[0]}` : ""}</span>
                    </li>
                  )}
                  {t.members.map((m) => (live ? <LiveAgentRow key={m.id} row={m} team={t} /> : <AgentRow key={m.id} row={m} team={t} />))}
                </ul>
              ))}
            </section>
          );
        })}
        {foot}
      </div>
    </>
  );
}

// ---------- this computer's agents: Foundation's own T3 instance ----------

/** apps/server/src/t3host.ts */
export interface T3Agent {
  id: string;
  driver: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  state: "ready" | "sign-in" | "missing" | "off" | "error";
  account?: string;
  message?: string;
  models: number;
  modelList: Array<{ slug: string; name: string }>;
  model?: string;
  /** cloud: the work goes to a service · local: a model server on this computer */
  where: "cloud" | "local";
  /** added from Foundation (Kimi, DeepSeek): which, and the address it talks to */
  added?: { preset: string; baseUrl: string };
  /** a thread on it can read and write the board; else it works in its folder only */
  boardTools?: boolean;
}
export interface T3Work {
  id: string;
  title: string;
  project: string;
  agent: string;
  model: string;
  state: "working" | "waiting" | "idle" | "error";
  updatedAt: string;
}
export interface T3Host {
  state: "off" | "starting" | "running" | "error";
  detail?: string;
  port?: number;
  version?: string;
  startedBy?: string;
  since: number;
  agents: T3Agent[];
  work: T3Work[];
}

/** how an agent stands, in a few words */
export function t3AgentWords(a: T3Agent): string {
  if (a.state === "ready") return [a.account ?? "ready", a.models ? `${a.models} model${a.models === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  if (a.state === "sign-in") return "needs sign-in on this computer";
  if (a.state === "missing") return "not installed on this computer";
  if (a.state === "off") return "off";
  return a.message ?? "can't start";
}

const WORK_WORD: Record<T3Work["state"], string> = { working: "working", waiting: "waiting for a person", idle: "at rest", error: "hit a problem" };

/** the model an agent runs unless told otherwise */
const firstModel = (a: T3Agent) => a.model ?? a.modelList[0]?.slug ?? "";

export interface T3Preset {
  name: string;
  cloud: { baseUrl: string; model: string };
  local: { baseUrl: string; model: string };
}
export interface T3Local {
  baseUrl: string;
  up: boolean;
  models: string[];
}
export interface T3AddInput {
  preset: string;
  where: "cloud" | "local";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

/** one agent T3 has: how it stands, its threads at work, and (ready, with somewhere to work) a way to ask it */
function T3AgentRow({
  agent,
  hue,
  work,
  viewer,
  admin,
  section,
  asking,
  onAsking,
  onAsk,
  onOpen,
  onStopWork,
  onRemove,
}: {
  agent: T3Agent;
  hue: number;
  work: T3Work[];
  viewer: boolean;
  admin: boolean;
  section?: { id: string; name: string } | null;
  asking: boolean;
  onAsking?: (on: boolean) => void;
  onAsk?: (agent: string, model: string, text: string) => Promise<boolean> | void;
  onOpen?: (thread?: string) => void;
  onStopWork?: (thread: string) => void;
  onRemove?: (agent: string) => void;
}) {
  const [text, setText] = useState("");
  const [model, setModel] = useState(firstModel(agent));
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await onAsk?.(agent.id, model, text.trim());
    setSending(false);
    if (ok !== false) {
      setText("");
      onAsking?.(false);
    }
  };
  return (
    <li className={`t3-agent is-${agent.state}`} style={{ ["--crew" as string]: `var(--color-crew-${hue % 6})` }} data-t3-agent={agent.id}>
      <span className="crew-face is-large t3-face" aria-hidden>
        {agent.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="t3-agent-main">
        <div className="t3-agent-top">
          <span className="agent-row-name">{agent.name}</span>
          {agent.version && !agent.added && <span className="agent-row-role">{agent.version}</span>}
          {agent.added && <span className="agent-row-role">{agent.model}</span>}
          <span className="t3-agent-acts">
            {agent.state === "ready" && !viewer && section && (
              <button className={`crew-row-btn${asking ? " is-on" : ""}`} onClick={() => onAsking?.(!asking)} data-tip={`Ask ${agent.name} for something in ${section.name}`}>
                Ask
              </button>
            )}
            {agent.added && admin && (
              <button className="crew-row-btn" onClick={() => onRemove?.(agent.id)} data-tip={`Remove ${agent.name} from T3 (its key goes with it)`}>
                Remove
              </button>
            )}
          </span>
        </div>
        <div className="t3-agent-words" data-tip={agent.state === "ready" ? agent.added?.baseUrl : agent.message}>
          <span className={`f-dot ${agent.state === "ready" ? "is-ok" : agent.state === "sign-in" ? "is-warn" : agent.state === "error" ? "is-bad" : ""}`} /> {agent.added && agent.state === "ready" ? hostOf(agent.added.baseUrl) : t3AgentWords(agent)}
        </div>
      </div>
      {asking && section && (
        <div className="t3-ask">
          <textarea
            className="t3-ask-text"
            autoFocus
            rows={3}
            value={text}
            placeholder={`What should ${agent.name} do in ${section.name}?`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              if (e.key === "Escape") onAsking?.(false);
            }}
          />
          <div className="t3-ask-foot">
            {agent.modelList.length > 1 ? (
              <select className="t3-ask-model" value={model} onChange={(e) => setModel(e.target.value)} aria-label={`${agent.name}'s model`}>
                {agent.modelList.map((m) => (
                  <option key={m.slug} value={m.slug}>
                    {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="t3-ask-note">{model}</span>
            )}
            <span className="t3-ask-note" data-tip={agent.boardTools ? `${agent.name} can read the board and make cards in ${section.name} under its own name. Anything else it would change waits for a person, in T3.` : `${agent.name} has no board tools: it works in a folder of its own and says what it made.`}>
              {agent.boardTools ? "writes the board" : "works in its folder"} · {agent.where === "local" ? "on this computer" : agent.added ? "your key" : "your plan"}
            </span>
            <button className="f-pill is-agent t3-ask-send" onClick={() => void send()} disabled={!text.trim() || sending}>
              {sending ? "Starting" : "Ask"}
            </button>
          </div>
        </div>
      )}
      {work.map((w) => (
        <div key={w.id} className={`t3-work is-${w.state}`} data-t3-work={w.id}>
          <span className="t3-work-title">{w.title}</span>
          <span className="t3-work-state">{WORK_WORD[w.state]}</span>
          {!viewer && (
            <span className="t3-work-acts">
              <button className="crew-row-btn" onClick={() => onOpen?.(w.id)} data-tip={w.state === "waiting" ? "Open it in T3 to answer what it's waiting for" : "Open its transcript in T3"}>
                Open
              </button>
              {w.state !== "idle" && (
                <button className="crew-row-btn is-stop" onClick={() => onStopWork?.(w.id)}>
                  Stop
                </button>
              )}
            </span>
          )}
        </div>
      ))}
    </li>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** adding Kimi or DeepSeek: which, and where it runs (the cloud with a key, or a model server on this computer) */
export function T3AddForm({ presets, local, start, only, busy, error, onWhere, onAdd, onCancel }: { presets: Record<string, T3Preset>; local: T3Local | null; start?: { preset?: string; where?: "cloud" | "local" }; /** the agent and where it runs are already settled (the guided steps): no pickers */ only?: boolean; busy?: boolean; error?: string | null; onWhere?: (where: "cloud" | "local", baseUrl: string) => void; onAdd?: (input: T3AddInput) => void; onCancel?: () => void }) {
  const names = Object.keys(presets);
  const [preset, setPreset] = useState(start?.preset ?? names[0] ?? "");
  const [where, setWhere] = useState<"cloud" | "local">(start?.where ?? "cloud");
  const [key, setKey] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const d = presets[preset]?.[where];
  const baseUrl = base ?? d?.baseUrl ?? "";
  const modelNow = model ?? (where === "local" ? (local?.models[0] ?? "") : (d?.model ?? ""));
  const pick = (p: string, w: "cloud" | "local") => {
    setPreset(p);
    setWhere(w);
    setModel(null);
    setBase(null);
    onWhere?.(w, presets[p]?.[w].baseUrl ?? "");
  };
  const ready = !!modelNow && !!baseUrl && (where === "local" || !!key.trim());
  return (
    <form
      className="t3-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onAdd?.({ preset, where, apiKey: where === "cloud" ? key.trim() : undefined, model: modelNow, baseUrl });
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="t3-add-row" hidden={only}>
        <div className="pane-seg" role="tablist" aria-label="Which agent">
          {names.map((p) => (
            <button type="button" key={p} role="tab" aria-selected={preset === p} className={`pane-seg-btn${preset === p ? " is-on" : ""}`} onClick={() => pick(p, where)}>
              {presets[p].name}
            </button>
          ))}
        </div>
        <div className="pane-seg" role="tablist" aria-label="Where it runs">
          {(["cloud", "local"] as const).map((w) => (
            <button type="button" key={w} role="tab" aria-selected={where === w} className={`pane-seg-btn${where === w ? " is-on" : ""}`} onClick={() => pick(preset, w)}>
              {w === "cloud" ? "Cloud" : "This computer"}
            </button>
          ))}
        </div>
      </div>
      <p className="t3-add-words">
        {where === "cloud"
          ? `${presets[preset]?.name}'s own service. What you ask goes to ${hostOf(baseUrl)} and is billed to your key there. T3 keeps the key; Foundation doesn't.`
          : `A ${presets[preset]?.name} model run by a model server on this computer (Ollama's address by default). No key, and nothing leaves the computer.`}
      </p>
      {where === "cloud" && (
        <label className="t3-field">
          <span>API key</span>
          <input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={`Your ${presets[preset]?.name} API key`} />
        </label>
      )}
      <label className="t3-field">
        <span>Model</span>
        {where === "local" && local?.up && local.models.length > 0 ? (
          <select value={modelNow} onChange={(e) => setModel(e.target.value)}>
            {local.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input type="text" spellCheck={false} value={modelNow} onChange={(e) => setModel(e.target.value)} placeholder={where === "local" ? "a model your local server has, e.g. deepseek-r1:14b" : "model id"} />
        )}
      </label>
      <label className="t3-field">
        <span>Address</span>
        <input type="text" spellCheck={false} value={baseUrl} onChange={(e) => setBase(e.target.value)} onBlur={() => where === "local" && onWhere?.("local", baseUrl)} />
      </label>
      {where === "local" && (
        <p className={`t3-add-note${local && !local.up ? " is-warn" : ""}`}>
          <span className={`f-dot ${local?.up ? "is-ok" : "is-warn"}`} />{" "}
          {local === null ? "Asking this computer's model server…" : local.up ? `A model server answers at ${hostOf(local.baseUrl)} with ${local.models.length} model${local.models.length === 1 ? "" : "s"}.` : `No model server answers at ${hostOf(baseUrl)}. It can be added now and will work once one runs there with this model.`}
        </p>
      )}
      {where === "cloud" && <p className="t3-add-note">The model id and address are the vendor's as last published: change them if yours differ.</p>}
      {error && <p className="t3-words is-bad">{error}</p>}
      <div className="t3-add-foot">
        <button type="button" className="crew-row-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="f-pill t3-add-go" disabled={!ready || busy}>
          {busy ? "Adding" : `Add ${presets[preset]?.name ?? ""}${where === "local" ? " (local)" : ""}`}
        </button>
      </div>
    </form>
  );
}

export interface T3BlockProps {
  host: T3Host | null;
  viewer: boolean;
  admin?: boolean;
  busy?: boolean;
  /** where an ask would go: the section the pane was opened from, or the one in use */
  section?: { id: string; name: string } | null;
  /** the agent whose ask is open (the design page holds one open) */
  askingStart?: string;
  /** the add form, when it's open */
  form?: React.ReactNode;
  onStart?: () => void;
  onStop?: () => void;
  onAsk?: (agent: string, model: string, text: string) => Promise<boolean> | void;
  onOpen?: (thread?: string) => void;
  onStopWork?: (thread: string) => void;
  onRemove?: (agent: string) => void;
  onAddOpen?: () => void;
}

/** the block alone, for the pane and the design page */
export function T3BlockView({ host, viewer, admin = false, busy, section, askingStart, form, onStart, onStop, onAsk, onOpen, onStopWork, onRemove, onAddOpen }: T3BlockProps) {
  const [asking, setAsking] = useState<string | null>(askingStart ?? null);
  const state = busy && host?.state !== "running" ? "starting" : (host?.state ?? "off");
  const on = host?.agents.filter((a) => a.state !== "off") ?? [];
  const off = host?.agents.filter((a) => a.state === "off") ?? [];
  const cloud = on.filter((a) => a.where !== "local");
  const local = on.filter((a) => a.where === "local");
  const row = (a: T3Agent) => (
    <T3AgentRow
      key={a.id}
      agent={a}
      hue={on.indexOf(a)}
      work={host!.work.filter((w) => w.agent === a.id && w.state !== "idle")}
      viewer={viewer}
      admin={admin}
      section={section}
      asking={asking === a.id}
      onAsking={(v) => setAsking(v ? a.id : null)}
      onAsk={onAsk}
      onOpen={onOpen}
      onStopWork={onStopWork}
      onRemove={onRemove}
    />
  );
  return (
    <section className={`agents-place t3-block is-${state}`} data-t3={state}>
      <div className="agents-place-head">
        <span className="t3-title">This computer's agents</span>
        <span className="agents-place-words">
          {state === "running" ? `T3${host?.version ? ` ${host.version}` : ""}` : state === "starting" ? "starting" : state === "error" ? "stopped" : "off"}
        </span>
        {state === "running" && !viewer && (
          <span className="t3-head-acts">
            <button className="crew-row-btn" onClick={() => onOpen?.()} data-tip="Open T3's own page: every thread, approvals, its settings">
              Open T3
            </button>
            <button className="crew-row-btn" onClick={onStop} data-tip="Stop T3 and the agents it runs · its threads are kept">
              Stop
            </button>
          </span>
        )}
      </div>
      {state === "off" && <p className="t3-words">T3 runs Claude, Codex and other coding agents from one place. It's a program on this computer, so a person starts it.</p>}
      {state === "starting" && (
        <p className="t3-words">
          <span className="thinking-dots"><i /><i /><i /></span> {host?.detail ?? "Starting T3"}
        </p>
      )}
      {state === "error" && <p className="t3-words is-bad">{host?.detail ?? "T3 stopped."}</p>}
      {(state === "off" || state === "error") && !viewer && (
        <button className="f-pill t3-start" onClick={onStart} disabled={busy}>
          {state === "error" ? "Start again" : "Start T3"}
        </button>
      )}
      {state === "running" && (
        <>
          {host!.agents.length === 0 && <p className="t3-words">Asking T3 which agents it has…</p>}
          {cloud.length > 0 && (
            <>
              <div className="t3-where" data-tip="What you ask these goes to a service, on your plan or key">
                In the cloud
              </div>
              <ul className="t3-agents" data-t3-where="cloud">{cloud.map(row)}</ul>
            </>
          )}
          {host!.agents.length > 0 && (
            <>
              <div className="t3-where" data-tip="These run on a model server on this computer: no key, nothing leaves it">
                On this computer
              </div>
              {local.length > 0 ? <ul className="t3-agents" data-t3-where="local">{local.map(row)}</ul> : <p className="t3-off">None yet. Kimi or DeepSeek can run here on a local model server.</p>}
            </>
          )}
          {off.length > 0 && <p className="t3-off">Off in T3: {off.map((a) => a.name).join(", ")}</p>}
          {form ??
            (admin && (
              <button className="crew-row-btn t3-add-open" onClick={onAddOpen}>
                ＋ Add Kimi or DeepSeek
              </button>
            ))}
        </>
      )}
    </section>
  );
}

/** Foundation's T3, read while the pane is open (every 3 s; faster while it starts) */
export function T3Block({ viewer, admin, section }: { viewer: boolean; admin: boolean; section: { id: string; name: string } | null }) {
  const [host, setHost] = useState<T3Host | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [presets, setPresets] = useState<Record<string, T3Preset>>({});
  const [local, setLocal] = useState<T3Local | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const fast = busy || host?.state === "starting";
  useEffect(() => {
    let gone = false;
    const read = () => void api<T3Host>("/api/t3host").then((h) => !gone && setHost(h)).catch(() => {});
    read();
    const t = setInterval(read, fast ? 800 : 3000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [fast]);
  const said = (e: unknown) => toast((e as Error).message, "bad");
  const press = (what: "start" | "stop") => {
    setBusy(true);
    void api<T3Host>(`/api/t3host/${what}`, { method: "POST" })
      .then(setHost) // a start that failed says why in the block itself
      .catch(said)
      .finally(() => setBusy(false));
  };
  const askLocal = (baseUrl: string) => {
    setLocal(null);
    void api<T3Local>(`/api/t3host/local?base=${encodeURIComponent(baseUrl)}`).then(setLocal).catch(() => setLocal({ baseUrl, up: false, models: [] }));
  };
  const openAdd = () => {
    setAdding(true);
    setAddError(null);
    void api<Record<string, T3Preset>>("/api/t3host/presets").then(setPresets).catch(said);
  };
  const board = activeBoardId();
  return (
    <T3BlockView
      host={host}
      viewer={viewer}
      admin={admin}
      busy={busy}
      section={section}
      onStart={() => press("start")}
      onStop={() => press("stop")}
      onAsk={async (agent, model, text) => {
        if (!section || !board) return false;
        try {
          const r = await api<{ name: string }>("/api/t3host/threads", { method: "POST", json: { board, section: section.id, agent, model, text } });
          toast(`${r.name} is on it, in ${section.name}`, "agent");
          return true;
        } catch (e) {
          said(e);
          return false;
        }
      }}
      onOpen={(thread) =>
        void api<{ url: string }>("/api/t3host/open", { method: "POST", json: { thread } })
          .then((r) => window.open(r.url, "_blank", "noopener"))
          .catch(said)
      }
      onStopWork={(thread) => void api(`/api/t3host/threads/${encodeURIComponent(thread)}/stop`, { method: "POST" }).catch(said)}
      onRemove={(agent) => void api<{ agents: T3Agent[] }>(`/api/t3host/agents/${encodeURIComponent(agent)}`, { method: "DELETE" }).then((r) => setHost((h) => (h ? { ...h, agents: r.agents } : h))).catch(said)}
      onAddOpen={openAdd}
      form={
        adding && Object.keys(presets).length > 0 ? (
          <T3AddForm
            presets={presets}
            local={local}
            busy={addBusy}
            error={addError}
            onWhere={(w, baseUrl) => w === "local" && askLocal(baseUrl)}
            onCancel={() => setAdding(false)}
            onAdd={(input) => {
              setAddBusy(true);
              setAddError(null);
              void api<{ agents: T3Agent[] }>("/api/t3host/agents", { method: "POST", json: input })
                .then((r) => {
                  setHost((h) => (h ? { ...h, agents: r.agents } : h));
                  setAdding(false);
                })
                .catch((e) => setAddError((e as Error).message))
                .finally(() => setAddBusy(false));
            }}
          />
        ) : undefined
      }
    />
  );
}

/** what an agent is to its team, in a word or two */
function roleOf(row: AgentRowData, team: CrewTeam<AgentRowData>): string {
  if (row.lead) return team.members.some((m) => m.id === row.lead) ? "helper" : `helper of ${row.leadName ?? "another agent"}`;
  return team.together ? "lead" : row.mine ? "yours" : row.askerName ? `for ${row.askerName.split(" ")[0]}` : "";
}

export function AgentRow({ row, team, acts }: { row: AgentRowData; team: CrewTeam<AgentRowData>; acts?: React.ReactNode }) {
  const role = roleOf(row, team);
  return (
    <li className={`agent-row is-${row.status}`} style={{ ["--crew" as string]: `var(--color-crew-${row.hue % 6})` }} data-agent-row={row.name}>
      <CrewFaceView face={row} size="large" />
      <div className="agent-row-main">
        <div>
          <span className="agent-row-name">{row.name}</span>
          {role && <span className="agent-row-role">{role}</span>}
        </div>
        <div className="agent-row-doing">{row.status === "working" ? row.doing || "working" : row.status === "done" ? "done" : row.status === "stopped" ? "stopped" : "hit a problem"}</div>
      </div>
      {row.task && !row.lead && <div className="agent-row-task">Asked: {titleOf(row.task)}</div>}
      {row.task && row.lead && <div className="agent-row-task">Its part: {titleOf(row.task)}</div>}
      <div className="agent-row-acts">{acts}</div>
    </li>
  );
}

export function LiveAgentRow({ row, team }: { row: AgentRowData; team: CrewTeam<AgentRowData> }) {
  const ask = crewAsk(row.id);
  const run = useSession(ask?.session ?? null);
  const busy = run.busy && row.status === "working";
  const following = useFollowing() === row.id;
  return (
    <AgentRow
      row={row}
      team={team}
      acts={
        <>
          {row.status === "working" && (
            <button className={`crew-row-btn${following ? " is-on" : ""}`} onClick={() => followCrew(following ? null : row.id)} data-tip={following ? "Stop following" : `Follow ${row.name}: your view rides along until you move`}>
              {following ? "Following" : "Follow"}
            </button>
          )}
          {row.mine && ask && (
            <button className="crew-row-btn" onClick={() => openSession({ id: ask.session, kind: "agent", title: titleOf(ask.prompt) })} data-tip="Open its session: what it did, step by step">
              Open
            </button>
          )}
          {row.mine && ask && busy && (
            <button className="crew-row-btn is-stop" onClick={() => stopSession(ask.session)} data-tip={`Stop ${row.name}`}>
              Stop
            </button>
          )}
        </>
      }
    />
  );
}
