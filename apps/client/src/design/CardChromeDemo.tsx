import type { CSSProperties, ReactNode } from "react";

/**
 * A card's chrome, on `#/design` ("Using a card"): the hover bar making room
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

function Card({ state, name, glyph, children, style }: { state?: string; name: string; glyph?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`frame-anchor chrome-bar chrome-demo oncall-static${state ? ` ${state}` : ""}`} style={{ width: 300, ...style }}>
      <div className="frame-card">
        <div className="frame-header" style={{ height: 30 }}>
          <div className="grip mini">
            <span />
            <span />
          </div>
          <span className="frame-title">
            {glyph ? `${glyph}  ` : ""}
            {name}
          </span>
          <div className="header-actions">
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
        <div className="map-resize" data-tip="Resize" />
      </div>
    </div>
  );
}

const Note = ({ scrolling = false }: { scrolling?: boolean }) => (
  <div className="frame-body note-body">
    <div className="note-inner bar-reflow" style={{ ["--h" as string]: "190px" }}>
      <div className={`note-rendered${scrolling ? " is-scrolling" : ""}`}>
        {LINES.map((l, i) => (i === 0 ? <h3 key={i}>{l}</h3> : <p key={i}>{l}</p>))}
      </div>
    </div>
  </div>
);

export function CardChromeDemo() {
  return (
    <div className="adapt-row" data-card-chrome>
      <div className="oncall-cell">
        <Card name="Rim drive" state="is-live-demo">
          <Note />
        </Card>
        <div className="effect-label">Live: put the pointer on it. The bar drops in and the note moves down for it; its last line stays</div>
      </div>
      <div className="oncall-cell">
        <Card name="Rim drive">
          <Note />
        </Card>
        <div className="effect-label">At rest: no bar, no scroll line, no corner</div>
      </div>
      <div className="oncall-cell">
        <Card name="Rim drive" state="is-hover">
          <Note scrolling />
        </Card>
        <div className="effect-label">Pointer on it: the bar has its room, a 2 px line by the edge says there is more, a gleam on the corner resizes</div>
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
        <div className="effect-label">Removing a card that would lose something asks first, on the card</div>
      </div>
    </div>
  );
}
