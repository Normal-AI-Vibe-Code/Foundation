/**
 * The crew on the board: every agent at work is a cursor with a name, gliding
 * to what it's about to change (the server aims it, then waits a beat, then
 * writes; see apps/server/src/crew.ts), saying in a few words what it's doing.
 * Several can work at once; each has its own colour from the violet family.
 *
 * Positions are worked out here, from the target's place in this browser's
 * layout, and driven by springs that write `transform` directly: no React
 * render per frame. An agent you asked rises from the voice sheet; anyone
 * else's appears where it first works.
 *
 * `CrewGuide`: when an agent brings you somewhere (bring_view), your view
 * glides there, unless you were moving around in the last moments, in which
 * case it asks first. Back always returns you to where you were.
 *
 * `CrewFollow`: follow an agent (the roster's Follow): your view rides along
 * with its cursor, keeping your zoom, until you move the view yourself or the
 * agent leaves. A pill under the top bar says whom you're following, with Stop.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { presets, Spring, Spring2D, type SpringConfig } from "../physics/spring";
import { camera, onCamera, toWorld } from "../state/camera";
import { floorInsets } from "../state/ui";
import { CELL_H, CELL_W, COLHEAD_H, getState, HEADER_H, objectsInSection, objectWorldRect, requestSnap, ROWNUM_W, sectionBodyRect, subscribe } from "../state/store";
import { portPoint } from "./ports";
import type { CrewPresence, PeerState } from "../sync/board";
import { useBoardTick } from "./Presence";

/** a cursor's trip: quick, settles without wobble (ζ ≈ 0.93) */
const TRAVEL: SpringConfig = { stiffness: 140, damping: 22, mass: 1, restDelta: 0.05, restSpeed: 0.05 };

export type CrewPeer = PeerState & { crew: CrewPresence };

export function crewPeers(peers: PeerState[]): CrewPeer[] {
  return peers.filter((p): p is CrewPeer => !!p.crew);
}

/** where a cursor points on its target, in world px (inside the card, near its top-left) */
export function aimPoint(target: CrewPresence["target"], slot = 0): { x: number; y: number } | null {
  if (!target) return null;
  const st = getState();
  let r: { x: number; y: number; w: number; h: number } | null = null;
  let within: { x: number; y: number; w: number; h: number } | null = null;
  if (target.kind === "section") {
    const s = st.sections[target.id];
    if (!s) return null;
    // a section: where the next card will land (after the last one in its flow), so the cursor is
    // already there when it appears; an empty section, just inside its top-left
    const body = sectionBodyRect(st.grid, s);
    const docked = objectsInSection(s.id).filter((o) => o.id !== s.host && !o.float);
    let x = body.x + 40;
    let y = body.y + 36;
    if (docked.length) {
      const last = docked.reduce((a, b) => (b.bornAt > a.bornAt ? b : a));
      const lr = objectWorldRect(last);
      if (lr && lr.x + lr.w + 26 + 220 < body.x + body.w) {
        x = lr.x + lr.w + 26 + 28;
        y = lr.y + 28;
      } else if (lr) {
        const bottom = Math.max(...docked.map((o) => objectWorldRect(o)).filter(Boolean).map((q) => q!.y + q!.h));
        y = bottom + 26 + 28;
      }
    }
    x += slot * 34;
    y += slot * 10;
    return { x: Math.max(body.x + 12, Math.min(body.x + body.w - 120, x)), y: Math.max(body.y + 8, Math.min(body.y + body.h - 56, y)) };
  } else {
    const o = st.tables[target.id] ?? st.maps[target.id] ?? st.notes[target.id] ?? st.media[target.id] ?? st.panels[target.id];
    // pointing at something precise: the tip sits on it
    const exact = o && pointSpot(target);
    if (exact) return exact;
    if (o) r = objectWorldRect(o);
    const sec = o ? st.sections[o.sectionId] : undefined;
    if (sec) within = sectionBodyRect(st.grid, sec);
  }
  if (!r) return null;
  // two agents on one target stand apart
  let x = r.x + Math.min(48, r.w * 0.22) + slot * 34;
  let y = r.y + Math.min(30, r.h * 0.22) + slot * 10;
  // a card scrolled out of its section's view: wait at the section's edge nearest it, never outside the section
  if (within) {
    x = Math.max(within.x + 12, Math.min(within.x + within.w - 120, x));
    y = Math.max(within.y + 8, Math.min(within.y + within.h - 56, y));
  }
  return { x, y };
}

