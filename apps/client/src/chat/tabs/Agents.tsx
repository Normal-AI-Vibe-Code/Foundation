/**
 * ChatForm's Agents tab (docs/chatform.md §3; server: apps/server/src/chatagents.ts). Talk with agents as
 * you would with a person.
 *
 * Left, a list in four parts: **Talk to** (every agent that can be talked to here: its face, whose model,
 * where it runs and whether it's ready), **Your conversations** (a channel of kind `agent` per person and
 * agent), **Foundation sessions** (your agent sessions on the grids, read here) and **T3 threads** (this
 * computer's T3, grouped by how they stand). Right, the open one: a conversation is a real channel, drawn
 * with the Chat tab's own timeline and composer and live on the same socket; a session or a T3 thread is
 * a read-only transcript in the same message shapes, and a T3 thread this server's T3 holds takes your
 * next message as its next turn (else: Open in T3 to continue).
 *
 * The open conversation's head is the agent itself, live (`characters/Avatar`, on the shared stage
 * budget): thinking while its turn works, talking while its words arrive, idle otherwise; with Stop while a
 * turn runs. Violet is the agent, everywhere.
 *
 * Address: `#/chat/agents` · `/c/<channel>` · `/s/<session>` · `/t/<thread>`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatHandle, chatTitle, type ChatChannelView, type ChatMessage, type ChatParty, type Mood, type UserInfo } from "@foundation/protocol";
import { api } from "../../lib/api";
import { goChat } from "../../lib/place";
import { toast } from "../../state/ui";
import { discard, editMessage, loadChannel, markRead, react, removeMessage, retry, sayTyping, send, setOpen, useChat } from "../model";
import { layoutTimeline, restOf } from "../logic";
import { Timeline } from "../Timeline";
import { Composer } from "../Composer";
import { PartyAvatar } from "../Avatar";
import type { MessageActions } from "../Message";
import { Avatar } from "../../characters/Avatar";
import { readyCharacters, seats, useRoster, type RosterCharacter } from "../../characters/roster";
import { ProviderMark, type Provider } from "../../characters/providers";
import { useStage } from "../../characters/stageBudget";
import "./agents.css";

// ---------------------------------------------------------------- what the server says (chatagents.ts)

interface AgentInfo {
  name: string;
  via: string;
  kind: "claude" | "shiba" | "t3" | "crew";
  provider: string;
  where: "cloud" | "this computer";
  host: "foundation" | "t3";
  service: string;
  state: "ready" | "needs sign-in" | "off";
  why?: string;
  character: string | null;
  tools: boolean;
}
interface SessionRow {
  id: string;
  title: string;
  board: string;
  runs: number;
  status: string;
  updatedAt: number;
}
type ThreadStatus = "working" | "waiting" | "problem" | "idle";
interface ThreadRow {
  id: string;
  title: string;
  project: string;
  agent: string;
  via: string;
  status: ThreadStatus;
  updatedAt: number;
  source: "foundation" | "vision";
  canContinue: boolean;
  why?: string;
  url?: string | null;
}
interface TurnView {
  id: string;
  channel: string;
  root: string | null;
  agent: string;
  by: string;
  byName: string;
  messageId: string | null;
  status: "thinking" | "working" | "writing" | "waiting" | "done" | "stopped" | "error";
  doing?: string;
}
interface Listing {
  agents: AgentInfo[];
  conversations: ChatChannelView[];
  sessions: SessionRow[];
  threads: ThreadRow[];
  t3: { state: string; detail?: string; vision: { available: boolean; missing?: string } };
}

const enc = encodeURIComponent;
const RUNNING = new Set(["thinking", "working", "writing", "waiting"]);
const GROUP: Array<{ status: ThreadStatus; label: string }> = [
  { status: "working", label: "Working" },
  { status: "waiting", label: "Waiting for a person" },
  { status: "problem", label: "Problem" },
  { status: "idle", label: "At rest" },
];

function parse(rest: string): { kind: "c" | "s" | "t"; id: string } | null {
  const [k, ...id] = rest.split("/");
  return (k === "c" || k === "s" || k === "t") && id.join("/") ? { kind: k, id: decodeURIComponent(id.join("/")) } : null;
}
const ago = (at: number) => {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const agentPartyOf = (name: string, via?: string): ChatParty => ({ kind: "agent", id: name, name, ...(via ? { via } : {}) });

/** the character an agent name wears: the one chosen for it (or Claude's, as chat draws it), else the crew's steady pick */
function useCharacter(name: string): RosterCharacter | undefined {
  const roster = useRoster();
  return useMemo(() => {
    const id = roster.avatars[name] ?? roster.avatars.Claude;
    const chosen = id ? readyCharacters(roster).find((c) => c.id === id) : undefined;
    return chosen ?? seats(roster, [name])[name];
  }, [roster, name]);
}

