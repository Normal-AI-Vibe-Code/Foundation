/**
 * The grid behind the grid (2026-11-26, Josh: "show how the agent council is thinking, even opening up a hidden grid to
 * show what they are thinking and working on … the T3 agents … visualized somewhere that you can look at to see what
 * they are working on concurrently"). Opened by expanding an agent's thinking (its pane's run, `RunTrace`) or from the
 * T3 agents in the agents pane, over the grid it belongs to.
 *
 * agenttrail's language (github.com/sodiumsun/agenttrail, MIT) on Foundation's tokens: the grid's sections are cards in
 * columns along their wires, a status ring at each card's corner (an agent's violet arc while one is in it, a check once
 * written, ! when the last step there failed), "Editing / Revising / Retrying" when it changed in the last minute; each
 * agent's trail a dotted line in its crew colour through the sections it touched; a handoff a heavier dashed line where
 * one agent picked up after another; a T3 agent's folder a card of its files. Run cards at the right: what each agent
 * is doing, its plan, its last tools and how long each took. Focusing one hangs its chain (each thought, tool and answer)
 * under where it stands, on a dashed tether. What it reasoned, what it called tools with and what they answered are the
 * asker's alone (apps/server/src/worktrail.ts); everyone else sees the shape.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { boardMaps } from "@foundation/protocol";
import { api } from "../lib/api";
import { useActiveBoard } from "../shell/Presence";
import { requestSnap } from "../state/store";
import { closeTrail, focusTrail, useTrail } from "./state";
import { edgePath, fileKind, layoutTrail, whereNow, type GridSection, type GridWire, type TrailLane, type TrailNode, type TrailStep } from "./model";
import "./trail.css";

const crewVar = (hue: number) => `var(--color-crew-${((hue % 6) + 6) % 6})`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const dur = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.floor(ms / 60_000)} min`);
const since = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
const kb = (b?: number) => (b == null ? "" : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const viaWord = (l: TrailLane) => (l.kind === "t3" ? `T3 · ${l.via.slice(3)}` : "Council");

/** the lanes of a grid, asked again every 1.5 s while open (the server keeps them in memory, so it's cheap) */
function useLanes(boardId: string | undefined, on: boolean) {
  const [lanes, setLanes] = useState<TrailLane[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!boardId || !on) return;
    let live = true;
    const get = () =>
      api<{ lanes: TrailLane[] }>(`/api/boards/${encodeURIComponent(boardId)}/trail`)
        .then((r) => {
          if (!live) return;
          setLanes(r.lanes);
          setErr(null);
        })
        .catch((e: Error) => live && setErr(e.message));
    void get();
    const t = window.setInterval(get, 1500);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [boardId, on]);
  return { lanes, err };
}

/** the grid's sections and the wires between them, from the board document */
function useGridShape(on: boolean): { sections: GridSection[]; wires: GridWire[]; name: string } {
  const board = useActiveBoard();
  // read again whenever the document changes, while the map is open (it is mounted, closed, from the start)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!board || !on) return;
    setTick((t) => t + 1);
    const bump = () => setTick((t) => t + 1);
    board.doc.on("update", bump);
    return () => board.doc.off("update", bump);
  }, [board, on]);
  return useMemo(() => {
    if (!board) return { sections: [], wires: [], name: "" };
    const m = boardMaps(board.doc);
    const sections: GridSection[] = [...m.sections.values()].map((s) => ({ id: s.id, name: s.name, c0: s.c0, r0: s.r0, parent: (s as { parent?: string }).parent }));
    const sectionOf = (panel: string) => {
      const o = m.objects.get(panel) as { sectionId?: string } | undefined;
      if (o?.sectionId) return o.sectionId;
      // an app a section hosts is the section
      for (const s of m.sections.values()) if (s.host === panel) return s.id;
      return undefined;
    };
    const wires: GridWire[] = [];
    for (const l of m.links.values()) {
      const a = sectionOf(l.from.panel);
      const b = sectionOf(l.to.panel);
      if (a && b && a !== b) wires.push({ from: a, to: b });
    }
    return { sections, wires, name: String(m.meta.get("name") ?? "") || "This grid" };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, tick]);
}

