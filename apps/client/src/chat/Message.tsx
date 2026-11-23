/**
 * One message in a timeline or a thread. Presentational: it draws what it's given and says what was
 * pressed through `actions` (the place wires them to the store; the design page passes none).
 *
 *  - The author leads a run: a person's face and name; an agent's character in a violet ring, its name in
 *    agent ink, the **Agent** mark and *for Ada*; a ghost's monogram and *via WhatsApp*. A message that
 *    continues a run shows only its words, its time waiting in the gutter until the pointer comes.
 *  - Words are markdown (`.note-rendered`), mentions marked (mine louder), *edited* after them.
 *  - Files and link previews under the words; reactions as pills (who, on roll-over); a thread's summary.
 *  - Hover bar: three quick reactions, react, reply in thread, pin, copy link, and ⋯ (mark unread from
 *    here; edit and remove for my own). Remove asks in place.
 *  - `system`, `huddle`, `link` and `draft` messages are drawn as what they are.
 */

import { memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ChatFile, ChatHuddleState, ChatMessage } from "@foundation/protocol";
import { renderMarkdown } from "../utils/markdown";
import { PartyAvatar, SERVICE_NAME } from "./Avatar";
import { ChatFiles, LinkPreviews } from "./Files";
import { EmojiPicker } from "./EmojiPicker";
import { emojiName } from "./emoji";
import { markMentions, type PendingMessage } from "./logic";
import { HuddleCard } from "./HuddleCard";
import { AgentFigure } from "./AgentFigure";
import { getChat } from "./model";
import { DraftBar } from "./tabs/DraftBar";
import { IconEdit, IconLink, IconMore, IconPin, IconReact, IconThread, IconTrash, IconUnread } from "./Icons";

export interface MessageMe {
  id: string;
  name: string;
  handle: string;
}

export interface MessageActions {
  react(m: ChatMessage, emoji: string, on: boolean): void;
  reply(m: ChatMessage): void;
  pin(m: ChatMessage, on: boolean): void;
  copyLink(m: ChatMessage): void;
  markUnread(m: ChatMessage): void;
  edit(m: ChatMessage): void;
  saveEdit(m: ChatMessage, text: string): void;
  cancelEdit(): void;
  remove(m: ChatMessage): void;
  openPlace?(m: ChatMessage): void;
  joinHuddle?(huddleId: string): void;
}

export interface MessageProps {
  message: ChatMessage;
  continued?: boolean;
  me?: MessageMe;
  /** drawn in a thread pane: no thread summary, no reply button */
  inThread?: boolean;
  flash?: boolean;
  editing?: boolean;
  actions?: MessageActions;
  srcOf?: (f: ChatFile) => string;
  liveHuddle?: ChatHuddleState | null;
}

export const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fullTime = (at: number) => new Date(at).toLocaleString([], { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });

export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
}

