/**
 * The timeline on `#/design` (the floor chapter): the grid's band with all six lanes busy, nearly empty, and where
 * history begins; a section's bar at 260, 400 and 560; the moment with a withheld answer and a voice and a video
 * note; a section drawn as it was; and the band in night. Drawn from fixtures built here (a slice, and a take made
 * from a real Yjs document's changes), so it shows before any server answers. The band and bars scrub here too.
 */

import { useMemo } from "react";
import * as Y from "yjs";
import { boardMaps, setNoteText, TakePlayer, type ObjectDoc, type TakeFrames, type TimelineEvent, type TimelineSlice } from "@foundation/protocol";
import { OldCards } from "../panels/ReplayView";
import { Moment } from "./Moment";
import { SectionTimelineBar } from "./SectionTimeline";
import { TimelineBand } from "./TimelineBar";
import { Playhead, type Timeline } from "./model";
import { rangeBounds, type Range } from "./logic";
import "./timeline.css";
import "../panels/replay.css";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** a busy day on "Fans": people in and out, Wren at work in the open and behind the scenes, cards, words, notes */
function busyEvents(now: number): TimelineEvent[] {
  let i = 0;
  const at = (hAgo: number) => now - hAgo * HOUR;
  const ada = { kind: "person" as const, id: "u_ada", name: "Ada Lovelace", color: "var(--viz-1)" };
  const kai = { kind: "person" as const, id: "u_kai", name: "Kai Moreno", color: "var(--viz-3)" };
  const wren = { kind: "agent" as const, id: "wren", name: "Wren", for: "u_kai" };
  const e = (kind: string, t: number, actor: TimelineEvent["actor"], text: string, more: Partial<TimelineEvent> = {}): TimelineEvent => ({ id: `ev${i++}`, board: "b_demo", section: "s1", at: t, kind, actor, text, ...more });
  const out: TimelineEvent[] = [
    e("person.here", at(9), ada, "was on the grid", { end: at(6.5) }),
    e("person.here", at(5), ada, "was on the grid", { end: at(1.2) }),
    e("person.here", at(7.5), kai, "was on the grid", { end: at(3) }),
    e("person.here", at(0.6), kai, "is on the grid", { end: null }),
    e("agent.seat", at(8.2), kai, "put Wren on Shroud's council"),
    e("agent.run", at(7.2), wren, "worked on the shroud's wall", { end: at(6.4), ref: { type: "run", id: "r1" } }),
    e("agent.run", at(2.4), wren, "laid out the test results", { end: at(1.9) }),
    e("agent.run", at(0.3), wren, "is checking the clearance", { end: null }),
    e("terminal", at(6.9), wren, "ran a command on Bench", { end: at(6.85), data: { exit: 0 } }),
    e("prompt", at(8), kai, "set Shroud's standing instructions"),
    e("card.add", at(8.8), ada, "added a note", { object: "n1", data: { card: "note", name: "Brief" } }),
    e("card.add", at(8.7), ada, "added a CAD file", { object: "f1", data: { card: "file", name: "shroud-revC.3mf" } }),
    e("card.edit", at(6.6), wren, "edited Brief", { object: "n1" }),
    e("card.add", at(6.5), wren, "added a note", { object: "n2", data: { card: "note", name: "Decision" } }),
    e("card.move", at(4.2), kai, "moved shroud-revC.3mf to Tests"),
    e("card.remove", at(3.3), kai, "removed an old sketch", { object: "n0" }),
    e("section.rename", at(2.9), ada, "renamed Tests to Test rig"),
    e("wire.add", at(2.1), wren, "wired Results to the chart"),
    e("chat.ask", at(7.25), kai, "asked Wren", { data: { body: "Would 3 mm at the root be enough?" }, ref: { type: "chat", id: "m1", within: "c1" } }),
    e("chat.answer", at(7.0), wren, "answered", { withheld: "Wren's answer read files beyond this grid: only Kai sees it" }),
    e("chat.message", at(6.45), ada, "said in #fan-shroud", { data: { body: "Decision's on the grid. Rev D next." } }),
    e("huddle", at(4.6), ada, "huddled with Kai", { end: at(4.1) }),
    e("chat.ask", at(4.13), ada, "asked Wren", { data: { body: "What does the rig say about the root at 3 mm?" } }),
    e("chat.answer", at(4.11), wren, "answered", { withheld: "Wren's answer read files beyond this grid: only Ada sees it" }),
    e("chat.message", at(1.5), kai, "said in #fan-shroud", { data: { body: "Rig numbers look right; Wren is checking clearance." } }),
    e("note.audio", at(4.05), ada, "left a voice note", { data: { note: { fileId: "demo-voice", mime: "audio/webm", ms: 23_000, peaks: Array.from({ length: 40 }, (_, k) => 0.25 + 0.7 * Math.abs(Math.sin(k / 3.1))) } } }),
    e("note.video", at(3.95), kai, "left a video note", { data: { note: { fileId: "demo-video", mime: "video/webm", ms: 41_000 } } }),
    e("note.video", at(1.1), kai, "left a video note", { data: { note: { fileId: "demo-video-2", mime: "video/webm", ms: 18_000 } } }),
  ];
  for (let k = 0; k < 18; k++) out.push(e("agent.tool", at(7.15 - k * 0.04), wren, k % 4 ? "read Brief" : "ran a script", { kind: k % 4 ? "agent.tool" : "agent.code", data: { tool: "read_board", ok: true } }));
  return out.sort((a, b) => a.at - b.at);
}

