/**
 * The side menu's **Chats** (2026-11-20): the ChatForm conversations this person keeps there, in their
 * own order, as rows in the grids' language (34 tall, full width, text from the selector's left edge):
 * the channel's mark (# or a lock, a person's face, an agent's ✦, a service's monogram), its name (in ink
 * at 700 when unread), a count pill (the accent for mentions of you and unread direct messages; quiet for
 * other unread where you follow everything) and a dot while a huddle is live. Hover: a ✕ to take it out
 * of the side menu (it only leaves here: nothing is left or archived). Pull a row up or down to reorder.
 * At the foot, *Browse all in ChatForm*. Empty: a sentence and a button that opens ChatForm.
 *
 * Pressing a row opens the conversation full width: ChatForm's own list folds away (chat/pins.ts).
 * While a conversation is carried out of ChatForm (chat/carryChat.ts) the list rings to say it can take it.
 *
 * `SideChatsView` is the presentational part (`#/design` draws it from fixtures); `SideChats` feeds it from
 * the chat store and the pins.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { chatTitle, type ChatChannelView } from "@foundation/protocol";
import { goChat, type Place } from "../lib/place";
import { channelMark } from "./Sidebar";
import { isDirect, parseRest } from "./logic";
import { useChat } from "./model";
import { getPins, movePin, openFromSideMenu, savePins, setListFolded, takeOutOfSideMenu, usePins } from "./pins";
import { dropIndex, reconcilePins } from "./sideMenuLogic";
import { PULL } from "./carryChat";
import { IconClose, IconPlus } from "./Icons";
import "./sidechats.css";

export interface SideChatsViewProps {
  channels: ChatChannelView[];
  meId?: string;
  online: string[];
  /** the conversation that's open (its row is current) */
  current: string | null;
  /** something is held over the side menu: the list rings */
  ringed?: boolean;
  /** still fetching the pins or the list */
  waiting?: boolean;
  onOpen(id: string): void;
  onUnpin(id: string): void;
  onMove(id: string, before: number): void;
  onBrowse(): void;
}

