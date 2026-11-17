/**
 * The clipboard, at the foot of the search pane: what you've clipped out of
 * search, as small cards on a strip of paper (state/clipboard.ts).
 *
 * A result's ＋ (or ⌘/Ctrl-click, or dropping it here) clips it. Pull one card
 * off the strip to carry just that; pull the stack's handle to carry them all
 * and deal them onto the grid. What lands on the board leaves the clipboard;
 * what's put back stays. Empty, it's one line that says how to use it, and is
 * still somewhere to drop a result.
 */
import { useRef } from "react";
import type { SearchHit } from "@foundation/protocol";
import { clearClips, unclip, useClips } from "../state/clipboard";
import { glyphOf, pictureOf } from "../lib/hits";
import { useFileSrc } from "../lib/fileSrc";
import { pickUp, type Pickup } from "../lib/pickup";
import { keys } from "../lib/keys";

/** the picture of a hit, loaded with this device's session wherever the server is (lib/fileSrc.ts) */
export function HitPicture({ hit }: { hit: SearchHit }) {
  const src = useFileSrc(pictureOf(hit));
  return src ? <img src={src} alt="" loading="lazy" draggable={false} /> : null;
}

/** press-and-pull on an element picks `hits` up; a press that doesn't move calls `onPress` */
export function usePull(hits: () => SearchHit[], opts: { fromClipboard?: boolean; onPress?: (e: React.PointerEvent) => void } = {}) {
  const d = useRef<{ x: number; y: number; held: Pickup | null } | null>(null);
  return {
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      d.current = { x: e.clientX, y: e.clientY, held: null };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      const g = d.current;
      if (!g) return;
      if (!g.held) {
        if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 5) return;
        const list = hits();
        if (!list.length) return;
        g.held = pickUp(list, e.currentTarget, { x: g.x, y: g.y }, { fromClipboard: opts.fromClipboard });
      }
      g.held.move(e.clientX, e.clientY);
    },
    onPointerUp(e: React.PointerEvent<HTMLElement>) {
      const g = d.current;
      d.current = null;
      if (!g) return;
      if (g.held) return void (!g.held.over && g.held.drop(e.clientX, e.clientY));
      opts.onPress?.(e);
    },
    onPointerCancel() {
      d.current?.held?.cancel();
      d.current = null;
    },
  };
}

function ClipCard({ hit }: { hit: SearchHit }) {
  const pull = usePull(() => [hit], { fromClipboard: true });
  const picture = Boolean(pictureOf(hit));
  return (
    <span className={`clip-card${picture ? " is-picture" : ""}`} data-hit-id={hit.id} data-tip={hit.title} {...pull}>
      {picture ? <HitPicture hit={hit} /> : <span className="clip-glyph">{glyphOf(hit)}</span>}
      <button
        className="clip-x"
        aria-label={`Take ${hit.title} off the clipboard`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => (e.stopPropagation(), unclip(hit.id))}
      >
        ✕
      </button>
    </span>
  );
}

export function Clipboard() {
  const clips = useClips();
  const all = usePull(() => clips, { fromClipboard: true });
  if (clips.length === 0)
    return (
      <div className="clipboard is-empty" aria-label="Clipboard">
        Drag onto the grid to place it · <b>＋</b> or {keys("mod+click")} keeps it on the clipboard
      </div>
    );
  return (
    <div className="clipboard" aria-label="Clipboard">
      <div className="clip-head">
        <span className="pane-eyebrow">Clipboard</span>
        <span className="clip-n">{clips.length}</span>
        <button className="clip-clear" onClick={clearClips}>
          Clear
        </button>
      </div>
      <div className="clip-strip">
        {clips.length > 1 && (
          <span className="clip-all" data-tip={`Carry all ${clips.length} onto the grid`} {...all}>
            <i />
            <i />
            <i />
            <b>All {clips.length}</b>
          </span>
        )}
        <div className="clip-cards">
          {clips.map((h) => (
            <ClipCard key={h.id} hit={h} />
          ))}
        </div>
      </div>
    </div>
  );
}
