import type { ReactNode } from "react";
import { MenuBody } from "../components/ContextMenu";
import type { MenuGroup, MenuItem } from "../components/menuLayout";
import { hintLabel, hintMarkup } from "../lib/scrollHint";

/**
 * What the pointer does, on `#/design` ("Using a card"), 2026-11-17:
 *
 *  - **what a left press picks up**: a card moves by its bar, an image or a
 *    video by the grip in its corner, and by nothing else;
 *  - **the mark that says a card scrolls**: Alt + scroll, on a card with more
 *    in it than fits, and how it's put away;
 *  - **a section's right-click menu**: the council across the top, Add and
 *    Live side by side, the grid's own actions as a row of icons that name
 *    themselves on roll-over.
 *
 * The same classes and the same components the grid uses (ObjectFrame's
 * markup, lib/scrollHint's mark, ContextMenu's MenuBody), held still.
 */

const LINES = [
  "Rim drive, rev C",
  "Bearing seat reamed to H7; the press fit holds at 60 °C.",
  "Stator potted in two pours. The second one cured overnight.",
  "Thrust measured on the pond rig: 41 N at 600 W.",
  "Next: the 5-blade ring, then the duct with the longer lip.",
  "Open: salt fog on the magnet coating, and the cable gland.",
];

/** an image card, as ObjectFrame draws one (chrome "icons") */
function Picture({ state }: { state?: string }) {
  return (
    <div className={`frame-anchor chrome-icons chrome-demo oncall-static${state ? ` ${state}` : ""}`} style={{ width: 240 }}>
      <div className="frame-icons">
        <button className="frame-icon" aria-label="Full screen" data-tip="Full screen">
          ⤢
        </button>
        <button className="frame-icon is-remove" aria-label="Remove" data-tip="Remove">
          ✕
        </button>
      </div>
      <div className="frame-card media-card">
        <div className="frame-body media-body">
          <div className="oncall-media" style={{ width: 240, height: 150 }} />
        </div>
        <div className="frame-grip" role="button" aria-label="Move the picture" data-tip="Drag to move">
          <div className="grip mini">
            <span />
            <span />
          </div>
        </div>
        <div className="map-resize" data-tip="Resize" />
      </div>
    </div>
  );
}

/** a note with more in it than fits, wearing the mark */
function Scrolling({ x, children }: { x?: boolean; children?: ReactNode }) {
  return (
    <div className="frame-anchor chrome-bar chrome-demo oncall-static" style={{ width: 300 }}>
      <div className="frame-card">
        <div className="frame-body note-body">
          <div className="note-inner" style={{ height: 170 }}>
            <div className="note-rendered is-scrolling">
              {LINES.map((l, i) => (i === 0 ? <h3 key={i}>{l}</h3> : <p key={i}>{l}</p>))}
            </div>
          </div>
        </div>
        {children}
        {/* the mark itself: lib/scrollHint.ts's own markup */}
        <div className={`scroll-hint is-on${x ? " is-shown-x" : ""}`} role="note" aria-label={hintLabel()} data-tip={hintLabel()} dangerouslySetInnerHTML={{ __html: hintMarkup() }} />
      </div>
    </div>
  );
}

const tag = (group: MenuGroup, items: MenuItem[]): MenuItem[] => items.map((it) => ({ ...it, group }));
/** a section's menu as components/sectionMenu.ts lists it (nothing here acts) */
const MENU: MenuItem[] = [
  { icon: "⚇", label: "Council: ask this section's agents…", agent: true },
  ...tag("add", [
    { heading: "Add" },
    { icon: "¶", label: "Text box" },
    { icon: "▤", label: "Markdown note" },
    { icon: "⊞", label: "Table" },
    { icon: "◍", label: "Map" },
    { icon: "⇪", label: "Image, video or file…" },
    { icon: "◳", label: "App or web page…" },
  ]),
  ...tag("live", [
    { heading: "Live" },
    { icon: "✦", label: "Agents card", agent: true },
    { icon: "◐", label: "Huddle" },
    { icon: "#", label: "Slack channel" },
    { icon: "▣", label: "Machine" },
    { icon: "☺", label: "Character: 3D" },
    { icon: "☺", label: "Character: mesh avatar" },
    { icon: "◨", label: "All agents on this grid" },
  ]),
  ...tag("grid", [
    { icon: "⤢", label: "Open as its own grid" },
    { icon: "←", label: "Insert section left" },
    { icon: "→", label: "Insert section right" },
    { icon: "↑", label: "Insert section above" },
    { icon: "↓", label: "Insert section below" },
    { icon: "◫", label: "Split column" },
    { icon: "⬓", label: "Split row" },
    { icon: "◳", label: "Let Moneyform fill the section" },
    { icon: "🗑", label: "Remove section…", danger: true },
  ]),
];
const CELL_MENU: MenuItem[] = [
  { icon: "+", label: "Create section at B2" },
  { icon: "✦", label: "Create it and ask an agent to build it…", agent: true },
];

export function PointerDemo() {
  return (
    <div data-pointer-demo>
      <div className="adapt-row">
        <div className="oncall-cell">
          <Picture state="is-live-demo" />
          <div className="effect-label">Live: put the pointer on it. A grip comes up in its corner; the picture itself is not a handle</div>
        </div>
        <div className="oncall-cell">
          <Picture state="is-hover" />
          <div className="effect-label">An image or a video has no bar: it moves by the grip, top left, of the same family as its icons</div>
        </div>
        <div className="oncall-cell">
          <Scrolling />
          <div className="effect-label">More in it than fits, pointer at rest: a 20 px mark by the scroll line, and the key. Its label: “{hintLabel()}”</div>
        </div>
        <div className="oncall-cell">
          <Scrolling x />
          <div className="effect-label">Pointer on the mark: ✕ (“Got it”) puts it away for good on this device. It also stops after three Alt-scrolls</div>
        </div>
      </div>
      <div className="adapt-row pointer-demo-menus">
        <div className="pointer-demo-menu">
          <div className="context-menu is-grouped is-specimen" role="menu" data-menu-specimen="section">
            <MenuBody items={MENU} />
          </div>
          <div className="effect-label">A section's menu: the council, then Add and Live side by side, then the grid's own actions as icons. Roll over one for its name; Remove is last, apart, in the bad colour</div>
        </div>
        <div className="pointer-demo-menu is-narrow">
          <div className="context-menu is-grouped is-specimen" role="menu" data-menu-specimen="narrow">
            <MenuBody items={MENU} />
          </div>
          <div className="effect-label">On a window too narrow for two columns they stack, and the row wraps</div>
        </div>
        <div className="pointer-demo-menu">
          <div className="context-menu is-specimen" role="menu" data-menu-specimen="cell">
            <MenuBody items={CELL_MENU} />
          </div>
          <div className="effect-label">An empty cell's menu stays a list</div>
        </div>
      </div>
    </div>
  );
}
