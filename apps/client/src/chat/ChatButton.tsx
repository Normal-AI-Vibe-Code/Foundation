/**
 * ChatForm's button: a 28 px pill, the mark and *ChatForm*, with what's waiting beside the word (mentions of me,
 * and unread direct messages; the roll-over says how many of each). It starts the chat store once someone is
 * signed in, so the badge is live wherever they are.
 *
 * Since 2026-11-25 (Josh: "perhaps chatform is actually a top right level tool") it heads the tools at the top
 * bar's right end, as one pill in two halves: the word opens the whole of ChatForm, and the panel at its end opens
 * the conversation pinned in the right panel (chat/pinRight.ts, chat/PinnedChat.tsx) beside whatever is open.
 */

import { useEffect, useMemo } from "react";
import { goChat } from "../lib/place";
import { startChat, useChat } from "./model";
import { setListFolded } from "./pins";
import { useTellWhere } from "./gridChatWhere";
import { chatTotals, totalsWords } from "./logic";
import { ChatMark } from "./Icons";
import { PinRightGlyph } from "./PinRightButton";
import { toggleChatRight, useChatPin } from "./pinRight";
import { CHAT_SERVER } from "./server";
import { chatTitle } from "@foundation/protocol";
import { placeOf } from "../lib/place";
import { useSyncExternalStore } from "react";
import "./chat.css";

export function ChatButton({ on }: { on: boolean }) {
  useEffect(() => startChat(), []);
  // on a chat server of its own: this window says which grid it has open, so people on it see each other (gridChatWhere.ts)
  useTellWhere();
  const s = useChat();
  const t = useMemo(() => chatTotals(Object.values(s.channels)), [s.channels]);
  const tip = s.status === "signin" ? "ChatForm: sign in to its server" : s.status === "unavailable" ? "ChatForm: this server doesn't have it yet" : t.total ? `ChatForm: ${totalsWords(t)}` : "ChatForm: channels, direct messages, agents";
  return <ChatButtonView on={on} total={t.total} tip={tip} words={totalsWords(t)} onClick={() => (setListFolded(false), goChat())} />;
}

export function ChatButtonView({ on, total, tip, words, onClick }: { on: boolean; total: number; tip: string; words: string; onClick?(): void }) {
  return (
    <button type="button" className={`top-today top-chat${on ? " is-on" : ""}`} aria-current={on ? "page" : undefined} onClick={onClick} data-tip={tip} data-top-chat data-place="chat">
      <ChatMark size={16} />
      <span className="top-word">ChatForm</span>
      {total > 0 && (
        <span className="pane-badge" data-chat-badge={total} aria-label={`${total} for you: ${words}`}>
          {total > 99 ? "99+" : total}
        </span>
      )}
    </button>
  );
}

/** the place in the window's hash, live */
function usePlaceKind() {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener("hashchange", fn);
      return () => window.removeEventListener("hashchange", fn);
    },
    () => placeOf(window.location.hash).kind,
    () => "today" as const,
  );
}

/** the top right's ChatForm: the word opens the whole place, the panel half the pinned conversation beside it */
export function ChatToolButton({ on }: { on: boolean }) {
  const place = usePlaceKind();
  const pin = useChatPin();
  const s = useChat();
  const pinned = pin.server === CHAT_SERVER && pin.channel ? s.channels[pin.channel] : undefined;
  const unreadThere = !on && pinned ? pinned.unread : 0;
  return (
    <span className="top-chat-split" data-top-chat-split>
      <ChatButton on={place === "chat"} />
      <button
        type="button"
        className={`top-btn top-chat-panel${on ? " is-on" : ""}`}
        onClick={toggleChatRight}
        aria-pressed={on}
        aria-label={on ? "Close the pinned conversation" : "Open the pinned conversation"}
        data-tip={on ? "Close the right panel" : pinned ? `In the right panel: ${pinned.kind === "open" || pinned.kind === "private" ? "#" : ""}${chatTitle(pinned, s.me?.id)}` : "Pin a conversation in the right panel"}
        data-tool-open="chat"
      >
        <PinRightGlyph />
        {unreadThere > 0 && <i className="tool-btn-dot is-unread" aria-hidden data-chat-pinned-unread={unreadThere} />}
      </button>
    </span>
  );
}
