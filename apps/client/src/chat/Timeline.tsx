/**
 * The timeline: a channel's messages laid out by logic `layoutTimeline` (day rules, the *New* rule, runs
 * of one author), newest at the foot. The scroller is `column-reverse`, so the foot is where it rests:
 * new messages arrive in view and older pages come in above without moving what you're reading. Near the
 * top it asks for older messages; near the foot of a page that isn't the newest, for newer ones. Away
 * from the foot, a *Jump to newest* pill.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ChatFile, ChatHuddleState } from "@foundation/protocol";
import type { TimelineItem } from "./logic";
import { MessageView, PendingView, type MessageActions, type MessageMe } from "./Message";

export interface TimelineProps {
  items: TimelineItem[];
  me?: MessageMe & { color?: string };
  actions?: MessageActions;
  editingId?: string | null;
  flashId?: string | null;
  /** bring this message to the middle (a search result, a link) */
  centerId?: string | null;
  srcOf?: (f: ChatFile) => string;
  liveHuddle?: ChatHuddleState | null;
  hasOlder?: boolean;
  hasNewer?: boolean;
  loading?: boolean;
  onOlder?(): void;
  onNewer?(): void;
  /** the newest message is in view, or isn't any more */
  onFoot?(atFoot: boolean): void;
  onJumpNewest?(): void;
  onRetry?(requestId: string): void;
  onDiscard?(requestId: string): void;
  /** drawn above the first message when there's nothing older: what this channel is */
  intro?: ReactNode;
  /** how many unread there are below the view (for the pill's words) */
  newBelow?: number;
  /** a static drawing (the design page): no scroller of its own */
  still?: boolean;
}

export function Timeline(p: TimelineProps) {
  const box = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const foot = useRef(true);
  const asked = useRef({ older: 0, newer: 0 });

  const look = useCallback(() => {
    const el = box.current;
    if (!el) return;
    // column-reverse: scrollTop is 0 at the foot and negative going up
    const fromFoot = Math.abs(el.scrollTop);
    const fromTop = el.scrollHeight - el.clientHeight - fromFoot;
    const atFoot = fromFoot < 24;
    if (atFoot !== foot.current) {
      foot.current = atFoot;
      p.onFoot?.(atFoot && !p.hasNewer);
    }
    setAway(fromFoot > 320);
    const now = Date.now();
    if (fromTop < 240 && p.hasOlder && !p.loading && now - asked.current.older > 400) {
      asked.current.older = now;
      p.onOlder?.();
    }
    if (fromFoot < 240 && p.hasNewer && !p.loading && now - asked.current.newer > 400) {
      asked.current.newer = now;
      p.onNewer?.();
    }
  }, [p]);

  // a page that doesn't fill the view: ask for the next one straight away
  useEffect(() => {
    const el = box.current;
    if (!el || p.still) return;
    if (el.scrollHeight <= el.clientHeight + 4 && p.hasOlder && !p.loading) p.onOlder?.();
  }, [p.items.length, p.hasOlder, p.loading, p.still]); // eslint-disable-line react-hooks/exhaustive-deps

  // tell the place where we are once on mount, and whenever the newest page changes
  useEffect(() => {
    p.onFoot?.(foot.current && !p.hasNewer);
  }, [p.hasNewer]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!p.centerId) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-message="${CSS.escape(p.centerId)}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [p.centerId, p.items.length]);

  const body = (
    <div className="chat-timeline-inner">
      {!p.hasOlder && p.intro}
      {p.hasOlder && <div className="chat-older">{p.loading ? "Loading earlier messages…" : ""}</div>}
      {p.items.map((it) =>
        it.kind === "day" ? (
          <div key={it.key} className="chat-day" role="separator">
            <span>{it.label}</span>
          </div>
        ) : it.kind === "new" ? (
          <div key="new" className="chat-new-rule" role="separator" data-new-rule>
            <span>New</span>
          </div>
        ) : it.kind === "message" ? (
          <MessageView
            key={it.key}
            message={it.message}
            continued={it.continued}
            me={p.me}
            actions={p.actions}
            editing={p.editingId === it.message.id}
            flash={p.flashId === it.message.id}
            srcOf={p.srcOf}
            liveHuddle={p.liveHuddle}
          />
        ) : p.me ? (
          <PendingView key={it.key} p={it.pending} continued={it.continued} me={p.me} onRetry={p.onRetry && (() => p.onRetry!(it.pending.requestId))} onDiscard={p.onDiscard && (() => p.onDiscard!(it.pending.requestId))} />
        ) : null,
      )}
    </div>
  );

  if (p.still) return <div className="chat-timeline is-still">{body}</div>;
  return (
    <div className="chat-timeline-wrap">
      <div ref={box} className="chat-timeline" onScroll={look} data-chat-timeline>
        {body}
      </div>
      <AnimatePresence>
        {(away || p.hasNewer) && (
          <motion.button
            type="button"
            className="chat-jump"
            onClick={() => {
              if (p.hasNewer) p.onJumpNewest?.();
              box.current?.scrollTo({ top: 0, behavior: "smooth" });
            }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            data-jump-newest
          >
            {p.newBelow ? `${p.newBelow} new · ` : ""}Jump to newest ↓
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
