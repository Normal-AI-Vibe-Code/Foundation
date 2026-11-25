/**
 * The thread pane, on the right: a floor pane with its hairline on the left (360 wide; over the timeline
 * as a sheet when the place is narrow). Head: *Thread* and where it is, ✕ (Esc). Then the first message,
 * a rule that counts the replies, the replies (runs of one author as in the timeline), and its own
 * composer at the foot.
 */

import type { ReactNode } from "react";
import { motion } from "motion/react";
import type { ChatFile, ChatMessage } from "@foundation/protocol";
import type { TimelineItem } from "./logic";
import { MessageView, PendingView, type MessageActions, type MessageMe } from "./Message";
import { IconClose } from "./Icons";

export interface ThreadPaneProps {
  where: string;
  root: ChatMessage | null;
  items: TimelineItem[];
  me?: MessageMe & { color?: string };
  actions?: MessageActions;
  editingId?: string | null;
  flashId?: string | null;
  loading?: boolean;
  srcOf?: (f: ChatFile) => string;
  composer?: ReactNode;
  typing?: ReactNode;
  onClose?(): void;
  onRetry?(id: string): void;
  onDiscard?(id: string): void;
  /** drawn in place, not sliding in (the design page) */
  still?: boolean;
}

export function ThreadPane(p: ThreadPaneProps) {
  const replies = p.items.filter((i) => i.kind === "message" || i.kind === "pending").length;
  return (
    <motion.aside
      className="chat-thread"
      aria-label="Thread"
      data-thread-pane={p.root?.id}
      initial={p.still ? false : { opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 420, damping: 40 }}
    >
      <header className="chat-thread-head">
        <span className="chat-thread-title">Thread</span>
        <span className="chat-thread-where" title={p.where}>{p.where}</span>
        <span className="chat-head-gap" />
        {p.onClose && (
          <button type="button" className="chat-head-btn" onClick={p.onClose} data-tip="Close the thread" data-kbd="Esc" aria-label="Close the thread">
            <IconClose />
          </button>
        )}
      </header>
      <div className="chat-thread-scroll">
        {p.root ? <MessageView message={p.root} me={p.me} actions={p.actions} inThread editing={p.editingId === p.root.id} flash={p.flashId === p.root.id} srcOf={p.srcOf} /> : <p className="chat-thread-wait" role="status">{p.loading ? "Loading the thread…" : "This thread isn't here any more."}</p>}
        <div className="chat-thread-rule" role="separator">
          <span>{replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : p.loading ? "" : "No replies yet"}</span>
        </div>
        {p.items.map((it) =>
          it.kind === "message" ? (
            <MessageView key={it.key} message={it.message} continued={it.continued} me={p.me} actions={p.actions} inThread editing={p.editingId === it.message.id} flash={p.flashId === it.message.id} srcOf={p.srcOf} />
          ) : it.kind === "pending" && p.me ? (
            <PendingView key={it.key} p={it.pending} continued={it.continued} me={p.me} onRetry={p.onRetry && (() => p.onRetry!(it.pending.requestId))} onDiscard={p.onDiscard && (() => p.onDiscard!(it.pending.requestId))} />
          ) : it.kind === "day" ? null : null,
        )}
      </div>
      <div className="chat-thread-foot">
        {p.composer}
        <div className="chat-typing" aria-live="polite">{p.typing}</div>
      </div>
    </motion.aside>
  );
}
