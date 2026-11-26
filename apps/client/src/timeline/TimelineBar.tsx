/**
 * The grid's timeline (docs/timeline.md §3): a band along the foot of the grid, on the floor. A hairline above it,
 * the grid's paper under it; it takes its height from the grid the way a pane takes its width (state/ui.ts
 * `timelineH` → floorInsets().bottom), so the cards stop above it, framing fits over it, and the bottom bar rises
 * to sit on it.
 *
 * The transport (Back to now, play, speed, the moment in words, the range, close), then the lanes with one playhead
 * through all of them, and the moment at the right. Under 900 px the lane names and the moment fold away (the
 * nearest thing said rides the transport instead); on a short window the lanes fold to two rows.
 *
 * TimelineLayer (mounted by the shell) holds the band, the banner that says you are looking at the past, Esc, and
 * the keys that would write while you look (Delete, ⌘Z/⌘Y, ⌘X, ⌘V stand down: nothing is edited in the past).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { floorInsets, setUi, toast, useUi } from "../state/ui";
import { TimeGlyph } from "../shell/glyphs";
import { RANGE_NAMES, RANGES, SPEEDS, momentAround, rangeClipped, spanWords, whenWords } from "./logic";
import { Lanes } from "./Lanes";
import { Moment } from "./Moment";
import { GRID, allBackToNow, anyPast, closeTimeline, openTimelines, setRange, subscribeAllHeads, useTimeline, useTimelines, usePlayhead, type Timeline } from "./model";
import "./timeline.css";

export function TimelineLayer({ onGrid }: { onGrid: boolean }) {
  const ui = useUi();
  const tl = useTimeline(GRID);
  usePastGuard();
  const show = onGrid && !ui.presenting && !!tl;
  useEffect(() => {
    if (!show) setUi({ timelineH: 0 });
  }, [show]);
  return (
    <>
      {show && <TimelineBand tl={tl!} />}
      {show && <PastBanner tl={tl!} />}
    </>
  );
}

/** while anything is shown as it was: Esc comes back, and the keys that would change the board do nothing */
function usePastGuard() {
  const past = useSyncExternalStore(subscribeAllHeads, anyPast);
  useEffect(() => {
    document.body.classList.toggle("is-looking-back", past);
    if (!past) return;
    // a note being written when the moment left now stops being written
    const a = document.activeElement as HTMLElement | null;
    if (a?.closest?.(".section-content .obj-slot")) a.blur();
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor, .xterm, .chat-compose");
    };
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        allBackToNow();
        return;
      }
      const writes = (!mod && (e.key === "Delete" || e.key === "Backspace")) || (mod && !e.altKey && (k === "z" || k === "y" || k === "x" || k === "v"));
      if (!writes) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) sayLookingBack(`You're looking at the past: nothing changes there · Esc comes back`);
    };
    // a file dropped on a section shown as it was would land in the present: not while looking back
    const onDrop = (e: DragEvent) => {
      const sec = (e.target as HTMLElement | null)?.closest?.("[data-section-id]");
      if (!sec || !sec.querySelector("[data-tl-past]")) return;
      e.preventDefault();
      e.stopPropagation();
      sayLookingBack("This section is shown as it was. Back to now to add to it.");
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [past]);
  useEffect(() => () => document.body.classList.remove("is-looking-back"), []);
}

/**
 * A key or a drop that would write, while looking back: the banner, which already says so, pulses; without one
 * (a section's own past) a toast says it, lifted clear of the band (timeline.css).
 */
const onResize = (f: () => void) => {
  window.addEventListener("resize", f);
  return () => window.removeEventListener("resize", f);
};

function sayLookingBack(words: string) {
  const banner = document.querySelector<HTMLElement>("[data-tl-banner]");
  if (!banner) return toast(words, "warn");
  banner.classList.remove("is-pulse");
  void banner.offsetWidth;
  banner.classList.add("is-pulse");
}