export function TrailGrid({ name }: { name?: string }) {
  const t = useTrail();
  const board = useActiveBoard();
  const { lanes, err } = useLanes(board?.boardId, Boolean(t));
  const shape = useGridShape(Boolean(t));
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!t) return;
    const i = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(i);
  }, [t]);
  useEffect(() => {
    if (!t) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeTrail();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [t]);
  // a seat named by its name (it may have left the council) finds its newest lane
  const focus = useMemo(() => {
    if (!t || !lanes) return null;
    if (t.crew && lanes.some((l) => l.crew === t.crew)) return t.crew;
    if (t.name) return lanes.find((l) => l.name === t.name)?.crew ?? null;
    return null;
  }, [t, lanes]);
  const layout = useMemo(() => layoutTrail({ sections: shape.sections, wires: shape.wires, lanes: lanes ?? [], all, now }), [shape, lanes, all, now]);
  if (!t) return null;
  const working = (lanes ?? []).filter((l) => l.status === "working");
  const contested = layout.nodes.filter((n) => n.contested).length;
  const focused = lanes?.find((l) => l.crew === focus) ?? null;
  return (
    <div className="trail" role="dialog" aria-label="The agents' work, behind the grid" data-trail data-trail-focus={focus ?? ""}>
      <header className="trail-head">
        <div className="trail-title">
          <span className="trail-eyebrow">Behind the grid</span>
          <h2>{name || shape.name}</h2>
        </div>
        <p className="trail-sum" data-trail-sum>
          {lanes == null ? "Reading…" : working.length ? `${working.length} agent${working.length === 1 ? "" : "s"} at work` : "No agent at work now"}
          {lanes && lanes.length > working.length ? ` · ${lanes.length - working.length} finished lately` : ""}
          {contested ? ` · ${contested} section${contested === 1 ? "" : "s"} with two at once` : ""}
        </p>
        <span className="trail-acts">
          <button type="button" className={`trail-seg${all ? "" : " is-on"}`} onClick={() => setAll(false)} aria-pressed={!all}>
            Touched
          </button>
          <button type="button" className={`trail-seg${all ? " is-on" : ""}`} onClick={() => setAll(true)} aria-pressed={all}>
            All sections
          </button>
          <button type="button" className="trail-x" onClick={closeTrail} aria-label="Back to the grid" data-tip="Back to the grid (Esc)">
            ✕
          </button>
        </span>
      </header>
      {err && !lanes && <p className="trail-empty">Couldn't read the agents' work: {err}</p>}
      {lanes && lanes.length === 0 && (
        <p className="trail-empty" data-trail-empty>
          No agent has worked on this grid in the last three hours. Ask one from a section's council, or one of T3's agents in the agents pane, and its work shows here as it happens.
        </p>
      )}
      {lanes && lanes.length > 0 && <TrailCanvas layout={layout} lanes={lanes} focus={focus} focused={focused} now={now} />}
      {lanes && lanes.length > 0 && (
        <aside className="trail-runs" aria-label="Each agent's run">
          {lanes.map((l) => (
            <RunCard key={l.crew} lane={l} on={l.crew === focus} dim={Boolean(focus) && l.crew !== focus} now={now} />
          ))}
          <p className="trail-note">What an agent reasoned, and what its tools were given and answered, show only to the person who asked it. Everyone on the grid sees where it worked.</p>
        </aside>
      )}
    </div>
  );
}

