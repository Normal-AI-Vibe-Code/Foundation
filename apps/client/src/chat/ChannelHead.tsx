/**
 * A channel's head, 52 tall over a hairline: its mark and name (16/600), the topic beside it in mist
 * (press to change it, Enter keeps it), then at the right: the people (a count; pressed, who's in it,
 * with add and remove), the pinned messages, the star, how loudly it tells me (all · mentions · none), and
 * ⋯ (export as JSON or Markdown, leave, archive — which asks first).
 */

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { chatTitle, type ChatChannelView, type ChatMessage, type ChatParty } from "@foundation/protocol";
import { channelMark } from "./Sidebar";
import { PartyAvatar } from "./Avatar";
import { Pop, PeoplePicker } from "./Pop";
import { timeOf } from "./Message";
import { IconBell, IconSideList, IconDownload, IconMore, IconPeople, IconPin, IconStar } from "./Icons";
import { isDirect } from "./logic";
import { ChannelHuddleButton, ChannelHuddleDock } from "./HuddleCard";

export interface ChannelHeadProps {
  channel: ChatChannelView;
  meId?: string;
  people: ChatParty[];
  online: string[];
  pinned?: ChatMessage[];
  canAdmin?: boolean;
  onTopic?(topic: string): void;
  onStar?(on: boolean): void;
  onNotify?(n: "all" | "mentions" | "none"): void;
  onMembers?(add: string[], remove: string[]): void;
  /** the members popover opened: the place may fetch who's in an open channel */
  onWantMembers?(): void;
  onJump?(m: ChatMessage): void;
  onExport?(f: "json" | "md"): void;
  onLeave?(): void;
  onArchive?(): void;
  onJoin?(): void;
  /** the server has no huddles or no pins (a chat server of its own): their buttons are left out */
  noHuddle?: boolean;
  noPins?: boolean;
  /** the channel list is folded away (opened from the side menu): a small control at the far left brings it back */
  onUnfold?(): void;
}

