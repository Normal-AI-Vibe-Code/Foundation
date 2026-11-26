/**
 * The lanes of a timeline, drawn on one canvas (the marks change only when the slice or the width does), with the
 * playhead, the history's edge, a section's own playhead and the roll-over as DOM over it. The playhead moves on
 * every pointer move without React: `Playhead.onMove` sets its transform. Used by the grid's band (all six lanes,
 * named) and a section's bar (condensed to one or two rows).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { onLook } from "@foundation/ui";
import { TIMELINE_LANE_NAMES, type TimelineEvent } from "@foundation/protocol";
import { getState, requestSnap } from "../state/store";
import { densityLevels, hitMark, layoutLanes, marksOf, stepMs, tOf, tickLabel, ticks, whenWords, xOf, type Mark } from "./logic";
import type { Playhead, Timeline } from "./model";

/** frame what a mark names: its card if it's still here, else its section */
export function frameEvent(e: TimelineEvent) {
  const st = getState();
  if (e.object && (st.notes[e.object] || st.tables[e.object] || st.panels[e.object] || st.maps[e.object] || st.media[e.object])) requestSnap({ kind: "object", id: e.object });
  else if (e.section && st.sections[e.section]) requestSnap({ kind: "section", id: e.section });
}

interface Marker {
  id: string;
  name: string;
  head: Playhead;
}

