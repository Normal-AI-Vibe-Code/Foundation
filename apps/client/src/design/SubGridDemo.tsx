/**
 * `#/design`: a section made a grid of its own (2026-11-17, Josh: "it should create a sub-grid that
 * can be pulled out of the grid collection and moved to other grids, but still maintain a preview in
 * the Grid it used to be in, and maintain a link to the new location").
 *
 * Four pieces, on the same classes the grid uses: the question a section asks before it becomes a
 * grid; the card that stands for the grid, with the grid in miniature; that card once the grid has
 * moved away (to the top of All Grids, into another grid); and the way back up from a grid that sits
 * inside another. Nothing here talks to a server: the grid is made up.
 */

import { GridLinkCard, type Outline, type OutlineCard } from "../panels/GridLinkCard";
import "../panels/system-cards.css";

const card = (id: string, kind: string, name: string, w: number, h: number): OutlineCard => ({ id, kind, name, w, h, x: 0, y: 0, float: false });

const RIM: Outline = {
  id: "rim-drive",
  name: "Rim drive",
  parent: "fans",
  parentName: "Fans",
  tracks: { cols: [1560, 1100, 900], rows: [760, 620] },
  cards: 11,
  updatedAt: null,
  sections: [
    {
      id: "s1",
      name: "Stator",
      c0: 0,
      r0: 0,
      c1: 0,
      r1: 1,
      cards: 5,
      grids: 0,
      items: [card("a", "note", "Brief", 420, 300), card("b", "table", "Parts", 520, 300), card("c", "image", "Section view", 480, 320), card("d", "note", "Winding plan", 420, 300), card("e", "map", "Suppliers", 420, 300)],
    },
    { id: "s2", name: "Rotor", c0: 1, r0: 0, c1: 1, r1: 0, cards: 3, grids: 0, items: [card("f", "note", "Magnets", 420, 300), card("g", "file", "rotor.step", 420, 300), card("h", "character", "Pip", 300, 400)] },
    { id: "s3", name: "Test rig", c0: 2, r0: 0, c1: 2, r1: 0, cards: 1, grids: 0, host: "i", items: [card("i", "app", "Dyno log", 800, 600)] },
    { id: "s4", name: "Blade", c0: 1, r0: 1, c1: 2, r1: 1, cards: 2, grids: 2, items: [card("j", "grid", "Blade", 720, 520), card("k", "note", "Open questions", 420, 300)] },
  ],
};

const nothing = () => {};

export function SubGridDemo() {
  return (
    <div className="subgrid-demo" data-design-subgrid>
      <div className="subgrid-demo-row">
        <figure className="subgrid-demo-fig">
          <div className="subgrid-demo-section">
            <div className="subgrid-demo-head">
              <span>Stator</span>
              <span className="sec-rest-open" aria-hidden>
                ⤢
              </span>
            </div>
            <div className="confirm-pop grid-ask">
              <span className="grid-ask-words">
                Make <b>Stator</b> its own grid? Its cards move into a new grid inside this one; this section keeps a preview of it. The machine “Bench” stays here.
              </span>
              <button className="confirm-btn primary">Make it a grid</button>
              <button className="confirm-btn">Cancel</button>
            </div>
          </div>
          <figcaption>⤢ on a section asks once, in place</figcaption>
        </figure>
        <figure className="subgrid-demo-fig">
          <div className="subgrid-demo-section">
            <div className="subgrid-demo-head">
              <span>Rim drive</span>
              <span className="sec-rest-open" aria-hidden>
                ⤓
              </span>
            </div>
            <div className="confirm-pop grid-ask" data-design-putback>
              <span className="grid-ask-words">
                Put <b>Rim drive</b> back into this section? Its cards come back here and the grid is archived (its history is kept).
              </span>
              <button className="confirm-btn primary">Put it back</button>
              <button className="confirm-btn">Cancel</button>
            </div>
          </div>
          <figcaption>⤓ on a grid's section puts it back: the undo, asked once</figcaption>
        </figure>
        <figure className="subgrid-demo-fig">
          <nav className="level-bar f-glass subgrid-demo-bar" aria-label="Where you are (example)">
            <span className="level-back">
              <span aria-hidden>⤡</span>
            </span>
            <span className="level-crumb">
              <span className="level-step">Fans</span>
              <span className="level-sep" aria-hidden>
                ›
              </span>
            </span>
            <span className="level-here">
              <span className="level-glyph" aria-hidden>
                ▦
              </span>
              Rim drive
            </span>
          </nav>
          <nav className="level-bar f-glass subgrid-demo-bar" aria-label="Where you are, a section open in this window (example)">
            <span className="level-back">
              <span aria-hidden>⤡</span>
            </span>
            <span className="level-step">Fans</span>
            <span className="level-crumb">
              <span className="level-sep" aria-hidden>
                ›
              </span>
              <span className="level-here">
                <span className="level-glyph" aria-hidden>
                  ▦
                </span>
                Sketches
              </span>
            </span>
            <span className="level-make">Make it a grid…</span>
          </nav>
          <figcaption>The way back up from a grid inside another; a section open in this window can be made a grid</figcaption>
        </figure>
      </div>
      <div className="subgrid-demo-row">
        <figure className="subgrid-demo-fig">
          <div className="subgrid-demo-card">
            <GridLinkCard board="rim-drive" name="Rim drive" outline={RIM} here="fans" inside={[{ id: "blade", name: "Blade" }]} onOpen={nothing} thumbs={false} />
          </div>
          <figcaption>A grid inside this one: its sections in miniature, their cards as blocks</figcaption>
        </figure>
        <figure className="subgrid-demo-fig">
          <div className="subgrid-demo-card">
            <GridLinkCard board="rim-drive" name="Rim drive" outline={{ ...RIM, parent: null, parentName: null }} here="fans" onOpen={nothing} onRemove={nothing} thumbs={false} />
          </div>
          <figcaption>Moved to the top of All Grids: the grid it was in keeps the preview and the link</figcaption>
        </figure>
        <figure className="subgrid-demo-fig">
          <div className="subgrid-demo-card">
            <GridLinkCard board="rim-drive" name="Rim drive" outline={{ ...RIM, parent: "motors", parentName: "Motors" }} here="fans" onOpen={nothing} onRemove={nothing} thumbs={false} />
          </div>
          <figcaption>Moved into another grid: the line names it, and a press goes there</figcaption>
        </figure>
      </div>
    </div>
  );
}