// ---------------------------------------------------------------- the tab

export default function AgentsTab({ user, rest }: { user: UserInfo; rest: string }) {
  const s = useChat();
  const open = parse(rest);
  const [list, setList] = useState<Listing | null>(null);
  const [why, setWhy] = useState("");
  const refresh = useCallback(() => {
    api<Listing>("/api/chat/agents")
      .then((l) => {
        setList(l);
        setWhy("");
      })
      .catch((e: Error) => setWhy(e.message));
  }, []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 8000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // my conversations: the server's list, kept live by the chat store
  const conversations = useMemo(() => {
    const byId = new Map<string, ChatChannelView>();
    for (const c of list?.conversations ?? []) byId.set(c.id, c);
    for (const c of Object.values(s.channels)) if (c.kind === "agent" && !c.archivedAt) byId.set(c.id, c);
    return [...byId.values()].sort((a, b) => b.lastPostAt - a.lastPostAt);
  }, [list, s.channels]);

  const talk = (a: AgentInfo) =>
    void api<{ channel: ChatChannelView }>(`/api/chat/agents/${enc(a.name)}/open`, { method: "POST" })
      .then((r) => goChat("agents", `c/${r.channel.id}`))
      .catch((e: Error) => toast(e.message, "bad"));

  const agentOf = (name?: string) => list?.agents.find((a) => a.name === name);

  return (
    <div className="cfa-tab" data-chat-tab="agents">
      <aside className="cfa-list" aria-label="Agents and conversations">
        <div className="cfa-list-scroll">
          {why && <p className="cfa-why">{why}</p>}
          <Part title="Talk to" count={list?.agents.length}>
            {(list?.agents ?? []).map((a) => (
              <button key={a.name} className={`cfa-row is-agent${a.state !== "ready" ? " is-off" : ""}`} onClick={() => talk(a)} data-agent-row={a.name} data-tip={a.why ? `${a.service} · ${a.why}` : a.service}>
                <PartyAvatar party={agentPartyOf(a.name, a.via)} size={28} />
                <span className="cfa-row-words">
                  <span className="cfa-row-name">{a.name}</span>
                  <span className="cfa-row-sub">{a.host === "t3" ? "T3 · " : ""}{a.where === "this computer" ? "on this computer" : "in the cloud"}</span>
                </span>
                <span className="cfa-row-marks">
                  <ProviderMark provider={a.provider as Provider} where={a.where === "this computer" ? "local" : "cloud"} size={20} />
                  <span className={`cfa-state is-${a.state.replace(/\s+/g, "-")}`} data-tip={a.state === "ready" ? "Ready" : a.why ?? a.state} aria-label={a.state} />
                </span>
              </button>
            ))}
            {list && !list.agents.length && <p className="cfa-empty">No agents here yet.</p>}
          </Part>
          <Part title="Your conversations" count={conversations.length}>
            {conversations.map((c) => (
              <a key={c.id} href={`#/chat/agents/c/${c.id}`} className={`cfa-row${open?.kind === "c" && open.id === c.id ? " is-current" : ""}${c.unread ? " is-unread" : ""}`} data-conversation={c.id}>
                <PartyAvatar party={agentPartyOf(c.agent?.name ?? chatTitle(c, user.id), c.agent?.via)} size={28} />
                <span className="cfa-row-words">
                  <span className="cfa-row-name">{chatTitle(c, user.id)}</span>
                  <span className="cfa-row-sub">{c.lastText ?? "Nothing said yet"}</span>
                </span>
                {c.unread > 0 && <span className="cfa-badge">{c.unread}</span>}
              </a>
            ))}
            {!conversations.length && <p className="cfa-empty">Press an agent above to start talking. In any channel, @ an agent and it answers in the thread.</p>}
          </Part>
          <Part title="Foundation sessions" count={list?.sessions.length}>
            {(list?.sessions ?? []).slice(0, 12).map((x) => (
              <a key={x.id} href={`#/chat/agents/s/${x.id}`} className={`cfa-row is-quiet${open?.kind === "s" && open.id === x.id ? " is-current" : ""}`} data-session={x.id}>
                <span className="cfa-row-words">
                  <span className="cfa-row-name">{x.title}</span>
                  <span className="cfa-row-sub">
                    {x.board} · {x.runs} turn{x.runs === 1 ? "" : "s"} · {ago(x.updatedAt)}
                  </span>
                </span>
                {x.status === "running" && <span className="cfa-state is-working" aria-label="working" />}
              </a>
            ))}
            {list && !list.sessions.length && <p className="cfa-empty">Your agent sessions on the grids show here.</p>}
          </Part>
          <Part title="T3 threads" count={list?.threads.length}>
            {list && list.t3.state !== "running" && <p className="cfa-empty">T3 isn't running on this computer{list.t3.detail ? `: ${list.t3.detail}` : ""}. Settings → Agents starts it.</p>}
            {GROUP.map((g) => {
              const rows = (list?.threads ?? []).filter((t) => t.status === g.status);
              if (!rows.length) return null;
              return (
                <div key={g.status} className="cfa-group" data-thread-group={g.status}>
                  <div className="cfa-group-head">
                    <span className={`cfa-state is-${g.status}`} aria-hidden />
                    {g.label}
                  </div>
                  {rows.slice(0, 20).map((t) => (
                    <a key={t.id} href={`#/chat/agents/t/${t.id}`} className={`cfa-row is-quiet${open?.kind === "t" && open.id === t.id ? " is-current" : ""}`} data-thread={t.id}>
                      <span className="cfa-row-words">
                        <span className="cfa-row-name">{t.title}</span>
                        <span className="cfa-row-sub">
                          {t.agent} · {t.project || (t.source === "vision" ? "Vision Code" : "T3")} · {ago(t.updatedAt)}
                        </span>
                      </span>
                    </a>
                  ))}
                </div>
              );
            })}
          </Part>
        </div>
      </aside>
      <section className="cfa-open">
        {!open ? (
          <div className="chat-tab-empty">
            <h2>Talk with an agent</h2>
            <p>Pick one on the left: a conversation with it is yours, and it answers as itself, marked as an agent working for you. In any channel, mention one (@claude) and it answers in that message's thread.</p>
          </div>
        ) : open.kind === "c" ? (
          <Conversation key={open.id} user={user} channelId={open.id} agent={agentOf(s.channels[open.id]?.agent?.name)} />
        ) : open.kind === "s" ? (
          <SessionView key={open.id} id={open.id} user={user} />
        ) : (
          <ThreadView key={open.id} id={open.id} user={user} onSent={refresh} />
        )}
      </section>
    </div>
  );
}

function Part({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="cfa-part">
      <h3 className="cfa-part-head">
        {title}
        {count ? <span className="cfa-part-count">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- the agent, live, at the head

function AgentHead({ name, via, provider, where, line, mood, children }: { name: string; via?: string; provider?: string; where?: string; line: string; mood: Mood; children?: React.ReactNode }) {
  const character = useCharacter(name);
  const { live, take } = useStage(Boolean(character));
  return (
    <header className="cfa-head" data-agent-head={name} data-mood={mood}>
      {/* the agent stands behind the head's own bottom hairline, chest up: no disc, no ring (2026-11-20) */}
      <div className={`cfa-face is-${mood}${character ? "" : " is-none"}`} onPointerEnter={take} aria-hidden data-agent-figure={name} data-figure-form="figure">
        <div className="cfa-face-body">{character ? <Avatar character={character} mood={mood} framing="bust" still={!live} /> : <span className="cfa-face-none">✦</span>}</div>
      </div>
      <div className="cfa-head-words">
        <div className="cfa-head-name">
          {name}
          <span className="chat-agent-mark" data-tip={`${name} is an agent${via ? ` (${via})` : ""}`}>
            Agent
          </span>
          {provider && <ProviderMark provider={provider as Provider} where={where === "this computer" ? "local" : "cloud"} size={18} />}
        </div>
        <div className="cfa-head-line" aria-live="polite">
          {line}
        </div>
      </div>
      <span className="chat-head-gap" />
      {children}
    </header>
  );
}

const moodOf = (t: TurnView | undefined): Mood => (!t || !RUNNING.has(t.status) ? "idle" : t.status === "writing" ? "talking" : t.status === "waiting" ? "talking" : "thinking");

// ---------------------------------------------------------------- a conversation: a real channel

function Conversation({ user, channelId, agent }: { user: UserInfo; channelId: string; agent?: AgentInfo }) {
  const s = useChat();
  const channel = s.channels[channelId];
  const meId = s.me?.id ?? user.id;
  const me = useMemo(() => ({ id: meId, name: user.name, handle: chatHandle(user.name), color: user.color }), [meId, user.name, user.color]);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    setOpen(channelId, null);
    loadChannel(channelId).catch((e: Error) => setErr(e.message));
    return () => setOpen(null, null);
  }, [channelId]);

  // its turns: polled while it's open (the socket carries the words; this says whether one is running)
  const [turns, setTurns] = useState<TurnView[]>([]);
  useEffect(() => {
    let live = true;
    const look = () =>
      api<{ turns: TurnView[] }>(`/api/chat/agents/turns?channel=${enc(channelId)}`)
        .then((r) => live && setTurns(r.turns))
        .catch(() => undefined);
    look();
    const t = window.setInterval(look, 700);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [channelId]);
  const running = turns.find((t) => RUNNING.has(t.status));

  const tl = s.timelines[channelId];
  useEffect(() => {
    if (channel?.me && tl && !tl.loading && (channel.me.readSeq < channel.lastSeq || channel.me.mentions > 0) && document.hasFocus()) void markRead(channelId);
  }, [channel, tl, channelId]);

  const items = useMemo(() => (tl ? layoutTimeline(tl.messages, { meId, pending: s.pending.filter((p) => p.channel === channelId && !p.root) }) : []), [tl, meId, s.pending, channelId]);
  const fail = (x: Error) => toast(x.message, "bad");
  const actions: MessageActions = useMemo(
    () => ({
      react: (m, e, on) => void react(m, e, on).catch(fail),
      reply: (m) => goChat("chat", restOf({ channel: m.channel, thread: m.id })),
      pin: () => toast("Pin it from the Chat tab"),
      copyLink: (m) => void navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}#/chat/agents/c/${m.channel}`).then(() => toast("Link copied")),
      markUnread: (m) => void markRead(m.channel, Math.max(0, m.seq - 1)),
      edit: (m) => setEditing(m.id),
      saveEdit: (m, text) => {
        setEditing(null);
        void editMessage(m, text).catch(fail);
      },
      cancelEdit: () => setEditing(null),
      remove: (m) => void removeMessage(m).catch(fail),
    }),
    [],
  );

  if (!channel) {
    return (
      <div className="chat-tab-empty">
        <h2>{s.loaded ? "This conversation isn't here" : "Connecting…"}</h2>
        {s.loaded && <p>It was archived, or it's someone else's. Start one from the list on the left.</p>}
      </div>
    );
  }
  const name = channel.agent?.name ?? chatTitle(channel, meId);
  const typing = s.typing.filter((t) => t.channel === channelId && t.root === null).map((t) => t.party.name);
  const line = running
    ? running.status === "writing"
      ? `${name} is typing…`
      : running.doing
        ? `${running.doing}…`
        : `${name} is thinking…`
    : agent
      ? agent.state === "ready"
        ? agent.service
        : `Can't answer now: ${agent.why ?? agent.state}`
      : "An agent";
  return (
    <div className="chat-main cfa-conversation" data-agent-conversation={channelId}>
      <AgentHead name={name} via={channel.agent?.via} provider={agent?.provider} where={agent?.where} line={line} mood={moodOf(running)}>
        {running && (
          <button
            className="cfa-stop"
            onClick={() =>
              void api(`/api/chat/agents/turns/${enc(running.id)}/stop`, { method: "POST" })
                .then(() => toast(`Stopped ${name}`))
                .catch(fail)
            }
            data-agent-stop
          >
            Stop
          </button>
        )}
      </AgentHead>
      {err && !tl?.messages.length ? (
        <div className="chat-tab-empty">
          <h2>The messages didn't come</h2>
          <p>{err}</p>
        </div>
      ) : (
        <Timeline
          items={items}
          me={me}
          actions={actions}
          editingId={editing}
          hasOlder={!!tl?.before}
          loading={!!tl?.loading}
          onRetry={retry}
          onDiscard={discard}
          intro={
            <div className="cfa-intro">
              <p>
                This is your conversation with <b>{name}</b>. It answers as itself, marked as an agent working for you, and remembers what was said here.
              </p>
            </div>
          }
        />
      )}
      <div className="chat-main-foot">
        <Composer
          channel={channelId}
          placeholder={`Message ${name}`}
          people={s.people}
          agents={s.agents}
          channels={Object.values(s.channels)}
          meId={meId}
          disabled={channel.archivedAt ? "This conversation is archived" : undefined}
          autoFocus
          onSend={(text, files) => send(channelId, text, files, null)}
          onTyping={() => sayTyping(channelId, null)}
        />
        <div className="chat-typing" aria-live="polite">
          {typing.length ? `${typing.join(" and ")} ${typing.length === 1 ? "is" : "are"} typing…` : ""}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- read-only transcripts

function SessionView({ id, user }: { id: string; user: UserInfo }) {
  const [data, setData] = useState<{ session: SessionRow; messages: ChatMessage[] } | null>(null);
  const [why, setWhy] = useState("");
  useEffect(() => {
    api<{ session: SessionRow; messages: ChatMessage[] }>(`/api/chat/agents/sessions/${enc(id)}`).then(setData, (e: Error) => setWhy(e.message));
  }, [id]);
  const items = useMemo(() => layoutTimeline(data?.messages ?? [], { meId: user.id }), [data, user.id]);
  if (why) return <Missing why={why} />;
  return (
    <div className="chat-main cfa-conversation is-readonly" data-agent-session={id}>
      <AgentHead name="Claude" via="claude" provider="claude" line={data ? `${data.session.title} · on “${data.session.board}”` : "Loading…"} mood={data?.session.status === "running" ? "thinking" : "idle"} />
      <Timeline items={items} me={{ id: user.id, name: user.name, handle: chatHandle(user.name) }} />
      <div className="cfa-foot-note">A Foundation session: read here. Continue it from its session tab on “{data?.session.board ?? "its grid"}”.</div>
    </div>
  );
}

function ThreadView({ id, user, onSent }: { id: string; user: UserInfo; onSent(): void }) {
  const s = useChat();
  const [data, setData] = useState<{ thread: ThreadRow; messages: ChatMessage[]; readable: boolean; note?: string } | null>(null);
  const [why, setWhy] = useState("");
  const live = useRef(true);
  const load = useCallback(() => {
    api<{ thread: ThreadRow; messages: ChatMessage[]; readable: boolean; note?: string }>(`/api/chat/agents/threads/${enc(id)}`).then(
      (d) => live.current && setData(d),
      (e: Error) => live.current && setWhy(e.message),
    );
  }, [id]);
  useEffect(() => {
    live.current = true;
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      live.current = false;
      window.clearInterval(t);
    };
  }, [load]);
  const items = useMemo(() => layoutTimeline(data?.messages ?? [], { meId: user.id }), [data, user.id]);
  if (why) return <Missing why={why} />;
  const t = data?.thread;
  const openInT3 = () =>
    void api<{ url: string }>("/api/t3host/open", { method: "POST", json: { thread: id } })
      .then((r) => window.open(r.url, "_blank", "noopener"))
      .catch(() => (t?.url ? window.open(t.url, "_blank", "noopener") : toast("T3 isn't running on this computer", "bad")));
  const status = t ? ({ working: "Working", waiting: "Waiting for a person in T3", problem: "A problem: open it in T3", idle: "At rest" } as const)[t.status] : "Loading…";
  return (
    <div className="chat-main cfa-conversation is-readonly" data-agent-thread={id}>
      <AgentHead name={t?.agent ?? "T3"} via={t?.via} line={t ? `${t.title} · ${status}` : status} mood={t?.status === "working" ? "thinking" : t?.status === "waiting" ? "talking" : "idle"}>
        <button className="cfa-ghost" onClick={openInT3}>
          Open in T3
        </button>
      </AgentHead>
      {data && !data.readable ? (
        <div className="chat-tab-empty">
          <p>{data.note}</p>
        </div>
      ) : (
        <Timeline items={items} me={{ id: user.id, name: user.name, handle: chatHandle(user.name) }} />
      )}
      <div className="chat-main-foot">
        {t?.canContinue ? (
          <Composer
            channel={`t3:${id}`}
            placeholder={`Send ${t.agent} its next turn`}
            people={s.people}
            agents={s.agents}
            channels={[]}
            meId={user.id}
            onSend={(text, files) => {
              if (files.length) toast("Files go to T3 from T3 itself; only the words were sent");
              void api(`/api/chat/agents/threads/${enc(id)}/say`, { method: "POST", json: { text } })
                .then(() => {
                  toast(`Sent to ${t.agent}`, "agent");
                  load();
                  onSent();
                })
                .catch((e: Error) => toast(e.message, "bad"));
            }}
          />
        ) : (
          <div className="cfa-foot-note" data-t3-continue>
            {t?.why ?? "Open in T3 to continue"}.{" "}
            <button className="cfa-link" onClick={openInT3}>
              Open in T3 to continue
            </button>
          </div>
        )}
        <div className="chat-typing" />
      </div>
    </div>
  );
}

function Missing({ why }: { why: string }) {
  return (
    <div className="chat-tab-empty">
      <h2>It isn't here</h2>
      <p>{why}</p>
    </div>
  );
}