function slice(now: number, events: TimelineEvent[], range: Range, start?: number): TimelineSlice {
  const { from, to } = rangeBounds(range, now, start);
  const density = Array.from({ length: 96 }, (_, k) => {
    const t0 = from + ((to - from) * k) / 96;
    const t1 = from + ((to - from) * (k + 1)) / 96;
    return events.filter((e) => e.at >= t0 && e.at < t1 && (e.kind.startsWith("card.") || e.kind === "agent.tool")).length;
  });
  return { board: "b_demo", section: null, from, to, start: start ?? from - HOUR, now, events, density, sections: [{ id: "s1", name: "Shroud" }, { id: "s0", name: "Sketches", gone: true }] };
}

/** a take made from a real document's changes: a section's notes added and edited over the day */
function take(now: number): TakePlayer {
  const doc = new Y.Doc();
  const m = boardMaps(doc);
  const t0 = now - 10 * HOUR;
  m.sections.set("s1", { id: "s1", name: "Shroud", c0: 0, r0: 0, c1: 0, r1: 0 });
  m.sections.set("s0", { id: "s0", name: "Sketches", c0: 1, r0: 0, c1: 1, r1: 0 });
  const base = Y.encodeStateAsUpdate(doc);
  const updates: TakeFrames["updates"] = [];
  let at = 0;
  doc.on("update", (u: Uint8Array) => updates.push({ at, update: u }));
  at = now - 8.8 * HOUR;
  doc.transact(() => {
    m.objects.set("n1", { id: "n1", kind: "note", sectionId: "s1", name: "Brief", x: 0, y: 0, float: false, bornAt: at, w: 300, h: 180 });
    setNoteText(doc, "n1", "# Fan shroud, rev C\n\n- Wall **2 mm**, PETG\n- Clearance to blade tip: 1.5 mm");
  });
  at = now - 8.7 * HOUR;
  doc.transact(() => m.objects.set("f1", { id: "f1", kind: "panel", panel: "file", sectionId: "s1", name: "shroud-revC.3mf", x: 0, y: 0, float: false, bornAt: at, w: 300, h: 220, ports: [] }));
  at = now - 6.5 * HOUR;
  doc.transact(() => {
    m.objects.set("n2", { id: "n2", kind: "note", sectionId: "s1", name: "Decision", x: 0, y: 0, float: false, bornAt: at, w: 300, h: 140 });
    setNoteText(doc, "n2", "Decision: wall to 3 mm at the root\n(Kai, agreed with Wren)");
  });
  at = now - 4.2 * HOUR;
  doc.transact(() => {
    const f = m.objects.get("f1") as ObjectDoc;
    m.objects.set("f1", { ...f, x: 680, y: 0, float: true });
  });
  at = now - 3.3 * HOUR;
  doc.transact(() => m.sections.delete("s0"));
  const frames: TakeFrames = {
    head: { id: "h_demo", board: "b_demo", section: null, from: t0, to: now, updates: updates.length },
    base,
    updates,
    cursors: [{ at: now - 6.5 * HOUR, who: [{ n: "Wren", t: "n2", a: 1 }] }],
  };
  return new TakePlayer(frames);
}