function RunCard({ lane: l, on, dim, now }: { lane: TrailLane; on: boolean; dim: boolean; now: number }) {
  const tools = l.steps.filter((s) => s.kind === "tool");
  const last = tools.slice(-5).reverse();
  const live = l.status === "working";
  const lastThought = l.mine ? [...l.steps].reverse().find((s) => s.kind === "thought")?.summary : undefined;
  return (
    <section
      className={`trail-run is-${l.status}${on ? " is-on" : ""}${dim ? " is-dim" : ""}`}
      style={{ ["--crew" as string]: crewVar(l.hue) } as CSSProperties}
      data-trail-run={l.name}
      data-trail-kind={l.kind}
    >
      <button type="button" className="trail-run-head" onClick={() => focusTrail(on ? null : l.crew)} aria-expanded={on} data-tip={on ? "Show every agent" : `Follow ${l.name}'s chain`}>
        <span className="trail-face" aria-hidden>
          {l.name.slice(0, 1)}
          {live && <i className="trail-face-ring" />}
        </span>
        <span className="trail-run-who">
          <b>{l.name}</b>
          <span className="trail-run-meta">
            {viaWord(l)} · for {l.askerName} · {since(l.started, l.ended ?? now)}
          </span>
        </span>
        <span className={`trail-run-state is-${l.status}`}>{live ? "Working" : l.status === "done" ? "Done" : l.status === "error" ? "Failed" : "Stopped"}</span>
      </button>
      <p className="trail-run-doing" title={l.task}>
        {live && (
          <span className="trail-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        )}
        {l.home ? <span className="trail-run-home">{l.home.name}</span> : null}
        {clip(l.doing || "starting", 80)}
      </p>
      {lastThought && live && <p className="trail-run-thought">{clip(lastThought.trim().replace(/\s+/g, " "), 160)}</p>}
      {l.plan && l.plan.steps.length > 0 && (
        <ol className="trail-run-plan" aria-label="Its plan">
          {l.plan.steps.map((s, i) => (
            <li key={i} className={`is-${s.status}`}>
              <i aria-hidden />
              {s.text}
            </li>
          ))}
        </ol>
      )}
      {last.length > 0 && (
        <ul className="trail-run-tools" aria-label="Its last steps">
          {last.map((s, i) => (
            <li key={i} className={s.ok === false ? "is-bad" : s.ms == null ? "is-live" : "is-ok"}>
              <span className="trail-run-tool">{clip(s.label, 44)}</span>
              <span className="trail-run-ms">{s.ms == null ? "…" : dur(s.ms)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="trail-run-foot">
        {tools.length} step{tools.length === 1 ? "" : "s"}
        {l.sections.length ? ` · ${l.sections.length} section${l.sections.length === 1 ? "" : "s"}` : ""}
        {l.files.length ? ` · ${l.files.length} file${l.files.length === 1 ? "" : "s"}` : ""}
        {l.private && !l.mine ? " · read beyond the grid" : ""}
      </p>
    </section>
  );
}

/** the canvas: pan by dragging, zoom with the wheel, fit on open and when the shape changes */
function TrailCanvas({ layout, lanes, focus, focused, now }: { layout: ReturnType<typeof layoutTrail>; lanes: TrailLane[]; focus: string | null; focused: TrailLane | null; now: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const fitted = useRef("");
  const byCrew = useMemo(() => new Map(lanes.map((l) => [l.crew, l])), [lanes]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const anchor = focused ? nodeById.get(whereNow(focused) ?? "") ?? nodeById.get(`folder:${focused.crew}`) : undefined;
  const chainH = focused && anchor ? 40 + Math.min(focused.steps.length, 16) * 64 : 0;
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.max(layout.width, 1);
    const h = Math.max(layout.height + chainH, 1);
    // never so small the names can't be read: a map bigger than the window starts at its top left (or the followed
    // agent's section), and the rest is a drag away
    const k = Math.max(0.62, Math.min(1.1, (r.width - 360) / w, r.height / h));
    const room = r.width - 360;
    const at = anchor && w * k > room ? Math.min(32, room / 2 - (anchor.x + anchor.w / 2) * k) : Math.max(16, (room - w * k) / 2);
    setCam({ k, x: at, y: Math.max(16, (r.height - h * k) / 2) });
  }, [layout.width, layout.height, chainH, anchor]);
  useEffect(() => {
    const key = `${layout.nodes.map((n) => n.id).join(",")}|${focus ?? ""}`;
    if (key === fitted.current) return;
    fitted.current = key;
    fit();
  }, [layout, focus, fit]);
  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    setCam((c) => {
      const k = Math.min(2.2, Math.max(0.25, c.k * Math.exp(-e.deltaY * 0.0015)));
      return { k, x: px - ((px - c.x) * k) / c.k, y: py - ((py - c.y) * k) / c.k };
    });
  };
  const down = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest("button, a, [data-trail-capsule]")) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (d) setCam((c) => ({ ...c, x: d.cx + e.clientX - d.x, y: d.cy + e.clientY - d.y }));
  };
  const up = () => (drag.current = null);
  const near = cam.k >= 1.05;
  const far = cam.k <= 0.45;
  const center = (n: TrailNode) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
  return (
    <div
      ref={box}
      className={`trail-canvas${near ? " is-near" : ""}${far ? " is-far" : ""}${focus ? " is-focused" : ""}`}
      onWheel={onWheel}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{ ["--dot-x" as string]: `${cam.x}px`, ["--dot-y" as string]: `${cam.y}px`, ["--dot-k" as string]: `${24 * cam.k}px` } as CSSProperties}
    >
      <div className="trail-world" style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` }}>
        <svg className="trail-svg" width={layout.width} height={layout.height + chainH + 80} aria-hidden>
          <defs>
            <marker id="trail-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9" className="trail-arrow" />
            </marker>
          </defs>
          {layout.edges.map((e) => {
            const a = nodeById.get(e.from)!;
            const b = nodeById.get(e.to)!;
            return <path key={`${e.from}>${e.to}`} d={edgePath(a, b)} className={`trail-edge is-${e.kind}${e.active ? " is-active" : ""}`} markerEnd={e.kind === "wire" ? "url(#trail-arrow)" : undefined} />;
          })}
          {layout.paths.map((p) => {
            const pts = p.nodes.map((id) => center(nodeById.get(id)!));
            const on = !focus || focus === p.crew;
            return (
              <polyline
                key={p.crew}
                points={pts.map((q, i) => `${q.x + ((p.hue % 3) - 1) * 6},${q.y + ((p.hue % 3) - 1) * 6 + (i === 0 ? 0 : 0)}`).join(" ")}
                className={`trail-path${p.ended ? " is-ended" : ""}${on ? "" : " is-dim"}${focus === p.crew ? " is-on" : ""}`}
                style={{ ["--crew" as string]: crewVar(p.hue) } as CSSProperties}
                data-trail-path={byCrew.get(p.crew)?.name}
              />
            );
          })}
          {layout.handoffs.map((h, i) => {
            const n = nodeById.get(h.section)!;
            const a = byCrew.get(h.from);
            const b = byCrew.get(h.to);
            if (!a || !b) return null;
            const x = n.x - 18;
            return (
              <g key={i} className="trail-handoff" style={{ ["--crew" as string]: crewVar(b.hue) } as CSSProperties} data-trail-handoff={`${a.name}>${b.name}`}>
                <path d={`M${x},${n.y + 8} L${x},${n.y + n.h - 8}`} />
                <text x={x - 6} y={n.y + n.h / 2} textAnchor="end">
                  {a.name} ⇢ {b.name}
                </text>
              </g>
            );
          })}
          {focused && anchor && (
            <path d={`M${anchor.x + 28},${anchor.y + anchor.h} L${anchor.x + 28},${anchor.y + anchor.h + 28}`} className="trail-tether" style={{ ["--crew" as string]: crewVar(focused.hue) } as CSSProperties} />
          )}
        </svg>
        {layout.nodes.map((n) => (
          <Node key={n.id} n={n} lanes={byCrew} focus={focus} now={now} />
        ))}
        {focused && anchor && <Chain lane={focused} x={anchor.x} y={anchor.y + anchor.h + 28} />}
      </div>
      <span className="trail-zoom">
        <button type="button" onClick={fit} data-tip="Fit everything">
          Fit
        </button>
        <span>{Math.round(cam.k * 100)}%</span>
      </span>
      <span className="trail-legend" aria-hidden>
        <i className="is-path" /> an agent's way through
        <i className="is-handoff" /> picked up after another
        <i className="is-wire" /> a wire between sections
      </span>
    </div>
  );
}

function Ring({ state }: { state: TrailNode["state"] }) {
  return (
    <svg className={`trail-ring is-${state}`} viewBox="0 0 22 22" aria-hidden>
      <circle cx="11" cy="11" r="9" className="trail-ring-base" />
      {state === "active" && <circle cx="11" cy="11" r="9" className="trail-ring-arc" />}
      {state === "done" && <path d="M6.5 11.2 l3 3 l6 -6.4" className="trail-ring-mark" />}
      {state === "failed" && (
        <>
          <path d="M11 6.2 v6" className="trail-ring-mark" />
          <circle cx="11" cy="15.4" r="1" className="trail-ring-dot" />
        </>
      )}
    </svg>
  );
}

function Node({ n, lanes, focus, now }: { n: TrailNode; lanes: Map<string, TrailLane>; focus: string | null; now: number }) {
  const here = n.here.map((c) => lanes.get(c)).filter(Boolean) as TrailLane[];
  const by = n.by.map((c) => lanes.get(c)).filter(Boolean) as TrailLane[];
  const dim = Boolean(focus) && !n.by.includes(focus!) && !n.here.includes(focus!);
  const go = () => n.kind === "section" && requestSnap({ kind: "section", id: n.id });
  return (
    <div
      className={`trail-node is-${n.kind} is-${n.state}${n.contested ? " is-contested" : ""}${dim ? " is-dim" : ""}${n.activity ? " is-busy" : ""}`}
      style={{ left: n.x, top: n.y, width: n.w, minHeight: n.h } as CSSProperties}
      data-trail-node={n.name}
      data-trail-state={n.state}
    >
      <div className="trail-node-top">
        <span className="trail-kicker">{n.kind === "folder" ? "Folder · code" : n.writes ? `${n.writes} change${n.writes === 1 ? "" : "s"} · ${n.reads} read${n.reads === 1 ? "" : "s"}` : n.reads ? `${n.reads} read${n.reads === 1 ? "" : "s"}` : "Section"}</span>
        <Ring state={n.state} />
      </div>
      <h3 className="trail-node-name">
        {n.kind === "section" ? (
          <button type="button" onClick={go} data-tip="Go to it on the grid">
            {n.name}
          </button>
        ) : (
          n.name
        )}
      </h3>
      <div className="trail-node-foot">
        <span className="trail-chips">
          {(here.length ? here : by).slice(0, 3).map((l) => (
            <span key={l.crew} className={`trail-chip${n.here.includes(l.crew) ? " is-here" : ""}`} style={{ ["--crew" as string]: crewVar(l.hue) } as CSSProperties} data-tip={`${l.name}${n.here.includes(l.crew) ? ", here now" : ""}`}>
              {l.name.slice(0, 1)}
            </span>
          ))}
          {by.length > 3 && <span className="trail-chip is-more">+{by.length - 3}</span>}
        </span>
        {n.contested && <span className="trail-flag">Two at once</span>}
        {n.activity && (
          <span className="trail-busy">
            <i aria-hidden />
            {n.activity}
          </span>
        )}
      </div>
      {n.kind === "folder" && n.files && (
        <ul className="trail-files">
          {n.files.slice(0, 8).map((f) => (
            <li key={f.path} className={`is-${f.change}${now - f.at < 60_000 ? " is-fresh" : ""}`} title={`${f.path} · ${f.change}${f.bytes != null ? ` · ${kb(f.bytes)}` : ""}`}>
              <FileGlyph kind={fileKind(f.path)} />
              <span className="trail-file-path">{f.path}</span>
              <span className="trail-file-change">{f.change === "added" ? "+" : f.change === "removed" ? "−" : "~"}</span>
            </li>
          ))}
          {n.files.length > 8 && <li className="is-more">and {n.files.length - 8} more</li>}
        </ul>
      )}
      {n.kind === "section" && n.cards.length > 0 && (
        <ul className="trail-cards">
          {n.cards.slice(0, 6).map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => requestSnap({ kind: "object", id: c.id })}>
                {c.name || "A card"}
              </button>
              <span className="trail-chips">
                {c.by.map((cr) => {
                  const l = lanes.get(cr);
                  return l ? <span key={cr} className="trail-chip is-small" style={{ ["--crew" as string]: crewVar(l.hue) } as CSSProperties} /> : null;
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileGlyph({ kind }: { kind: ReturnType<typeof fileKind> }) {
  const d: Record<string, string> = {
    code: "M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5",
    image: "M2.5 3.5h11v9h-11zM2.5 10.5l3.5-3 3 2.5 2-1.5 2.5 2",
    page: "M2.5 3.5h11v9h-11zM2.5 6h11",
    doc: "M4 2.5h5.5l2.5 2.5v8.5H4zM6 8h4M6 10.5h4",
    data: "M3 4.5c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2.2 2 5 2s5-.9 5-2",
    shell: "M2.5 3.5h11v9h-11zM4.5 6.5l2 1.5-2 1.5M8 10h3",
    file: "M4 2.5h5.5l2.5 2.5v8.5H4z",
  };
  return (
    <svg className="trail-file-glyph" viewBox="0 0 16 16" aria-hidden>
      <path d={d[kind]} />
    </svg>
  );
}

/** the focused agent's chain, hung under where it stands: each thought, tool and answer, staggered in */
function Chain({ lane, x, y }: { lane: TrailLane; x: number; y: number }) {
  const [all, setAll] = useState(false);
  const steps = lane.steps;
  const shown = all ? steps : steps.slice(-16);
  return (
    <ol className="trail-chain" style={{ left: x, top: y, ["--crew" as string]: crewVar(lane.hue) } as CSSProperties} aria-label={`${lane.name}'s chain`} data-trail-chain={lane.name}>
      <li className="trail-chain-ask">
        <span className="trail-kicker">Asked by {lane.askerName}</span>
        <p>“{clip(lane.task, 220)}”</p>
      </li>
      {steps.length > shown.length && (
        <li className="trail-chain-more">
          <button type="button" onClick={() => setAll(true)}>
            {steps.length - shown.length} earlier step{steps.length - shown.length === 1 ? "" : "s"}
          </button>
        </li>
      )}
      {shown.map((s, i) => (
        <Capsule key={`${s.at}-${i}`} s={s} i={i} mine={lane.mine} />
      ))}
      {steps.length === 0 && <li className="trail-chain-quiet">{lane.status === "working" ? "Reading the ask…" : "No step on the grid."}</li>}
      {!lane.mine && <li className="trail-chain-quiet">Its reasoning and what its tools answered are {lane.askerName}'s to see.</li>}
      {lane.kind === "t3" && lane.mine && <li className="trail-chain-quiet">A T3 agent's own reasoning stays in T3; here are its steps on the grid and the files it writes.</li>}
    </ol>
  );
}

function Capsule({ s, i, mine }: { s: TrailStep; i: number; mine: boolean }) {
  const [open, setOpen] = useState(false);
  const kind = s.kind === "tool" ? (s.ok === false ? "bad" : s.ms == null ? "live" : s.read ? "read" : "write") : s.kind;
  const text = s.kind === "tool" ? s.summary : s.summary;
  const long = (text?.length ?? 0) > 160;
  const args =
    s.input &&
    Object.entries(s.input)
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${clip(typeof v === "string" ? v : JSON.stringify(v), 48)}`)
      .join(" · ");
  return (
    <li className={`trail-capsule is-${kind}`} style={{ ["--i" as string]: Math.min(i, 12) } as CSSProperties} data-trail-capsule={s.kind}>
      <span className="trail-capsule-mark" aria-hidden />
      <div className="trail-capsule-body">
        <span className="trail-capsule-head">
          <b>{s.kind === "thought" ? "Thought" : s.kind === "said" ? "Said" : clip(s.label, 52)}</b>
          {s.kind === "tool" && <span className="trail-capsule-ms">{s.ms == null ? "running" : dur(s.ms)}</span>}
        </span>
        {mine && args && <code className="trail-capsule-args">{args}</code>}
        {text && (mine || s.kind !== "tool") && (
          <p className="trail-capsule-text">
            {s.kind === "tool" && s.ok === false ? "Failed: " : ""}
            {open || !long ? text.trim() : `${text.trim().slice(0, 150)}…`}
            {long && (
              <button type="button" className="trail-capsule-more" onClick={() => setOpen(!open)}>
                {open ? "Less" : "All of it"}
              </button>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/** the same map with given lanes, for #/design (no server, no focus store: a run card's press follows locally) */
export function TrailSpecimen({ lanes, sections, wires, name, focus: initial = null, now }: { lanes: TrailLane[]; sections: GridSection[]; wires: GridWire[]; name: string; focus?: string | null; now: number }) {
  const [focus, setFocus] = useState<string | null>(initial);
  const layout = useMemo(() => layoutTrail({ sections, wires, lanes, now }), [sections, wires, lanes, now]);
  const focused = lanes.find((l) => l.crew === focus) ?? null;
  const press = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    const card = el.closest("[data-trail-run]");
    if (!card || !el.closest(".trail-run-head")) return;
    e.stopPropagation();
    const crew = lanes.find((l) => l.name === card.getAttribute("data-trail-run"))?.crew ?? null;
    setFocus((f) => (f === crew ? null : crew));
  };
  return (
    <div className="trail is-specimen" data-trail-specimen onClickCapture={press}>
      <header className="trail-head">
        <div className="trail-title">
          <span className="trail-eyebrow">Behind the grid</span>
          <h2>{name}</h2>
        </div>
        <p className="trail-sum">{lanes.filter((l) => l.status === "working").length} agents at work</p>
      </header>
      <TrailCanvas layout={layout} lanes={lanes} focus={focus} focused={focused} now={now} />
      <aside className="trail-runs">
        {lanes.map((l) => (
          <RunCard key={l.crew} lane={l} on={l.crew === focus} dim={Boolean(focus) && l.crew !== focus} now={now} />
        ))}
      </aside>
    </div>
  );
}