export const MessageView = memo(function MessageView({ message: m, continued, me, inThread, flash, editing, actions, srcOf, liveHuddle }: MessageProps) {
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const mine = !!me && m.author.id === me.id && m.author.kind === "person";
  const removed = !!m.deletedAt;

  if (m.type === "system") {
    return (
      <div className="chat-system" data-message={m.id} data-seq={m.seq}>
        <span>{m.text}</span>
        <time dateTime={new Date(m.createdAt).toISOString()} title={fullTime(m.createdAt)}>
          {timeOf(m.createdAt)}
        </time>
      </div>
    );
  }

  const hover = !removed && actions && !editing;
  return (
    <div
      className={`chat-msg${continued ? " is-continued" : ""}${flash ? " is-flash" : ""}${m.author.kind === "agent" ? " is-agent" : ""}${m.author.kind === "ghost" ? " is-ghost" : ""}${editing ? " is-editing" : ""}${m.pinned ? " is-pinned" : ""}${menu || picker || confirm ? " is-held" : ""}`}
      data-message={m.id}
      data-seq={m.seq}
      data-author={m.author.name}
    >
      <div className="chat-msg-gutter">
        {continued ? (
          <time className="chat-msg-gutter-time" dateTime={new Date(m.createdAt).toISOString()} title={fullTime(m.createdAt)}>
            {timeOf(m.createdAt)}
          </time>
        ) : (
          <PartyAvatar party={m.author} size={m.author.kind === "agent" ? 36 : 32} />
        )}
      </div>
      <div className="chat-msg-main">
        {!continued && <Author m={m} />}
        {m.pinned && !continued && <span className="chat-pinned-mark">Pinned</span>}
        {removed ? (
          <p className="chat-removed">This message was removed.</p>
        ) : editing && actions ? (
          <EditBox text={m.text} onSave={(t) => actions.saveEdit(m, t)} onCancel={actions.cancelEdit} />
        ) : (
          <Body m={m} me={me} srcOf={srcOf} liveHuddle={liveHuddle} actions={actions} />
        )}
        {!removed && m.reactions.length > 0 && (
          <div className="chat-reactions">
            {m.reactions.map((r) => {
              const on = !!me && r.by.includes(me.name);
              return (
                <button
                  key={r.emoji}
                  type="button"
                  className={`chat-reaction${on ? " is-mine" : ""}`}
                  onClick={() => actions?.react(m, r.emoji, !on)}
                  data-tip={`${listNames(r.by, me?.name)} reacted with ${emojiName(r.emoji)}`}
                  aria-label={`${emojiName(r.emoji)}, ${r.by.length} ${r.by.length === 1 ? "reaction" : "reactions"}`}
                  aria-pressed={on}
                >
                  <span className="chat-reaction-emoji" aria-hidden>{r.emoji}</span>
                  <span className="chat-reaction-n">{r.by.length}</span>
                </button>
              );
            })}
            {actions && (
              <button type="button" className="chat-reaction is-add" onClick={() => setPicker(true)} data-tip="Add a reaction" aria-label="Add a reaction">
                <IconReact />
              </button>
            )}
          </div>
        )}
        {!inThread && m.replyCount > 0 && (
          <button type="button" className="chat-thread-summary" onClick={() => actions?.reply(m)} data-thread-summary={m.id}>
            <span className="chat-thread-faces" aria-hidden>
              {(m.repliers ?? []).slice(-3).map((n) =>
                // an agent among the repliers stands on its line, as everywhere (AgentFigure.tsx)
                getChat().agents.some((a) => a.name === n) ? (
                  <AgentFigure key={n} name={n} size={20} className="chat-thread-figure" />
                ) : (
                  <span key={n} className="chat-thread-face">
                    {n.slice(0, 1).toUpperCase()}
                  </span>
                ),
              )}
            </span>
            <span className="chat-thread-count">
              {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
            </span>
            {m.lastReplyAt && <span className="chat-thread-last">Last reply {ago(m.lastReplyAt)}</span>}
            <span className="chat-thread-view">View thread</span>
          </button>
        )}
        {confirm && actions && (
          <div
            className="chat-confirm"
            role="alertdialog"
            aria-label="Remove message"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setConfirm(false);
              }
            }}
          >
            <span>Remove this message for everyone? Attached files stay in the archive.</span>
            <button
              type="button"
              className="chat-confirm-yes"
              onClick={() => {
                setConfirm(false);
                actions.remove(m);
              }}
            >
              Remove message
            </button>
            <button type="button" className="chat-confirm-no" onClick={() => setConfirm(false)} autoFocus>
              Keep
            </button>
          </div>
        )}
      </div>
      {hover && (
        <div className="chat-hoverbar" role="toolbar" aria-label="Message actions">
          {["👍", "✅", "👀"].map((e) => (
            <button
              key={e}
              type="button"
              className="chat-hoverbar-quick"
              onClick={() => actions.react(m, e, !(me && m.reactions.find((r) => r.emoji === e)?.by.includes(me.name)))}
              data-tip={`React ${emojiName(e)}`}
              aria-label={`React with ${emojiName(e)}`}
            >
              {e}
            </button>
          ))}
          <span className="chat-hoverbar-rule" aria-hidden />
          <button type="button" onClick={() => setPicker((p) => !p)} data-tip="Add a reaction" aria-label="Add a reaction" aria-expanded={picker}>
            <IconReact />
          </button>
          {!inThread && (
            <button type="button" onClick={() => actions.reply(m)} data-tip="Reply in thread" aria-label="Reply in thread">
              <IconThread />
            </button>
          )}
          <button type="button" className={m.pinned ? "is-on" : ""} onClick={() => actions.pin(m, !m.pinned)} data-tip={m.pinned ? "Unpin" : "Pin to the channel"} aria-label={m.pinned ? "Unpin" : "Pin"} aria-pressed={m.pinned}>
            <IconPin />
          </button>
          <button type="button" onClick={() => actions.copyLink(m)} data-tip="Copy a link to this message" aria-label="Copy link">
            <IconLink />
          </button>
          <button type="button" className={menu ? "is-on" : ""} onClick={() => setMenu((x) => !x)} data-tip="More" aria-label="More" aria-haspopup="menu" aria-expanded={menu}>
            <IconMore />
          </button>
          <AnimatePresence>
            {menu && (
              <MoreMenu
                onClose={() => setMenu(false)}
                items={[
                  { label: "Mark unread from here", icon: <IconUnread />, run: () => actions.markUnread(m) },
                  ...(mine && m.type === "text" ? [{ label: "Edit", icon: <IconEdit />, run: () => actions.edit(m) }] : []),
                  ...(mine ? [{ label: "Remove…", icon: <IconTrash />, run: () => setConfirm(true), bad: true }] : []),
                ]}
              />
            )}
          </AnimatePresence>
        </div>
      )}
      {picker && actions && (
        <EmojiPicker
          className="is-in-message"
          onClose={() => setPicker(false)}
          onPick={(e) => {
            setPicker(false);
            actions.react(m, e, !(me && m.reactions.find((r) => r.emoji === e)?.by.includes(me.name)));
          }}
        />
      )}
    </div>
  );
});

