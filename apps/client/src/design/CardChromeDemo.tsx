import { useMemo, type CSSProperties, type ReactNode } from "react";
import { DEMO_CHANNELS, DEMO_MESSAGES } from "../chat/ChatDesign";
import { layoutTimeline } from "../chat/logic";
import { Timeline } from "../chat/Timeline";
import { Composer } from "../chat/Composer";
import type { MessageActions } from "../chat/Message";
import { ChatCardFrame, ChatCardHead } from "../panels/ChatCardView";
import { BareGlyph, MarkdownGlyph } from "../components/NoteView";
import { RichToolbar } from "../components/RichText";

/**
 * A card's chrome, on `#/design` ("Using a card"): the hover bar of a note and
 * a chat card rising above the card while what's in it holds still (2026-11-25),
 * the note's toolbar hanging under its foot while it's written in, the chat
 * card with its paper taken away, the bar of every other card making room
 * instead of covering what's under it, the 2 px scroll line, the resize gleam,
 * and a removal that asks first. The same classes the grid's cards wear
 * (components/ObjectFrame.tsx), so what is drawn here is what ships. The first
 * card is live: put the pointer on it. The others hold a state still.
 */

const LINES = [
  "Rim drive, rev C",
  "Bearing seat reamed to H7; the press fit holds at 60 °C.",
  "Stator potted in two pours. The second one cured overnight.",
  "Thrust measured on the pond rig: 41 N at 600 W.",
  "Next: the 5-blade ring, then the duct with the longer lip.",
  "Open: salt fog on the magnet coating, and the cable gland.",
  "Supplier quotes are in the Supply section, three of five back.",
  "Review with Ada on Thursday.",
];

function Card({ state, name, glyph, rise = false, cardClass = "", extras, children, after, style }: { state?: string; name: string; glyph?: string; rise?: boolean; cardClass?: string; extras?: ReactNode; children: ReactNode; after?: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`frame-anchor chrome-bar chrome-demo oncall-static${rise ? " bar-rise" : ""}${state ? ` ${state}` : ""}`} style={{ width: 300, ...style }}>
      <div className={`frame-card${cardClass ? ` ${cardClass}` : ""}`}>
        <div className="frame-header" style={rise ? undefined : { height: 30 }}>
          <div className="grip mini">
            <span />
            <span />
          </div>
          <span className="frame-title">
            {glyph ? `${glyph}  ` : ""}
            {name}
          </span>
          <div className="header-actions">
            {extras}
            <button className="icon-btn" aria-label="Full screen" data-tip="Full screen">
              ⤢
            </button>
            <button className="icon-btn float-btn" aria-label="Float freely" data-tip="Float freely">
              ⌗
            </button>
            <button className="icon-btn is-remove" aria-label="Remove" data-tip="Remove">
              ✕
            </button>
          </div>
        </div>
        {children}
        {after}
        <div className="map-resize" data-tip="Resize" />
      </div>
    </div>
  );
}

const Note = ({ scrolling = false, writing = false }: { scrolling?: boolean; writing?: boolean }) => (
  <div className="frame-body note-body">
    <div className="note-inner bar-reflow" style={{ ["--h" as string]: "190px" }}>
      <div className={`note-rendered rich-text${scrolling ? " is-scrolling" : ""}${writing ? " is-writing" : ""}`}>
        {LINES.map((l, i) => (i === 0 ? <h3 key={i}>{l}</h3> : <p key={i}>{l}</p>))}
      </div>
    </div>
  </div>
);

/** the note's own two buttons in its bar */
const noteButtons = (
  <>
    <button className="icon-btn note-bare-btn" aria-label="No background" data-tip="Hide the background">
      <BareGlyph off={false} />
    </button>
    <button className="icon-btn note-md-btn" aria-label="Markdown" data-tip="Write it as markdown">
      <MarkdownGlyph />
    </button>
  </>
);

const NOOP: MessageActions = { react: () => {}, reply: () => {}, pin: () => {}, copyLink: () => {}, markUnread: () => {}, edit: () => {}, saveEdit: () => {}, cancelEdit: () => {}, remove: () => {} };
const ME = { id: "u_josh", name: "Josh Leong", handle: "josh.leong", color: "var(--viz-2)" };

