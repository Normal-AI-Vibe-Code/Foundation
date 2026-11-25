/**
 * Replay and the clock (ChatForm R1, docs/chatform.md §1 "Replay is a clock").
 *
 *  - SessionReplay({ sessionId }): a recorded session in the Huddles tab. One transport (play/pause, a scrub
 *    bar marked with each line said, each recording span, each burst of grid changes and each chat message,
 *    1× 1.5× 2×; Space, ← → 5 s, J K L), every recording as a tile kept in sync with the transport's clock
 *    (each <video> seeks to t − its offset; a person with no recording at t is their portrait, pulsing while
 *    their line is said), a shared screen large, agents' avatars talking while their lines are said (and,
 *    when asked, said again by speechSynthesis), the transcript following and clickable, and the grid as it
 *    was: each take's section drawn read-only at the transport's time.
 *  - ReplayBody: the clock card on a grid (`panel: "replay"`). Its transport off "now" rewinds the section
 *    it sits in, for this viewer only: SectionRewind draws the section as it was over the live one (whose
 *    cards hide), with a banner on its top edge (Viewing 2:14 into Tuesday's huddle · Back to now) and a
 *    small stage of the recordings. Nothing is written to the board; Esc or Back to now returns.
 *
 * Audio: each person's recording is their own camera and their own mic (lib/huddle.ts records the local
 * stream only), so every tile's sound on is the room once, never doubled. The sound switch mutes them all.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import * as Y from "yjs";
import { boardMaps, decodeTake, noteTextOf, tableCellsOf, TakePlayer, type HuddleLine, type ObjectDoc, type ReplayTimeline, type ReplayMedia, type Mood } from "@foundation/protocol";
import { api, ApiError, fetchFile } from "../lib/api";
import { useFileSrc } from "../lib/fileSrc";
import { CONTENT_PAD, getState, objectPixelSize, sectionFlow, liveFit, type PanelMeta } from "../state/store";
import { activeBoard } from "../sync/board";
import { toast, useUi } from "../state/ui";
import { Avatar } from "../characters/Avatar";
import { seats, useRoster } from "../characters/roster";
import { CadPreview } from "../cad/CadPreview";
import { MODEL_EXT } from "../cad/model";
import { Portrait, goToCard } from "./HuddleCall";
import "./replay.css";

// ---------- data: the timeline and the takes ----------

export interface ReplayData {
  timeline: ReplayTimeline;
  /** take id → its player (rebuilds the board at a time) */
  players: Map<string, TakePlayer>;
}

const timelines = new Map<string, Promise<ReplayData>>();

/** the timeline and every take it shows, fetched once per page (a session that ended doesn't change) */
export function loadReplay(sessionId: string, fresh = false): Promise<ReplayData> {
  if (fresh) timelines.delete(sessionId);
  let p = timelines.get(sessionId);
  if (!p) {
    p = (async () => {
      const timeline = await api<ReplayTimeline>(`/api/replay/${encodeURIComponent(sessionId)}`);
      const players = new Map<string, TakePlayer>();
      await Promise.all(
        timeline.takes.map(async (t) => {
          const bytes = new Uint8Array(await (await fetchFile(`/api/replay/takes/${encodeURIComponent(t.id)}`)).arrayBuffer());
          players.set(t.id, new TakePlayer(decodeTake(bytes)));
        }),
      );
      return { timeline, players };
    })();
    p.catch(() => timelines.delete(sessionId));
    timelines.set(sessionId, p);
  }
  return p;
}

function useReplay(sessionId: string | undefined): { data: ReplayData | null; why: string | null; locked: boolean } {
  const [s, setS] = useState<{ data: ReplayData | null; why: string | null; locked: boolean }>({ data: null, why: null, locked: false });
  useEffect(() => {
    if (!sessionId) return;
    let on = true;
    setS({ data: null, why: null, locked: false });
    loadReplay(sessionId).then(
      (data) => on && setS({ data, why: null, locked: false }),
      (e: Error) => on && setS({ data: null, why: e.message, locked: e instanceof ApiError && (e.status === 404 || e.status === 403) }),
    );
    return () => {
      on = false;
    };
  }, [sessionId]);
  return s;
}

const durationOf = (t: ReplayTimeline) => Math.max(1000, (t.session.endedAt ?? Date.now()) - t.session.startedAt);

// ---------- the clock: one transport, many readers ----------

export class Clock {
  t = 0;
  playing = false;
  speed = 1;
  readonly duration: number;
  private subs = new Set<() => void>();
  private raf = 0;
  private last = 0;
  version = 0;
  constructor(duration: number, t = 0) {
    this.duration = duration;
    this.t = Math.min(duration, Math.max(0, t));
  }
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  };
  private emit() {
    this.version++;
    for (const f of this.subs) f();
  }
  private tick = (now: number) => {
    if (!this.playing) return;
    this.t = Math.min(this.duration, this.t + (now - this.last) * this.speed);
    this.last = now;
    if (this.t >= this.duration) this.playing = false;
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  };
  play() {
    if (this.playing) return;
    if (this.t >= this.duration - 50) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  seek(t: number) {
    this.t = Math.min(this.duration, Math.max(0, t));
    this.last = performance.now();
    this.emit();
  }
  setSpeed(s: number) {
    this.speed = s;
    this.emit();
  }
  destroy() {
    this.pause();
    this.subs.clear();
  }
}