export function TimelineBand({ tl, still = false }: { tl: Timeline; still?: boolean }) {
  const ui = useUi();
  const band = useRef<HTMLDivElement>(null);
  const v = useTimelines();
  usePlayhead(tl.head, 30_000);
  // a short window: the lanes fold to two rows, so the grid keeps its paper (followed as the window changes)
  const short = useSyncExternalStore(onResize, () => typeof window !== "undefined" && window.innerHeight < 760);
  // the band's height is the floor's, at the foot: the grid frames above it and the bottom bar sits on it
  useLayoutEffect(() => {
    if (still) return;
    const el = band.current;
    if (!el) return;
    const put = () => {
      setUi({ timelineH: Math.round(el.offsetHeight) });
      // what floats at the window's foot (toasts) rises clear of the band and the bottom bar on it
      document.body.style.setProperty("--tl-foot", `${Math.round(el.offsetHeight)}px`);
    };
    const ro = new ResizeObserver(put);
    ro.observe(el);
    put();
    document.body.classList.add("has-timeline-band");
    return () => {
      ro.disconnect();
      setUi({ timelineH: 0 });
      document.body.classList.remove("has-timeline-band");
      document.body.style.removeProperty("--tl-foot");
    };
  }, [still]);
  // a section scrubbed on its own: its playhead on the band, named
  const markers = useMemo(
    () =>
      openTimelines()
        .filter((s) => s.scope === "section" && s.detached && !s.childName)
        .map((s) => ({ id: s.sectionId!, name: s.sectionId ? (sectionName(s.sectionId) ?? "Section") : "Section", head: s.head })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v],
  );
  const seek = (t: number | null) => tl.head.seek(t);
  const f = floorInsets(ui);
  const style = still ? undefined : { left: f.left, right: f.right };
  return (
    <div ref={band} className={`tl-band${still ? " is-still" : ""}${short ? " is-short" : ""}`} style={style} role="region" aria-label="This grid's timeline" data-tl-band data-tl-state={tl.sliceState}>
      <Transport tl={tl} seek={seek} onClose={() => closeTimeline(tl.key)} title={tl.childName ? `${tl.childName}'s own timeline` : "Timeline"} />
      <div className="tl-body">
        <div className="tl-main">
          {tl.sliceState === "loading" && !tl.slice && <p className="tl-state">Reading this grid's past…</p>}
          {(tl.sliceState === "missing" || tl.sliceState === "error") && (
            <p className={`tl-state is-${tl.sliceState}`} data-tl-why>
              {tl.sliceWhy}
            </p>
          )}
          {tl.slice && <Lanes tl={tl} rows={short ? 2 : 0} names={!short} seek={seek} markers={markers} label="Time on this grid" />}
        </div>
        {tl.slice && <Moment tl={tl} seek={seek} />}
      </div>
    </div>
  );
}

function sectionName(id: string): string | null {
  const el = document.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(id)}"] .section-name`);
  return el?.textContent?.trim() || null;
}

