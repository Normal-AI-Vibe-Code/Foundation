/**
 * The sidebar, on the floor: Unreads (when there are any), Threads, Starred, Channels and Direct messages,
 * each a section that folds (kept on this device). A row is its mark (# or a lock; a face for a direct
 * message, with a presence dot; an agent's in violet), its name, and how much is waiting: unread names
 * are bold; a mention count is an accent pill, other unread a quiet one; a muted channel is dim.
 * `+` on Channels makes or browses one; on Direct messages it starts one.
 */

import { useState } from "react";
import { chatTitle, type ChatChannelView, type ChatParty } from "@foundation/protocol";
import { PartyAvatar } from "./Avatar";
import { isDirect } from "./logic";
import { IconChevron, IconHash, IconLock, IconPlus, IconThread } from "./Icons";
import { carryHandlers } from "./carryChat";
import { isKept, keepInSideMenu, takeOutOfSideMenu } from "./pins";
import { openContextMenu } from "../components/ContextMenu";
import { setUi } from "../state/ui";
import { gridsOf, useWhereabouts } from "../lib/whereabouts";
import { useGrids } from "../lib/grids";

export interface SidebarProps {
  channels: ChatChannelView[];
  meId?: string;
  online: string[];
  current: string | null;
  view?: "threads" | "browse" | "search" | null;
  onOpen(id: string): void;
  onView(v: "threads" | "browse"): void;
  /** the server has no list of my threads (a chat server of its own): the row is left out */
  noThreads?: boolean;
  onNew(kind: "channel" | "direct"): void;
  /** channels someone is typing in */
  typing?: Set<string>;
  /** rows can be pulled out into the side menu, and kept there from their menu (the live place; not the design page) */
  carry?: boolean;
}

