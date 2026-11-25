/**
 * The chat card on `#/design` (the ChatForm chapter): the real head, timeline, composer and notices of
 * panels/ChatCardView.tsx drawn from fixtures at the card's smallest size (360 × 480), with no server:
 * at rest (who is on this grid ringed, who is only online quieter, an agent as its figure, what's unread, the
 * huddle button), in use (the 2 px ring every card in use wears; the caret in its field), on a chat server of
 * its own (no huddle button, the quiet line that voice needs Foundation's), locked, and on another server.
 */

import { useMemo } from "react";
import type { ChatParty } from "@foundation/protocol";
import { DEMO_CHANNELS, DEMO_MESSAGES } from "../chat/ChatDesign";
import { layoutTimeline } from "../chat/logic";
import { cardPeople, elsewhereWords, lockedWords } from "../chat/gridChat";
import { Timeline } from "../chat/Timeline";
import { Composer } from "../chat/Composer";
import { ChannelHuddleButton } from "../chat/HuddleCard";
import type { MessageActions } from "../chat/Message";
import { ChatCardFrame, ChatCardHead, ChatCardNotice } from "./ChatCardView";

const ME = { id: "u_josh", name: "Josh Leong", handle: "josh.leong", color: "var(--viz-2)" };
const PEOPLE: ChatParty[] = [
  { kind: "person", id: "u_ada", name: "Ada Lovelace", color: "var(--viz-1)" },
  { kind: "person", id: "u_kai", name: "Kai Moreno", color: "var(--viz-3)" },
  { kind: "person", id: "u_noa", name: "Noa Berg", color: "var(--viz-5)" },
];
const NOOP: MessageActions = { react: () => {}, reply: () => {}, pin: () => {}, copyLink: () => {}, markUnread: () => {}, edit: () => {}, saveEdit: () => {}, cancelEdit: () => {}, remove: () => {} };

export function ChatCardDemo() {
  const shroud = DEMO_CHANNELS[0];
  const items = useMemo(() => layoutTimeline(DEMO_MESSAGES.filter((m) => m.type !== "huddle").slice(-6), { meId: ME.id }), []);
  // Ada and Kai are on this grid, Noa is online elsewhere, Wren is at work here
  const who = useMemo(
    () =>
      cardPeople({
        channel: { kind: "open", agent: undefined, members: undefined },
        people: PEOPLE,
        online: ["u_ada", "u_noa"],
        where: { people: [{ id: "u_ada", name: "Ada Lovelace", color: "" }, { id: "u_kai", name: "Kai Moreno", color: "" }], agents: [{ id: "crew_1", name: "Wren", hue: 2, via: "claude", status: "working", doing: "checking the inlet" }] },
        meId: ME.id,
      }),
    [],
  );
  const timeline = <Timeline items={items} me={ME} actions={NOOP} srcOf={() => "#"} />;
  const composer = (text: string) => <Composer channel="ch_shroud" placeholder="Message #fan-shroud" people={[]} agents={[]} channels={[]} initial={text} compact autoFocus={false} onSend={() => {}} />;
  return (
    <div className="chat-card-demo" data-chat-card-demo>
      <figure>
        <div className="chat-card-demo-slot">
          <div className="chat-card is-open">
            <ChatCardFrame head={<ChatCardHead channel={shroud} meId={ME.id} online={[]} who={who} unread={3} mentions={1} huddle={<ChannelHuddleButton channel={shroud} />} onOpen={() => {}} />} timeline={timeline} foot={composer("")} quiet={<div className="chat-card-quiet">Kai Moreno is typing…</div>} />
          </div>
        </div>
        <figcaption>At rest · two on this grid, one online, an agent at work</figcaption>
      </figure>
      <figure>
        <div className="chat-card-demo-slot is-in-use">
          <div className="chat-card is-open is-in-use">
            <ChatCardFrame head={<ChatCardHead channel={shroud} meId={ME.id} online={[]} who={who} huddle={<ChannelHuddleButton channel={{ ...shroud, huddle: { id: "h_demo", board: "chat", people: ["Ada Lovelace", "Kai Moreno"], recording: false, liveSince: Date.now() - 134_000 } }} />} onOpen={() => {}} />} timeline={timeline} foot={composer("On my way: two minutes")} quiet={<div className="chat-card-quiet" />} />
          </div>
        </div>
        <figcaption>In use · a huddle is live</figcaption>
      </figure>
      <figure>
        <div className="chat-card-demo-slot">
          <div className="chat-card is-open">
            <ChatCardFrame head={<ChatCardHead channel={shroud} meId={ME.id} online={[]} who={{ faces: who.faces.filter((f) => f.online).map((f) => ({ ...f, here: false })), agents: [] }} onOpen={() => {}} />} timeline={timeline} foot={composer("")} quiet={<div className="chat-card-quiet">Voice needs Foundation's own server: this conversation is on chat.example.app.</div>} />
          </div>
        </div>
        <figcaption>On a chat server of its own · no voice</figcaption>
      </figure>
      <figure>
        <div className="chat-card-demo-slot is-short">
          <div className="chat-card is-locked">
            <ChatCardNotice kind="locked" {...lockedWords(false)} />
          </div>
        </div>
        <figcaption>Locked · the chat server doesn't give you this conversation</figcaption>
      </figure>
      <figure>
        <div className="chat-card-demo-slot is-short">
          <div className="chat-card is-elsewhere">
            <ChatCardNotice kind="elsewhere" {...elsewhereWords("https://chat.example.app", "")} />
          </div>
        </div>
        <figcaption>On another chat server than this device's</figcaption>
      </figure>
    </div>
  );
}
