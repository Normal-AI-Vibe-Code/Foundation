/**
 * A ChatForm conversation as a card on a grid (`panel: "chat"`; Josh, 2026-11-25: "chat objects also to be
 * created in sections … have people who are visible in the grid with you … able to chat through voice and text
 * inside the Foundation grid"). The board keeps a reference only (chat/gridChat.ts); everything drawn here is
 * asked of the chat server by the person looking, so its access is the chat server's:
 *
 *  - **open**: the head (the conversation's mark and name, who of it is on this grid or online, a huddle, what's
 *    unread, Open in ChatForm), then ChatForm's own timeline and composer (chat/Timeline.tsx, chat/Composer.tsx),
 *    fed from the same store as ChatForm (chat/model.ts), so a message sent in either shows in both. A thread
 *    opens over the timeline, inside the card (chat/Thread.tsx).
 *  - **locked**: the chat server doesn't give this person the conversation. A lock and one line; no name beyond
 *    what the board already shows, no people, no counts.
 *  - **elsewhere**: the card was made against another chat server than this device's ChatForm is on. It says
 *    which, and never looks the id up on the wrong server.
 *  - **unpicked**: put down from a section's menu: pick one of your conversations, or make a channel.
 *
 * Using it follows every card's rule (lib/cardUse.ts): at rest the wheel is the grid's (Alt-wheel reads back
 * through the timeline) and the card is moved by its bar; putting the caret in its field, or ⌘/Ctrl-click, puts
 * it in use (the wheel scrolls it, and reading it marks it read) until Esc or a press elsewhere.
 *
 * Posting is a chat write, checked by the chat server, so a viewer of the grid who is in the conversation can
 * write here. Picking the conversation writes the card, which is the board's (not for a viewer).
 *
 * Voice is the channel's own huddle (chat/HuddleCard.tsx: started and joined by people; agents are seated by a
 * person in the call's controls). Huddles run on Foundation's own server: when ChatForm is on a chat server of
 * its own the head has no huddle button, and a quiet line says why.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { chatHandle, chatTitle, type ChatChannelView } from "@foundation/protocol";
import { updatePanel, type PanelMeta } from "../state/store";
import { toast, useUi } from "../state/ui";
import { putInUse } from "../lib/cardUse";
import { goChat } from "../lib/place";
import { useWhereabouts } from "../lib/whereabouts";
import { activeBoard } from "../sync/board";
import { useOnScreen } from "./PanelView";
import {
  createChannel,
  discard,
  editMessage,
  loadChannel,
  loadNewer,
  loadOlder,
  loadThread,
  markRead,
  markUnreadFrom,
  pin,
  react,
  refreshChannel,
  refreshList,
  removeMessage,
  retry,
  sayTyping,
  send,
  startChat,
  useChat,
  type ChatState,
} from "../chat/model";
import { CHAT_SERVER, CHAT_SERVER_NAME } from "../chat/server";
import { chatCan } from "../chat/serverLogic";
import { fuzzyScore, layoutTimeline, restOf } from "../chat/logic";
import { CHAT_CARD_NAME, cantSend, cardPeople, chatCardRef, chatCardState, elsewhereWords, lockedWords, peopleWords, type CardPeople } from "../chat/gridChat";
import { Timeline } from "../chat/Timeline";
import { Composer } from "../chat/Composer";
import { ThreadPane } from "../chat/Thread";
import { ChannelIntro } from "../chat/Views";
import { NewChannelDialog } from "../chat/Dialogs";
import { channelMark } from "../chat/Sidebar";
import { PartyAvatar } from "../chat/Avatar";
import { AgentFigure } from "../chat/AgentFigure";
import { ChannelHuddleButton, ChannelHuddleDock } from "../chat/HuddleCard";
import { ChatMark, IconLock, IconPlus } from "../chat/Icons";
import type { MessageActions } from "../chat/Message";
import "../chat/chat.css";
import "./chat-card.css";

const FACES = 5;

// ---------------------------------------------------------------- the card on a grid

export function ChatCardBody({ panel }: { panel: PanelMeta }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useOnScreen(host, 0.25);
  const s = useChat();
  const ui = useUi();
  useEffect(() => startChat(), []);

  const here = (panel.chatServer ?? "") === CHAT_SERVER;
  const channel = here && panel.channel ? s.channels[panel.channel] : undefined;
  // the list didn't have it: ask for it by id once the list is here (a channel made since; or one this person can't see)
  const [asked, setAsked] = useState<"no" | "asking" | "refused">("no");
  const reachable = s.status === "live" || s.status === "connecting";
  useEffect(() => {
    if (!live || !here || !panel.channel || channel || !s.loaded || !reachable) return;
    let on = true;
    setAsked("asking");
    void refreshChannel(panel.channel).then((c) => on && setAsked(c ? "no" : "refused"));
    return () => {
      on = false;
    };
  }, [live, here, panel.channel, !!channel, s.loaded, reachable]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = chatCardState({ channel: panel.channel, cardServer: panel.chatServer, hereServer: CHAT_SERVER, status: s.status, loaded: s.loaded, has: !!channel, asked });
  const viewer = ui.role === "viewer";
  let body: ReactNode;
  if (state === "open" && channel) body = <LiveCard panel={panel} channel={channel} s={s} live={live} inUse={ui.engaged === panel.id} />;
  else if (state === "unpicked") body = <Picker panel={panel} s={s} viewer={viewer} />;
  else if (state === "elsewhere") body = <ChatCardNotice kind="elsewhere" {...elsewhereWords(panel.chatServer, CHAT_SERVER)} />;
  else if (state === "locked") body = <ChatCardNotice kind="locked" {...lockedWords(viewer)} />;
  else if (state === "signin")
    body = (
      <ChatCardNotice kind="signin" title={`Sign in to ${CHAT_SERVER_NAME || "ChatForm"}`} line="This conversation is on ChatForm's own server, which has its own sign-in on each device.">
        <button type="button" className="f-pill is-accent" onClick={() => goChat()} data-chat-card-signin>
          Open ChatForm to sign in
        </button>
      </ChatCardNotice>
    );
  else if (state === "unavailable") body = <ChatCardNotice kind="waiting" title="ChatForm isn't on this server yet" line={s.why || "When it is, the conversation appears here."} />;
  else body = <ChatCardNotice kind="waiting" title={s.status === "offline" ? "Offline" : "Opening the conversation…"} line={s.status === "offline" ? s.why : ""} />;

  return (
    <div ref={host} className={`chat-card is-${state}${ui.engaged === panel.id ? " is-in-use" : ""}`} data-chat-card={panel.channel ?? ""} data-chat-card-state={state}>
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- a card that isn't the conversation

/** locked, on another server, waiting, signing in: a mark, a title, one line (and what a person can do about it) */
export function ChatCardNotice({ kind, title, line, children }: { kind: "locked" | "elsewhere" | "signin" | "waiting"; title: string; line?: string; children?: ReactNode }) {
  return (
    <div className={`chat-card-notice is-${kind}`} role={kind === "waiting" ? "status" : undefined} data-chat-card-notice={kind}>
      <span className="chat-card-notice-mark" aria-hidden>
        {kind === "locked" ? <IconLock size={16} /> : kind === "elsewhere" ? <ElsewhereGlyph /> : <ChatMark size={18} />}
      </span>
      <b>{title}</b>
      {line && <span className="chat-card-dim">{line}</span>}
      {children}
    </div>
  );
}

function ElsewhereGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2.5" width="12" height="4" rx="1.2" />
      <rect x="2" y="9.5" width="12" height="4" rx="1.2" />
      <path d="M4.5 4.5h.01M4.5 11.5h.01" />
    </svg>
  );
}

// ---------------------------------------------------------------- the head

export interface ChatCardHeadProps {
  channel: ChatChannelView;
  meId?: string;
  online: string[];
  who: CardPeople;
  /** unread, shown while the card isn't the one in use */
  unread?: number;
  mentions?: number;
  /** the huddle button, or nothing where there's no voice */
  huddle?: ReactNode;
  onOpen?(): void;
  /** agents' stills, for the design page (no roster there) */
  agentStill?: { src: string; role?: string; cut?: boolean };
}

export function ChatCardHead({ channel, meId, online, who, unread = 0, mentions = 0, huddle, onOpen, agentStill }: ChatCardHeadProps) {
  const title = chatTitle(channel, meId);
  const named = channel.kind === "open" || channel.kind === "private";
  const words = peopleWords(who);
  const shown = who.faces.slice(0, FACES);
  const agents = who.agents.slice(0, Math.max(1, FACES - shown.length));
  const more = who.faces.length - shown.length + (who.agents.length - agents.length);
  return (
    <header className="chat-card-head">
      <span className={`chat-card-mark${channel.kind === "agent" ? " is-agent" : ""}`}>{channelMark(channel, meId, online, 20)}</span>
      <span className="chat-card-title" title={channel.topic ? `${named ? "#" : ""}${title} · ${channel.topic}` : title}>
        {title}
      </span>
      {(shown.length > 0 || agents.length > 0) && (
        <span className="chat-card-faces" role="img" aria-label={words} data-tip={words} data-chat-card-faces={who.faces.filter((f) => f.here).length}>
          {shown.map((f) => (
            <span key={f.party.id} className={`chat-card-face${f.here ? " is-here" : ""}`} data-face={f.party.name} data-here={f.here ? "1" : "0"}>
              <PartyAvatar party={f.party} size={22} online={f.online} />
            </span>
          ))}
          {agents.map((a) => (
            <span key={`a:${a.name}`} className={`chat-card-face is-agent${a.here ? " is-here" : ""}`} data-face={a.name} data-here={a.here ? "1" : "0"}>
              <AgentFigure name={a.name} size={22} still={agentStill} />
            </span>
          ))}
          {more > 0 && <span className="chat-card-more">+{more}</span>}
        </span>
      )}
      <span className="chat-card-gap" />
      {unread > 0 && (
        <span className={`chat-count${mentions > 0 || channel.kind === "dm" || channel.kind === "group" ? " is-accent" : ""}`} data-tip={mentions > 0 ? `${mentions} ${mentions === 1 ? "mention" : "mentions"} of you · ${unread} unread` : `${unread} unread`} data-chat-card-unread={unread}>
          {unread > 99 ? "99+" : unread}
        </span>
      )}
      {huddle}
      {onOpen && (
        <button type="button" className="chat-head-btn" onClick={onOpen} data-tip="Open in ChatForm" aria-label="Open in ChatForm" data-chat-card-open>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6.5 3.5H3.5v9h9v-3M9.5 3.5h3v3M12.5 3.5 7.5 8.5" />
          </svg>
        </button>
      )}
    </header>
  );
}

