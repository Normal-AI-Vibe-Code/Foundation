/**
 * ChatForm's button in the top bar's left corner, right after Today and of its family: a 28 px pill, the
 * mark and *ChatForm*, with what's waiting beside the word (mentions of me, and unread direct messages;
 * the roll-over says how many of each). It starts the chat store once someone is signed in, so the badge
 * is live wherever they are.
 */

import { useEffect, useMemo } from "react";
import { goChat } from "../lib/place";
import { startChat, useChat } from "./model";
import { setListFolded } from "./pins";
import { chatTotals, totalsWords } from "./logic";
import { ChatMark } from "./Icons";
import "./chat.css";

export function ChatButton({ on }: { on: boolean }) {
  useEffect(() => startChat(), []);
  const s = useChat();
  const t = useMemo(() => chatTotals(Object.values(s.channels)), [s.channels]);
  const tip = s.status === "signin" ? "ChatForm: sign in to its server" : s.status === "unavailable" ? "ChatForm: this server doesn't have it yet" : t.total ? `ChatForm: ${totalsWords(t)}` : "ChatForm: channels, direct messages, agents";
  return <ChatButtonView on={on} total={t.total} tip={tip} words={totalsWords(t)} onClick={() => (setListFolded(false), goChat())} />;
}

export function ChatButtonView({ on, total, tip, words, onClick }: { on: boolean; total: number; tip: string; words: string; onClick?(): void }) {
  return (
    <button className={`top-today top-chat${on ? " is-on" : ""}`} onClick={onClick} data-tip={tip} data-top-chat data-place="chat">
      <ChatMark size={16} />
      ChatForm
      {total > 0 && (
        <span className="pane-badge" data-chat-badge={total} aria-label={`${total} for you: ${words}`}>
          {total > 99 ? "99+" : total}
        </span>
      )}
    </button>
  );
}
