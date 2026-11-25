/**
 * The Chat tab's other views, in the timeline's place: browsing open channels to join, the threads this
 * window knows I'm in, and search results (`/api/chat/search`, with `from:` `in:` `before:` `after:`
 * `has:`); a result opens its message in place, flashed.
 */

import { ErrorCard } from "../components/ErrorCard";
import { chatTitle, parseChatQuery, type ChatChannelKind, type ChatChannelView, type ChatMessage } from "@foundation/protocol";
import { PartyAvatar } from "./Avatar";
import { channelMark } from "./Sidebar";
import { ago, timeOf } from "./Message";
import type { ChatHit } from "./model";

export function BrowseView({ channels, meId, onOpen, onJoin }: { channels: ChatChannelView[]; meId?: string; onOpen(id: string): void; onJoin(id: string): void }) {
  const open = channels.filter((c) => c.kind === "open" && !c.archivedAt).sort((a, b) => b.lastPostAt - a.lastPostAt);
  return (
    <div className="chat-view" data-chat-view="browse">
      <header className="chat-view-head">
        <h2>Open channels</h2>
        <p>Anyone here can read and join these. Private ones show only to the people in them.</p>
      </header>
      <div className="chat-view-list">
        {open.map((c) => (
          <div key={c.id} className="chat-browse-row" data-browse-row={c.name}>
            <button type="button" className="chat-browse-main" onClick={() => onOpen(c.id)}>
              <span className="chat-side-mark">{channelMark(c, meId)}</span>
              <span className="chat-browse-text">
                <span className="chat-browse-name" title={chatTitle(c, meId)}>{chatTitle(c, meId)}</span>
                <span className="chat-browse-meta" title={c.purpose || undefined}>
                  {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                  {c.purpose ? ` · ${c.purpose}` : ""}
                  {c.lastPostAt ? ` · last message ${ago(c.lastPostAt)}` : ""}
                </span>
              </span>
            </button>
            {c.me ? (
              <span className="chat-browse-joined">Joined</span>
            ) : (
              <button type="button" className="f-pill" onClick={() => onJoin(c.id)}>
                Join
              </button>
            )}
          </div>
        ))}
        {!open.length && <p className="chat-view-empty">No open channels yet. Make the first with ＋ beside Channels.</p>}
      </div>
    </div>
  );
}

export interface ThreadRow {
  root: ChatMessage;
  channel: { id: string; name: string; kind: ChatChannelKind };
}

export function ThreadsView({ threads, busy, why, onOpen }: { threads: ThreadRow[] | null; busy?: boolean; why?: string; onOpen(m: ChatMessage): void }) {
  return (
    <div className="chat-view" data-chat-view="threads">
      <header className="chat-view-head">
        <h2>Threads</h2>
        <p>The threads you started or replied in, newest reply first.</p>
      </header>
      <div className="chat-view-list">
        {threads?.map(({ root: m, channel }) => (
          <button key={m.id} type="button" className="chat-hit" onClick={() => onOpen(m)} data-thread-row={m.id}>
            <PartyAvatar party={m.author} size={28} />
            <span className="chat-hit-main">
              <span className="chat-hit-where">
                {channel.kind === "open" || channel.kind === "private" ? `#${channel.name}` : channel.name} · {m.author.name}
              </span>
              <span className="chat-hit-text">{m.text || m.files.map((f) => f.name).join(", ")}</span>
              <span className="chat-hit-meta">
                {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
                {m.lastReplyAt ? ` · last ${ago(m.lastReplyAt)}` : ""}
                {m.repliers?.length ? ` · ${m.repliers.join(", ")}` : ""}
              </span>
            </span>
          </button>
        ))}
        {busy && !threads && <p className="chat-view-empty" role="status">Looking…</p>}
        {why && <ErrorCard message={why} />}
        {threads && !threads.length && <p className="chat-view-empty">No threads yet. Reply in thread from a message's hover bar, and it's kept here.</p>}
      </div>
    </div>
  );
}

const highlight = (text: string, words: string[]) => {
  if (!words.length) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
};

export function SearchView({ q, hits, busy, why, onOpen }: { q: string; hits: ChatHit[] | null; busy: boolean; why?: string; onOpen(h: ChatHit): void }) {
  const parsed = parseChatQuery(q);
  const words = parsed.words.replace(/"/g, "").split(/\s+/).filter((w) => w.length > 1);
  const filters = [parsed.from && `from ${parsed.from}`, parsed.in && `in #${parsed.in}`, parsed.has && `with a ${parsed.has}`, parsed.after && `after ${new Date(parsed.after).toLocaleDateString()}`, parsed.before && `before ${new Date(parsed.before).toLocaleDateString()}`].filter(Boolean);
  return (
    <div className="chat-view" data-chat-view="search">
      <header className="chat-view-head">
        <h2>{parsed.words ? `“${parsed.words}”` : "Search"}</h2>
        <p>{filters.length ? filters.join(" · ") : "Narrow it with from:ada in:general has:file before:2026-11-01 after:… in the field."}</p>
      </header>
      <div className="chat-view-list">
        {hits?.map((h) => (
          <button key={h.message.id} type="button" className="chat-hit" onClick={() => onOpen(h)} data-search-hit={h.message.id}>
            <PartyAvatar party={h.message.author} size={28} />
            <span className="chat-hit-main">
              <span className="chat-hit-where">
                {h.channel.kind === "open" || h.channel.kind === "private" ? `#${h.channel.name}` : h.channel.name || "Direct message"} · {h.message.author.name} · {timeOf(h.message.createdAt)}, {new Date(h.message.createdAt).toLocaleDateString([], { day: "numeric", month: "short" })}
              </span>
              <span className="chat-hit-text">{highlight(stripMarks(h.snippet || h.message.text), words)}</span>
              {h.message.files.length > 0 && <span className="chat-hit-meta">{h.message.files.map((f) => f.name).join(" · ")}</span>}
            </span>
          </button>
        ))}
        {busy && !hits && <p className="chat-view-empty" role="status">Looking…</p>}
        {why && <ErrorCard message={why} />}
        {hits && !hits.length && !busy && <p className="chat-view-empty">Nothing said matches that. Fewer words, or a different filter, may find it.</p>}
      </div>
    </div>
  );
}

/** a snippet may carry the server's own marks («…», <mark>, [[…]]): drawn as plain text, matches marked here */
const stripMarks = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\[\[|\]\]|[«»]/g, "");

/** the channel's start: its name, what it's for, who made it */
export function ChannelIntro({ c, meId }: { c: ChatChannelView; meId?: string }) {
  const direct = c.kind === "dm" || c.kind === "group" || c.kind === "agent";
  return (
    <div className="chat-intro">
      <span className="chat-intro-mark">{channelMark(c, meId, undefined, 40)}</span>
      <h3>{direct || c.kind === "portal" ? chatTitle(c, meId) : `#${c.name}`}</h3>
      <p>
        {direct ? (c.kind === "agent" ? `A conversation with ${chatTitle(c, meId)}, an agent. What it says is marked as an agent's.` : `The start of your conversation with ${chatTitle(c, meId)}. Only the people in it can read it.`) : c.purpose || (c.kind === "portal" ? `The start of this conversation with ${c.name}${c.origin ? `, on ${c.origin.service}` : ""}.` : `The very start of #${c.name}.`)}
      </p>
    </div>
  );
}

