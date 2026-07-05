# Foundation

A spreadsheet-canvas desktop app: fully functional spreadsheet tables on an
infinite pannable/zoomable canvas, with split-panel workspaces, spring-physics
motion, and a GPU shader background. Built with Tauri 2 + React + TypeScript.

## Run

```sh
npm run tauri dev      # native desktop window (dev, hot reload)
npm run tauri build    # production installer (src-tauri/target/release/bundle)
npm run dev            # frontend only, in a browser at localhost:1420
```

## The Grid model

The workspace is a single spreadsheet-like **Grid** with column/row tracks.
**Sections** occupy rectangular spans of tracks (their header shows the span,
e.g. `A1:A3`) and each section is its own scrollable nested grid holding
primitives (tables, maps).

- **Split** (◫ / ⬓ in a section header) subdivides the section's track —
  every other section touching that track shifts or widens its span, exactly
  like inserting a spreadsheet column/row
- **Resize** by dragging the gutters between tracks — this resizes the
  underlying grid, so every section in the track resizes with it
- **Scroll** with the wheel inside a section to move its nested grid;
  primitives live in section content space
- The **viewport snaps**: pan the void and release — the camera springs to
  frame the nearest section, track band, object, or the whole grid.
  **⤢** on a section expands it to fill the viewport; **Esc** returns to
  overview; double-click a table header to snap to it
- **Grid chrome**: spreadsheet labels (A, B, … / 1, 2, …) frame the grid,
  dashed lines mark track boundaries, and uncovered cells appear as dashed
  targets with a **+ Section** button
- **Move sections**: drag a section's header — a highlight tracks the cell
  under the cursor; drop on a sibling to swap places, or on an empty cell
  to relocate (freed tracks are pruned)
- **Data-flow wires**: animated connectors show what feeds what — blue for
  table → map bindings, green for cross-table formula references. Wires
  track cards mid-drag and pulse when the source table's data changes

Inside a section, primitives **dock into a flow grid** by default — new cards
take the next slot, and everything reflows on a spring when something is
added, removed, or resized. Dragging a card's header floats it (free
position); the **⌗ / ✥** button on any card docks it back or releases it.

## Using it

- **⊞ / ◍ / ▤ / ⇪** in a section header — add a table / map / markdown
  note / media (open dialog); or **drop image & video files** from the
  desktop straight onto a section. Videos autoplay muted on a loop —
  toggle autoplay (❚❚/▶) and sound (🔇/🔊) in the card header
- **＋** on a section's right/bottom edge — add a new section beside it
  (inserts a grid track, spreadsheet-style)
- **✕** in a section header — remove it (with confirmation); an aligned
  neighbor absorbs the freed space and unused tracks are pruned
- **Pan**: drag the void (release velocity carries into the snap).
  **Zoom**: `Ctrl` + scroll (snaps to the nearest framing when idle)
- **Move a table**: drag its header — it follows on a spring tether
- **Edit cells**: click to select, type or double-click / `Enter` to edit,
  `Tab`/`Enter` to commit, arrows to navigate, `Delete` to clear
- **Formulas** start with `=`: `=B2*1.1`, `=SUM(B2:B6)`, `=IF(D2>0, D2, 0)`
  - Functions: `SUM AVG MIN MAX COUNT COUNTA IF ROUND ABS SQRT FLOOR CEIL POW CONCAT`
  - Cross-table references: `=Revenue!A1` or `='Table 1'!D8*2`
  - While typing a formula, click any cell (any table) to insert its reference
  - Errors: `#REF`, `#CYCLE`, `#DIV/0`, `#VALUE`, `#NAME`
- **Rename a table**: click its name (names are what formulas reference)
- **Rich cells**: drag an image file onto a cell (stored as a thumbnail,
  double-click for a lightbox), or drop/paste/type a URL — Google Drive,
  Docs, Sheets and Slides links get branded chips; click a chip to open it
  in your browser
- **Maps**: the **◍ Map** toolbar button drops a MapLibre GL map onto the
  canvas. Bind it to any table that has `Lat` / `Lng` header columns (plus a
  name/label column) and every valid row becomes a pulsing pin — edits to the
  table re-plot pins live. Toggle **3D** for a tilted perspective, drag the
  corner to resize. Maps are passive cards while the canvas is zoomed out;
  click one to spring the canvas to 1:1 and interact (pan/zoom/rotate) directly

## Architecture

| Path | What |
| --- | --- |
| `src/engine/formula.ts` | tokenizer → recursive-descent parser → evaluator |
| `src/engine/workbook.ts` | cell store, cross-table dependency graph, topological recalc, cycle detection |
| `src/physics/spring.ts` | shared-rAF spring engine (camera, drags, inertia) — writes styles directly, no React re-render on the hot path |
| `src/gl/background.ts` | WebGL2 fragment shader: paper grain + camera-synced dot grid + pointer light |
| `src/state/store.ts` | grid tracks + section spans + object layout; split/resize with spreadsheet semantics |
| `src/components/` | `GridViewport` (camera, snap framing, gutters), `SectionView` (scrollable nested grid), `TableView` (sheet UI), `MapView` (MapLibre binding) |
| `src/utils/media.ts` | image downscaling, external link opening, link labeling |

Component-level springs (entrances, button press physics) use the `motion`
library; continuous motion (pan/zoom/drag/fling) uses the custom spring
engine. All animated properties are GPU-composited transforms.