function fixture(key: string, opts: { events: TimelineEvent[]; range?: Range; start?: number; t?: number | null; scope?: "grid" | "section"; detached?: boolean; childName?: string | null; player?: TakePlayer | null }): Timeline {
  const now = Date.now();
  const range = opts.range ?? "day";
  const s = slice(now, opts.events, range, opts.start);
  const head = new Playhead();
  head.window = { from: s.from, to: s.to, start: s.start };
  head.t = opts.t ?? null;
  return {
    key,
    scope: opts.scope ?? "grid",
    sectionId: opts.scope === "section" ? "s1" : null,
    board: "b_demo",
    section: opts.scope === "section" ? "s1" : null,
    childName: opts.childName ?? null,
    range,
    head,
    detached: !!opts.detached,
    from: s.from,
    to: s.to,
    slice: s,
    sliceState: "ok",
    sliceWhy: null,
    player: opts.player ?? null,
    historyHead: null,
    historyState: opts.player ? "ok" : "idle",
    historyWhy: null,
    skew: 0,
  };
}

export function TimelineDemo() {
  const now = useMemo(() => Date.now(), []);
  const player = useMemo(() => take(now), [now]);
  const busy = useMemo(() => fixture("design:busy", { events: busyEvents(now), t: now - 6.45 * HOUR, player }), [now, player]);
  const quiet = useMemo(() => fixture("design:quiet", { events: busyEvents(now).filter((e) => e.kind === "card.add").slice(0, 2), range: "hour" }), [now]);
  const begins = useMemo(() => fixture("design:begins", { events: busyEvents(now).filter((e) => e.at > now - 3 * HOUR), range: "day", start: now - 3.5 * HOUR }), [now]);
  const sections = useMemo(() => [260, 400, 560].map((w, k) => ({ w, tl: fixture(`design:sec${w}`, { events: busyEvents(now), scope: "section", t: k ? now - (3 + k) * HOUR : null, detached: k === 2 }) })), [now]);
  const moment = useMemo(() => fixture("design:moment", { events: busyEvents(now), t: now - 4.08 * HOUR, range: "day" }), [now]);
  const night = useMemo(() => fixture("design:night", { events: busyEvents(now), t: now - 4.1 * HOUR, player }), [now, player]);
  const at = now - 6.45 * HOUR;
  return (
    <div className="tldemo" data-tl-demo>
      <div>
        <p className="tldemo-cap">The grid's band, every lane busy, scrubbed back to the moment Ada wrote the decision down (drag it, arrows, Space). Wren's work in the open is violet; behind the scenes, hollow</p>
        <TimelineBand tl={busy} still />
      </div>
      <div>
        <p className="tldemo-cap">Nearly empty: lanes with nothing in range fold to a line</p>
        <TimelineBand tl={quiet} still />
      </div>
      <div>
        <p className="tldemo-cap">History begins: before it, nothing is known, and the band says so</p>
        <TimelineBand tl={begins} still />
      </div>
      <div>
        <p className="tldemo-cap">A section's bar at 260, 400 and 560: at now; scrubbed; scrubbed on its own while the grid's is open (Follow the grid)</p>
        <div className="tldemo-bars">
          {sections.map(({ w, tl }) => (
            <div key={w} className="tldemo-section" style={{ width: w }} data-tl-demo-section={w}>
              <div className="tldemo-section-head">Shroud</div>
              <SectionTimelineBar tl={tl} still />
            </div>
          ))}
        </div>
      </div>
      <div className="tldemo-bars">
        <div>
          <p className="tldemo-cap">The moment: what was said, the answer held back, the notes left</p>
          <div className="tldemo-moment">
            <Moment tl={moment} seek={(t) => moment.head.seek(t)} />
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 320 }}>
          <p className="tldemo-cap">A section drawn as it was at that moment, for the person scrubbing only</p>
          <div className="rpdemo-frame">
            <div className="rpdemo-head">Shroud</div>
            <div className="rpdemo-body">
              <div className="rp-rewind-ground tl-past-ground" />
              <div className="rpdemo-content">
                <OldCards doc={player.docAt(at)} sectionId="s1" availW={980} cursors={player.cursorsAt(at)} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="f-night tldemo-night" style={{ background: "var(--color-void)" }}>
        <p className="tldemo-cap">Night: greys, white for the playhead, violet still an agent</p>
        <TimelineBand tl={night} still />
      </div>
    </div>
  );
}