/** a chat card on a grid, its bar up: with its paper, or without */
function ChatCard({ bare }: { bare: boolean }) {
  const shroud = DEMO_CHANNELS[0];
  const items = useMemo(() => layoutTimeline(DEMO_MESSAGES.filter((m) => m.type !== "huddle").slice(-4), { meId: ME.id }), []);
  return (
    <Card
      name={shroud.name ?? "fan-shroud"}
      glyph="#"
      rise
      state="is-hover"
      cardClass={`panel-card kind-chat${bare ? " is-bare" : ""}`}
      style={{ width: 360 }}
      extras={
        <button className={`icon-btn note-bare-btn${bare ? " is-on" : ""}`} aria-pressed={bare} aria-label="No background" data-tip={bare ? "Show the background" : "Hide the background"}>
          <BareGlyph off={bare} />
        </button>
      }
    >
      <div className="frame-body panel-body panel-chat">
        <div className="panel-inner bar-reflow" style={{ ["--h" as string]: "400px" }}>
          <div className={`chat-card is-open${bare ? " is-bare" : ""}`} data-chat-card-demo-bare={bare ? "1" : "0"}>
            <ChatCardFrame
              head={<ChatCardHead channel={shroud} meId={ME.id} online={[]} who={{ faces: [], agents: [] }} unread={2} onOpen={() => {}} />}
              timeline={<Timeline items={items} me={ME} actions={NOOP} srcOf={() => "#"} />}
              foot={<Composer channel="ch_shroud" placeholder="Message #fan-shroud" people={[]} agents={[]} channels={[]} compact autoFocus={false} onSend={() => {}} />}
              quiet={<div className="chat-card-quiet" />}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

export function CardChromeDemo() {
  return (
    <div className="adapt-row" data-card-chrome>
      <div className="oncall-cell">
        <Card name="Rim drive" state="is-live-demo" rise cardClass="note-card" extras={noteButtons}>
          <Note />
        </Card>
        <div className="effect-label">Live: put the pointer on it. The bar rises into place above the note, a fifth larger; the note doesn't move</div>
      </div>
      <div className="oncall-cell">
        <Card name="Rim drive" rise cardClass="note-card" extras={noteButtons}>
          <Note />
        </Card>
        <div className="effect-label">At rest: no bar, no scroll line, no corner</div>
      </div>
      <div className="oncall-cell">
        <Card name="Rim drive" state="is-hover" rise cardClass="note-card" extras={noteButtons}>
          <Note scrolling />
        </Card>
        <div className="effect-label">Pointer on it: the bar above the card (36 tall, 4 px clear of it), a 2 px line by the edge says there is more, a gleam on the corner resizes</div>
      </div>
      <div className="oncall-cell is-writing-demo">
        <Card
          name="Rim drive"
          state="is-hover"
          rise
          cardClass="note-card"
          extras={noteButtons}
          after={
            <div className="rich-bar-slot is-under">
              <RichToolbar marks={{ bold: false, italic: false, underline: false, strike: false, ul: false, ol: false, quote: false, style: "p" }} size="m" />
            </div>
          }
        >
          <Note writing />
        </Card>
        <div className="effect-label">Writing: the bar above, the toolbar (40 tall) under the foot; the words keep their place and every line shows</div>
      </div>
      <div className="oncall-cell is-chat-demo">
        <ChatCard bare={false} />
        <div className="effect-label">A chat card, pointer on it: its bar rises the same way; the conversation holds still</div>
      </div>
      <div className="oncall-cell is-chat-demo">
        <ChatCard bare />
        <div className="effect-label">Background off: the conversation stands on the section; the composer keeps its paper, the dashed edge shows under the pointer</div>
      </div>
      <div className="oncall-cell">
        <Card name="Taro" glyph="☺" state="is-confirming">
          <div className="confirm-pop frame-confirm" role="alertdialog" aria-label="Remove Taro?">
            <span>
              Remove <b>Taro</b>? Its pictures and files stay in the archive.
            </span>
            <span className="frame-confirm-acts">
              <button className="confirm-btn danger">Remove</button>
              <button className="confirm-btn">Keep</button>
            </span>
          </div>
          <div className="frame-body panel-body">
            <div className="panel-inner bar-reflow" style={{ ["--h" as string]: "190px" }}>
              <p style={{ margin: 0, padding: "var(--space-5)", color: "var(--color-dim)", font: "400 var(--text-12) / 1.4 var(--font-sans)" }}>A character is asked about before its card goes: it leaves every council with it.</p>
            </div>
          </div>
        </Card>
        <div className="effect-label">Every other card makes room: its bar (30 tall) drops in at the top edge and the content moves down 38 px. Removing a card that would lose something asks first, on the card</div>
      </div>
    </div>
  );
}