/** re-render when the clock moves by at least `step` ms (or plays/pauses, or changes speed) */
function useClock(clock: Clock, step = 0) {
  const key = useCallback(() => `${step ? Math.floor(clock.t / step) : clock.t}|${clock.playing}|${clock.speed}`, [clock, step]);
  useSyncExternalStore(clock.subscribe, key);
  return clock;
}

/** keyboard on a replay: Space plays, ← → five seconds, J K L back / pause / forward ten */
function onTransportKey(clock: Clock, e: React.KeyboardEvent | KeyboardEvent) {
  const k = e.key;
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return false;
  if (k === " " || k === "k" || k === "K") clock.toggle();
  else if (k === "ArrowLeft") clock.seek(clock.t - 5000);
  else if (k === "ArrowRight") clock.seek(clock.t + 5000);
  else if (k === "j" || k === "J") clock.seek(clock.t - 10_000);
  else if (k === "l" || k === "L") clock.seek(clock.t + 10_000);
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

export const clockText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** about how long a line takes to say (2.6 words a second), as the server times an agent's seat */
const sayMs = (l: Pick<HuddleLine, "text">) => Math.min(30_000, 800 + (l.text.split(/\s+/).length / 2.6) * 1000);

// ---------- the transport: play, the scrub bar and its marks, speed ----------

export function Transport({ clock, timeline, compact = false }: { clock: Clock; timeline: ReplayTimeline; compact?: boolean }) {
  useClock(clock, compact ? 250 : 100);
  const bar = useRef<HTMLDivElement>(null);
  const t0 = timeline.session.startedAt;
  const d = clock.duration;
  const pct = (at: number) => `${Math.min(100, Math.max(0, ((at - t0) / d) * 100))}%`;
  const seekAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    clock.seek(((clientX - r.left) / Math.max(1, r.width)) * d);
  };
  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    seekAt(e.clientX);
    const move = (ev: PointerEvent) => seekAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const said = timeline.lines.filter((l) => l.source !== "system");
  return (
    <div className={`rp-transport${compact ? " is-compact" : ""}`} data-rp-transport>
      <button className="rp-play" onClick={(e) => (e.stopPropagation(), clock.toggle())} aria-label={clock.playing ? "Pause" : "Play"} data-tip={clock.playing ? "Pause (Space)" : "Play (Space)"} data-rp-play>
        {clock.playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>
      <span className="rp-time" data-rp-time={Math.round(clock.t)}>
        {clockText(clock.t)}
        {!compact && <i> / {clockText(d)}</i>}
      </span>
      <div
        ref={bar}
        className="rp-bar"
        onPointerDown={onDown}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 15_000 : 5_000;
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            clock.seek(Math.max(0, clock.t - step));
          } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            clock.seek(Math.min(d, clock.t + step));
          } else if (e.key === "Home") {
            e.preventDefault();
            e.stopPropagation();
            clock.seek(0);
          } else if (e.key === "End") {
            e.preventDefault();
            e.stopPropagation();
            clock.seek(d);
          }
        }}
        role="slider"
        aria-label="Time in the session"
        aria-valuemin={0}
        aria-valuemax={Math.round(d / 1000)}
        aria-valuenow={Math.round(clock.t / 1000)}
        aria-valuetext={clockText(clock.t)}
        tabIndex={0}
        data-rp-bar
      >
        <span className="rp-track" />
        {timeline.recordings.map((r, i) => (
          <span key={`r${i}`} className="rp-rec" style={{ left: pct(r.startedAt), width: `calc(${pct(r.stoppedAt ?? t0 + d)} - ${pct(r.startedAt)})` }} />
        ))}
        {timeline.changes.map((c, i) => (
          <span key={`c${i}`} className="rp-mark is-grid" style={{ left: pct(c.at) }} />
        ))}
        {said.map((l) => (
          <span key={l.id} className={`rp-mark is-line${l.source === "agent" ? " is-agent" : ""}`} style={{ left: pct(l.at) }} />
        ))}
        {timeline.messages.map((m) => (
          <span key={m.id} className="rp-mark is-chat" style={{ left: pct(m.createdAt) }} />
        ))}
        <span className="rp-fill" style={{ width: pct(t0 + clock.t) }} />
        <span className="rp-thumb" style={{ left: pct(t0 + clock.t) }} />
      </div>
      {!compact && (
        <span className="rp-speeds" role="group" aria-label="Speed">
          {[1, 1.5, 2].map((s) => (
            <button key={s} className={`rp-speed${clock.speed === s ? " is-on" : ""}`} onClick={() => clock.setSpeed(s)} aria-pressed={clock.speed === s}>
              {s}×
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

// ---------- the people: recordings in sync, portraits, agents talking ----------

/** keeps every <video> of a replay on the transport's clock: seeks when it's off by more than 0.25 s, nudges its rate for smaller drift */
function useVideoSync(clock: Clock, videos: React.MutableRefObject<Map<string, { el: HTMLVideoElement; m: ReplayMedia }>>, sound: boolean) {
  useEffect(() => {
    const sync = () => {
      for (const { el, m } of videos.current.values()) {
        const target = (clock.t - m.offset) / 1000;
        const len = (m.endedAt - m.startedAt) / 1000;
        const inside = target >= 0 && target <= len;
        el.muted = !sound;
        if (!inside) {
          if (!el.paused) el.pause();
          continue;
        }
        const drift = el.currentTime - target;
        if (!clock.playing) {
          if (!el.paused) el.pause();
          if (Math.abs(drift) > 0.04 && !el.seeking) el.currentTime = target;
          continue;
        }
        if (Math.abs(drift) > 0.25) {
          if (!el.seeking) el.currentTime = target;
          el.playbackRate = clock.speed;
        } else el.playbackRate = clock.speed * (1 - Math.max(-0.08, Math.min(0.08, drift * 0.5)));
        if (el.paused) void el.play().catch(() => {});
      }
    };
    sync();
    const off = clock.subscribe(sync);
    const t = setInterval(sync, 250);
    return () => {
      off();
      clearInterval(t);
      for (const { el } of videos.current.values()) el.pause();
    };
  }, [clock, videos, sound]);
}

function SyncedVideo({ m, register }: { m: ReplayMedia; register: (id: string, el: HTMLVideoElement | null, m: ReplayMedia) => void }) {
  const src = useFileSrc(m.url);
  return <video ref={(el) => register(m.fileId, el, m)} src={src} preload="auto" playsInline data-rp-video={m.person} data-rp-offset={m.offset} />;
}

/** the session's people and agents at the clock's time: a tile each, a shared screen large */
export function Stage({ clock, timeline, sound, small = false, srcFor }: { clock: Clock; timeline: ReplayTimeline; sound: boolean; small?: boolean; srcFor?: (m: ReplayMedia) => ReplayMedia }) {
  useClock(clock, 200);
  const roster = useRoster();
  const chars = useMemo(() => seats(roster, timeline.agents), [roster, timeline.agents]);
  const videos = useRef(new Map<string, { el: HTMLVideoElement; m: ReplayMedia }>());
  const register = useCallback((id: string, el: HTMLVideoElement | null, m: ReplayMedia) => {
    if (el) videos.current.set(id, { el, m });
    else videos.current.delete(id);
  }, []);
  useVideoSync(clock, videos, sound);
  const media = timeline.media.map((m) => (srcFor ? srcFor(m) : m));
  const at = timeline.session.startedAt + clock.t;
  const covering = (m: ReplayMedia) => clock.t >= m.offset && clock.t <= m.offset + (m.endedAt - m.startedAt);
  const saying = (who: string) => timeline.lines.some((l) => l.speaker === who && l.source !== "system" && at >= l.at && at <= l.at + sayMs(l));
  const screen = media.find((m) => m.kind === "screen" && covering(m));
  const cams = media.filter((m) => m.kind !== "screen");
  const people = [...new Set([...timeline.people, ...cams.map((m) => m.person)])];
  const tiles = people.map((p) => {
    const mine = cams.filter((m) => m.person === p);
    return (
      <div key={p} className={`rp-tile${saying(p) ? " is-saying" : ""}`} data-rp-tile={p}>
        {mine.map((m) => (
          <div key={m.fileId} className={`rp-video${covering(m) ? "" : " is-off"}`}>
            <SyncedVideo m={m} register={register} />
          </div>
        ))}
        {!mine.some(covering) && (
          <span className="rp-portrait" data-rp-portrait={p}>
            <Portrait name={p} size={small ? 40 : 64} />
          </span>
        )}
        <span className="rp-name">{p}</span>
      </div>
    );
  });
  const agents = timeline.agents.map((a) => {
    const talking = saying(a);
    const mood: Mood = talking ? "talking" : "idle";
    return (
      <div key={a} className={`rp-tile is-agent${talking ? " is-saying" : ""}`} data-rp-agent={a} data-mood={mood}>
        <div className="rp-agent-figure">
          <Avatar character={chars[a]} mood={mood} framing="bust" />
        </div>
        <span className="rp-name">
          <span className="rp-agent-mark">Agent</span>
          {a}
        </span>
      </div>
    );
  });
  return (
    <div className={`rp-stage${screen ? " is-sharing" : ""}${small ? " is-small" : ""} n-${Math.min(6, people.length + timeline.agents.length)}`} data-rp-stage>
      {screen && (
        <div className="rp-screen">
          <SyncedVideo m={screen} register={register} />
          <span className="rp-name">{screen.person}'s screen</span>
        </div>
      )}
      <div className="rp-faces">
        {tiles}
        {agents}
      </div>
    </div>
  );
}

/** say an agent's line again as it comes round, when asked (speechSynthesis, here only) */
function useSpeakAgents(clock: Clock, timeline: ReplayTimeline, on: boolean) {
  const said = useRef(new Set<string>());
  useEffect(() => {
    if (!on || typeof speechSynthesis === "undefined") return;
    let lastT = clock.t;
    const off = clock.subscribe(() => {
      const t = clock.t;
      if (clock.playing && t > lastT) {
        for (const l of timeline.lines) {
          const o = l.at - timeline.session.startedAt;
          if (l.source === "agent" && o > lastT && o <= t && !said.current.has(l.id)) {
            said.current.add(l.id);
            const u = new SpeechSynthesisUtterance(l.text);
            u.rate = clock.speed;
            speechSynthesis.speak(u);
          }
        }
      } else if (!clock.playing) speechSynthesis.cancel();
      if (t < lastT) said.current.clear();
      lastT = t;
    });
    return () => {
      off();
      speechSynthesis.cancel();
    };
  }, [clock, timeline, on]);
}

// ---------- the transcript, following ----------

function ReplayTranscript({ clock, timeline }: { clock: Clock; timeline: ReplayTimeline }) {
  useClock(clock, 250);
  const t0 = timeline.session.startedAt;
  const rows = useMemo(
    () =>
      [
        ...timeline.lines.map((l) => ({ id: l.id, at: l.at, who: l.speaker, text: l.text, kind: l.source })),
        ...timeline.messages.filter((m) => m.type !== "huddle").map((m) => ({ id: m.id, at: m.createdAt, who: m.author, text: m.text || m.files.map((f) => f.name).join(", "), kind: "chat" as const })),
      ].sort((a, b) => a.at - b.at),
    [timeline],
  );
  const now = t0 + clock.t;
  const current = rows.filter((r) => r.at <= now).at(-1)?.id;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-rp-line="${current}"]`);
    const b = box.current;
    if (!el || !b) return;
    const top = el.offsetTop - b.offsetTop;
    if (top < b.scrollTop || top > b.scrollTop + b.clientHeight - el.offsetHeight) b.scrollTo({ top: Math.max(0, top - b.clientHeight / 3), behavior: "smooth" });
  }, [current]);
  return (
    <div ref={box} className="rp-lines wheel-own" data-rp-transcript>
      {rows.length === 0 && <p className="rp-note">Nothing was said or typed.</p>}
      {rows.map((r) => (
        <button key={r.id} className={`rp-line is-${r.kind}${r.id === current ? " is-now" : ""}${r.at > now ? " is-later" : ""}`} onClick={() => clock.seek(r.at - t0)} data-rp-line={r.id}>
          <time>{clockText(r.at - t0)}</time>
          {r.kind === "system" ? (
            <span className="rp-line-text">{r.text}</span>
          ) : (
            <>
              <b>
                {r.who}
                {r.kind === "agent" && <i className="rp-agent-mark">Agent</i>}
                {r.kind === "chat" && <i className="rp-chat-mark">in the channel</i>}
              </b>
              <span className="rp-line-text">{r.text}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

// ---------- the grid as it was: a section drawn read-only from a rebuilt document ----------

const FLOW_GAP = 26;

/** the section's cards' places, the grid's own flow (store.ts flowAt) on a rebuilt document */
export function flowOf(objects: ObjectDoc[], availW: number, host?: string): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const all = objects.filter((o) => o.id !== host);
  const docked = all.filter((o) => !o.float).sort((a, b) => a.bornAt - b.bornAt);
  const floaters = all.filter((o) => o.float).map((o) => ({ x: o.x, y: o.y, ...objectPixelSize(o as never) }));
  const collide = (x: number, y: number, w: number, h: number) => floaters.find((f) => x < f.x + f.w + FLOW_GAP && x + w + FLOW_GAP > f.x && y < f.y + f.h + FLOW_GAP && y + h + FLOW_GAP > f.y);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const o of docked) {
    const { w, h } = objectPixelSize(o as never);
    for (let g = 0; g < 80; g++) {
      if (x > 0 && x + w > availW) {
        x = 0;
        y += shelf + FLOW_GAP;
        shelf = 0;
        continue;
      }
      const hit = collide(x, y, w, h);
      if (!hit) break;
      const nx = hit.x + hit.w + FLOW_GAP;
      if (nx + w <= availW) x = nx;
      else {
        x = 0;
        y = Math.max(y + FLOW_GAP, hit.y + hit.h + FLOW_GAP);
        shelf = 0;
      }
    }
    out.set(o.id, { x, y });
    x += w + FLOW_GAP;
    shelf = Math.max(shelf, h);
  }
  for (const o of all) if (o.float) out.set(o.id, { x: o.x, y: o.y });
  return out;
}

const GLYPH: Record<string, string> = { note: "▤", table: "⊞", map: "◍", image: "▨", video: "▶", file: "▯", huddle: "◐", app: "◳", link: "↗", machine: "▣", agent: "✦", replay: "◷" };

/** one card as it was: a note's words, a table's cells, a picture, a CAD file's still; anything else its mark and name */
function OldCard({ o, doc }: { o: ObjectDoc; doc: Y.Doc }) {
  if (o.kind === "note") {
    const text = noteTextOf(doc, o);
    return (
      <div className="rp-card is-note" data-rp-card={o.name}>
        <div className="rp-note-text">{text.replace(/^#+\s*/gm, "")}</div>
      </div>
    );
  }
  if (o.kind === "table") {
    const cells = tableCellsOf(doc, o.id);
    const rows = Math.min(o.rows, 10);
    const cols = Math.min(o.cols, 6);
    return (
      <div className="rp-card is-table" data-rp-card={o.name}>
        <div className="rp-card-head">{o.name}</div>
        <div className="rp-cells" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: rows * cols }, (_, i) => (
            <span key={i}>{cells[`${i % cols},${Math.floor(i / cols)}`] ?? ""}</span>
          ))}
        </div>
      </div>
    );
  }
  if (o.kind === "media") return <OldMedia o={o} />;
  if (o.kind === "panel" && o.panel === "file" && o.fileId && MODEL_EXT.test(o.name))
    return (
      <div className="rp-card is-cad" data-rp-card={o.name}>
        <CadPreview url={`/files/${o.fileId}`} name={o.name} />
      </div>
    );
  const kind = o.kind === "panel" ? o.panel : o.kind;
  return (
    <div className={`rp-card is-${kind}`} data-rp-card={o.name}>
      <span className="rp-card-glyph">{kind === "file" ? <CubeGlyph /> : (GLYPH[kind] ?? "▫")}</span>
      <span className="rp-card-name">{o.name}</span>
    </div>
  );
}

function OldMedia({ o }: { o: Extract<ObjectDoc, { kind: "media" }> }) {
  const src = useFileSrc(o.src, o.media === "image");
  return <div className="rp-card is-media" data-rp-card={o.name}>{o.media === "image" && src ? <img src={src} alt={o.name} draggable={false} /> : <span className="rp-card-glyph">▶</span>}</div>;
}

/** the cards of a section in a rebuilt document, at their places; they move on short springs between moments */
export function OldCards({ doc, sectionId, availW, skip, cursors, origin }: { doc: Y.Doc; sectionId: string; availW: number; skip?: (o: ObjectDoc) => boolean; cursors?: ReturnType<TakePlayer["cursorsAt"]>; origin?: { x: number; y: number; fit: number } }) {
  const m = boardMaps(doc);
  const sec = m.sections.get(sectionId);
  const objects = [...m.objects.values()].filter((o) => o.sectionId === sectionId && !(o.kind === "panel" && o.panel === "replay") && !skip?.(o));
  const pos = flowOf(objects, availW, sec?.host);
  return (
    <>
      {objects.map((o) => {
        const p = pos.get(o.id) ?? { x: o.x, y: o.y };
        const { w, h } = objectPixelSize(o as never);
        return (
          <motion.div key={o.id} className="rp-slot" initial={false} animate={{ x: CONTENT_PAD + p.x, y: CONTENT_PAD + p.y }} transition={{ type: "spring", stiffness: 420, damping: 38 }} style={{ width: w, height: h }} data-rp-obj={o.id}>
            <OldCard o={o} doc={doc} />
          </motion.div>
        );
      })}
      {cursors?.map((c, i) => {
        let x: number | undefined;
        let y: number | undefined;
        if (c.t) {
          const p = pos.get(c.t);
          if (p) {
            x = CONTENT_PAD + p.x + 24;
            y = CONTENT_PAD + p.y + 24;
          }
        } else if (origin && typeof c.x === "number" && typeof c.y === "number") {
          x = (c.x - origin.x) / origin.fit;
          y = (c.y - origin.y) / origin.fit;
        }
        if (x === undefined || y === undefined || x < 0 || y < 0) return null;
        return (
          <motion.span key={`${c.n}${i}`} className={`rp-cursor${c.a ? " is-agent" : ""}`} initial={false} animate={{ x, y }} transition={{ type: "spring", stiffness: 300, damping: 30 }} style={c.c && !c.a ? { color: c.c } : undefined} data-rp-cursor={c.n}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M2 1.5 13 8l-5 1.2L5.6 14Z" fill="currentColor" />
            </svg>
            <span>{c.n}</span>
          </motion.span>
        );
      })}
    </>
  );
}

/** the board's take at the clock: re-render only when a change or a cursor sample is crossed */
function useDocAt(clock: Clock, player: TakePlayer | undefined, t0: number) {
  const key = useCallback(() => {
    if (!player) return "-";
    const at = t0 + clock.t;
    return `${player.indexAt(at)}|${Math.floor(clock.t / 200)}`;
  }, [clock, player, t0]);
  useSyncExternalStore(clock.subscribe, key);
  if (!player) return null;
  const at = t0 + clock.t;
  return { doc: player.docAt(at), cursors: player.cursorsAt(at), version: player.version };
}

/** a take's section, read-only, fitted into a box (the Huddles tab's view of the grid) */
function TakeView({ clock, timeline, takeId, player, data }: { clock: Clock; timeline: ReplayTimeline; takeId: string; player: TakePlayer; data: ReplayData }) {
  const take = timeline.takes.find((t) => t.id === takeId)!;
  const at = useDocAt(clock, player, timeline.session.startedAt);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  if (!at || !take.section) return null;
  const availW = 1180;
  const objects = [...boardMaps(at.doc).objects.values()].filter((o) => o.sectionId === take.section);
  const pos = flowOf(objects, availW);
  let extW = 360;
  let extH = 200;
  for (const o of objects) {
    const p = pos.get(o.id)!;
    const s = objectPixelSize(o as never);
    extW = Math.max(extW, p.x + s.w + CONTENT_PAD * 2);
    extH = Math.max(extH, p.y + s.h + CONTENT_PAD * 2);
  }
  const fit = Math.min(1, (w - 2) / extW, 480 / extH);
  void data;
  return (
    <section className="rp-take" aria-label={`${take.boardName} as it was`} data-rp-take={take.id}>
      <header className="rp-take-head">
        <span className="rp-take-where">
          {take.boardName}
          {take.sectionName ? ` › ${take.sectionName}` : ""}
        </span>
        <span className="rp-dim">
          as it was at {clockText(clock.t)} · {take.updates} {take.updates === 1 ? "change" : "changes"} kept
        </span>
        <span className="rp-gap" />
        <button className="f-pill" onClick={() => goToCard(take.board, take.section ?? "")}>
          Open the grid
        </button>
      </header>
      {take.truncated && <p className="rp-note is-warn">{take.truncated}.</p>}
      <div ref={box} className="rp-take-box" style={{ height: Math.ceil(extH * fit) + 2 }} data-rp-section={take.section} data-rp-count={objects.length}>
        <div className="rp-take-content" style={{ transform: `scale(${fit})` }}>
          <OldCards doc={at.doc} sectionId={take.section} availW={availW} cursors={at.cursors} />
        </div>
      </div>
    </section>
  );
}

// ---------- the session's replay (the Huddles tab) ----------

export function SessionReplay({ sessionId }: { sessionId: string }) {
  const { data, why, locked } = useReplay(sessionId);
  if (!data) return <div className="rp-wrap">{why ? <p className="rp-note">{locked ? "This session isn't one you can replay." : why}</p> : <p className="rp-note">Opening the replay…</p>}</div>;
  return <SessionReplayView data={data} />;
}

/** the whole replay, from data in hand (the design page hands it fixtures) */
export function SessionReplayView({ data, srcFor, onClock, still }: { data: ReplayData; srcFor?: (m: ReplayMedia) => ReplayMedia; onClock?: (c: Clock) => void; still?: boolean }) {
  const { timeline } = data;
  const clock = useMemo(() => new Clock(durationOf(timeline)), [timeline]);
  useEffect(() => {
    onClock?.(clock);
    (window as unknown as { __replayClock?: Clock }).__replayClock = clock;
    return () => clock.destroy();
  }, [clock, onClock]);
  const [sound, setSound] = useState(true);
  const [speak, setSpeak] = useState(false);
  useSpeakAgents(clock, timeline, speak);
  const ui = useUi();
  const [putting, setPutting] = useState(false);
  const putClock = async (board: string, section: string | null) => {
    setPutting(true);
    try {
      const r = await api<{ result: { id: string } }>(`/api/boards/${encodeURIComponent(board)}/tools/add_replay`, { method: "POST", json: { session: timeline.session.id, ...(section ? { section } : {}), request_id: `clock:${timeline.session.id}:${board}` } });
      goToCard(board, r.result.id);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setPutting(false);
    }
  };
  const grids = [...new Map([...timeline.takes.map((t) => [t.board, t.section] as const), ...timeline.places.map((p) => [p.board, p.section] as const)]).entries()];
  return (
    <div className="rp-wrap" tabIndex={0} onKeyDown={(e) => onTransportKey(clock, e)} data-rp-session={timeline.session.id} aria-label="Replay">
      <div className="rp-top">
        <h3 className="rp-h">Replay</h3>
        <span className="rp-dim">
          {timeline.media.length} {timeline.media.length === 1 ? "recording" : "recordings"} · {timeline.lines.filter((l) => l.source !== "system").length} lines · {timeline.changes.length} grid changes
        </span>
        <span className="rp-gap" />
        <label className="rp-check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
        </label>
        <label className="rp-check">
          <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} /> Say agents' lines aloud
        </label>
        {!still && ui.role !== "viewer" && grids.map(([board, section]) => (
          <button key={board} className="f-pill is-accent" disabled={putting} onClick={() => void putClock(board, section)} data-rp-put={board}>
            Put the clock on its grid{grids.length > 1 ? ` · ${timeline.takes.find((t) => t.board === board)?.boardName ?? timeline.places.find((p) => p.board === board)?.boardName ?? board}` : ""}
          </button>
        ))}
      </div>
      <div className="rp-main">
        <Stage clock={clock} timeline={timeline} sound={sound} srcFor={srcFor} />
        <ReplayTranscript clock={clock} timeline={timeline} />
      </div>
      <Transport clock={clock} timeline={timeline} />
      {timeline.gridHidden && <p className="rp-note">{timeline.gridHidden}</p>}
      {timeline.takes.map((t) => {
        const p = data.players.get(t.id);
        return p ? <TakeView key={t.id} clock={clock} timeline={timeline} takeId={t.id} player={p} data={data} /> : null;
      })}
    </div>
  );
}

// ---------- the clock card on a grid, and the section it rewinds ----------

export interface Rewind {
  sectionId: string;
  panelId: string;
  data: ReplayData;
  clock: Clock;
  takeId: string | null;
}
const rewinds = new Map<string, Rewind>();
const rewindSubs = new Set<() => void>();
let rewindVersion = 0;
function setRewind(sectionId: string, r: Rewind | null) {
  if (r) rewinds.set(sectionId, r);
  else rewinds.delete(sectionId);
  rewindVersion++;
  rewindSubs.forEach((f) => f());
}
function useRewind(sectionId: string): Rewind | null {
  useSyncExternalStore(
    (f) => {
      rewindSubs.add(f);
      return () => rewindSubs.delete(f);
    },
    () => rewindVersion,
  );
  return rewinds.get(sectionId) ?? null;
}
/** the sections rewound in this window now (tests) */
export const rewoundSections = () => [...rewinds.keys()];

const whenWords = (at: number) => new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
const dayName = (at: number) => {
  const d = new Date(at);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 864e5);
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${d.toLocaleDateString([], { weekday: "long" })}`;
};

export function ReplayBody({ panel }: { panel: PanelMeta }) {
  const { data, locked, why } = useReplay(panel.sessionId);
  if (locked || (!data && why)) return <ClockCardLocked why={locked ? null : why} />;
  if (!data) return <div className="rp-clock is-loading">Opening the replay…</div>;
  return <ClockCard panel={panel} data={data} />;
}

export function ClockCardLocked({ why }: { why: string | null }) {
  return (
    <div className="rp-clock is-locked" data-rp-locked>
      <span className="rp-clock-lock" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      </span>
      <span className="rp-clock-text">
        <b>A recorded huddle</b>
        <span className="rp-dim">{why ?? "From a conversation you're not in: only its people can replay it."}</span>
      </span>
    </div>
  );
}

function ClockCard({ panel, data }: { panel: PanelMeta; data: ReplayData }) {
  const { timeline } = data;
  const dur = durationOf(timeline);
  const clock = useMemo(() => new Clock(dur, dur), [dur]);
  const boardId = activeBoard()?.boardId;
  const takeId = useMemo(() => timeline.takes.find((t) => t.board === boardId && t.section === panel.sectionId)?.id ?? timeline.takes.find((t) => t.board === boardId)?.id ?? null, [timeline, boardId, panel.sectionId]);
  const [rewound, setRewound] = useState(false);
  useClock(clock, 500);
  // leaving "now" (a scrub, a play) rewinds the section; Back to now puts it back
  useEffect(
    () =>
      clock.subscribe(() => {
        if (!rewinds.has(panel.sectionId) && (clock.playing || clock.t < dur - 30)) {
          setRewind(panel.sectionId, { sectionId: panel.sectionId, panelId: panel.id, data, clock, takeId });
          setRewound(true);
        }
      }),
    [clock, dur, panel.sectionId, panel.id, data, takeId],
  );
  useEffect(
    () => () => {
      clock.destroy();
      if (rewinds.get(panel.sectionId)?.clock === clock) setRewind(panel.sectionId, null);
    },
    [clock, panel.sectionId],
  );
  useEffect(() => {
    const r = () => setRewound(rewinds.get(panel.sectionId)?.clock === clock);
    rewindSubs.add(r);
    return () => void rewindSubs.delete(r);
  }, [clock, panel.sectionId]);
  return <ClockCardView timeline={timeline} clock={clock} rewound={rewound} grid={Boolean(takeId)} onBack={() => backToNow(panel.sectionId)} />;
}

export function backToNow(sectionId: string) {
  const r = rewinds.get(sectionId);
  if (!r) return;
  r.clock.pause();
  r.clock.seek(r.clock.duration);
  setRewind(sectionId, null);
}

/** the clock card's face: the session's name, when, who, the transport (the design page draws it from fixtures) */
export function ClockCardView({ timeline, clock, rewound, grid, onBack }: { timeline: ReplayTimeline; clock: Clock; rewound: boolean; grid: boolean; onBack?: () => void }) {
  useClock(clock, 500);
  return (
    <div className={`rp-clock${rewound ? " is-rewound" : ""}${clock.playing ? " is-playing" : ""}`} onKeyDown={(e) => onTransportKey(clock, e)} tabIndex={0} data-rp-clock={timeline.session.id} data-rp-rewound={rewound ? "1" : "0"}>
      <div className="rp-clock-top">
        <span className="rp-clock-glyph" aria-hidden>
          ◷
        </span>
        <span className="rp-clock-title">{timeline.session.name}</span>
        <span className="rp-dim rp-clock-when">{whenWords(timeline.session.startedAt)}</span>
        {rewound && onBack ? (
          <button className="rp-clock-now" onClick={(e) => (e.stopPropagation(), onBack())} data-rp-now>
            Back to now
          </button>
        ) : null}
      </div>
      <Transport clock={clock} timeline={timeline} compact />
      <div className="rp-clock-foot rp-dim">
        {rewound ? (grid ? "This section is shown as it was. Only you see it." : "Nothing was kept on this grid: the conversation plays.") : `${[...timeline.people, ...timeline.agents].join(", ")} · ${grid ? "scrub to see this section as it was" : "play the conversation"}`}
      </div>
    </div>
  );
}

/**
 * Over a section whose clock is off "now": the section as it was (its live cards hidden under it, the clock
 * card left on top), a banner on its top edge and a small stage of the recordings. For this viewer only.
 */
export function SectionRewind({ sectionId }: { sectionId: string }) {
  const r = useRewind(sectionId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!r) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        backToNow(sectionId);
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [r, sectionId]);
  if (!r) return null;
  return (
    <div ref={ref} className="rp-rewind" data-rp-rewind={sectionId}>
      <style>{`[data-section-id="${sectionId}"] .section-content > .obj-slot:not([data-obj-id="${r.panelId}"]) { opacity: 0; pointer-events: none; } [data-section-id="${sectionId}"] { box-shadow: 0 0 0 2px var(--color-pulse), var(--shadow-pane); }`}</style>
      <span className="rp-rewind-ground" />
      <RewoundCards r={r} sectionId={sectionId} />
      {createPortal(
        <div className="rp-rewind-hud">
          <RewindBanner r={r} sectionId={sectionId} />
        </div>,
        document.body,
      )}
    </div>
  );
}

function RewoundCards({ r, sectionId }: { r: Rewind; sectionId: string }) {
  const player = r.takeId ? r.data.players.get(r.takeId) : undefined;
  const at = useDocAt(r.clock, player, r.data.timeline.session.startedAt);
  if (!at) return null;
  const flow = sectionFlow(sectionId);
  const fit = liveFit.get(sectionId) ?? flow.fit;
  const st = getState();
  const sec = st.sections[sectionId];
  // world → this section's content: its body's corner, then its fit
  let origin: { x: number; y: number; fit: number } | undefined;
  const el = document.querySelector<HTMLElement>(`[data-section-id="${sectionId}"]`);
  if (sec && el) origin = { x: el.offsetLeft + 1, y: el.offsetTop + 1 + 42, fit };
  return (
    <div className="rp-rewind-cards" data-rp-doc-version={at.version} data-rp-count={[...boardMaps(at.doc).objects.values()].filter((o) => o.sectionId === sectionId && !(o.kind === "panel" && o.panel === "replay")).length}>
      <OldCards doc={at.doc} sectionId={sectionId} availW={Math.max(360, flow.availW)} cursors={at.cursors} origin={origin} />
    </div>
  );
}

export function RewindBanner({ r, sectionId }: { r: Rewind; sectionId: string }) {
  const clock = useClock(r.clock, 250);
  const t = r.data.timeline;
  const [sound, setSound] = useState(true);
  const at = t.session.startedAt + clock.t;
  const sectionName = getState().allSections?.[sectionId]?.name ?? t.takes.find((k) => k.id === r.takeId)?.sectionName ?? null;
  const line = t.lines.filter((l) => l.source !== "system" && l.at <= at && at <= l.at + Math.max(4000, sayMs(l))).at(-1);
  return (
    <>
      <div className="rp-banner" role="status" data-rp-banner={sectionId}>
        <span className="rp-banner-dot" aria-hidden />
        <span className="rp-banner-text">
          Viewing <b>{clockText(clock.t)}</b> into {dayName(t.session.startedAt)}'s huddle{sectionName ? <> · {sectionName}</> : null}
        </span>
        <span className="rp-dim rp-banner-note">{r.takeId ? "as it was · only you see this" : "nothing was kept on this grid"}</span>
        <span className="rp-gap" />
        <label className="rp-check">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
        </label>
        <button className="rp-banner-now" onClick={() => backToNow(sectionId)} data-rp-back>
          Back to now <kbd>Esc</kbd>
        </button>
      </div>
      <div className="rp-floating" data-rp-floating>
        <Stage clock={r.clock} timeline={t} sound={sound} small />
        {line && (
          <p className="rp-floating-line">
            <b>{line.speaker}</b> {line.text}
          </p>
        )}
      </div>
    </>
  );
}

// ---------- glyphs ----------

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M3.5 2.2v9.6L11.6 7Z" fill="currentColor" />
    </svg>
  );
}
function PauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="3" y="2.2" width="2.8" height="9.6" rx="0.8" fill="currentColor" />
      <rect x="8.2" y="2.2" width="2.8" height="9.6" rx="0.8" fill="currentColor" />
    </svg>
  );
}

