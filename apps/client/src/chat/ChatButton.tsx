/**
 * ChatForm's button: a 28 px pill, the mark and *ChatForm*, with what's waiting beside the word (mentions of me,
 * and unread direct messages; the roll-over says how many of each). It starts the chat store once someone is
 * signed in, so the badge is live wherever they are.
 *
 * Since 2026-11-25 (Josh: "perhaps chatform is actually a top right level tool") it heads the tools at the top
 * bar's right end; since 2026-11-26 as the mark alone, its word kept as the button's name for a screen reader.
 */

import { useEffect, useMemo } from "react";
import { goChat } from "../lib/place";
import { startChat, useChat } from "./model";
import { setListFolded } from "./pins";
import { useTellWhere } from "./gridChatWhere";
import { chatTotals, totalsWords } from "./logic";
import { ChatMark } from "./Icons";
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

/**
 * The top right's ChatForm (2026-11-26, Josh: "a pill with just the chatform icon and a small number icon if there
 * are notifications"): the mark, and the count beside it when something's waiting. It opens the whole of ChatForm;
 * a conversation goes to the right panel from its own head there (chat/PinRightButton.tsx).
 */
export function ChatToolButton() {
  const place = usePlaceKind();
  return (
    <span className="top-chat-solo" data-top-chat-solo>
      <ChatButton on={place === "chat"} />
    </span>
  );
}
