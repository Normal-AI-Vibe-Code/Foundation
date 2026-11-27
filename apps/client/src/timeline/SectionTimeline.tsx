/**
 * A section's timeline (docs/timeline.md §3): opened from the clock in its header, a slim bar that unfolds from under
 * the header, over the top of its body (it never pushes the cards: a section fits its cards to its body). Its own range and
 * playhead, the lanes condensed to one or two rows. Scrubbing it takes only this section into the past; while the
 * grid's band is open that detaches it (*Follow the grid* joins them again) and its playhead shows on the band.
 * Closing it returns the section to now. A section that stands for a grid opens that grid's own timeline.
 *
 * At 260 px the bar is the time, the track and close; from 400 the range; from 560 the play button and the nearest
 * thing said (container queries, timeline.css).
 */

import { TimeGlyph } from "../shell/glyphs";
import { Lanes } from "./Lanes";
import { Transport } from "./TimelineBar";
import { GRID, childGridOf, closeTimeline, followGrid, getTimeline, sectionKey, seekSection, toggleSectionTimeline, useTimeline, useTimelines, type Timeline } from "./model";
import "./timeline.css";

export function SectionTimeline({ sectionId }: { sectionId: string }) {
  const tl = useTimeline(sectionKey(sectionId));
  if (!tl) return null;
  return <SectionTimelineBar tl={tl} />;
}

export function SectionTimelineBar({ tl, still = false }: { tl: Timeline; still?: boolean }) {
  useTimelines();
  const sectionId = tl.sectionId!;
  const seek = (t: number | null) => (still ? tl.head.seek(t) : seekSection(sectionId, t));
  // on the design page a detached fixture stands for a bar beside an open band
  const gridOpen = still ? tl.detached : !!getTimeline(GRID);
  const title = tl.childName ? `${tl.childName}'s own timeline` : "This section";
  return (
    <div
      className={`tl-section${tl.head.t !== null ? " is-past" : ""}${tl.detached ? " is-detached" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      role="region"
      aria-label={`${title}: timeline`}
      data-tl-section={sectionId}
    >
      <Transport tl={tl} seek={seek} onClose={() => closeTimeline(tl.key)} title={title} compact follow={tl.detached && gridOpen ? () => followGrid(sectionId) : undefined} />
      {tl.sliceState === "loading" && !tl.slice && <p className="tl-state">Reading its past…</p>}
      {(tl.sliceState === "missing" || tl.sliceState === "error") && (
        <p className={`tl-state is-${tl.sliceState}`} data-tl-why>
          {tl.sliceWhy}
        </p>
      )}
      {tl.slice && <Lanes tl={tl} rows={2} names={false} axis={false} seek={seek} label={`Time in ${title}`} />}
      {tl.childName && tl.head.t !== null && <p className="tl-state is-quiet">Its cards stay as they are here: open the grid to see it as it was.</p>}
    </div>
  );
}

/**
 * The section's clock: at rest beside its council chip, and among its tools (with the council: the place's meta
 * layer). `is-on` while its timeline is open.
 */
export function SectionClock({ sectionId, variant }: { sectionId: string; variant: "rest" | "tool" }) {
  const on = !!useTimeline(sectionKey(sectionId));
  const grid = childGridOf(sectionId);
  const tip = on ? "Close this section's timeline" : grid ? `${grid.name}'s own timeline` : "This section's timeline";
  return (
    <button
      type="button"
      className={`${variant === "rest" ? "sec-time-head" : "sec-tool"} sec-time${on ? " is-on" : ""}`}
      data-tip={tip}
      aria-label={tip}
      aria-pressed={on}
      onClick={() => toggleSectionTimeline(sectionId, grid)}
      data-sec-time={sectionId}
    >
      <TimeGlyph size={variant === "rest" ? 13 : 14} />
    </button>
  );
}
