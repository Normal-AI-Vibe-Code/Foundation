/**
 * An app opened as a tab of its own (2026-11-18, Josh: "the expand option should open the app fully in
 * Foundation as the T3 APP as a tab, and it should be accessible in the grids panel with an appropriate
 * icon. I think most of the vibe coded apps should follow this"). The app is a space like any grid: it has
 * a tab, a row in All Grids with its own mark, and it can be filed inside a grid. Its canvas is the app,
 * filling the paper the floor leaves, in the app's own look: the theme around it goes back to paper.
 *
 *  - T3 (`app: "t3"`): the same tool the right pane shows, whole: its state, Start and Stop, and T3's page,
 *    signed in by a link minted when it opens.
 *  - anything else: the app at its address, sandboxed as a page space is (PageCanvas).
 */

import { floorInsets, useUi } from "../state/ui";
import type { BoardRow } from "../lib/grids";
import { PageCanvas } from "./PageCanvas";
import { T3Tool } from "./Tools";

export function AppCanvas({ space }: { space: BoardRow }) {
  const ui = useUi();
  const insets = floorInsets(ui);
  if (space.app !== "t3") return <PageCanvas space={space} />;
  return (
    <div className="page-canvas app-canvas" style={{ left: insets.left, right: insets.right, top: insets.top }} data-app-canvas="t3">
      <T3Tool shown full />
    </div>
  );
}