export function SideChatsView(p: SideChatsViewProps) {
  const list = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; at: number } | null>(null);

  const pull = (e: React.PointerEvent<HTMLElement>, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".chat-pin-off")) return;
    const start = e.clientY;
    const startX = e.clientX;
    let on = false;
    const swallow = (c: MouseEvent) => {
      c.preventDefault();
      c.stopPropagation();
    };
    const rows = () => [...(list.current?.querySelectorAll<HTMLElement>("[data-chat-pin]") ?? [])].map((el) => el.getBoundingClientRect());
    const move = (ev: PointerEvent) => {
      if (!on && Math.hypot(ev.clientY - start, ev.clientX - startX) < PULL) return;
      if (!on) {
        on = true;
        window.addEventListener("click", swallow, true);
      }
      setDrag({ id, at: dropIndex(ev.clientY, rows()) });
    };
    const up = (ev: PointerEvent) => {
      stop();
      if (!on) return;
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      setDrag(null);
      p.onMove(id, dropIndex(ev.clientY, rows()));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const cancel = () => {
      stop();
      setDrag(null);
      window.removeEventListener("click", swallow, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  return (
    <div ref={list} className={`chat-pins${p.ringed ? " is-ringed" : ""}${drag ? " is-sorting" : ""}`} data-side-chats data-ringed={p.ringed ? "true" : undefined}>
      {p.channels.map((c, i) => (
        <SideChatRow key={c.id} c={c} meId={p.meId} online={p.online} current={p.current === c.id} dragging={drag?.id === c.id} gapBefore={!!drag && drag.at === i && drag.id !== c.id && p.channels[i - 1]?.id !== drag.id} onOpen={p.onOpen} onUnpin={p.onUnpin} onPull={pull} />
      ))}
      {drag && drag.at === p.channels.length && p.channels[p.channels.length - 1]?.id !== drag.id && <div className="chat-pin-gap is-end" aria-hidden />}
      {!p.channels.length && !p.waiting && (
        <div className="pane-empty is-create chat-pins-empty">
          <span>Drag a conversation here from ChatForm's list to keep it one press away.</span>
          <button type="button" className="f-pill" onClick={p.onBrowse} data-side-chats-open>
            Open ChatForm
          </button>
        </div>
      )}
      {p.channels.length > 0 && (
        <button type="button" className="pane-row chat-pins-browse" onClick={p.onBrowse} data-side-chats-browse>
          <span className="pane-glyph">
            <IconPlus />
          </span>
          <span className="pane-label">Browse all in ChatForm</span>
        </button>
      )}
    </div>
  );
}

function SideChatRow({ c, meId, online, current, dragging, gapBefore, onOpen, onUnpin, onPull }: { c: ChatChannelView; meId?: string; online: string[]; current: boolean; dragging: boolean; gapBefore: boolean; onOpen(id: string): void; onUnpin(id: string): void; onPull(e: React.PointerEvent<HTMLElement>, id: string): void }) {
  const title = chatTitle(c, meId);
  const muted = c.me?.notify === "none";
  const unread = c.unread > 0 && !muted;
  const direct = isDirect(c);
  const mentions = c.me?.mentions ?? 0;
  const n = direct ? c.unread : mentions;
  const quiet = !n && unread && !direct && c.me?.notify === "all";
  return (
    <>
      {gapBefore && <div className="chat-pin-gap" aria-hidden />}
      <div className={`space-row chat-pin${current ? " is-current" : ""}${unread ? " is-unread" : ""}${muted ? " is-muted" : ""}${c.kind === "agent" ? " is-agent" : ""}${dragging ? " is-dragging" : ""}`} data-chat-pin={c.id} data-chat-pin-name={title} data-unread={unread ? c.unread : undefined}>
        <button type="button" className="pane-row space-open" onClick={() => onOpen(c.id)} onPointerDown={(e) => onPull(e, c.id)} aria-current={current ? "page" : undefined} data-tip={`${title} · pull to reorder`}>
          <span className="pane-glyph chat-pin-mark">{channelMark(c, meId, online, 18)}</span>
          <span className="pane-label" title={title}>{title}</span>
          {c.huddle && <span className="chat-pin-huddle" aria-label="a huddle is live" data-tip="A huddle is live" />}
          {n > 0 && !muted ? (
            <span className="chat-count is-accent" data-pin-count={n} data-tip={direct ? `${n} unread` : `${n} ${n === 1 ? "mention" : "mentions"} of you`}>
              {n > 99 ? "99+" : n}
            </span>
          ) : quiet ? (
            <span className="chat-count" data-pin-count={c.unread} data-tip={`${c.unread} unread`}>
              {c.unread > 99 ? "99+" : c.unread}
            </span>
          ) : null}
        </button>
        <button type="button" className="space-move chat-pin-off" onClick={() => onUnpin(c.id)} aria-label={`Take ${title} out of the side menu`} data-tip="Take out of the side menu (nothing is left)">
          <IconClose size={12} />
        </button>
      </div>
    </>
  );
}

/** the conversation a place has open, when it's ChatForm's Chat tab on one */
export function chatOpenIn(place: Place): string | null {
  if (place.kind !== "chat" || place.tab !== "chat") return null;
  const r = parseRest(place.rest);
  return r.view ? null : r.channel;
}

export function SideChats({ place }: { place: Place }) {
  const s = useChat();
  const pins = usePins();
  const sees = (id: string) => !!s.channels[id] && !s.channels[id].archivedAt;
  const shown = useMemo(() => reconcilePins(pins.ids, sees), [pins.ids, s.channels]); // eslint-disable-line react-hooks/exhaustive-deps
  const channels = useMemo(() => shown.map((id) => s.channels[id]), [shown, s.channels]);

  // a pin to a conversation this person can no longer see goes, quietly (only once the list is really here)
  const ready = pins.loaded && s.loaded && (s.status === "live" || s.status === "connecting" || s.status === "offline") && Object.keys(s.channels).length > 0;
  useEffect(() => {
    if (ready && shown.length !== pins.ids.length) savePins(shown);
  }, [ready, shown, pins.ids.length]);

  return (
    <SideChatsView
      channels={channels}
      meId={s.me?.id}
      online={s.online}
      current={chatOpenIn(place)}
      ringed={!!pins.held}
      waiting={!pins.loaded}
      onOpen={openFromSideMenu}
      onUnpin={takeOutOfSideMenu}
      onMove={(id, before) => {
        // the rows drawn are the pins this person can see: land before the same row in the whole list
        const target = channels[before]?.id;
        movePin(id, target ? getPins().ids.indexOf(target) : getPins().ids.length);
      }}
      onBrowse={() => {
        setListFolded(false);
        goChat("chat");
      }}
    />
  );
}
