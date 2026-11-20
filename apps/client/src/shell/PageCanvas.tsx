/**
 * A web page space's canvas: the page at its address, filling the paper the
 * floor leaves (under the top bar, between the panes, above the bottom bar).
 * The space still has its board underneath, for its people and activity; the
 * grid just isn't what you look at.
 *
 * The page follows the same frame rules as an app on a card (frameSandbox.ts):
 * always sandboxed, its own origin only for a saved app, never Foundation itself
 * (a sentence says so in its place).
 */

import { floorInsets, useUi } from "../state/ui";
import { frameAllow, frameFor } from "../panels/frameSandbox";
import { useFrameContext } from "../lib/frames";
import type { BoardRow } from "../lib/grids";

export function PageCanvas({ space }: { space: BoardRow }) {
  const ui = useUi();
  const ctx = useFrameContext();
  const insets = floorInsets(ui);
  if (!space.url) return null;
  const d = frameFor(space.url, ctx);
  return (
    <div className="page-canvas" style={{ left: insets.left, right: insets.right, top: insets.top }}>
      {!d.ok ? (
        <div className="tool-empty" data-frame-refused>
          <b>{space.name}</b>
          <p>{d.reason}</p>
        </div>
      ) : (
        ctx.ready && <iframe key={space.url} src={d.url} title={space.name} allow={frameAllow(d, "fullscreen")} sandbox={d.sandbox} referrerPolicy="no-referrer" />
      )}
    </div>
  );
}