const FOLD = "chatform-folds";
function readFolds(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(FOLD) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function Sidebar(p: SidebarProps) {
  const [folds, setFolds] = useState(readFolds);
  const fold = (k: string) =>
    setFolds((f) => {
      const next = { ...f, [k]: !f[k] };
      try {
        localStorage.setItem(FOLD, JSON.stringify(next));
      } catch { /* private window */ }
      return next;
    });

  const live = p.channels.filter((c) => c.me && !c.archivedAt);
  const byName = (a: ChatChannelView, b: ChatChannelView) => chatTitle(a, p.meId).localeCompare(chatTitle(b, p.meId));
  const byRecent = (a: ChatChannelView, b: ChatChannelView) => b.lastPostAt - a.lastPostAt;
  const unreads = live.filter((c) => c.unread > 0 || (c.me?.mentions ?? 0) > 0).filter((c) => c.me?.notify !== "none").sort(byRecent);
  const starred = live.filter((c) => c.me?.starred).sort(byName);
  const channels = live.filter((c) => !c.me?.starred && (c.kind === "open" || c.kind === "private")).sort(byName);
  const direct = live.filter((c) => !c.me?.starred && isDirect(c)).sort(byRecent);

  const row = (c: ChatChannelView, where: string) => <Row key={`${where}-${c.id}`} c={c} meId={p.meId} online={p.online} current={p.current === c.id && !p.view} onOpen={p.onOpen} typing={p.typing?.has(c.id)} carry={p.carry} />;

  return (
    <nav className="chat-sidebar" aria-label="Conversations">
      <div className="chat-side-scroll">
        {!p.noThreads && (
          <button type="button" className={`chat-side-row is-nav${p.view === "threads" ? " is-current" : ""}`} onClick={() => p.onView("threads")} data-side-threads>
            <span className="chat-side-mark">
              <IconThread />
            </span>
            <span className="chat-side-name">Threads</span>
          </button>
        )}
        {unreads.length > 0 && (
          <Section id="unreads" name="Unreads" folded={!!folds.unreads} onFold={fold} count={unreads.length}>
            {unreads.map((c) => row(c, "u"))}
          </Section>
        )}
        {starred.length > 0 && (
          <Section id="starred" name="Starred" folded={!!folds.starred} onFold={fold}>
            {starred.map((c) => row(c, "s"))}
          </Section>
        )}
        <Section id="channels" name="Channels" folded={!!folds.channels} onFold={fold} onAdd={() => p.onNew("channel")} addTip="New channel">
          {channels.map((c) => row(c, "c"))}
          <button type="button" className={`chat-side-row is-quiet${p.view === "browse" ? " is-current" : ""}`} onClick={() => p.onView("browse")} data-side-browse>
            <span className="chat-side-mark">
              <IconPlus />
            </span>
            <span className="chat-side-name">Browse channels</span>
          </button>
        </Section>
        <Section id="direct" name="Direct messages" folded={!!folds.direct} onFold={fold} onAdd={() => p.onNew("direct")} addTip="New message">
          {direct.map((c) => row(c, "d"))}
          {!direct.length && <p className="chat-side-empty">Start one with ＋: a person, or a few people.</p>}
        </Section>
      </div>
    </nav>
  );
}

function Section({ id, name, folded, onFold, onAdd, addTip, count, children }: { id: string; name: string; folded: boolean; onFold(id: string): void; onAdd?(): void; addTip?: string; count?: number; children: React.ReactNode }) {
  return (
    <section className={`chat-side-section${folded ? " is-folded" : ""}`} data-side-section={id}>
      <div className="chat-side-head">
        <button type="button" className="chat-side-fold" onClick={() => onFold(id)} aria-expanded={!folded}>
          <IconChevron open={!folded} />
          <span>{name}</span>
          {folded && count ? <span className="chat-side-headcount">{count}</span> : null}
        </button>
        {onAdd && (
          <button type="button" className="chat-side-add" onClick={onAdd} data-tip={addTip} aria-label={addTip}>
            <IconPlus />
          </button>
        )}
      </div>
      {!folded && <div className="chat-side-rows">{children}</div>}
    </section>
  );
}

export function channelMark(c: Pick<ChatChannelView, "kind" | "members" | "agent" | "origin">, meId?: string, online?: string[], size = 18) {
  if (c.kind === "private") return <IconLock size={14} />;
  if (c.kind === "open") return <IconHash size={14} />;
  const others = (c.members ?? []).filter((m) => m.id !== meId);
  const who: ChatParty | undefined = c.kind === "agent" && c.agent ? { kind: "agent", id: c.agent.name, name: c.agent.name } : others[0];
  if (c.kind === "group") return <span className="chat-side-count-mark">{Math.min(9, others.length + 1)}</span>;
  if (!who) return <IconHash size={14} />;
  return <PartyAvatar party={who} size={size} online={c.kind === "dm" && who.kind === "person" ? !!online?.includes(who.id) : undefined} />;
}

/**
 * Which grid the person in a direct message is on right now (2026-11-21): "in Form Industries", dim, after their
 * name; press the conversation as before. Nothing when they're on none (lib/whereabouts.ts).
 */
function PersonWhere({ c, meId }: { c: ChatChannelView; meId?: string }) {
  const all = useWhereabouts();
  const grids = useGrids();
  const other = (c.members ?? []).find((m) => m.id !== meId && m.kind === "person");
  if (!other) return null;
  const on = gridsOf(all, other.id);
  if (!on.length) return null;
  const names = on.map((id) => grids.find((g) => g.id === id)?.name ?? "a grid");
  const label = names.length > 1 ? `in ${names[0]} +${names.length - 1}` : `in ${names[0]}`;
  return (
    <span className="chat-side-where" data-person-where={other.id} data-tip={`${other.name} is on ${names.join(", ")}`}>
      {label}
    </span>
  );
}

/** what a conversation is, in a word (the slip in the hand says it) */
export const kindWord = (c: Pick<ChatChannelView, "kind">) => (c.kind === "open" || c.kind === "private" ? "channel" : c.kind === "dm" ? "direct message" : c.kind === "group" ? "group" : c.kind === "agent" ? "agent" : "conversation");

/**
 * `carry`: the row can be pulled out into the side menu (chat/carryChat.ts) and its right-click (or the
 * menu key, Shift+F10) menu keeps it there or takes it out (2026-11-20).
 */
export function Row({ c, meId, online, current, onOpen, typing, carry }: { c: ChatChannelView; meId?: string; online: string[]; current: boolean; onOpen(id: string): void; typing?: boolean; carry?: boolean }) {
  const mentions = c.me?.mentions ?? 0;
  const muted = c.me?.notify === "none";
  const unread = c.unread > 0 && !muted;
  const direct = isDirect(c);
  const n = direct ? c.unread : mentions;
  const title = chatTitle(c, meId);
  const hand = carry ? carryHandlers(() => ({ id: c.id, title: c.kind === "open" || c.kind === "private" ? `#${title}` : title, kind: kindWord(c) })) : null;
  return (
    <button
      type="button"
      className={`chat-side-row${current ? " is-current" : ""}${unread ? " is-unread" : ""}${muted ? " is-muted" : ""}${c.kind === "agent" ? " is-agent" : ""}`}
      onClick={() => onOpen(c.id)}
      onPointerDown={hand?.onPointerDown}
      onContextMenu={
        carry
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 24, y: r.bottom };
              openContextMenu(at.x, at.y, [isKept(c.id) ? { label: "Take out of the side menu", action: () => takeOutOfSideMenu(c.id) } : { label: "Keep in the side menu", action: () => (keepInSideMenu(c.id), setUi({ spacesView: "chats", pane: true, paneView: "spaces" })) }]);
            }
          : undefined
      }
      data-channel-row={c.id}
      data-channel-name={title}
      aria-current={current ? "page" : undefined}
    >
      <span className="chat-side-mark">{channelMark(c, meId, online)}</span>
      <span className="chat-side-name" title={title}>{title}</span>
      {c.kind === "dm" && <PersonWhere c={c} meId={meId} />}
      {typing && !current && <span className="chat-side-typing" aria-label="typing" />}
      {n > 0 && !muted ? (
        <span className="chat-count is-accent" data-tip={direct ? `${n} unread` : `${n} ${n === 1 ? "mention" : "mentions"} of you`}>
          {n > 99 ? "99+" : n}
        </span>
      ) : unread && !direct && c.me?.notify === "all" ? (
        <span className="chat-count" data-tip={`${c.unread} unread`}>
          {c.unread > 99 ? "99+" : c.unread}
        </span>
      ) : null}
    </button>
  );
}
