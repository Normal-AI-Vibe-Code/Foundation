/**
 * A web page space's canvas: the page at its address, filling the paper the
 * floor leaves (under the top bar, between the panes, above the bottom bar).
 * The space still has its board underneath, for its people and activity; the
 * grid just isn't what you look at.
 *
 * The page runs in the same sandbox as an app on a card (frameSandbox.ts):
 * a page from elsewhere keeps its own origin and can't reach the board.
 */

import { floorInsets, useUi } from "../state/ui";
import { SERVER as FOUNDATION_SERVER } from "../lib/api";
import { sandboxFor } from "../panels/frameSandbox";
import type { BoardRow } from "../lib/grids";

export function PageCanvas({ space }: { space: BoardRow }) {
  const ui = useUi();
  const insets = floorInsets(ui);
  if (!space.url) return null;
  return (
    <div className="page-canvas" style={{ left: insets.left, right: insets.right, top: insets.top }}>
      <iframe
        key={space.url}
        src={space.url}
        title={space.name}
        allow="clipboard-read; clipboard-write; fullscreen"
        sandbox={sandboxFor(space.url, [window.location.origin, FOUNDATION_SERVER || window.location.origin])}
      />
    </div>
  );
}