/** "B3" → column 1, row 2 (zero-based) */
export function parseCell(cell: string): { c: number; r: number } | null {
  const m = /^([A-Za-z]{1,3})([1-9][0-9]*)$/.exec(cell.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { c: c - 1, r: Number(m[2]) - 1 };
}

/** a table cell or a panel's port, in world px, for an agent pointing at it (null: not something precise) */
function pointSpot(target: NonNullable<CrewPresence["target"]>) {
  const st = getState();
  if (target.cell && st.tables[target.id]) {
    const t = st.tables[target.id];
    const at = parseCell(target.cell);
    const r = objectWorldRect(t);
    if (!at || !r || at.c >= t.cols || at.r >= t.rows) return null;
    const s = r.s ?? 1;
    return { x: r.x + (ROWNUM_W + at.c * CELL_W + CELL_W * 0.35) * s, y: r.y + (HEADER_H + COLHEAD_H + at.r * CELL_H + CELL_H * 0.55) * s };
  }
  if (target.port && st.panels[target.id]) {
    const p = st.panels[target.id];
    const port = p.ports.find((x) => x.id === target.port || x.name === target.port);
    return port ? portPoint(p, port.id) : null;
  }
  return null;
}

/** where the voice sheet is, in world px: an agent you asked rises from it */
function sheetPoint() {
  return toWorld(camera.width / 2, camera.height - 96);
}

export function CrewCursors() {
  const board = useBoardTick();
  const layer = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      onCamera((c) => {
        layer.current?.style.setProperty("--inv-scale", String(1 / c.scale));
      }),
    [],
  );
  const crew = crewPeers(board?.peers() ?? []);
  const me = board?.user.id;
  // agents aiming at the same thing take turns standing beside each other
  const slots = new Map<number, number>();
  const byTarget = new Map<string, number>();
  for (const p of crew) {
    const k = p.crew.target?.id ?? "";
    const n = byTarget.get(k) ?? 0;
    slots.set(p.clientId, n);
    byTarget.set(k, n + 1);
  }
  return (
    <div ref={layer} className="crew-layer" aria-hidden>
      {crew.map((p) => (
        <CrewCursor key={p.clientId} peer={p} mine={p.crew.asker === me} slot={slots.get(p.clientId) ?? 0} />
      ))}
    </div>
  );
}

function CrewCursor({ peer, mine, slot }: { peer: CrewPeer; mine: boolean; slot: number }) {
  const el = useRef<HTMLDivElement>(null);
  const spring = useRef<Spring2D | null>(null);
  const peerRef = useRef(peer);
  peerRef.current = peer;
  const slotRef = useRef(slot);
  slotRef.current = slot;
  const [placed, setPlaced] = useState(false);
  const placeRef = useRef<(() => void) | null>(null);

  // arriving: a pop on the pop spring (the one overshoot, for an arrival), written to the arrow and tag.
  // A spring, not a CSS animation: it keeps time on its own when the page's animation clock stalls,
  // so a cursor can never be left invisible at the start of its entrance.
  useEffect(() => {
    if (!placed) return;
    const node = el.current;
    const parts = node ? [node.querySelector<HTMLElement>(".crew-arrow"), node.querySelector<HTMLElement>(".crew-tag")] : [];
    const pop = new Spring(0.55, presets.pop);
    const pose = (v: number) => {
      for (const p of parts) {
        if (!p) continue;
        p.style.scale = v.toFixed(3);
        p.style.opacity = Math.min(1, Math.max(0, (v - 0.55) / 0.4)).toFixed(3);
      }
    };
    pose(0.55); // the start pose now, not a frame late (no flash at full size)
    const off = pop.onChange(pose);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) pop.set(1);
    else pop.to(1);
    return () => {
      off();
      pop.set(1);
    };
  }, [placed]);

  useEffect(() => {
    let last = { x: 0, y: 0, t: performance.now() };
    let lean = 0;
    const write = () => {
      const s = spring.current;
      const node = el.current;
      if (!s || !node) return;
      const x = s.x.value;
      const y = s.y.value;
      const now = performance.now();
      const dt = Math.max(1, now - last.t);
      // lean into the trip a little, upright at rest
      const target = Math.max(-14, Math.min(14, ((x - last.x) / dt) * 4 * camera.scale));
      lean += (target - lean) * 0.25;
      if (Math.abs(lean) < 0.05) lean = 0;
      last = { x, y, t: now };
      node.style.transform = `translate3d(${x}px, ${y}px, 0) scale(var(--inv-scale, 1)) rotate(${lean.toFixed(2)}deg)`;
    };
    const place = () => {
      const p = aimPoint(peerRef.current.crew.target, slotRef.current);
      if (!spring.current) {
        const start = p && !mine ? p : mine ? sheetPoint() : null;
        if (!start) return; // somebody else's agent, nowhere yet: it appears where it first works
        spring.current = new Spring2D(start.x, start.y, TRAVEL);
        spring.current.x.onChange(write);
        spring.current.y.onChange(write);
        write();
        setPlaced(true);
      }
      if (p) {
        const s = spring.current;
        if (Math.abs(s.x.goal - p.x) > 0.5 || Math.abs(s.y.goal - p.y) > 0.5) s.to(p.x, p.y);
      }
    };
    placeRef.current = place;
    place();
    const offStore = subscribe(place); // cards move, sections resize, the target appears
    return () => {
      offStore();
    };
  }, [mine]);

  // a new target, or a new slot beside another agent (awareness, not the store, says so)
  useEffect(() => placeRef.current?.(), [peer.crew.target?.id, peer.crew.target?.kind, peer.crew.target?.cell, peer.crew.target?.port, slot]);

  const c = peer.crew;
  const done = c.status !== "working";
  return (
    <div
      ref={el}
      className={`crew-cursor${placed ? " is-placed" : ""}${done ? ` is-${c.status}` : ""}${mine ? " is-mine" : ""}${!done && (c.target?.cell || c.target?.port) ? " is-pointing" : ""}`}
      style={{ ["--crew" as string]: `var(--color-crew-${c.hue % 6})` }}
      data-crew={c.id}
      data-crew-name={peer.user.name}
      data-target={c.target?.id ?? ""}
    >
      <svg className="crew-arrow" width="20" height="22" viewBox="0 0 20 22">
        <path d="M2 2 L17.5 10.5 L10.4 12.3 L7 19.5 Z" fill="var(--crew)" stroke="var(--color-raise)" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      <span className="crew-spark" />
      <span className="crew-laser" aria-hidden />
      <div className="crew-tag">
        <span className="crew-name">
          ✦ {peer.user.name}
          {c.leadName && <span className="crew-with"> · with {c.leadName}</span>}
        </span>
        <span className="crew-doing">{done ? (c.status === "done" ? "✓ done" : c.status === "stopped" ? "stopped" : "hit a problem") : c.doing}</span>
      </div>
    </div>
  );
}

