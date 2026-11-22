/**
 * `#/design`, the ChatForm chapter: conversations kept in the side menu and agents on a baseline
 * (2026-11-20), the real components from fixtures, with no server.
 *
 *  - The side menu's selector with **Chats**, and its rows: unread, a mention, a direct message, an agent,
 *    a live huddle, the current one; the same list ringed while a conversation is held over it.
 *  - A slip in the hand (chat/carryChat.ts), drawn where it would be.
 *  - A chat opened from the side menu: ChatForm's list folded, the unfold control at the head's left.
 *  - An agent at each size: the figure behind its line (88 the Agents tab's head, 36 the timeline, 28 a list,
 *    20 a mention), the ✦ on the line when it wears no character, a picture that couldn't be cut on its
 *    tile, and the ✦ on its tint under 20 px.
 */

import { useMemo } from "react";
import type { ChatChannelView, ChatMessage, ChatParty } from "@foundation/protocol";
import { SideChatsView } from "./SideChats";
import { ChannelHead } from "./ChannelHead";
import { Timeline } from "./Timeline";
import { AgentFigure } from "./AgentFigure";
import { channelMark } from "./Sidebar";
import { layoutTimeline } from "./logic";
import type { MessageActions } from "./Message";
import { DEMO_CHANNELS } from "./ChatDesign";
import { PlusGlyph } from "../shell/glyphs";
import "./sidechats.css";

const NOW = Date.now();
const MIN = 60_000;
const ME = { id: "u_josh", name: "Josh Leong", handle: "josh.leong", color: "var(--viz-2)" };
const ADA: ChatParty = { kind: "person", id: "u_ada", name: "Ada Lovelace", color: "var(--viz-1)" };
const WREN: ChatParty = { kind: "agent", id: "Wren", name: "Wren", via: "claude", forName: "Josh Leong" };

/**
 * A stand-in portrait with no colour of its own (greys on a clear ground, 3:4, head and shoulders with
 * headroom, as a character's portrait is framed), so the page shows a figure on its line without a server.
 */
export const DEMO_FIGURE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'><g fill='gray'><path d='M28 400 C30 300 78 262 150 258 C222 262 270 300 272 400Z' fill-opacity='.62'/><rect x='128' y='196' width='44' height='70' rx='18' fill-opacity='.5'/><ellipse cx='150' cy='126' rx='60' ry='76' fill-opacity='.78'/><path d='M92 112 C96 62 128 46 154 48 C196 50 214 84 210 118 C190 96 150 88 92 112Z' fill-opacity='.95'/></g></svg>",
  );
const FIG = { src: DEMO_FIGURE, role: "portrait", cut: true };

const pick = (...ids: string[]) => ids.map((id) => DEMO_CHANNELS.find((c) => c.id === id)!).filter(Boolean);
const withHuddle = (c: ChatChannelView): ChatChannelView => ({ ...c, huddle: { id: "h_1", board: "chat", startedAt: NOW - 4 * MIN, liveSince: NOW - 4 * MIN, recording: false, people: ["Ada Lovelace", "Kai Moreno"] } as unknown as ChatChannelView["huddle"] });

const NOOP: MessageActions = { react: () => {}, reply: () => {}, pin: () => {}, copyLink: () => {}, markUnread: () => {}, edit: () => {}, saveEdit: () => {}, cancelEdit: () => {}, remove: () => {} };

let seq = 500;
const msg = (author: ChatParty, minsAgo: number, text: string): ChatMessage => ({ id: `sm_${++seq}`, channel: "ch_general", seq, author, type: "text", text, root: null, createdAt: NOW - minsAgo * MIN, editedAt: null, deletedAt: null, files: [], reactions: [], replyCount: 0, lastReplyAt: null, pinned: false, mentions: [] });

function Selector({ over }: { over?: boolean }) {
  return (
    <div className="pane-pick">
      <div className="pane-seg" role="tablist" aria-label="How grids are listed (design)">
        {(["Recent", "All Grids", "Chats"] as const).map((v) => (
          <span key={v} role="tab" aria-selected={v === "Chats"} className={`pane-seg-btn${v === "Chats" ? " is-on" : ""}${v === "Chats" && over ? " is-over" : ""}`} style={{ display: "inline-grid", placeItems: "center" }}>
            {v}
          </span>
        ))}
      </div>
      <span className="pane-new" aria-hidden>
        <PlusGlyph />
      </span>
    </div>
  );
}