/** the card's inside, laid out: head, a call if one is docked, the timeline (a thread over it), the foot */
export function ChatCardFrame({ head, dock, note, timeline, thread, foot, quiet }: { head: ReactNode; dock?: ReactNode; note?: ReactNode; timeline: ReactNode; thread?: ReactNode; foot: ReactNode; quiet?: ReactNode }) {
  return (
    <>
      {head}
      {dock}
      {note}
      <div className="chat-card-main">
        {timeline}
        <AnimatePresence>{thread}</AnimatePresence>
      </div>
      <div className="chat-card-foot">
        {foot}
        {quiet}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- the conversation, live

function LiveCard({ panel, channel, s, live, inUse }: { panel: PanelMeta; channel: ChatChannelView; s: ChatState; live: boolean; inUse: boolean }) {
  const id = channel.id;
  const boardId = activeBoard()?.boardId ?? "";
  const account = s.remote ? s.account : (activeBoard()?.user ?? null);
  const meId = s.me?.id ?? account?.id ?? "";
  const meName = s.me?.name || account?.name || "";
  const me = useMemo(() => ({ id: meId, name: meName, handle: chatHandle(meName), color: account?.color }), [meId, meName, account?.color]);
  const can = (what: Parameters<typeof chatCan>[2]) => chatCan(s.remote, s.features, what);
  const channels = useMemo(() => Object.values(s.channels), [s.channels]);
  const where = useWhereabouts()[boardId];
  const who = useMemo(() => cardPeople({ channel, people: s.people, online: s.online, where, meId }), [channel, s.people, s.online, where, meId]);

  // the page: the newest, once the card has been on screen; again whenever the store let it go (a reconnect drops
  // the pages of conversations that aren't ChatForm's open one)
  const tl = s.timelines[id];
  const [loadErr, setLoadErr] = useState("");
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (live) setSeen(true);
  }, [live]);
  useEffect(() => {
    if (!seen || tl) return;
    setLoadErr("");
    loadChannel(id).catch((e: Error) => setLoadErr(e.message));
  }, [seen, id, !tl]); // eslint-disable-line react-hooks/exhaustive-deps
  // a conversation whose people didn't come with the list: asked for once, so the head can say who of them is here
  // (an open channel sends only a count: there the head draws from everyone the chat server lists)
  useEffect(() => {
    if (seen && !channel.members && channel.kind !== "open") void refreshChannel(id);
  }, [seen, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // the New rule: where I'd read to when the card first drew it
  const [ruleSeq, setRuleSeq] = useState<number | null>(() => (channel.me && channel.unread > 0 ? channel.me.readSeq : null));
  const held = useRef(false);

  // reading: the card is in use, the window has focus, and the newest message is in view
  const [atFoot, setAtFoot] = useState(true);
  const [focused, setFocused] = useState(() => document.hasFocus() && !document.hidden);
  useEffect(() => {
    const on = () => setFocused(document.hasFocus() && !document.hidden);
    window.addEventListener("focus", on);
    window.addEventListener("blur", on);
    document.addEventListener("visibilitychange", on);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", on);
      document.removeEventListener("visibilitychange", on);
    };
  }, []);
  useEffect(() => {
    if (!inUse) held.current = false;
  }, [inUse]);
  useEffect(() => {
    if (!inUse || !channel.me || !atFoot || !focused || held.current || !tl || tl.after || tl.loading) return;
    if (channel.me.readSeq < channel.lastSeq || channel.me.mentions > 0) void markRead(id);
  }, [inUse, channel, atFoot, focused, tl, id]);

  // a thread opens over the timeline, in the card
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    if (threadId) void loadThread(id, threadId);
  }, [id, threadId]);
  const [editing, setEditing] = useState<string | null>(null);
  const fail = (x: Error) => toast(x.message, "bad");

  const actions: MessageActions = useMemo(
    () => ({
      react: (m, e, on) => void react(m, e, on).catch(fail),
      reply: (m) => (putInUse(panel.id), setThreadId(m.id)),
      pin: chatCan(s.remote, s.features, "pins") ? (m, on) => void pin(m, on).catch(fail) : undefined,
      copyLink: (m) => {
        const url = `${window.location.origin}${window.location.pathname}#/chat/chat/${restOf({ channel: m.channel, at: m.seq })}`;
        void navigator.clipboard?.writeText(url).then(
          () => toast("Link copied"),
          () => toast(url),
        );
      },
      markUnread: (m) => {
        held.current = true;
        setRuleSeq(m.seq - 1);
        void markUnreadFrom(m);
      },
      edit: (m) => setEditing(m.id),
      saveEdit: (m, text) => {
        setEditing(null);
        void editMessage(m, text).catch((x: Error) => toast(`Not saved: ${x.message}`, "bad"));
      },
      cancelEdit: () => setEditing(null),
      remove: (m) => void removeMessage(m).catch(fail),
      openPlace: (m) => m.place && window.dispatchEvent(new CustomEvent("foundation:board", { detail: m.place.board })),
    }),
    [panel.id, s.remote, s.features], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const items = useMemo(() => (tl ? layoutTimeline(tl.messages, { readSeq: ruleSeq, meId, pending: s.pending.filter((p) => p.channel === id && !p.root) }) : []), [tl, ruleSeq, meId, s.pending, id]);
  const thread = threadId ? s.threads[threadId] : undefined;
  const threadRoot = thread?.root ?? (threadId ? (tl?.messages.find((m) => m.id === threadId) ?? null) : null);
  const threadItems = useMemo(() => (threadId ? layoutTimeline(thread?.replies ?? [], { meId, pending: s.pending.filter((p) => p.root === threadId) }).filter((i) => i.kind !== "new") : []), [threadId, thread?.replies, meId, s.pending]);

  const editLast = (root: string | null) => () => {
    const list = root ? (s.threads[root]?.replies ?? []) : (tl?.messages ?? []);
    const mine = [...list].reverse().find((m) => m.author.id === meId && m.author.kind === "person" && m.type === "text" && !m.deletedAt);
    if (!mine) return false;
    setEditing(mine.id);
    return true;
  };
  const typingWords = (root: string | null) => {
    const names = s.typing.filter((t) => t.channel === id && t.root === root).map((t) => t.party.name);
    if (!names.length) return null;
    return names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : "Several people are typing…";
  };

  const title = chatTitle(channel, meId);
  const named = channel.kind === "open" || channel.kind === "private";
  const disabled = cantSend(channel, account?.role ?? "member");
  const noFiles = can("files") ? undefined : `${CHAT_SERVER_NAME || "This chat server"} doesn't take files yet.`;
  const placeholder = named ? `Message #${title}${channel.me ? "" : " (sending joins it)"}` : `Message ${title}`;
  const voice = can("huddles");
  const use = () => putInUse(panel.id);

  return (
    <ChatCardFrame
      head={
        <ChatCardHead
          channel={channel}
          meId={meId}
          online={s.online}
          who={who}
          unread={inUse ? 0 : channel.unread}
          mentions={channel.me?.mentions ?? 0}
          huddle={voice ? <ChannelHuddleButton channel={channel} /> : undefined}
          onOpen={() => goChat("chat", restOf({ channel: id }))}
        />
      }
      dock={voice ? <ChannelHuddleDock channel={channel} /> : undefined}
      note={
        s.status === "offline" ? (
          <div className="chat-offline" role="status">
            Offline · {s.why}
          </div>
        ) : undefined
      }
      timeline={
        loadErr && !tl?.messages.length ? (
          <ChatCardNotice kind="waiting" title="The messages didn't come" line={loadErr}>
            <button type="button" className="f-pill" onClick={() => (setLoadErr(""), loadChannel(id, true).catch((e: Error) => setLoadErr(e.message)))}>
              Try again
            </button>
          </ChatCardNotice>
        ) : (
          <Timeline
            items={items}
            me={me}
            actions={actions}
            editingId={editing}
            liveHuddle={channel.huddle}
            hasOlder={!!tl?.before}
            hasNewer={!!tl?.after}
            loading={!!tl?.loading || !tl}
            onOlder={() => void loadOlder(id)}
            onNewer={() => void loadNewer(id)}
            onFoot={setAtFoot}
            onJumpNewest={() => void loadChannel(id, true)}
            onRetry={retry}
            onDiscard={discard}
            intro={<ChannelIntro c={channel} meId={meId} />}
            newBelow={!atFoot && channel.unread > 0 ? channel.unread : 0}
          />
        )
      }
      thread={
        threadId ? (
          <ThreadPane
            key={threadId}
            where={named ? `#${title}` : title}
            root={threadRoot}
            items={threadItems}
            me={me}
            actions={actions}
            editingId={editing}
            loading={thread?.loading}
            onClose={() => setThreadId(null)}
            onRetry={retry}
            onDiscard={discard}
            typing={typingWords(threadId)}
            composer={
              <Composer
                channel={id}
                root={threadId}
                placeholder="Reply…"
                people={s.people}
                agents={s.agents}
                channels={channels}
                meId={meId}
                disabled={disabled}
                noFiles={noFiles}
                noAttachFrom={s.remote}
                audience={channel}
                compact
                autoFocus
                onSend={(text, files) => send(id, text, files, threadId)}
                onTyping={() => sayTyping(id, threadId)}
                onEditLast={editLast(threadId)}
              />
            }
          />
        ) : undefined
      }
      foot={
        // the caret in the field puts the card in use (lib/cardUse.ts): then the wheel is the timeline's
        <div onFocusCapture={use}>
          <Composer
            channel={id}
            placeholder={placeholder}
            people={s.people}
            agents={s.agents}
            channels={channels}
            meId={meId}
            disabled={disabled}
            noFiles={noFiles}
            noAttachFrom={s.remote}
            audience={channel}
            compact
            autoFocus={false}
            onSend={(text, files) => send(id, text, files, null)}
            onTyping={() => sayTyping(id, null)}
            onEditLast={editLast(null)}
          />
        </div>
      }
      quiet={
        <div className="chat-card-quiet" aria-live="polite">
          {typingWords(null) ?? (!voice && s.remote ? <span data-chat-card-novoice>Voice needs Foundation's own server: this conversation is on {CHAT_SERVER_NAME}.</span> : null)}
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- picking a conversation

function Picker({ panel, s, viewer }: { panel: PanelMeta; s: ChatState; viewer: boolean }) {
  const [q, setQ] = useState("");
  const [making, setMaking] = useState(false);
  useEffect(() => {
    if (making) refreshList();
  }, [making]);
  const meId = s.me?.id;
  const rows = useMemo(() => {
    const all = Object.values(s.channels).filter((c) => !c.archivedAt && (c.me || c.kind === "open"));
    const t = q.trim().replace(/^#/, "");
    const scored = all.map((c) => ({ c, title: chatTitle(c, meId), score: 0 })).map((r) => ({ ...r, score: t ? fuzzyScore(t, r.title) : 1 }));
    return scored.filter((r) => r.score > 0).sort((a, b) => (t ? b.score - a.score : Number(!!b.c.me) - Number(!!a.c.me) || b.c.lastPostAt - a.c.lastPostAt));
  }, [s.channels, q, meId]);
  const pick = (c: ChatChannelView) => updatePanel(panel.id, chatCardRef(c, CHAT_SERVER));

  if (viewer) return <ChatCardNotice kind="waiting" title="No conversation here yet" line="Someone who can edit this grid picks which one this card shows." />;
  if (s.status === "signin")
    return (
      <ChatCardNotice kind="signin" title={`Sign in to ${CHAT_SERVER_NAME || "ChatForm"}`} line="Then pick the conversation this card shows.">
        <button type="button" className="f-pill is-accent" onClick={() => goChat()}>
          Open ChatForm to sign in
        </button>
      </ChatCardNotice>
    );
  if (s.status === "unavailable") return <ChatCardNotice kind="waiting" title="ChatForm isn't on this server yet" line={s.why} />;
  return (
    <div className="chat-card-picker" data-chat-card-picker>
      <div className="f-eyebrow">Which conversation{s.remote ? ` · ${CHAT_SERVER_NAME}` : ""}</div>
      <input className="chat-card-filter" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Find a channel or a person" aria-label="Find a conversation" />
      <div className="chat-card-rows wheel-own">
        {!s.loaded ? (
          <p className="chat-card-dim">Listing your conversations…</p>
        ) : rows.length === 0 ? (
          <p className="chat-card-dim">{q ? "Nothing by that name." : "No conversations yet."}</p>
        ) : (
          rows.slice(0, 60).map(({ c, title }) => (
            <button key={c.id} type="button" className={`chat-card-row${c.kind === "agent" ? " is-agent" : ""}`} onClick={() => pick(c)} data-chat-card-pick={c.id}>
              <span className="chat-card-row-mark">{channelMark(c, meId, s.online, 18)}</span>
              <span className="chat-card-row-name">{title}</span>
              {!c.me && <i className="chat-card-dim">not joined</i>}
            </button>
          ))
        )}
      </div>
      <button type="button" className="f-pill chat-card-new" onClick={() => setMaking(true)} data-chat-card-new>
        <IconPlus /> New channel…
      </button>
      <p className="chat-card-dim chat-card-keeps">The grid keeps only which conversation this is. Who can read it stays ChatForm's.</p>
      <AnimatePresence>
        {making && (
          <NewChannelDialog
            people={s.people}
            online={s.online}
            meId={meId}
            onClose={() => setMaking(false)}
            onCreate={async (c) => {
              const made = await createChannel({ kind: c.kind, name: c.name, purpose: c.purpose, members: c.members });
              setMaking(false);
              pick(made);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export { CHAT_CARD_NAME };
