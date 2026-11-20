/**
 * #/design, 2026-11-18: the themes, the release page, and what a right-click on a card offers (with a card
 * pinned to its section and a card minimized). Drawn from the real components and the real tokens.
 */

import { THEMES, type ThemeId } from "@foundation/ui";
import { MenuBody } from "../components/ContextMenu";
import type { MenuItem } from "../components/menuLayout";
import { ReleaseCard } from "../settings/ReleasePage";
import type { ReleasePost } from "../settings/releases";

const SCOPE: Record<ThemeId, string> = { paper: "f-paper", day: "f-day", night: "f-night", room: "f-room" };

/** each theme, worn by the same small surface: a title, a line, a rule, the accent and a quiet button */
export function ThemesDemo() {
  return (
    <div className="theme-demo">
      {(Object.keys(THEMES) as ThemeId[]).map((id) => (
        <figure key={id} className={`theme-demo-card${id === "room" ? " is-room" : ""}`} data-theme-demo={id}>
          <div className={`theme-demo-face ${SCOPE[id]}`}>
            <span className="f-eyebrow">{id === "room" ? "Today" : id === "paper" ? "A grid" : `A grid · ${id}`}</span>
            <b>{THEMES[id].name}</b>
            <p>Ink, mist and dim, a hairline, and the one accent.</p>
            <span className="theme-demo-row">
              <button type="button" className="f-pill is-accent">
                Forward
              </button>
              <button type="button" className="f-pill">
                Quiet
              </button>
              <code>12.5 mono</code>
            </span>
          </div>
          <figcaption>
            <code>{id}</code> {THEMES[id].what}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** the release page's card, on paper and over the room */
export function ReleasePageDemo({ post }: { post: ReleasePost }) {
  return (
    <div className="release-demo">
      <div className="release-demo-face">
        <ReleaseCard post={post} running />
      </div>
      <div className="release-demo-face is-room">
        <div className="f-room">
          <ReleaseCard post={post} />
        </div>
      </div>
    </div>
  );
}

const noop = () => {};
const TABLE_MENU: MenuItem[] = [
  { heading: "Parts" },
  { icon: "◎", label: "Frame it", action: noop },
  { icon: "⤢", label: "Full screen  Ctrl+Enter", action: noop },
  { icon: "▁", label: "Minimize", action: noop },
  { divider: true },
  { icon: "⊟", label: "Pin to the section: span it", action: noop },
  { icon: "✥", label: "Float freely", action: noop },
  { divider: true },
  { icon: "⇄", label: "Inputs and outputs…", action: noop },
  { icon: "⌁", label: "Copy a link to it", action: noop },
  { divider: true },
  { icon: "🗑", label: "Remove this table", danger: true, action: noop },
];

const COLS = ["A", "B", "C", "D", "E"];

/** a card's right-click menu beside a section whose table is pinned to it, with a minimized card over it */
export function CardMenuDemo() {
  return (
    <div className="cardmenu-demo">
      <div className="context-menu cardmenu-demo-menu" role="menu">
        <MenuBody items={TABLE_MENU} />
      </div>
      <div className="cardmenu-demo-section">
        <div className="cardmenu-demo-head">
          <b>Section 2</b>
          <span className="section-coords">B1</span>
        </div>
        <div className="cardmenu-demo-body">
          <div className="table-anchor is-pinned" style={{ width: "100%" }}>
            <div className="table-card">
              <div className="table-header" style={{ height: 44 }}>
                <span className="table-name">Parts</span>
                <span className="table-pinned-tag">5 × 4 · pinned to the section</span>
              </div>
              <div className="sheet" style={{ gridTemplateColumns: `44px repeat(${COLS.length}, 1fr)`, gridTemplateRows: "28px repeat(4, 34px)" }}>
                <div className="corner" style={{ gridColumn: 1, gridRow: 1 }} />
                {COLS.map((c, i) => (
                  <div key={c} className="colhead" style={{ gridColumn: i + 2, gridRow: 1 }}>
                    {c}
                  </div>
                ))}
                {[0, 1, 2, 3].map((r) => (
                  <div key={r} className="rownum" style={{ gridColumn: 1, gridRow: r + 2 }}>
                    {r + 1}
                  </div>
                ))}
                {[0, 1, 2, 3].flatMap((r) =>
                  COLS.map((c, i) => (
                    <div key={`${c}${r}`} className="cell" style={{ gridColumn: i + 2, gridRow: r + 2 }}>
                      {r === 0 && i === 0 ? <span className="cell-text">Rim drive</span> : r === 0 && i === 1 ? <span className="cell-text">12</span> : null}
                    </div>
                  )),
                )}
              </div>
            </div>
          </div>
          {/* a minimized card over the sheet: its bar alone */}
          <div className="frame-anchor chrome-bar is-folded cardmenu-demo-folded">
            <div className="frame-card">
              <div className="frame-header" style={{ height: 30 }}>
                <div className="grip mini">
                  <span />
                  <span />
                </div>
                <span className="frame-title">Supplier notes</span>
                <div className="header-actions">
                  <button type="button" className="icon-btn" data-tip="Restore" aria-label="Restore">
                    ▢
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