function listNames(names: string[], me?: string) {
  const shown = names.map((n) => (n === me ? "You" : n));
  if (shown.length <= 3) return shown.join(", ").replace(/, ([^,]*)$/, " and $1");
  return `${shown.slice(0, 3).join(", ")} and ${shown.length - 3} more`;
}

function Author({ m }: { m: ChatMessage }) {
  const a = m.author;
  return (
    <div className="chat-msg-head">
      <span className="chat-msg-name">{a.name}</span>
      {a.kind === "agent" && (
        <>
          <span className="chat-agent-mark" data-tip={`${a.name} is an agent${a.via ? ` (${a.via})` : ""}`}>
            Agent
          </span>
          {a.forName && <span className="chat-msg-for">for {a.forName}</span>}
        </>
      )}
      {a.kind === "ghost" && <span className="chat-msg-for">{[a.service ? `via ${SERVICE_NAME[a.service]}` : "", a.handle].filter(Boolean).join(" · ")}</span>}
      <time className="chat-msg-time" dateTime={new Date(m.createdAt).toISOString()} title={fullTime(m.createdAt)}>
        {timeOf(m.createdAt)}
      </time>
    </div>
  );
}

function Body({ m, me, srcOf, liveHuddle, actions }: { m: ChatMessage; me?: MessageMe; srcOf?: (f: ChatFile) => string; liveHuddle?: ChatHuddleState | null; actions?: MessageActions }) {
  return (
    <>
      {m.type === "huddle" && <HuddleCard message={m} live={liveHuddle} onJoin={actions?.joinHuddle} />}
      {m.type === "link" && m.place && (
        <button type="button" className="chat-place" onClick={() => actions?.openPlace?.(m)} disabled={!actions?.openPlace}>
          <span className="chat-place-glyph" aria-hidden>
            ▦
          </span>
          <span className="chat-place-text">
            <span className="chat-place-label">{m.place.label}</span>
            <span className="chat-place-where">{m.place.boardName ?? m.place.board}</span>
          </span>
        </button>
      )}
      {m.text && <Words text={m.text} mine={me?.handle} edited={!!m.editedAt} />}
      <ChatFiles files={m.files} srcOf={srcOf} />
      <LinkPreviews previews={m.previews} />
      {m.outbound && <DraftBar message={m} live={!!actions} />}
    </>
  );
}

