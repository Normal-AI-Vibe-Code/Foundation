/**
 * The pin that puts a conversation in the right panel (chat/pinRight.ts), on ChatForm's head and a chat card's head.
 */
import { CHAT_SERVER } from "./server";
import { pinRight, toggleChatRight, useChatPin } from "./pinRight";

/** pin this conversation in the right panel (chat/pinRight.ts): lit while it is the one there */
export function PinRightButton({ channel, className = "chat-head-btn" }: { channel: string; className?: string }) {
  const pinned = useChatPin();
  const on = pinned.channel === channel && pinned.server === CHAT_SERVER;
  return (
    <button
      type="button"
      className={`${className}${on ? " is-on" : ""}`}
      onClick={() => (on ? toggleChatRight() : pinRight(channel, CHAT_SERVER))}
      aria-pressed={on}
      aria-label={on ? "Pinned in the right panel" : "Pin in the right panel"}
      data-tip={on ? "Pinned in the right panel: press to show or hide it" : "Pin in the right panel, beside your work"}
      data-chat-pin-right={channel}
    >
      <PinRightGlyph />
    </button>
  );
}

/** a window with its right panel filled */
export function PinRightGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" />
      <path d="M10 2.5v11" />
      <rect x="11.3" y="5" width="1.6" height="6" rx=".8" fill="currentColor" stroke="none" />
    </svg>
  );
}