export function Lanes({ tl, rows = 0, names = true, axis = true, seek, markers = [], label }: { tl: Timeline; rows?: 0 | 1 | 2; names?: boolean; axis?: boolean; seek: (t: number | null) => void; markers?: Marker[]; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [look, setLook] = useState(0);
  const [hover, setHover] = useState<{ m: Mark; x: number } | null>(null);
  const events = useMemo(() => tl.slice?.events ?? [], [tl.slice]);
  const layout = useMemo(() => layoutLanes(events, rows ? { rows, row: 10, line: 10, gap: 2 } : { row: 14, line: 5, gap: 4 }), [events, rows]);
  const { from, to } = tl;
  const marks = useMemo(() => marksOf(events, layout.lanes, from, to, w, to), [events, layout, from, to, w]);
  const start = tl.slice?.start ?? null;
  const begins = start !== null && start > from ? xOf(start, from, to, w) : null;

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => onLook(() => setLook((n) => n + 1)), []);

  // the marks, drawn once per slice, width or look
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const h = layout.height;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(c);
    const tok = (n: string) => cs.getPropertyValue(n).trim();
    const ink = tok("--color-frost");
    const agent = tok("--color-agent");
    const lineC = tok("--color-line-strong");
    const dim = tok("--color-dim");
    const pulse = tok("--color-pulse");
    // the texture: how much changed in each step, faint behind every lane
    const levels = densityLevels(tl.slice?.density ?? []);
    if (levels.length) {
      const step = w / levels.length;
      ctx.fillStyle = ink;
      levels.forEach((v, i) => {
        if (!v) return;
        ctx.globalAlpha = 0.015 + v * 0.055;
        ctx.fillRect(i * step, 0, Math.max(1, step - 0.5), h);
      });
      ctx.globalAlpha = 1;
    }
    // before keeping began: nothing is known, hatched
    if (begins !== null && begins > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, begins, h);
      ctx.clip();
      ctx.strokeStyle = lineC;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      for (let x = -h; x < begins; x += 7) {
        ctx.beginPath();
        ctx.moveTo(x, h);
        ctx.lineTo(x + h, 0);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    // empty lanes are a line; lanes with something have a faint floor
    for (const l of layout.lanes) {
      ctx.fillStyle = lineC;
      if (l.empty && !rows) ctx.fillRect(0, l.y + l.h / 2, w, 1);
      else if (!rows) {
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, l.y + l.h - 1, w, 1);
        ctx.globalAlpha = 1;
      }
    }
    // a person's colour may be a token ("var(--viz-3)"): the canvas needs it resolved
    const resolve = (c: string) => (c.startsWith("var(") ? tok(c.slice(4, -1).trim()) || pulse : c);
    for (const m of marks) {
      const color = m.tone === "agent" ? agent : m.tone === "person" ? resolve(m.color || pulse) : m.tone === "dim" ? dim : ink;
      const y = m.y;
      const h2 = m.h;
      if (m.shape === "span") {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5;
        roundRect(ctx, m.x0, y + 2, Math.max(3, m.x1 - m.x0), h2 - 4, 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillRect(m.x0, y + 2, 1.5, h2 - 4);
      } else if (m.shape === "hollow") {
        // behind the scenes: it happened, and no cursor showed it
        ctx.strokeStyle = agent;
        ctx.lineWidth = 1.25;
        if (m.x1 > m.x0 + 2) {
          roundRect(ctx, m.x0 + 0.5, y + 2.5, m.x1 - m.x0 - 1, h2 - 5, 2);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(m.x0, y + h2 / 2, Math.max(2, h2 / 2 - 2.5), 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (m.shape === "note") {
        // a note to play: a round mark, video squared
        ctx.fillStyle = color;
        const r = Math.max(2.5, h2 / 2 - 2.5);
        if (m.event.kind === "note.video") {
          roundRect(ctx, m.x0 - r, y + h2 / 2 - r, r * 2, r * 2, 1.5);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(m.x0, y + h2 / 2, r, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(m.x0) - 0.75, y + 1, 1.5, h2 - 2);
      }
    }
  }, [marks, layout, w, look, begins, tl.slice, rows]);

  // the playhead: placed on every move, without React
  const place = useCallback(() => {
    const el = line.current;
    if (!el) return;
    const t = tl.head.t;
    const x = t === null ? w : xOf(t, from, to, w);
    el.style.transform = `translateX(${x}px)`;
    el.dataset.now = t === null ? "1" : "0";
  }, [tl.head, from, to, w]);
  useLayoutEffect(() => {
    place();
    return tl.head.onMove(place);
  }, [place, tl.head]);

  const tAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    // the track may be drawn scaled (a section's bar on the grid): measure it as drawn
    const k = r.width / Math.max(1, w);
    return { t: tOf((clientX - r.left) / k, from, to, w), x: (clientX - r.left) / k, k, r };
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.focus({ preventScroll: true });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
    const at = tAt(e.clientX);
    const y = (e.clientY - at.r.top) / at.k;
    const picked = hitMark(marks, at.x, y);
    const x0 = e.clientX;
    let moved = false;
    tl.head.pause();
    seek(at.t);
    setHover(null);
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      seek(tAt(ev.clientX).t);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      // a press on a mark: the playhead goes to it, and what it names is framed
      if (!moved && picked) {
        seek(picked.event.at);
        frameEvent(picked.event);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onHover = (e: React.PointerEvent) => {
    if (e.buttons) return;
    const at = tAt(e.clientX);
    const m = hitMark(marks, at.x, (e.clientY - at.r.top) / at.k);
    setHover((h) => (h?.m.id === m?.id ? h : m ? { m, x: m.x0 } : null));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const span = to - from;
    const t = tl.head.t ?? to;
    // a young grid's window is shorter than its range's name: the step is never more than a fortieth of it
    const step = Math.min(stepMs(tl.range, span, e.shiftKey), Math.max(1000, (span / 40) * (e.shiftKey ? 4 : 1)));
    let next: number | null | undefined;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = t - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = t + step >= to ? null : t + step;
    else if (e.key === "Home") next = Math.max(from, start ?? from);
    else if (e.key === "End") next = null;
    else if (e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      tl.head.toggle();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    tl.head.pause();
    seek(next);
  };
  const tk = axis && w ? ticks(from, to, w) : [];
  const t = tl.head.t;
  return (
    <div className={`tl-lanes${names ? " has-names" : ""}${rows ? ` is-rows-${rows}` : ""}`} data-tl-lanes={tl.key}>
      {names && (
        <div className="tl-names" style={{ height: layout.height }} aria-hidden>
          {layout.lanes.map((l) => (
            <span key={l.lane} className={`tl-name${l.empty ? " is-empty" : ""}`} style={{ top: l.y, height: l.empty ? undefined : l.h }}>
              {l.empty ? null : TIMELINE_LANE_NAMES[l.lane]}
            </span>
          ))}
        </div>
      )}
      <div className="tl-track-col">
        <div
          ref={track}
          className="tl-track"
          style={{ height: layout.height }}
          tabIndex={0}
          role="slider"
          aria-label={label}
          aria-valuemin={Math.round(from / 1000)}
          aria-valuemax={Math.round(to / 1000)}
          aria-valuenow={Math.round((t ?? to) / 1000)}
          aria-valuetext={whenWords(t)}
          onPointerDown={onDown}
          onPointerMove={onHover}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          data-tl-track={tl.key}
          data-tl-marks={marks.length}
          data-tl-changes={marks.filter((m) => m.lane === "changes").length}
          data-tl-from={Math.round(from)}
          data-tl-to={Math.round(to)}
        >
          <canvas ref={canvas} className="tl-canvas" style={{ width: w, height: layout.height }} />
          {begins !== null && (
            <span className={`tl-begins${begins < 200 ? " is-right" : ""}`} style={{ transform: `translateX(${begins}px)` }} data-tl-begins>
              <span className="tl-begins-words">History begins {whenWords(start)}</span>
            </span>
          )}
          {markers.map((m) => (
            <SectionMarker key={m.id} m={m} from={from} to={to} w={w} />
          ))}
          <div ref={line} className="tl-playhead" aria-hidden>
            <span className="tl-playhead-knob" />
          </div>
          {hover && (
            <div className={`tl-tip${hover.x > w - 220 ? " is-left" : ""}`} style={{ transform: `translateX(${hover.x}px)`, top: hover.m.y + hover.m.h + 4 }} role="tooltip" data-tl-tip>
              <TipBody e={hover.m.event} />
            </div>
          )}
        </div>
        {axis && (
          <div className="tl-axis" aria-hidden>
            {tk.map((k) => (
              <span key={k.t} className={`tl-tick${k.day ? " is-day" : ""}`} style={{ transform: `translateX(${k.x}px)` }}>
                {tickLabel(k.t, from, to)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TipBody({ e }: { e: TimelineEvent }) {
  const body = typeof e.data?.body === "string" ? (e.data.body as string) : null;
  return (
    <>
      <span className="tl-tip-head">
        <b className={e.actor.kind === "agent" ? "is-agent" : undefined}>{e.actor.name}</b> {e.text}
      </span>
      {body && <span className="tl-tip-body">{body.length > 160 ? `${body.slice(0, 157)}…` : body}</span>}
      {e.withheld && <span className="tl-tip-withheld">{e.withheld}</span>}
      <span className="tl-tip-when">
        {whenWords(e.at)}
        {e.end !== undefined ? (e.end === null ? " · still going" : ` – ${whenWords(e.end)}`) : ""}
      </span>
    </>
  );
}

/** a section's own playhead on the grid's band: a second, named marker */
function SectionMarker({ m, from, to, w }: { m: Marker; from: number; to: number; w: number }) {
  const el = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const e = el.current;
      if (!e) return;
      const t = m.head.t;
      e.style.display = t === null ? "none" : "";
      if (t !== null) e.style.transform = `translateX(${xOf(t, from, to, w)}px)`;
    };
    place();
    return m.head.onMove(place);
  }, [m.head, from, to, w]);
  return (
    <span ref={el} className="tl-marker" data-tl-marker={m.id}>
      <span className="tl-marker-name">{m.name}</span>
    </span>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
