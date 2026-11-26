/**
 * A section as it was, while a timeline's playhead is off now (docs/timeline.md §3 "Scrubbing"). Mounted in every
 * section (components/SectionView.tsx, beside the clock card's SectionRewind): over its live cards, which hide for
 * this viewer only, the cards of the board rebuilt at that moment, and the pointers that were in it. A section that
 * wasn't there yet says so. Nothing here writes: the live cards only fade and stop taking the pointer, and the
 * section's own tools that would change it stand down.
 *
 * It redraws only when the moment crosses a change or a cursor sample (TakePlayer.indexAt), however fast the
 * playhead moves; a section whose clock card is rewinding it already shows that instead.
 */

import { useCallback, useSyncExternalStore } from "react";
import { boardMaps } from "@foundation/protocol";
import { PastSectionCards, useRewind } from "../panels/ReplayView";
import { momentOfSection, subscribeAllHeads, type Timeline } from "./model";
import { sampleAt, whenWords } from "./logic";

export function TimelinePast({ sectionId }: { sectionId: string }) {
  const rewinding = useRewind(sectionId);
  // the moment, and which change and cursor sample it falls on: the key that redraws
  const key = useCallback(() => {
    const m = momentOfSection(sectionId);
    if (!m) return "now";
    const p = m.tl.player;
    return `${m.tl.key}|${p ? `${p.indexAt(m.t)}|${sampleAt(p.frames.cursors, m.t)}` : "-"}|${m.tl.historyState}`;
  }, [sectionId]);
  const k = useSyncExternalStore(subscribeAllHeads, key);
  if (rewinding || k === "now") return null;
  const m = momentOfSection(sectionId);
  if (!m) return null;
  return <Past sectionId={sectionId} t={m.t} tl={m.tl} />;
}

function Past({ sectionId, t, tl }: { sectionId: string; t: number; tl: Timeline }) {
  const own = tl.scope === "section";
  const hide = `[data-section-id="${sectionId}"]`;
  // the live cards hide and take nothing; the header's tools that change the section rest (the clock stays)
  // the ground of the past is the body's own background (one element per section, not a layer the size of the grid:
  // with every section rewound at once, those ran out of tiles and drew white)
  const ground = `${hide} > .section-body { background-color: color-mix(in srgb, var(--color-abyss) ${own ? 88 : 93}%, var(--color-pulse)); background-image: radial-gradient(circle, color-mix(in srgb, var(--color-pulse) 22%, transparent) 1.1px, transparent 1.4px); background-size: 28px 28px; }`;
  const css = `${ground}
${hide} .section-content > .obj-slot, ${hide} .section-body > .pinned-slot, ${hide} .section-body > .mini-grid, ${hide} > .section-empty, ${hide} .section-body > .section-empty { opacity: 0; pointer-events: none; }
${hide} .section-header .section-name, ${hide} .section-header .sec-layout, ${hide} .section-tools .sec-group:not(.sec-meta), ${hide} .sec-remove, ${hide} > .add-btn { pointer-events: none; opacity: 0.35; }${own ? `\n${hide} { box-shadow: 0 0 0 2px var(--color-pulse), var(--shadow-pane); }` : ""}`;
  const player = tl.player;
  let body: React.ReactNode;
  if (!player) {
    body = (
      <p className="tl-past-note" data-tl-past-note>
        {tl.historyState === "loading" || tl.historyState === "idle" ? "Opening the past…" : (tl.historyWhy ?? "The past can't be drawn here.")}
      </p>
    );
  } else {
    const doc = player.docAt(t);
    const there = boardMaps(doc).sections.has(sectionId);
    body = there ? (
      <PastSectionCards
        sectionId={sectionId}
        doc={doc}
        cursors={player.cursorsAt(t)}
        version={player.version}
        // a pointer that was over another section is drawn there, not here
        only={(c, o) => typeof c.x !== "number" || typeof c.y !== "number" || (c.x >= o.x - 1 && c.y >= o.y - 42 && c.x <= o.x + o.w && c.y <= o.y - 42 + o.h)}
      />
    ) : (
      <p className="tl-past-note is-absent" data-tl-absent>
        This section wasn't here at {whenWords(t)}.
      </p>
    );
  }
  return (
    <div className="rp-rewind tl-past" data-tl-past={sectionId} data-tl-at={Math.round(t)}>
      <style>{css}</style>
      {body}
    </div>
  );
}
