/**
 * The bell, in the top bar right after ChatForm's button: what was said to me. A 30 px top-bar button (the bell
 * drawn at the shell's weight), the count of what I haven't seen on the accent's pill at its shoulder, and on a
 * press a glass panel under it titled **Notifications**: who, where, a line of what they said and when, newest
 * first, live as they arrive. Pressing one opens ChatForm at that message (flashed) and it's seen; **Mark all
 * read** clears the count.
 *
 * On a server that keeps no list of what was said to me the panel falls back to the conversations with something
 * waiting, from the counts the chat store has. The store is chat/notify.ts; the rules are chat/notifyLogic.ts.
 * `BellButton` and `BellPanel` are presentational, so `#/design` draws them from fixtures.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { chatTitle, type ChatChannelView, type ChatParty } from "@foundation/protocol";
import { goChat, goSettings } from "../lib/place";
import { PartyAvatar } from "./Avatar";
import { IconBell, IconHash, IconLock } from "./Icons";
import { ago } from "./Message";
import { Pop } from "./Pop";
import { chatTotals, restOf } from "./logic";
import { useChat } from "./model";
import { openNotice, seeAllNotices, startNotices, useNotices, useTell } from "./notify";
import { countWords, firstLine, isSeen, unseenCount, waitingRows, whereWords, whyWords, type Notice, type Seen, type WaitingRow } from "./notifyLogic";
import { setListFolded } from "./pins";
import "./chat.css";
import "./bell.css";

const PANEL_W = 380;

export function NotificationBell() {
  useEffect(() => startNotices(), []);
  const chat = useChat();
  const n = useNotices();
  const tell = useTell();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const channels = useMemo(() => Object.values(chat.channels), [chat.channels]);
  const waiting = useMemo(() => (n.listed ? [] : waitingRows(channels)), [n.listed, channels]);
  const count = n.listed ? unseenCount(n.list, n.seen, chat.channels) : chatTotals(channels).total;

  // under the bell, kept inside the window
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_W - 8)), top: r.bottom + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  const close = useCallback(() => setOpen(false), []);

  // nobody signed in to chat here, or a server without ChatForm: no bell
  if (!chat.loaded || chat.status === "off" || chat.status === "signin" || chat.status === "unavailable") return null;

  return (
    <>
      <BellButton ref={btn} count={count} open={open} onToggle={() => setOpen((x) => !x)} />
      {createPortal(
        <AnimatePresence>
          {open && at && (
            <div className="chat-bell-anchor" style={{ left: at.left, top: at.top }}>
              <BellPanel
                notices={n.listed ? n.list.slice(0, 40) : undefined}
                waiting={n.listed ? undefined : waiting.map((w) => ({ ...w, title: titleOf(chat.channels[w.channel], chat.me?.id) }))}
                seen={n.seen}
                channels={chat.channels}
                busy={n.busy && !n.list.length}
                count={count}
                told={tell.on && tell.permission === "granted"}
                onClose={close}
                onOpen={(x) => {
                  close();
                  openNotice(x);
                }}
                onWaiting={(w) => {
                  close();
                  setListFolded(false);
                  goChat("chat", restOf({ channel: w.channel }));
                }}
                onAll={n.listed ? seeAllNotices : undefined}
                onSeeAll={
                  n.listed
                    ? () => {
                        close();
                        setListFolded(false);
                        goChat("chat", restOf({ view: "mentions" }));
                      }
                    : undefined
                }
                onSettings={() => {
                  close();
                  goSettings("general");
                }}
              />
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

const titleOf = (c: ChatChannelView | undefined, me?: string) => (c ? (c.kind === "open" || c.kind === "private" ? `#${c.name}` : chatTitle(c, me)) : "A conversation");

export function BellButton({ count, open, onToggle, ref }: { count: number; open?: boolean; onToggle?(): void; ref?: React.Ref<HTMLButtonElement> }) {
  const tip = count ? `Notifications: ${count} you haven't seen` : "Notifications: mentions of you and direct messages";
  return (
    <button
      ref={ref}
      type="button"
      className={`top-btn top-bell${open ? " is-on" : ""}`}
      onClick={onToggle}
      aria-label={count ? `Notifications, ${count} unseen` : "Notifications"}
      aria-haspopup="dialog"
      aria-expanded={!!open}
      data-tip={open ? undefined : tip}
      data-pop-anchor
      data-top-bell
    >
      <IconBell />
      {count > 0 && (
        <span className="pane-badge" data-bell-badge={count} aria-hidden>
          {countWords(count)}
        </span>
      )}
    </button>
  );
}

export interface BellPanelProps {
  /** the list of what was said to me; absent on a server that keeps none (then `waiting`) */
  notices?: Notice[];
  waiting?: Array<WaitingRow & { title: string }>;
  seen: Seen;
  channels?: Record<string, Pick<ChatChannelView, "me"> | undefined>;
  busy?: boolean;
  count: number;
  /** this device shows desktop notifications (else the foot says where to turn them on) */
  told?: boolean;
  now?: number;
  onClose(): void;
  onOpen?(n: Notice): void;
  onWaiting?(w: WaitingRow): void;
  onAll?(): void;
  onSeeAll?(): void;
  onSettings?(): void;
  /** drawn in place with no outside-press or Esc of its own (the design page) */
  inPlace?: boolean;
}

