/**
 * ChatForm, a place inside Foundation (`#/chat/<tab>/<rest>`; lib/place.ts): the top bar and the side menu
 * stay, and the open paper holds ChatForm. Under the top bar, a strip like Settings': **ChatForm**, the
 * tabs (Chat · Agents · Inbox · Huddles) and a search field at its right. docs/chatform.md §3.
 *
 * The Chat tab is wired here: the sidebar, the channel's head, the timeline and its composer, the thread
 * pane, the views (browse, threads, search) and the dialogs. Everything it draws is a presentational
 * component (Sidebar, ChannelHead, Timeline, MessageView, Composer, ThreadPane…) fed from the store
 * (chat/model.ts), so `#/design` draws the same components from fixtures.
 *
 * Keys: Ctrl/⌘+K inside ChatForm is the quick switcher (and again, Foundation's commands; the shell leaves
 * ⌘K to ChatForm while it's the place). Typing anywhere that isn't a field goes to the composer. Esc
 * closes the thread pane. The shell's plain-key shortcuts (V, P) don't fire here.
 *
 * On a chat server of its own (chat/server.ts) the place is the Chat tab alone, signed in there on its own
 * (chat/ChatServer.tsx); what that server doesn't have (files, pins, huddles, agents, the inbox) is left out.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { chatHandle, chatTitle, type UserInfo } from "@foundation/protocol";
import { TOP_BAR, floorInsets, getUi, setUi, toast, useUi } from "../state/ui";
import { CHAT_TABS, goChat, type ChatTab, type Place } from "../lib/place";
import {
  archiveChannel,
  changeMembers,
  createChannel,
  discard,
  editMessage,
  exportChannel,
  joinChannel,
  leaveChannel,
  loadAround,
  loadChannel,
  loadNewer,
  loadOlder,
  loadThread,
  markRead,
  markUnreadFrom,
  openDirect,
  pin,
  react,
  refreshChannel,
  refreshList,
  removeMessage,
  retry,
  sayTyping,
  searchChat,
  send,
  setOpen,
  startChat,
  updateChannel,
  useChat,
  type ChatHit,
  type ChatState,
} from "./model";
import { chatApi } from "./server";
import { layoutTimeline, parseRest, restOf, type ChatRest } from "./logic";
import { Sidebar } from "./Sidebar";
import { setListFolded, usePins } from "./pins";
import { ChannelHead } from "./ChannelHead";
import { Timeline } from "./Timeline";
import { Composer, type ComposerHandle } from "./Composer";
import { ThreadPane } from "./Thread";
import { NewChannelDialog, NewDirectDialog, QuickSwitcher } from "./Dialogs";
import { BrowseView, ChannelIntro, SearchView, ThreadsView, type ThreadRow } from "./Views";
import { ChatMark, IconClose, IconSearch } from "./Icons";
import type { MessageActions } from "./Message";
import { SlackNudge } from "./tabs/SlackGuide";
import { ServerNote } from "../server/ServerAbout";
import { ChatServerNote, ChatSignIn } from "./ChatServer";
import { chatCan, type ChatFeature } from "./serverLogic";
import "./chat.css";

const AgentsTab = lazy(() => import("./tabs/Agents"));
const InboxTab = lazy(() => import("./tabs/Inbox"));
const HuddlesTab = lazy(() => import("./tabs/Huddles"));

const LABEL: Record<ChatTab, string> = { chat: "Chat", agents: "Agents", inbox: "Inbox", huddles: "Huddles" };
const LAST = "chatform-last";

const isField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

export function ChatForm({ user, place }: { user: UserInfo; place: Extract<Place, { kind: "chat" }> }) {
  const ui = useUi();
  const insets = floorInsets(ui);
  const s = useChat();
  const [switcher, setSwitcher] = useState(false);
  const route = useMemo(() => parseRest(place.rest), [place.rest]);
  const [q, setQ] = useState(route.view === "search" ? route.q : "");
  useEffect(() => {
    if (route.view === "search") setQ(route.q);
  }, [route.view, route.q]);

  useEffect(() => startChat({ id: user.id, name: user.name }), [user]);

  // Ctrl/⌘+K: the quick switcher, inside ChatForm (the shell leaves it to us while chat is the place)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        if (getUi().command) return;
        e.preventDefault();
        e.stopPropagation();
        setSwitcher((x) => !x);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const search = (text: string) => {
    const t = text.trim();
    if (t) goChat("chat", restOf({ view: "search", q: t }));
  };

  return (
    <div className="chatform" style={{ left: insets.left, right: insets.right, top: TOP_BAR }} data-chat-tab={place.tab}>
      <header className="chat-strip">
        <h1>
          <ChatMark size={18} />
          ChatForm
        </h1>
        <nav className="settings-tabs chat-tabs" aria-label="ChatForm">
          {(s.remote ? (["chat"] as const) : CHAT_TABS).map((t) => (
            <a key={t} href={`#/chat/${t}`} className={`settings-tab${place.tab === t ? " is-current" : ""}`} aria-current={place.tab === t ? "page" : undefined} data-chat-tab-link={t} onClick={t === "chat" ? () => setListFolded(false) : undefined}>
              {LABEL[t]}
            </a>
          ))}
        </nav>
        <span className="chat-head-gap" />
        <label className="chat-strip-search">
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") search(q);
              if (e.key === "Escape") {
                setQ("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search messages"
            aria-label="Search messages"
            data-chat-search
          />
          {q && (
            <button className="chat-strip-clear" onClick={() => setQ("")} aria-label="Clear the search">
              <IconClose size={12} />
            </button>
          )}
        </label>
        {s.remote ? <ChatServerNote /> : <ServerNote />}
      </header>
      <div className="chat-body">
        {place.tab === "chat" || s.remote ? (
          <ChatTabView user={user} s={s} route={route} />
        ) : (
          <Suspense fallback={<div className="chat-tab-empty" />}>
            {place.tab === "agents" ? <AgentsTab user={user} rest={place.rest} /> : place.tab === "inbox" ? <InboxTab user={user} rest={place.rest} /> : <HuddlesTab user={user} rest={place.rest} />}
          </Suspense>
        )}
      </div>
      {!s.remote && <SlackNudge user={user} tab={place.tab} />}
      <AnimatePresence>
        {switcher && (
          <QuickSwitcher
            channels={Object.values(s.channels)}
            people={s.people}
            meId={s.me?.id}
            online={s.online}
            onClose={() => setSwitcher(false)}
            onChannel={(id) => goChat("chat", restOf({ channel: id }))}
            onPerson={(id) =>
              void openDirect([id])
                .then((c) => goChat("chat", restOf({ channel: c.id })))
                .catch((e: Error) => toast(e.message, "bad"))
            }
            onCommands={() => setUi({ command: true })}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- the Chat tab

function ChatTabView({ user: foundationUser, s, route }: { user: UserInfo; s: ChatState; route: ChatRest }) {
  // on a chat server, who I am (my id, my role) is that server's account, not Foundation's
  const user: UserInfo = useMemo(() => (s.remote && s.account ? { ...foundationUser, ...s.account } : foundationUser), [s.remote, s.account, foundationUser]);
  const can = useCallback((what: ChatFeature) => chatCan(s.remote, s.features, what), [s.remote, s.features]);
  const channels = useMemo(() => Object.values(s.channels), [s.channels]);
  const meId = s.me?.id ?? user.id;
  const me = useMemo(() => ({ id: meId, name: user.name, handle: chatHandle(user.name), color: user.color }), [meId, user.name, user.color]);
  const go = useCallback((r: Partial<ChatRest>, replace = false) => {
    const hash = `#/chat/chat${restOf(r) ? `/${restOf(r)}` : ""}`;
    if (replace) window.location.replace(`${window.location.pathname}${window.location.search}${hash}`);
    else window.location.hash = hash;
  }, []);

  // no channel named: the last one this device had open, else #general, else the first joined
  const fallback = useMemo(() => {
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST);
    } catch { /* private window */ }
    if (last && s.channels[last] && !s.channels[last].archivedAt) return last;
    const joined = channels.filter((c) => c.me && !c.archivedAt);
    return (joined.find((c) => c.name === "general") ?? channels.find((c) => c.name === "general" && c.kind === "open") ?? joined.sort((a, b) => b.lastPostAt - a.lastPostAt)[0])?.id ?? null;
  }, [channels, s.channels]);
  useEffect(() => {
    if (!route.channel && !route.view && s.loaded && fallback) go({ channel: fallback }, true);
  }, [route.channel, route.view, s.loaded, fallback, go]);

  const channelId = route.view ? null : route.channel;
  const channel = channelId ? s.channels[channelId] : undefined;
  useEffect(() => {
    setOpen(channelId, route.thread);
    if (channelId) {
      try {
        localStorage.setItem(LAST, channelId);
      } catch { /* private window */ }
    }
  }, [channelId, route.thread]);

  // the page: the newest, or around the message the address names
  const [centerId, setCenterId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flash = useCallback((id: string) => {
    setFlashId(id);
    setTimeout(() => setFlashId((x) => (x === id ? null : x)), 1800);
  }, []);
  const [loadErr, setLoadErr] = useState("");
  useEffect(() => {
    if (!channelId || !s.loaded) return;
    setLoadErr("");
    if (route.at != null) {
      void loadAround(channelId, route.at).then((m) => {
        if (!m) return;
        if (m.root && !route.thread) go({ channel: channelId, thread: m.root }, true);
        setCenterId(m.root ?? m.id);
        flash(m.id);
      });
    } else
      loadChannel(channelId).catch((e: Error) => setLoadErr(e.message));
  }, [channelId, route.at, s.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (channelId && route.thread) void loadThread(channelId, route.thread);
  }, [channelId, route.thread]);

  // the New rule: where I'd read to when I opened the channel; it stays while I'm here
  const [ruleAt, setRuleAt] = useState<{ channel: string; seq: number | null } | null>(null);
  useEffect(() => {
    if (!channel || ruleAt?.channel === channel.id) return;
    setRuleAt({ channel: channel.id, seq: channel.me && channel.unread > 0 ? channel.me.readSeq : null });
  }, [channel, ruleAt]);

  // reading: the channel is open, the window has focus, the newest message is in view (and I didn't just mark it unread)
  const [atFoot, setAtFoot] = useState(true);
  const [focused, setFocused] = useState(() => document.hasFocus() && !document.hidden);
  const held = useRef<string | null>(null);
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
    held.current = null;
  }, [channelId]);
  const tl = channelId ? s.timelines[channelId] : undefined;
  useEffect(() => {
    if (!channel?.me || !atFoot || !focused || held.current === channel.id || !tl || tl.after || tl.loading) return;
    if (channel.me.readSeq < channel.lastSeq || channel.me.mentions > 0) void markRead(channel.id);
  }, [channel, atFoot, focused, tl]);

  // editing: one message at a time
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setEditing(null), [channelId]);

  const actions: MessageActions = useMemo(
    () => ({
      react: (m, e, on) => void react(m, e, on).catch((x: Error) => toast(x.message, "bad")),
      reply: (m) => go({ channel: m.channel, thread: m.id }),
      pin: can("pins") ? (m, on) => void pin(m, on).catch((x: Error) => toast(x.message, "bad")) : undefined,
      copyLink: (m) => {
        const url = `${window.location.origin}${window.location.pathname}#/chat/chat/${restOf({ channel: m.channel, at: m.seq })}`;
        void navigator.clipboard?.writeText(url).then(
          () => toast("Link copied"),
          () => toast(url),
        );
      },
      markUnread: (m) => {
        held.current = m.channel;
        setRuleAt({ channel: m.channel, seq: m.seq - 1 });
        void markUnreadFrom(m);
      },
      edit: (m) => setEditing(m.id),
      saveEdit: (m, text) => {
        setEditing(null);
        void editMessage(m, text).catch((x: Error) => toast(`Not saved: ${x.message}`, "bad"));
      },
      cancelEdit: () => setEditing(null),
      remove: (m) => void removeMessage(m).catch((x: Error) => toast(x.message, "bad")),
      openPlace: (m) => {
        if (!m.place) return;
        window.dispatchEvent(new CustomEvent("foundation:board", { detail: m.place.board }));
      },
    }),
    [go, can],
  );

  const items = useMemo(
    () => (tl ? layoutTimeline(tl.messages, { readSeq: ruleAt?.channel === channelId ? ruleAt.seq : null, meId, pending: s.pending.filter((p) => p.channel === channelId && !p.root) }) : []),
    [tl, ruleAt, channelId, meId, s.pending],
  );

  const thread = route.thread ? s.threads[route.thread] : undefined;
  const threadRoot = thread?.root ?? (route.thread ? tl?.messages.find((m) => m.id === route.thread) ?? null : null);
  const threadItems = useMemo(
    () => (route.thread ? layoutTimeline(thread?.replies ?? [], { meId, pending: s.pending.filter((p) => p.root === route.thread) }).filter((i) => i.kind !== "new") : []),
    [route.thread, thread?.replies, meId, s.pending],
  );

  // Esc closes the thread (when the caret isn't in a field, where Esc is the field's)
  useEffect(() => {
    if (!route.thread) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isField(e.target) && !document.querySelector(".chat-pop, .chat-modal, .chat-lightbox, .chat-emoji-picker")) go({ channel: channelId });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [route.thread, channelId, go]);

  // typing anywhere that isn't a field goes to the composer
  const composer = useRef<ComposerHandle>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || isField(e.target)) return;
      if (document.querySelector(".chat-modal, .chat-lightbox, .command-bar")) return;
      composer.current?.focus();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const [dialog, setDialog] = useState<"channel" | "direct" | null>(null);
  // a dialog that picks people: the list again first, so someone who just signed in is there
  useEffect(() => {
    if (dialog) refreshList();
  }, [dialog]);
  const typingIn = useMemo(() => new Set(s.typing.map((t) => t.channel)), [s.typing]);

  const editLast = (root: string | null) => () => {
    const list = root ? (s.threads[root]?.replies ?? []) : (tl?.messages ?? []);
    const mine = [...list].reverse().find((m) => m.author.id === meId && m.author.kind === "person" && m.type === "text" && !m.deletedAt);
    if (!mine) return false;
    setEditing(mine.id);
    return true;
  };

  const viewer = user.role === "viewer";
  const disabled = !channel ? undefined : channel.archivedAt ? "This channel is archived: everything said stays readable" : viewer && !channel.me ? "View only: a viewer posts where they're a member" : undefined;
  const title = channel ? chatTitle(channel, meId) : "";
  const placeholder = channel ? (channel.kind === "open" || channel.kind === "private" ? `Message #${title}${channel.me ? "" : " (sending joins it)"}` : `Message ${title}`) : "";
  const typingWords = (root: string | null) => {
    const who = s.typing.filter((t) => t.channel === channelId && t.root === root).map((t) => t.party.name);
    if (!who.length) return null;
    return who.length === 1 ? `${who[0]} is typing…` : who.length === 2 ? `${who[0]} and ${who[1]} are typing…` : "Several people are typing…";
  };

  // search
  const [hits, setHits] = useState<ChatHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchWhy, setSearchWhy] = useState("");
  useEffect(() => {
    if (route.view !== "search" || !route.q) return;
    const ctl = new AbortController();
    setSearching(true);
    setHits(null);
    setSearchWhy("");
    searchChat(route.q, ctl.signal)
      .then(setHits)
      .catch((e: Error) => e.name !== "AbortError" && setSearchWhy(e.message))
      .finally(() => setSearching(false));
    return () => ctl.abort();
  }, [route.view, route.q]);

  // the threads I'm in (the server's list)
  const [threadRows, setThreadRows] = useState<ThreadRow[] | null>(null);
  const [threadsWhy, setThreadsWhy] = useState("");
  useEffect(() => {
    if (route.view !== "threads") return;
    let live = true;
    setThreadsWhy("");
    chatApi<{ threads: ThreadRow[] }>("/api/chat/threads")
      .then((r) => live && setThreadRows(r.threads))
      .catch((e: Error) => live && setThreadsWhy(e.message));
    return () => {
      live = false;
    };
  }, [route.view]);

  const pinned = useMemo(() => (tl?.messages ?? []).filter((m) => m.pinned && !m.deletedAt), [tl]);
  // opened from the side menu: the conversation takes the whole area and the channel list folds away (chat/pins.ts)
  const folded = usePins().listFolded && !!channel && !route.view;
  const fail = (x: Error) => toast(x.message, "bad");

  // a chat server nobody is signed in to on this device: the whole tab is its sign-in
  if (s.status === "signin") {
    return <ChatSignIn note={s.why} />;
  }

  const noFiles = can("files") ? undefined : "Files can't be sent on this chat server yet. They stay on Foundation's own.";
  let main: React.ReactNode;
  if (s.status === "unavailable") {
    main = (
      <div className="chat-tab-empty">
        <h2>ChatForm isn't on this server yet</h2>
        <p>{s.why} When it is, channels, direct messages and threads appear here; this page asks again every minute.</p>
      </div>
    );
  } else if (route.view === "browse") {
    main = <BrowseView channels={channels} meId={meId} onOpen={(id) => go({ channel: id })} onJoin={(id) => void joinChannel(id).then(() => go({ channel: id }), fail)} />;
  } else if (route.view === "threads") {
    main = <ThreadsView threads={threadRows} busy={!threadRows} why={threadsWhy} onOpen={(m) => go({ channel: m.channel, thread: m.id })} />;
  } else if (route.view === "search") {
    main = <SearchView q={route.q} hits={hits} busy={searching} why={searchWhy} onOpen={(h) => go(h.message.root ? { channel: h.channel.id, thread: h.message.root, at: h.message.seq } : { channel: h.channel.id, at: h.message.seq })} />;
  } else if (!channel) {
    main = (
      <div className="chat-tab-empty">
        {!s.loaded ? (
          <p>Connecting…</p>
        ) : channelId ? (
          <>
            <h2>This conversation isn't here</h2>
            <p>It was archived, or it's one you can't see. Pick another on the left.</p>
          </>
        ) : (
          <>
            <h2>Nothing to read yet</h2>
            <p>Make a channel with ＋ beside Channels, or start a direct message.</p>
          </>
        )}
      </div>
    );
  } else {
    main = (
      <div
        className="chat-main"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files") && !disabled && !noFiles) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length || disabled || noFiles) return;
          e.preventDefault();
          composer.current?.addFiles([...e.dataTransfer.files]);
        }}
      >
        <ChannelHead
          channel={channel}
          meId={meId}
          people={s.people}
          online={s.online}
          pinned={pinned}
          canAdmin={user.role === "admin" || channel.createdBy === user.id}
          onTopic={can("topics") && (channel.me || channel.kind === "open") ? (topic) => void updateChannel(channel.id, { topic }).catch(fail) : undefined}
          onStar={can("star") ? (on) => void updateChannel(channel.id, { starred: on }).catch(fail) : undefined}
          onNotify={can("notify") ? (n) => void updateChannel(channel.id, { notify: n }).catch(fail) : undefined}
          onMembers={can("members") && channel.me ? (add, remove) => void changeMembers(channel.id, add, remove).catch(fail) : undefined}
          noHuddle={!can("huddles")}
          noPins={!can("pins")}
          onWantMembers={() => void refreshChannel(channel.id)}
          onJump={(m) => go({ channel: channel.id, at: m.seq })}
          onExport={can("export") ? (f) => void exportChannel(channel.id, f).catch(fail) : undefined}
          onLeave={() => void leaveChannel(channel.id).catch(fail)}
          onArchive={can("archive") ? () => void archiveChannel(channel.id).then(() => toast(`#${channel.name} is archived`), fail) : undefined}
          onJoin={!viewer ? () => void joinChannel(channel.id).catch(fail) : undefined}
          onUnfold={folded ? () => setListFolded(false) : undefined}
        />
        {s.status === "offline" && <div className="chat-offline">Offline · {s.why}</div>}
        {loadErr && !tl?.messages.length ? (
          <div className="chat-tab-empty">
            <h2>The messages didn't come</h2>
            <p>{loadErr}</p>
            <button className="f-pill" onClick={() => loadChannel(channel.id, true).catch((e: Error) => setLoadErr(e.message))}>
              Try again
            </button>
          </div>
        ) : (
          <Timeline
            items={items}
            me={me}
            actions={actions}
            editingId={editing}
            flashId={flashId}
            centerId={centerId}
            liveHuddle={channel.huddle}
            hasOlder={!!tl?.before}
            hasNewer={!!tl?.after}
            loading={!!tl?.loading}
            onOlder={() => void loadOlder(channel.id)}
            onNewer={() => void loadNewer(channel.id)}
            onFoot={setAtFoot}
            onJumpNewest={() => {
              setCenterId(null);
              go({ channel: channel.id }, true);
              void loadChannel(channel.id, true);
            }}
            onRetry={retry}
            onDiscard={discard}
            intro={<ChannelIntro c={channel} meId={meId} />}
            newBelow={!atFoot && channel.unread > 0 ? channel.unread : 0}
          />
        )}
        <div className="chat-main-foot">
          <Composer
            ref={composer}
            channel={channel.id}
            placeholder={placeholder}
            people={s.people}
            agents={s.agents}
            channels={channels}
            meId={meId}
            disabled={disabled}
            noFiles={noFiles}
            autoFocus
            onSend={(text, files) => send(channel.id, text, files, null)}
            onTyping={() => sayTyping(channel.id, null)}
            onEditLast={editLast(null)}
          />
          <div className="chat-typing" aria-live="polite">
            {typingWords(null)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-tab-chat${route.thread && channel ? " has-thread" : ""}${folded ? " is-list-folded" : ""}`}>
      {!folded && <Sidebar channels={channels} meId={meId} online={s.online} current={channelId} view={route.view} onOpen={(id) => go({ channel: id })} onView={(v) => go({ view: v })} onNew={setDialog} typing={typingIn} carry={!s.remote} noThreads={!can("threads-list")} />}
      {main}
      <AnimatePresence>
        {route.thread && channel && (
          <ThreadPane
            key={route.thread}
            where={channel.kind === "open" || channel.kind === "private" ? `#${title}` : title}
            root={threadRoot}
            items={threadItems}
            me={me}
            actions={actions}
            editingId={editing}
            flashId={flashId}
            loading={thread?.loading}
            onClose={() => go({ channel: channel.id })}
            onRetry={retry}
            onDiscard={discard}
            typing={typingWords(route.thread)}
            composer={
              <Composer
                channel={channel.id}
                root={route.thread}
                placeholder="Reply…"
                people={s.people}
                agents={s.agents}
                channels={channels}
                meId={meId}
                disabled={disabled}
                noFiles={noFiles}
                compact
                autoFocus
                onSend={(text, files) => send(channel.id, text, files, route.thread)}
                onTyping={() => sayTyping(channel.id, route.thread)}
                onEditLast={editLast(route.thread)}
              />
            }
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {dialog === "channel" && (
          <NewChannelDialog
            people={s.people}
            online={s.online}
            meId={meId}
            onClose={() => setDialog(null)}
            onCreate={async (c) => {
              const made = await createChannel({ kind: c.kind, name: c.name, purpose: c.purpose, members: c.members });
              setDialog(null);
              go({ channel: made.id });
            }}
          />
        )}
        {dialog === "direct" && (
          <NewDirectDialog
            people={s.people}
            online={s.online}
            meId={meId}
            onClose={() => setDialog(null)}
            onStart={async (ids) => {
              const made = await openDirect(ids);
              setDialog(null);
              go({ channel: made.id });
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