// ---------- "Replay here": on a grid's huddle card once a recorded session has ended ----------

/**
 * On a huddle card on a grid, once it's quiet: when its latest session was recorded, Replay here puts that
 * session's clock card beside it, in its section (a board write: not for a viewer). Seeing the session end
 * while the card is on screen offers it once, as a toast; nothing is added until someone presses it.
 */
export function ReplayHere({ panel, boardId, live }: { panel: PanelMeta; boardId: string; live: boolean }) {
  const ui = useUi();
  const [s, setS] = useState<{ id: string; recorded: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const wasLive = useRef(live);
  useEffect(() => {
    if (live) {
      wasLive.current = true;
      return;
    }
    let on = true;
    api<{ sessions: Array<{ id: string; recordings?: unknown[] }> }>(`/api/huddles/${encodeURIComponent(panel.id)}?board=${encodeURIComponent(boardId)}`)
      .then((r) => {
        const last = r.sessions[0];
        if (!on || !last) return;
        const recorded = Boolean(last.recordings?.length);
        setS({ id: last.id, recorded });
        if (recorded && wasLive.current && ui.role !== "viewer") toast("The huddle was recorded: Replay here puts its clock on this section", "ok");
        wasLive.current = false;
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [live, panel.id, boardId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (live || !s?.recorded || ui.role === "viewer") return null;
  const add = async () => {
    setBusy(true);
    try {
      const at = panel.float ? { x: panel.x, y: panel.y + panel.h + 24 } : {};
      await api(`/api/boards/${encodeURIComponent(boardId)}/tools/add_replay`, { method: "POST", json: { session: s.id, section: panel.sectionId, ...at, request_id: `replay-here:${s.id}:${panel.sectionId}` } });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="f-pill is-accent" disabled={busy} onClick={() => void add()} data-replay-here={s.id}>
      ◷ Replay here
    </button>
  );
}

function CubeGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M28 6 48 17v22L28 50 8 39V17Z" />
      <path d="M8 17l20 11 20-11M28 28v22" />
    </svg>
  );
}
