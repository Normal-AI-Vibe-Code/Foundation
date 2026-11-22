/**
 * ChatForm on `#/design` (the ChatForm chapter): the real components drawn from fixtures, with no server.
 * The top bar's button at rest (with its badge) and on; then the place itself: the strip, the sidebar
 * (unread, mentions, muted, starred, a dm with presence, an agent), a channel's head, a timeline (a
 * person, a run, an agent working for someone, a ghost from WhatsApp, a thread's summary, reactions, a
 * picture, a file, a huddle, the New rule, a message on its way and one that failed), the composer with
 * files going, and a thread pane.
 */

import { useMemo } from "react";
import type { ChatChannelView, ChatFile, ChatMessage, ChatParty } from "@foundation/protocol";
import { ChatButtonView } from "./ChatButton";
import { Sidebar } from "./Sidebar";
import { ChannelHead } from "./ChannelHead";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";
import { ThreadPane } from "./Thread";
import { ChannelIntro } from "./Views";
import { layoutTimeline, type PendingMessage } from "./logic";
import type { MessageActions } from "./Message";
import { ChatMark, IconSearch } from "./Icons";
import "./chat.css";
import { HuddleDemo } from "../panels/HuddleDesign";
import { ReplayDemo } from "../panels/ReplayDesign";
import { InboxDemo } from "./tabs/InboxDesign";
import { SideMenuDemo } from "./SideMenuDesign";

const NOW = Date.now();
const MIN = 60_000;
const ADA: ChatParty = { kind: "person", id: "u_ada", name: "Ada Lovelace", color: "var(--viz-1)" };
const KAI: ChatParty = { kind: "person", id: "u_kai", name: "Kai Moreno", color: "var(--viz-3)" };
const NOA: ChatParty = { kind: "person", id: "u_noa", name: "Noa Berg", color: "var(--viz-5)" };
const ME = { id: "u_josh", name: "Josh Leong", handle: "josh.leong", color: "var(--viz-2)" };
const WREN: ChatParty = { kind: "agent", id: "Wren", name: "Wren", via: "claude", forName: "Ada Lovelace" };
const MEI: ChatParty = { kind: "ghost", id: "gh_1", name: "Mei Lin", service: "whatsapp", handle: "+65 9123 4567" };

/** a picture with no colour of its own (greys on whatever ground), so the page needs no file */
const PICTURE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 480 300'><g fill='gray'><rect width='480' height='300' fill-opacity='.16'/><path d='M0 300 L130 150 L230 240 L330 110 L480 300Z' fill-opacity='.45'/><circle cx='372' cy='78' r='30' fill-opacity='.35'/></g></svg>",
  );
const srcOf = (f: ChatFile) => (f.mime.startsWith("image/") ? PICTURE : "#");