export function ChannelHead(p: ChannelHeadProps) {
  const c = p.channel;
  const [pop, setPop] = useState<"members" | "pins" | "more" | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [adding, setAdding] = useState<string[]>([]);
  const [archiving, setArchiving] = useState(false);
  const direct = isDirect(c);
  const toggle = (k: typeof pop) => setPop((x) => (x === k ? null : k));
  const notify = c.me?.notify ?? "all";
  const members = c.members ?? [];

  return (
    <>
    <header className="chat-head" data-channel-head={c.id}>
      {p.onUnfold && (
        <button className="chat-unfold" onClick={p.onUnfold} aria-label="Show the conversations" data-tip="Show the conversations" data-chat-unfold>
          <IconSideList />
        </button>
      )}
      <span className="chat-head-mark">{channelMark(c, p.meId, p.online, 22)}</span>
      <h2 className="chat-head-name">{chatTitle(c, p.meId)}</h2>
      {c.archivedAt && <span className="chat-head-tag">Archived</span>}
      {topic !== null ? (
        <input
          className="chat-head-topic-field"
          autoFocus
          value={topic}
          placeholder="What's this channel about right now"
          onChange={(e) => setTopic(e.target.value)}
          onBlur={() => {
            if (topic !== c.topic) p.onTopic?.(topic.trim());
            setTopic(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setTopic(null);
          }}
        />
      ) : (
        <button className={`chat-head-topic${c.topic ? "" : " is-empty"}`} onClick={() => p.onTopic && !c.archivedAt && setTopic(c.topic)} disabled={!p.onTopic || !!c.archivedAt} data-tip={p.onTopic ? "Change the topic" : undefined}>
          {c.topic || (p.onTopic ? "Add a topic" : "")}
        </button>
      )}
      <span className="chat-head-gap" />
      {!c.me && !c.archivedAt && p.onJoin && (
        <button className="f-pill is-accent" onClick={p.onJoin}>
          Join
        </button>
      )}
      {!p.noHuddle && <ChannelHuddleButton channel={c} />}
      <div className="chat-head-anchor">
        <button className={`chat-head-btn is-count${pop === "members" ? " is-on" : ""}`} data-pop-anchor onClick={() => (toggle("members"), p.onWantMembers?.())} data-tip="Who's in it" data-members-count={c.memberCount}>
          <IconPeople />
          <span>{c.memberCount}</span>
        </button>
        <AnimatePresence>
          {pop === "members" && (
            <Pop className="chat-members-pop" onClose={() => setPop(null)} label="People in this channel">
              <div className="chat-pop-head">
                {c.memberCount} {c.memberCount === 1 ? "person" : "people"}
              </div>
              <div className="chat-pop-list">
                {members.map((m) => (
                  <div key={`${m.kind}:${m.id}`} className="chat-member">
                    <PartyAvatar party={m} size={24} online={m.kind === "person" ? p.online.includes(m.id) : undefined} />
                    <span className="chat-member-name">
                      {m.name}
                      {m.id === p.meId && <span className="chat-member-you"> · you</span>}
                    </span>
                    {m.kind === "agent" && <span className="chat-agent-mark">Agent</span>}
                    {!direct && p.onMembers && m.id !== p.meId && m.kind === "person" && (
                      <button className="chat-link-btn is-quiet" onClick={() => p.onMembers!([], [m.id])}>
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                {!members.length && <p className="chat-pop-note">Anyone signed in can read an open channel; {c.memberCount} have joined.</p>}
              </div>
              {!direct && p.onMembers && !c.archivedAt && (
                <div className="chat-pop-add">
                  <PeoplePicker people={p.people} chosen={adding} onChange={setAdding} exclude={members.map((m) => m.id)} online={p.online} placeholder="Add people" />
                  <button
                    className="f-pill is-accent"
                    disabled={!adding.length}
                    onClick={() => {
                      p.onMembers!(adding, []);
                      setAdding([]);
                    }}
                  >
                    Add {adding.length > 1 ? `${adding.length} people` : ""}
                  </button>
                </div>
              )}
            </Pop>
          )}
        </AnimatePresence>
      </div>
      {!p.noPins && (
        <div className="chat-head-anchor">
          <button className={`chat-head-btn${pop === "pins" ? " is-on" : ""}`} data-pop-anchor onClick={() => toggle("pins")} data-tip="Pinned" aria-label="Pinned messages">
            <IconPin />
            {(c.pinned?.length ?? 0) > 0 && <span>{c.pinned!.length}</span>}
          </button>
          <AnimatePresence>
            {pop === "pins" && (
              <Pop className="chat-pins-pop" onClose={() => setPop(null)} label="Pinned messages">
                <div className="chat-pop-head">Pinned</div>
                <div className="chat-pop-list">
                  {(p.pinned ?? []).map((m) => (
                    <button
                      key={m.id}
                      className="chat-pin-row"
                      onClick={() => {
                        setPop(null);
                        p.onJump?.(m);
                      }}
                    >
                      <span className="chat-pin-who">
                        {m.author.name} · {timeOf(m.createdAt)}
                      </span>
                      <span className="chat-pin-text">{m.text || m.files.map((f) => f.name).join(", ") || "A message"}</span>
                    </button>
                  ))}
                  {!(p.pinned ?? []).length && <p className="chat-pop-note">Nothing's pinned. A message's pin keeps it here for everyone.</p>}
                </div>
              </Pop>
            )}
          </AnimatePresence>
        </div>      )}
      {c.me && p.onStar && (
        <button className={`chat-head-btn${c.me.starred ? " is-star" : ""}`} onClick={() => p.onStar?.(!c.me!.starred)} data-tip={c.me.starred ? "Unstar" : "Star: keep it at the top"} aria-pressed={c.me.starred} aria-label="Star">
          <IconStar on={c.me.starred} />
        </button>
      )}
      <div className="chat-head-anchor">
        <button className={`chat-head-btn${pop === "more" ? " is-on" : ""}`} data-pop-anchor onClick={() => toggle("more")} data-tip="Notifications, export, archive" aria-label="More">
          {notify === "none" ? <IconBell off /> : <IconMore />}
        </button>
        <AnimatePresence>
          {pop === "more" && (
            <Pop className="chat-more-pop" onClose={() => (setPop(null), setArchiving(false))} label="Channel settings">
              {c.me && p.onNotify && (
                <>
                  <div className="chat-pop-head">Tell me about</div>
                  <div className="chat-seg" role="radiogroup" aria-label="Notifications">
                    {(["all", "mentions", "none"] as const).map((n) => (
                      <button key={n} role="radio" aria-checked={notify === n} className={`chat-seg-btn${notify === n ? " is-on" : ""}`} onClick={() => p.onNotify?.(n)}>
                        {n === "all" ? "Everything" : n === "mentions" ? "Mentions" : "Nothing"}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {p.onExport && (
                <>
                  <div className="chat-pop-head">Take it out</div>
                  <button className="chat-menu-item" onClick={() => p.onExport?.("md")}>
                    <IconDownload />
                    Download as Markdown
                  </button>
                  <button className="chat-menu-item" onClick={() => p.onExport?.("json")}>
                    <IconDownload />
                    Download as JSON (everything)
                  </button>
                </>
              )}
              {p.onExport && ((c.me && !direct && p.onLeave) || (p.canAdmin && p.onArchive && !c.archivedAt)) ? <div className="chat-pop-rule" /> : null}
              {!p.onExport && !(c.me && p.onNotify) && !(c.me && !direct && p.onLeave) && !(p.canAdmin && p.onArchive && !c.archivedAt && !direct) && <p className="chat-pop-note">Nothing to change here on this chat server.</p>}
              {c.me && !direct && p.onLeave && (
                <button className="chat-menu-item" onClick={() => (setPop(null), p.onLeave!())}>
                  Leave the channel
                </button>
              )}
              {p.canAdmin && p.onArchive && !c.archivedAt && !direct &&
                (archiving ? (
                  <div className="chat-confirm is-in-pop" role="alertdialog">
                    <span>Archive #{c.name}? Nobody can post in it; everything said stays readable and downloadable.</span>
                    <button className="chat-confirm-yes" onClick={() => (setPop(null), setArchiving(false), p.onArchive!())}>
                      Archive
                    </button>
                    <button className="chat-confirm-no" onClick={() => setArchiving(false)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <button className="chat-menu-item is-bad" onClick={() => setArchiving(true)}>
                    Archive the channel…
                  </button>
                ))}
            </Pop>
          )}
        </AnimatePresence>
      </div>
    </header>
    {!p.noHuddle && <ChannelHuddleDock channel={c} />}
    </>
  );
}