// ---------- bringing you somewhere ----------

let lastInteract = 0;
/** the person moved the view or the pointer with intent just now (a gesture, a key, the wheel) */
export function recentlyBusy(ms = 1800) {
  return performance.now() - lastInteract < ms;
}

interface GuideOffer {
  nonce: number;
  agent: string;
  hue: number;
  name: string;
  note?: string;
  target: { id: string; kind: "object" | "section" };
  /** brought: we moved; asked: we're asking first */
  mode: "brought" | "asked";
  back?: { x: number; y: number; scale: number };
}

export function CrewGuide() {
  const board = useBoardTick();
  const seen = useRef(new Set<number>());
  const [offer, setOffer] = useState<GuideOffer | null>(null);

  useEffect(() => {
    const busy = () => (lastInteract = performance.now());
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", busy, opts);
    window.addEventListener("wheel", busy, opts);
    window.addEventListener("keydown", busy, opts);
    return () => {
      window.removeEventListener("pointerdown", busy, opts);
      window.removeEventListener("wheel", busy, opts);
      window.removeEventListener("keydown", busy, opts);
    };
  }, []);

  const me = board?.user.id;
  const crew = crewPeers(board?.peers() ?? []);
  useEffect(() => {
    for (const p of crew) {
      const g = p.crew.guide;
      if (!g || g.to !== me || seen.current.has(g.nonce)) continue;
      seen.current.add(g.nonce);
      const base = { nonce: g.nonce, agent: p.user.name, hue: p.crew.hue, name: g.name, note: g.note, target: g.target };
      if (recentlyBusy()) {
        setOffer({ ...base, mode: "asked" });
      } else {
        const back = { x: camera.x, y: camera.y, scale: camera.scale };
        requestSnap({ kind: g.target.kind, id: g.target.id });
        setOffer({ ...base, mode: "brought", back });
      }
    }
  });

  // it says so for a while, then goes (Back stays offered while it shows)
  useEffect(() => {
    if (!offer) return;
    const t = setTimeout(() => setOffer((o) => (o?.nonce === offer.nonce ? null : o)), offer.mode === "asked" ? 15_000 : 20_000);
    return () => clearTimeout(t);
  }, [offer]);

  const go = () => {
    if (!offer) return;
    const back = { x: camera.x, y: camera.y, scale: camera.scale };
    requestSnap({ kind: offer.target.kind, id: offer.target.id });
    setOffer({ ...offer, mode: "brought", back });
  };
  const goBack = () => {
    if (offer?.back) requestSnap({ kind: "view", ...offer.back });
    setOffer(null);
  };

  return (
    <AnimatePresence>
      {offer && (
        <motion.div
          key={offer.nonce}
          className="crew-guide f-glass"
          style={{ ["--crew" as string]: `var(--color-crew-${offer.hue % 6})` }}
          initial={{ opacity: 0, y: -10, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          role="status"
          data-mode={offer.mode}
        >
          <span className="crew-guide-dot" />
          <span className="crew-guide-text">
            <b>{offer.agent}</b> {offer.mode === "brought" ? "brought you to" : "wants to show you"} <b>{offer.name}</b>
            {offer.note && <span className="crew-guide-note"> · {offer.note}</span>}
          </span>
          {offer.mode === "brought" ? (
            <button className="f-pill crew-guide-back" onClick={goBack} data-tip="Back to where you were">
              ← Back
            </button>
          ) : (
            <>
              <button className="f-pill is-agent" onClick={go}>
                Go
              </button>
              <button className="crew-guide-x" onClick={() => setOffer(null)} aria-label="Not now" data-tip="Not now">
                ✕
              </button>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- following an agent ----------

let following: string | null = null;
const followSubs = new Set<() => void>();
const followEmit = () => followSubs.forEach((f) => f());

/** ride along with this agent's cursor (its crew id); null stops */
export function followCrew(id: string | null) {
  following = id;
  followEmit();
}
export function followingCrew() {
  return following;
}
export function useFollowing() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    followSubs.add(f);
    return () => {
      followSubs.delete(f);
    };
  }, []);
  return following;
}

/** the camera that puts world point p in the middle of the open paper, at the current zoom */
export function viewCentredOn(p: { x: number; y: number }) {
  const f = floorInsets();
  const cx = f.left + (camera.width - f.left - f.right) / 2;
  const cy = f.top + (camera.height - f.top) / 2;
  return { x: cx - p.x * camera.scale, y: cy - p.y * camera.scale, scale: camera.scale };
}

/** is p inside the middle of the open paper (the view only moves when the cursor nears an edge) */
function wellInView(p: { x: number; y: number }) {
  const f = floorInsets();
  const vx = p.x * camera.scale + camera.x;
  const vy = p.y * camera.scale + camera.y;
  const w = camera.width - f.left - f.right;
  const h = camera.height - f.top;
  return vx > f.left + w * 0.2 && vx < f.left + w * 0.8 && vy > f.top + h * 0.2 && vy < f.top + h * 0.8;
}

export function CrewFollow() {
  const board = useBoardTick();
  const id = useFollowing();
  const crew = crewPeers(board?.peers() ?? []);
  const peer = id ? crew.find((p) => p.crew.id === id) : undefined;
  const last = useRef("");
  const lastGlide = useRef(0);

  // the agent left the board: stop (after a beat, so its "done" can be seen)
  useEffect(() => {
    if (!id || peer) return;
    const t = setTimeout(() => following === id && followCrew(null), 1200);
    return () => clearTimeout(t);
  }, [id, peer]);

  // you moved the view yourself: stop following (a press on the pill itself doesn't count)
  useEffect(() => {
    if (!id) return;
    const stop = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.(".crew-follow, .crew-row, .talk-sheet")) return;
      followCrew(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && followCrew(null);
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", stop, opts);
    window.addEventListener("wheel", stop, opts);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", stop, opts);
      window.removeEventListener("wheel", stop, opts);
      window.removeEventListener("keydown", key, true);
    };
  }, [id]);

  // ride along: when the agent aims somewhere new that's near the edge (or off screen), glide there
  useEffect(() => {
    if (!peer?.crew.target) return;
    const key = `${peer.crew.target.kind}:${peer.crew.target.id}`;
    // one glide per new target; the same target only again once the last glide has had time to land
    // (a snap re-renders the board, and this runs on every render)
    const now = performance.now();
    if (key === last.current && now - lastGlide.current < 900) return;
    const p = aimPoint(peer.crew.target);
    if (!p) return;
    last.current = key;
    if (wellInView(p)) return;
    lastGlide.current = now;
    requestSnap({ kind: "view", ...viewCentredOn(p) });
  });
  useEffect(() => {
    last.current = "";
  }, [id]);

  return (
    <AnimatePresence>
      {id && peer && (
        <motion.div
          key={id}
          className="crew-guide crew-follow f-glass"
          style={{ ["--crew" as string]: `var(--color-crew-${peer.crew.hue % 6})` }}
          initial={{ opacity: 0, y: -10, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          role="status"
        >
          <span className="crew-guide-dot" />
          <span className="crew-guide-text">
            Following <b>{peer.user.name}</b>
            <span className="crew-guide-note"> · {peer.crew.status === "working" ? peer.crew.doing : peer.crew.status === "done" ? "done" : peer.crew.status}</span>
          </span>
          <button className="f-pill crew-guide-back" onClick={() => followCrew(null)} data-tip="Stop following" data-kbd="Esc">
            Stop
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