/** play, speed, the moment in words, the range, Back to now and close */
export function Transport({ tl, seek, onClose, title, compact = false, follow }: { tl: Timeline; seek: (t: number | null) => void; onClose: () => void; title: string; compact?: boolean; follow?: () => void }) {
  const head = usePlayhead(tl.head, 1000)!;
  const words = useRef<HTMLSpanElement>(null);
  // the time in words follows a scrub on every move, without React
  useLayoutEffect(() => {
    const put = () => {
      if (words.current) words.current.textContent = whenWords(tl.head.t, Date.now() + tl.skew);
    };
    put();
    return tl.head.onMove(put);
  }, [tl.head, tl.skew]);
  const past = head.t !== null;
  const nearest = useNearest(tl);
  return (
    <div className={`tl-transport${compact ? " is-compact" : ""}`} data-tl-transport={tl.key}>
      <span className="tl-title">
        <TimeGlyph size={14} />
        <span className="tl-title-words">{title}</span>
      </span>
      <button type="button" className="tl-play" onClick={() => head.toggle()} aria-label={head.playing ? "Pause" : "Play"} data-tip={head.playing ? "Pause (Space)" : "Play this range (Space)"} data-tl-play>
        {head.playing ? (
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
            <rect x="3" y="2.2" width="2.8" height="9.6" rx="0.8" fill="currentColor" />
            <rect x="8.2" y="2.2" width="2.8" height="9.6" rx="0.8" fill="currentColor" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
            <path d="M3.5 2.2v9.6L11.6 7Z" fill="currentColor" />
          </svg>
        )}
      </button>
      {!compact && (
        <span className="tl-speeds" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={`tl-speed${head.speed === s ? " is-on" : ""}`} aria-pressed={head.speed === s} onClick={() => head.setSpeed(s)} data-tip={s === 1 ? "Plays this range in a minute" : `Plays this range in ${60 / s} seconds`}>
              {s}×
            </button>
          ))}
        </span>
      )}
      <span ref={words} className={`tl-when${past ? " is-past" : ""}`} data-tl-when>
        {whenWords(head.t)}
      </span>
      {past && (
        <button type="button" className="tl-now" onClick={() => (head.pause(), seek(null))} data-tl-now>
          Back to now
        </button>
      )}
      {follow && (
        <button type="button" className="tl-follow" onClick={follow} data-tl-follow data-tip="Join the grid's playhead again">
          Follow the grid
        </button>
      )}
      {nearest && (
        <span className="tl-nearest" data-tl-nearest>
          <b className={nearest.agent ? "is-agent" : undefined}>{nearest.who}</b> {nearest.body ?? nearest.text}
        </span>
      )}
      <span className="tl-gap" />
      {tl.historyState === "missing" || tl.historyState === "error" ? (
        <span className="tl-warn" data-tip={tl.historyWhy ?? undefined} data-tl-history-why>
          {compact ? "Can't draw the past" : (tl.historyWhy ?? "The past can't be drawn")}
        </span>
      ) : null}
      {tl.slice && (tl.range === "all" || rangeClipped(tl.range, tl.from, tl.to)) && (
        <span className="tl-span" data-tl-span data-tip="What this grid's history holds: the band shows that, not empty time before it">
          {spanWords(tl.to - Math.max(tl.from, tl.slice.start ?? tl.from))} of history
        </span>
      )}
      <span className="tl-ranges" role="radiogroup" aria-label="Range">
        {RANGES.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={tl.range === r} className={`tl-range${tl.range === r ? " is-on" : ""}`} onClick={() => setRange(tl.key, r)} data-tl-range={r}>
            {RANGE_NAMES[r]}
          </button>
        ))}
      </span>
      <button type="button" className="tl-close" onClick={onClose} aria-label="Close the timeline" data-tip="Close: back to now" data-kbd={tl.scope === "grid" ? "H" : undefined} data-tl-close>
        ✕
      </button>
    </div>
  );
}

/** the nearest thing said, for a band or bar too narrow for the moment's column */
function useNearest(tl: Timeline) {
  usePlayhead(tl.head, Math.max(1000, (tl.to - tl.from) / 240));
  const events = tl.slice?.events;
  const t = tl.head.t;
  return useMemo(() => {
    if (!events || t === null) return null;
    const m = momentAround(events, t, Math.max(5 * 60_000, (tl.to - tl.from) / 24));
    return m.said.find((s) => s.id === m.nearest && !s.withheld) ?? null;
  }, [events, t, tl.from, tl.to]);
}

/** while the grid is shown as it was: when, for whom, and the way back */
function PastBanner({ tl }: { tl: Timeline }) {
  const head = usePlayhead(tl.head, 1000)!;
  if (head.t === null) return null;
  return (
    <div className="tl-banner" role="status" data-tl-banner>
      <span className="tl-banner-dot" aria-hidden />
      <span className="tl-banner-text">
        Looking at <b>{whenWords(head.t, Date.now() + tl.skew)}</b>
      </span>
      <span className="tl-banner-note">the grid as it was · only you see this</span>
      <button type="button" className="tl-banner-now" onClick={() => (head.pause(), head.seek(null))} data-tl-back>
        Back to now <kbd>Esc</kbd>
      </button>
    </div>
  );
}