function Pane({ width, channels, current, held, empty }: { width: number; channels: ChatChannelView[]; current: string | null; held?: "near" | "over"; empty?: boolean }) {
  return (
    <aside className="side-pane chat-demo-pane" style={{ width }} aria-label="Side menu (design)">
      <Selector over={!!held} />
      <div className={`pane-scroll${held ? " is-chat-target" : ""}${held === "over" ? " is-chat-over" : ""}`}>
        <section className="pane-group">
          <SideChatsView channels={empty ? [] : channels} meId={ME.id} online={["u_kai"]} current={current} ringed={!!held} onOpen={() => {}} onUnpin={() => {}} onMove={() => {}} onBrowse={() => {}} />
        </section>
      </div>
    </aside>
  );
}

export function SideMenuDemo() {
  const kept = useMemo(() => [withHuddle(pick("ch_general")[0]), ...pick("ch_design", "ch_kai", "ch_wren", "ch_shroud", "ch_random")], []);
  const general = DEMO_CHANNELS.find((c) => c.id === "ch_general")!;
  const items = useMemo(
    () => layoutTimeline([msg(ADA, 12, "The kiln schedule moved to Thursday; the shroud test piece goes in first."), msg(WREN, 9, "I moved the print-farm card on the grid to Thursday for Ada and told the shop."), msg(ADA, 4, "Thanks. @josh.leong that frees Wednesday for the review.")], { meId: ME.id }),
    [],
  );
  return (
    <div className="chat-demo" data-design-sidemenu>
      <div className="chat-demo-row">
        <div>
          <p className="chat-demo-cap">Side menu · Chats (unread, a mention, a huddle, current)</p>
          <Pane width={272} channels={kept} current="ch_shroud" />
        </div>
        <div>
          <p className="chat-demo-cap">A conversation held over it · at 220</p>
          <Pane width={220} channels={kept.slice(0, 3)} current={null} held="over" />
          <p className="chat-demo-cap" style={{ marginTop: "var(--space-5)" }}>The slip in the hand</p>
          <div className="held chat-held is-lifted is-over chat-demo-held" style={{ ["--lean" as string]: "-1.8deg", ["--grab-x" as string]: "60px", ["--grab-y" as string]: "28px" }}>
            <div className="held-card" style={{ width: 232, height: 56 }}>
              <div className="held-face">
                <span className="chat-held-mark">{channelMark(general, ME.id)}</span>
                <span className="held-main">
                  <span className="held-title">#general</span>
                  <span className="held-src">ChatForm · channel</span>
                </span>
              </div>
            </div>
          </div>
        </div>
        <div>
          <p className="chat-demo-cap">Empty</p>
          <Pane width={272} channels={[]} current={null} empty />
        </div>
      </div>

      <div>
        <p className="chat-demo-cap">Opened from the side menu · ChatForm's list folded, the conversation takes the area</p>
        <div className="chat-demo-frame chat-demo-folded">
          <div className="chat-body">
            <div className="chat-tab-chat is-list-folded">
              <div className="chat-main">
                <ChannelHead channel={general} meId={ME.id} people={[ADA]} online={[]} onUnfold={() => {}} />
                <Timeline items={items} me={ME} actions={NOOP} onRetry={() => {}} onDiscard={() => {}} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <p className="chat-demo-cap">An agent stands behind a line · 88 · 36 · 28 · 20 · no character · a picture that couldn't be cut · 18 and 14 (the ✦ on its tint)</p>
        <div className="chat-demo-figures">
          <div className="chat-demo-head">
            <AgentFigure name="Wren" size={88} width={80} still={FIG} />
            <span>
              <b>Wren</b>
              <small>the Agents tab's head: its hairline is the line</small>
            </span>
          </div>
          {[36, 28, 20].map((s) => (
            <figure key={s} className="chat-demo-fig">
              <AgentFigure name="Wren" size={s} still={FIG} />
              <figcaption>{s}</figcaption>
            </figure>
          ))}
          <figure className="chat-demo-fig">
            <AgentFigure name="Nobody" size={36} />
            <figcaption>✦ 36</figcaption>
          </figure>
          <figure className="chat-demo-fig">
            <AgentFigure name="Wren" size={36} still={{ ...FIG, cut: false }} />
            <figcaption>tile</figcaption>
          </figure>
          {[18, 14].map((s) => (
            <figure key={s} className="chat-demo-fig">
              <AgentFigure name="Wren" size={s} />
              <figcaption>{s}</figcaption>
            </figure>
          ))}
          <figure className="chat-demo-fig">
            <span className="chat-avatar is-person" style={{ width: 32, height: 32, fontSize: 12, background: "var(--viz-1)" }}>
              AL
            </span>
            <figcaption>a person</figcaption>
          </figure>
        </div>
      </div>
    </div>
  );
}