export function BellPanel(p: BellPanelProps) {
  const rows = p.notices ?? [];
  const waiting = p.waiting ?? [];
  const empty = !rows.length && !waiting.length;
  const body = (
      <div className="chat-bell" data-bell-panel>
        <header className="chat-bell-head">
          <h2>Notifications</h2>
          {p.onAll && p.count > 0 && (
            <button type="button" className="chat-link-btn" onClick={p.onAll} data-bell-all>
              Mark all read
            </button>
          )}
        </header>
        <div className="chat-bell-list">
          {rows.map((n) => (
            <NoticeRow key={n.id} n={n} unseen={!isSeen(n, p.seen, p.channels)} now={p.now} onOpen={p.onOpen} />
          ))}
          {waiting.map((w) => (
            <button key={w.channel} type="button" className="chat-bell-row is-unseen" onClick={() => p.onWaiting?.(w)} data-bell-waiting={w.channel}>
              <span className="chat-bell-mark" aria-hidden>
                {w.kind === "private" ? <IconLock /> : w.kind === "open" ? <IconHash /> : <span>{w.title.slice(0, 1).toUpperCase()}</span>}
              </span>
              <span className="chat-bell-main">
                <span className="chat-bell-who">
                  <b>{w.title}</b>
                  <span>{w.why === "mention" ? `${w.n} ${w.n === 1 ? "mention" : "mentions"} of you` : `${w.n} new`}</span>
                </span>
                {w.text && <span className="chat-bell-text">{w.text}</span>}
              </span>
              <time className="chat-bell-when">{ago(w.at, p.now)}</time>
            </button>
          ))}
          {empty && (
            <p className="chat-bell-empty" role="status">
              {p.busy ? "Looking…" : "Nothing new for you. When someone mentions you or writes to you directly, it's listed here."}
            </p>
          )}
        </div>
        {(p.onSeeAll || (!p.told && p.onSettings)) && (
          <footer className="chat-bell-foot">
            {p.onSeeAll && (
              <button type="button" className="chat-link-btn" onClick={p.onSeeAll} data-bell-see-all>
                Recent mentions in ChatForm
              </button>
            )}
            {!p.told && p.onSettings && (
              <button type="button" className="chat-link-btn is-quiet" onClick={p.onSettings} data-bell-settings>
                Tell me on this device…
              </button>
            )}
          </footer>
        )}
      </div>
  );
  if (p.inPlace) return <div className="chat-pop chat-bell-pop f-glass is-in-place" role="group" aria-label="Notifications">{body}</div>;
  return (
    <Pop onClose={p.onClose} className="chat-bell-pop f-glass" label="Notifications">
      {body}
    </Pop>
  );
}

/** one thing said to me: who, where (and why), a line of it, when; a dot while I haven't seen it */
export function NoticeRow({ n, unseen, now, onOpen, lead }: { n: Notice; unseen: boolean; now?: number; onOpen?(n: Notice): void; lead?: ReactNode }) {
  const author: ChatParty = n.message.author;
  const why = whyWords(n.why);
  return (
    <button type="button" className={`chat-bell-row${unseen ? " is-unseen" : ""}`} onClick={() => onOpen?.(n)} data-bell-row={n.id} data-unseen={unseen || undefined}>
      {lead ?? <PartyAvatar party={author} size={28} />}
      <span className="chat-bell-main">
        <span className="chat-bell-who">
          <b>{author.name}</b>
          <span>{[n.channel.kind === "dm" ? "" : whereWords(n.channel), why].filter(Boolean).join(" · ") || "Direct message"}</span>
        </span>
        <span className="chat-bell-text">{firstLine(n.message) || "…"}</span>
      </span>
      <time className="chat-bell-when" dateTime={new Date(n.message.createdAt).toISOString()}>
        {ago(n.message.createdAt, now)}
      </time>
      {unseen && <span className="chat-bell-dot" aria-label="Not seen yet" />}
    </button>
  );
}