/** markdown, with mentions marked; links open beside Foundation */
export function Words({ text, mine, edited }: { text: string; mine?: string; edited?: boolean }) {
  let html = markMentions(renderMarkdown(text), mine);
  // edited: said at the end of the last line, not on a line of its own
  if (edited) html = /<\/p>\s*$/.test(html) ? html.replace(/<\/p>\s*$/, ' <span class="chat-edited">(edited)</span></p>') : `${html}<span class="chat-edited">(edited)</span>`;
  return (
    <div className="chat-text note-rendered">
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function EditBox({ text, onSave, onCancel }: { text: string; onSave(t: string): void; onCancel(): void }) {
  const [v, setV] = useState(text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(240, t.scrollHeight)}px`;
  }, [v]);
  return (
    <div className="chat-edit">
      <textarea
        ref={ref}
        value={v}
        aria-label="Edit message"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (v.trim() && v !== text) onSave(v);
            else onCancel();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="chat-edit-foot">
        <span>Enter saves · Esc cancels</span>
        <button type="button" className="f-pill" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="f-pill is-accent" onClick={() => (v.trim() && v !== text ? onSave(v) : onCancel())}>
          Save
        </button>
      </div>
    </div>
  );
}

function MoreMenu({ items, onClose }: { items: Array<{ label: string; icon: React.ReactNode; run(): void; bad?: boolean }>; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".chat-hoverbar")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <motion.div ref={box} className="chat-menu is-under-bar" role="menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={{ type: "spring", stiffness: 520, damping: 38 }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={`chat-menu-item${it.bad ? " is-bad" : ""}`}
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </motion.div>
  );
}

/** a message this window is still sending, or couldn't (with Retry) */
export function PendingView({ p, continued, me, onRetry, onDiscard }: { p: PendingMessage; continued?: boolean; me: MessageMe & { color?: string }; onRetry?(): void; onDiscard?(): void }) {
  return (
    <div className={`chat-msg is-pending${p.state === "failed" ? " is-failed" : ""}${continued ? " is-continued" : ""}`} data-pending={p.requestId}>
      <div className="chat-msg-gutter">{!continued && <PartyAvatar party={{ kind: "person", id: me.id, name: me.name, color: me.color }} size={32} />}</div>
      <div className="chat-msg-main">
        {!continued && (
          <div className="chat-msg-head">
            <span className="chat-msg-name">{me.name}</span>
            <time className="chat-msg-time">{timeOf(p.createdAt)}</time>
          </div>
        )}
        {p.text && <Words text={p.text} mine={me.handle} />}
        {p.files.length > 0 && <ChatFiles files={p.files} />}
        <div className="chat-pending-state" role={p.state === "failed" ? "alert" : "status"}>
          {p.state === "sending" ? (
            "Sending…"
          ) : (
            <>
              <span className="chat-pending-bad">Not sent{p.error ? `: ${p.error}` : ""}</span>
              {onRetry && (
                <button type="button" className="chat-link-btn" onClick={onRetry}>
                  Retry
                </button>
              )}
              {onDiscard && (
                <button type="button" className="chat-link-btn is-quiet" onClick={onDiscard}>
                  Discard
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