let seq = 0;
const m = (author: ChatParty, minsAgo: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => {
  seq++;
  return { id: `m_${seq}`, channel: "ch_shroud", seq, author, type: "text", text, root: null, createdAt: NOW - minsAgo * MIN, editedAt: null, deletedAt: null, files: [], reactions: [], replyCount: 0, lastReplyAt: null, pinned: false, mentions: [], ...extra };
};

const view = (id: string, kind: ChatChannelView["kind"], name: string, extra: Partial<ChatChannelView> = {}, me: Partial<NonNullable<ChatChannelView["me"]>> | null = {}): ChatChannelView => ({
  id,
  kind,
  name,
  topic: "",
  purpose: "",
  createdBy: ME.id,
  createdAt: NOW - 30 * 86400_000,
  archivedAt: null,
  lastSeq: 10,
  lastPostAt: NOW - 60 * MIN,
  memberCount: 6,
  unread: 0,
  me: me ? { channel: id, readSeq: 10, mentions: 0, notify: "all", starred: false, joinedAt: 0, ...me } : null,
  ...extra,
});

export const DEMO_CHANNELS: ChatChannelView[] = [
  view("ch_shroud", "open", "fan-shroud", { topic: "Rev C goes to the printer Friday", purpose: "The fan shroud, rev C: CAD, prints, tests.", memberCount: 7, pinned: ["m_3"] }, { starred: true }),
  view("ch_general", "open", "general", { unread: 4, lastPostAt: NOW - 2 * MIN }, { readSeq: 6 }),
  view("ch_design", "private", "design-review", { unread: 2, lastPostAt: NOW - 9 * MIN }, { mentions: 1, readSeq: 8 }),
  view("ch_random", "open", "random", { unread: 0 }, { notify: "none" }),
  view("ch_print", "open", "print-farm", { unread: 12 }, { notify: "mentions", readSeq: 0 }),
  view("ch_kai", "dm", "", { members: [{ ...ME, kind: "person" }, KAI], unread: 2, lastPostAt: NOW - 4 * MIN }),
  view("ch_noa", "dm", "", { members: [{ ...ME, kind: "person" }, NOA], lastPostAt: NOW - 50 * MIN }),
  view("ch_wren", "agent", "", { agent: { name: "Wren", via: "claude" }, members: [{ ...ME, kind: "person" }, WREN], lastPostAt: NOW - 70 * MIN }),
];

const ROOT = m(ADA, 64, "Rev C is up: the inlet lip is **2 mm** thicker and the fillet at the strut is gone. @josh.leong can you look before it prints?", {
  replyCount: 3,
  lastReplyAt: NOW - 12 * MIN,
  repliers: ["Kai Moreno", "Wren", "Josh Leong"],
  files: [{ id: "f_1", name: "shroud-revC.png", mime: "image/png", size: 412_000, w: 480, h: 300 }],
  reactions: [
    { emoji: "👍", by: ["Kai Moreno", "Josh Leong"] },
    { emoji: "👀", by: ["Noa Berg"] },
  ],
  mentions: [ME.id],
});

export const DEMO_MESSAGES: ChatMessage[] = [
  m({ kind: "system", id: "system", name: "ChatForm" }, 300, "Noa Berg joined #fan-shroud", { type: "system", createdAt: NOW - 26 * 3600_000 }),
  m(NOA, 280, "Printer's free from Thursday night if we want a test piece first.", { createdAt: NOW - 25 * 3600_000 }),
  ROOT,
  m(ADA, 63, "And the STEP, for anyone who wants it turned:", { files: [{ id: "f_2", name: "shroud-revC.step", mime: "model/step", size: 2_480_000 }] }),
  m(WREN, 40, "I ran the inlet through the flow check for Ada:\n\n- pressure drop **down 6 %** against rev B\n- no separation at the strut now\n- the lip is the thinnest wall left at 1.8 mm\n\nThe full report is on the grid.", { reactions: [{ emoji: "🎉", by: ["Ada Lovelace", "Kai Moreno", "Noa Berg"] }] }),
  m(MEI, 22, "Hi! The supplier can do the shroud in PA12 by next Wednesday, if you confirm today 🙏"),
  m(KAI, 8, "Confirming with Mei now. I'll put the quote in #print-farm.", { editedAt: NOW - 7 * MIN }),
  m(KAI, 7, "Also: the old rev B prints are on the shelf by the door, if anyone wants one."),
  m(ADA, 3, "Huddle?", {}),
  m(ADA, 2, "", { type: "huddle", huddle: { id: "h_1", startedAt: NOW - 2 * MIN, people: ["Ada Lovelace", "Kai Moreno"], recorded: true } }),
];

const REPLIES: ChatMessage[] = [
  m(KAI, 30, "Looks good. Is the lip still printable without supports?", { root: ROOT.id }),
  m(WREN, 20, "Yes: at 45° it's self-supporting on the printer's profile. I checked the overhangs for Kai.", { root: ROOT.id, author: { ...WREN, forName: "Kai Moreno" } }),
  m({ kind: "person", id: ME.id, name: ME.name, color: ME.color }, 12, "Great, go ahead and print it.", { root: ROOT.id }),
];

const PENDING: PendingMessage[] = [
  { requestId: "rq_1", channel: "ch_shroud", root: null, text: "Joining in a minute", files: [], createdAt: NOW - 20_000, state: "sending" },
  { requestId: "rq_2", channel: "ch_shroud", root: null, text: "And the photo from the shop floor", files: [], createdAt: NOW - 10_000, state: "failed", error: "Can't reach the Foundation server" },
];

const NOOP: MessageActions = {
  react: () => {},
  reply: () => {},
  pin: () => {},
  copyLink: () => {},
  markUnread: () => {},
  edit: () => {},
  saveEdit: () => {},
  cancelEdit: () => {},
  remove: () => {},
};

export function ChatFormDemo() {
  const items = useMemo(() => layoutTimeline(DEMO_MESSAGES, { readSeq: 6, meId: ME.id, pending: PENDING }), []);
  const thread = useMemo(() => layoutTimeline(REPLIES, { meId: ME.id }).filter((i) => i.kind !== "day"), []);
  const shroud = DEMO_CHANNELS[0];
  return (
    <div className="chat-demo">
      <div className="chat-demo-row">
        <div>
          <p className="chat-demo-cap">Top bar · at rest, with what's waiting</p>
          <div className="chat-demo-bar">
            <ChatButtonView on={false} total={5} tip="ChatForm: 1 mention · 4 in direct messages" words="1 mention · 4 in direct messages" />
          </div>
        </div>
        <div>
          <p className="chat-demo-cap">On ChatForm</p>
          <div className="chat-demo-bar">
            <ChatButtonView on total={0} tip="ChatForm" words="" />
          </div>
        </div>
      </div>
      <div className="chat-demo-frame">
        <header className="chat-strip">
          <h1>
            <ChatMark size={18} />
            ChatForm
          </h1>
          <nav className="settings-tabs chat-tabs" aria-label="ChatForm (design)">
            {["Chat", "Agents", "Inbox", "Huddles"].map((t, i) => (
              <span key={t} className={`settings-tab${i === 0 ? " is-current" : ""}`}>
                {t}
              </span>
            ))}
          </nav>
          <span className="chat-head-gap" />
          <label className="chat-strip-search">
            <IconSearch />
            <input placeholder="Search messages" aria-label="Search messages (design)" readOnly />
          </label>
        </header>
        <div className="chat-body">
          <div className="chat-tab-chat has-thread">
            <Sidebar channels={DEMO_CHANNELS} meId={ME.id} online={[KAI.id]} current="ch_shroud" onOpen={() => {}} onView={() => {}} onNew={() => {}} typing={new Set(["ch_kai"])} />
            <div className="chat-main">
              <ChannelHead channel={shroud} meId={ME.id} people={[ADA, KAI, NOA]} online={[KAI.id]} pinned={[ROOT]} onTopic={() => {}} onStar={() => {}} onNotify={() => {}} onExport={() => {}} canAdmin onArchive={() => {}} onLeave={() => {}} />
              <Timeline items={items} me={ME} actions={NOOP} srcOf={srcOf} intro={<ChannelIntro c={shroud} meId={ME.id} />} onRetry={() => {}} onDiscard={() => {}} />
              <div className="chat-main-foot">
                <Composer
                  channel="ch_shroud"
                  placeholder="Message #fan-shroud"
                  people={[ADA, KAI, NOA]}
                  agents={[{ name: "Wren" }]}
                  channels={DEMO_CHANNELS}
                  meId={ME.id}
                  initial="Looks right. @kai.moreno can you check the strut fillet on the print?"
                  initialChips={[
                    { key: "a", name: "shop-floor.jpg", size: 1_840_000, mime: "image/jpeg", progress: 1, id: "f_9", thumb: PICTURE },
                    { key: "b", name: "shroud-revC-print.3mf", size: 6_300_000, mime: "model/3mf", progress: 0.64 },
                  ]}
                  autoFocus={false}
                  onSend={() => {}}
                  upload={() => new Promise(() => {})}
                />
                <div className="chat-typing">Kai Moreno is typing…</div>
              </div>
            </div>
            <ThreadPane still where="#fan-shroud" root={ROOT} items={thread} me={ME} actions={NOOP} srcOf={srcOf} onClose={() => {}} composer={<Composer channel="ch_shroud" root={ROOT.id} placeholder="Reply…" people={[]} agents={[]} channels={[]} initial="" compact autoFocus={false} onSend={() => {}} />} />
          </div>
        </div>
      </div>
      <SideMenuDemo />
      <HuddleDemo />
      <ReplayDemo />
      <InboxDemo />
    </div>
  );
}
