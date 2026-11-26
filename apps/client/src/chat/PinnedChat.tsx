/**
 * ChatForm in the right panel (2026-11-25, Josh: "Chat Form should be able to pin a conversation on the right panel,
 * perhaps chatform is actually a top right level tool"). The tools pane's first tab: the conversation pinned there
 * (chat/pinRight.ts), live, beside the grid — the same conversation a chat card shows (panels/ChatCardView.tsx
 * ChatConversation), fed from ChatForm's own store, so a message sent in one shows in all. Its head switches to
 * another conversation (the list, most recent first, unread lit) or takes the pin off; Open in ChatForm goes to the
 * whole place.
 *
 * Something from the grid dropped on it (a card carried over, a search result) goes into its composer
 * (chat/chatDrop.ts), and a message pulled out of it lands on the grid as a note (chat/Message.tsx).
 *
 * The panel is in use while the pointer or the caret is in it: the wheel is its own and reading it marks it read.
 */

import { useEffect, useMemo, useState } from "react";
import { chatTitle, type ChatChannelView } from "@foundation/protocol";
import { startChat, refreshChannel, useChat, type ChatState } from "./model";
import { CHAT_SERVER, CHAT_SERVER_NAME } from "./server";
import { useChatPin, pinRight, unpinRight } from "./pinRight";
import { channelMark } from "./Sidebar";
import { fuzzyScore } from "./logic";
import { goChat } from "../lib/place";
import { ChatCardNotice, ChatConversation } from "../panels/ChatCardView";
import "./chat.css";
import "../panels/chat-card.css";

export function PinnedChat({ shown }: { shown: boolean }) {
  useEffect(() => startChat(), []);
  const s = useChat();
  const pin = useChatPin();
  const [picking, setPicking] = useState(false);
  const here = pin.server === CHAT_SERVER;
  const channel = here && pin.channel ? s.channels[pin.channel] : undefined;
  // a pinned conversation the list didn't bring (made since, or not listed): asked for once by id
  useEffect(() => {
    if (shown && here && pin.channel && !channel && s.loaded && s.status === "live") void refreshChannel(pin.channel);
  }, [shown, here, pin.channel, !!channel, s.loaded, s.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // the panel is in use while the pointer or the caret is in it
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  let body;
  if (s.status === "signin")
    body = (
      <ChatCardNotice kind="signin" title={`Sign in to ${CHAT_SERVER_NAME || "ChatForm"}`} line="Then pin a conversation here, beside your work.">
        <button type="button" className="f-pill is-accent" onClick={() => goChat()}>
          Open ChatForm to sign in
        </button>
      </ChatCardNotice>
    );
  else if (s.status === "unavailable") body = <ChatCardNotice kind="waiting" title="ChatForm isn't on this server yet" line={s.why} />;
  else if (picking || !pin.channel || !here) body = <PinPicker s={s} current={here ? pin.channel : null} onPick={(c) => (pinRight(c.id, CHAT_SERVER), setPicking(false))} onCancel={pin.channel && here ? () => setPicking(false) : undefined} />;
  else if (!channel) body = <ChatCardNotice kind="waiting" title={s.status === "offline" ? "Offline" : "Opening the conversation…"} line={s.status === "offline" ? s.why : ""} />;
  else
    body = (
      <ChatConversation
        channel={channel}
        s={s}
        live={shown}
        inUse={shown && (hover || focus)}
        headActions={
          <>
            <button type="button" className="chat-head-btn" onClick={() => setPicking(true)} aria-label="Pin another conversation" data-tip="Another conversation" data-chat-pin-switch>
              <SwitchGlyph />
            </button>
            <button type="button" className="chat-head-btn" onClick={unpinRight} aria-label="Unpin" data-tip="Take the pin off" data-chat-unpin>
              <UnpinGlyph />
            </button>
          </>
        }
      />
    );

  return (
    <div
      className={`chat-card chat-pinned is-${channel && !picking ? "open" : "picking"} is-in-use`}
      data-chat-pinned={channel?.id ?? ""}
      data-chat-drop-zone={channel && !picking ? "on" : "off"}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocusCapture={() => setFocus(true)}
      onBlurCapture={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocus(false)}
    >
      {body}
    </div>
  );
}

/** which conversation the panel keeps: most recent first, unread lit, filtered as you type */
function PinPicker({ s, current, onPick, onCancel }: { s: ChatState; current: string | null; onPick(c: ChatChannelView): void; onCancel?(): void }) {
  const [q, setQ] = useState("");
  const meId = s.me?.id;
  const rows = useMemo(() => {
    const all = Object.values(s.channels).filter((c) => !c.archivedAt && (c.me || c.kind === "open"));
    const t = q.trim().replace(/^#/, "");
    return all
      .map((c) => ({ c, title: chatTitle(c, meId), score: t ? fuzzyScore(t, chatTitle(c, meId)) : 1 }))
      .filter((r) => r.score > 0)
      .sort((a, b) => (t ? b.score - a.score : Number(!!b.c.me) - Number(!!a.c.me) || b.c.lastPostAt - a.c.lastPostAt));
  }, [s.channels, q, meId]);
  return (
    <div className="chat-card-picker chat-pin-picker" data-chat-pin-picker>
      <div className="chat-pin-picker-head">
        <div className="f-eyebrow">Pin a conversation here{s.remote ? ` · ${CHAT_SERVER_NAME}` : ""}</div>
        {onCancel && (
          <button type="button" className="f-pill" onClick={onCancel}>
            Back
          </button>
        )}
      </div>
      <input className="chat-card-filter" value={q} autoFocus onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && onCancel?.())} placeholder="Find a channel or a person" aria-label="Find a conversation" />
      <div className="chat-card-rows wheel-own">
        {!s.loaded ? (
          <p className="chat-card-dim">Listing your conversations…</p>
        ) : rows.length === 0 ? (
          <p className="chat-card-dim">{q ? "Nothing by that name." : "No conversations yet."}</p>
        ) : (
          rows.slice(0, 80).map(({ c, title }) => (
            <button key={c.id} type="button" className={`chat-card-row${c.kind === "agent" ? " is-agent" : ""}${c.id === current ? " is-current" : ""}`} onClick={() => onPick(c)} data-chat-pin-pick={c.id}>
              <span className="chat-card-row-mark">{channelMark(c, meId, s.online, 18)}</span>
              <span className="chat-card-row-name">{title}</span>
              {c.unread > 0 && <span className={`chat-count${(c.me?.mentions ?? 0) > 0 || c.kind === "dm" || c.kind === "group" ? " is-accent" : ""}`}>{c.unread > 99 ? "99+" : c.unread}</span>}
              {!c.me && <i className="chat-card-dim">not joined</i>}
            </button>
          ))
        )}
      </div>
      <p className="chat-card-dim chat-card-keeps">Kept on this device. Drag a card from the grid onto it to share it; drag a message out onto the grid to keep it there.</p>
    </div>
  );
}

function SwitchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" />
    </svg>
  );
}

function UnpinGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
