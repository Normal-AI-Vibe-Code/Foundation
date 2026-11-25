/**
 * Replay and the clock on `#/design` (the ChatForm chapter): the clock card at rest, scrubbed back, and
 * locked; a section rewound with its banner and its small stage; the session's replay with its transport,
 * transcript and the grid as it was. Drawn from fixtures built here (a take made from a real Yjs
 * document's changes): no server.
 */

import { useMemo } from "react";
import * as Y from "yjs";
import { boardMaps, setNoteText, TakePlayer, type ObjectDoc, type ReplayTimeline, type TakeFrames } from "@foundation/protocol";
import { ClockCardLocked, ClockCardView, Clock, OldCards, RewindBanner, SessionReplayView, type ReplayData } from "./ReplayView";
import "./replay.css";

const MIN = 60_000;

function fixture(): ReplayData {
  const t0 = Date.now() - 3 * 60 * MIN;
  const doc = new Y.Doc();
  const m = boardMaps(doc);
  m.sections.set("s1", { id: "s1", name: "Shroud", c0: 0, r0: 0, c1: 0, r1: 0 });
  m.objects.set("n1", { id: "n1", kind: "note", sectionId: "s1", name: "Brief", x: 0, y: 0, float: false, bornAt: t0, w: 300, h: 180 });
  setNoteText(doc, "n1", "Fan shroud, rev C\nWall 2 mm, PETG\nClearance to blade tip: 1.5 mm");
  m.objects.set("f1", { id: "f1", kind: "panel", panel: "file", sectionId: "s1", name: "shroud-revC.3mf", x: 0, y: 0, float: false, bornAt: t0 + 1, w: 300, h: 220, ports: [] });
  const base = Y.encodeStateAsUpdate(doc);
  const updates: TakeFrames["updates"] = [];
  let at = 0;
  doc.on("update", (u: Uint8Array) => updates.push({ at, update: u }));
  at = t0 + 2 * MIN;
  doc.transact(() => {
    m.objects.set("n2", { id: "n2", kind: "note", sectionId: "s1", name: "Decision", x: 0, y: 0, float: false, bornAt: at, w: 300, h: 140 });
    setNoteText(doc, "n2", "Decision: wall to 3 mm at the root\n(Kai, agreed with Wren)");
  });
  at = t0 + 3 * MIN;
  doc.transact(() => {
    const f = m.objects.get("f1") as ObjectDoc;
    m.objects.set("f1", { ...f, x: 680, y: 0, float: true });
  });
  const frames: TakeFrames = {
    head: { id: "tk_demo", board: "b_demo", section: "s1", from: t0, to: t0 + 4 * MIN, updates: updates.length },
    base,
    updates,
    cursors: [{ at: t0 + 2 * MIN, who: [{ n: "Wren", t: "n2", a: 1 }] }],
  };
  const timeline: ReplayTimeline = {
    session: { id: "hs_demo", huddleId: "hd_demo", home: "chat", name: "Huddle in #fan-shroud", startedAt: t0, endedAt: t0 + 4 * MIN, channel: { id: "ch_shroud", name: "fan-shroud", kind: "open" } },
    people: ["Ada Lovelace", "Kai Moreno"],
    agents: ["Wren"],
    lines: [
      { id: "l1", at: t0 + 20_000, speaker: "Ada Lovelace", text: "Let's look at the root of the shroud: it flexes at speed.", source: "speech" },
      { id: "l2", at: t0 + 70_000, speaker: "Kai Moreno", text: "Wren, would 3 mm at the root be enough?", source: "typed" },
      { id: "l3", at: t0 + 80_000, speaker: "Wren", text: "At 3 mm the deflection at the root drops by about half. I'd keep the tip at 2 mm.", source: "agent" },
      { id: "l4", at: t0 + 125_000, speaker: "Kai Moreno", text: "Writing that down on the grid.", source: "speech" },
    ],
    media: [],
    recordings: [{ by: "Ada Lovelace", startedAt: t0 + 10_000, stoppedAt: t0 + 4 * MIN - 5000 }],
    places: [{ board: "b_demo", boardName: "Fans", section: "s1", sectionName: "Shroud", at: t0 + 5000, by: "Ada Lovelace" }],
    events: [],
    messages: [{ id: "m1", createdAt: t0 + 150_000, text: "Rev C attached for the record", type: "text", files: [], author: "Ada Lovelace" }],
    takes: [{ id: "tk_demo", board: "b_demo", boardName: "Fans", section: "s1", sectionName: "Shroud", from: t0, to: t0 + 4 * MIN, updates: updates.length, bytes: 4096, truncated: null }],
    changes: updates.map((u) => ({ take: "tk_demo", at: u.at })),
  };
  return { timeline, players: new Map([["tk_demo", new TakePlayer(frames)]]) };
}

export function ReplayDemo() {
  const data = useMemo(fixture, []);
  const { timeline } = data;
  const atRest = useMemo(() => new Clock(4 * MIN, 4 * MIN), []);
  const mid = useMemo(() => new Clock(4 * MIN, 134_000), []);
  const player = data.players.get("tk_demo")!;
  const at = timeline.session.startedAt + 134_000;
  const rewound = { sectionId: "s_demo", panelId: "p_demo", data, clock: mid, takeId: "tk_demo" };
  return (
    <div className="chat-demo-row rpdemo" data-rp-demo>
      <div className="rpdemo-cards">
        <p className="chat-demo-cap">The clock card at rest (360 × 120)</p>
        <div className="rpdemo-card">
          <ClockCardView timeline={timeline} clock={atRest} rewound={false} grid />
        </div>
        <p className="chat-demo-cap">Scrubbed back: its section is drawn as it was</p>
        <div className="rpdemo-card">
          <ClockCardView timeline={timeline} clock={mid} rewound grid onBack={() => {}} />
        </div>
        <p className="chat-demo-cap">From a conversation you're not in</p>
        <div className="rpdemo-card">
          <ClockCardLocked why={null} />
        </div>
      </div>
      <div className="rpdemo-section">
        <p className="chat-demo-cap">A section rewound, for the person scrubbing only</p>
        <div className="rpdemo-frame">
          <div className="rpdemo-head">Shroud</div>
          <div className="rpdemo-body">
            <div className="rp-rewind-ground" />
            <div className="rpdemo-content">
              <OldCards doc={player.docAt(at)} sectionId="s1" availW={980} cursors={player.cursorsAt(at)} />
            </div>
            <RewindBanner r={rewound} sectionId="s_demo" />
          </div>
        </div>
      </div>
      <div className="rpdemo-full">
        <p className="chat-demo-cap">The session's replay (Huddles tab): the transport and its marks, the people, the transcript following, the grid as it was</p>
        <SessionReplayView data={data} still />
      </div>
    </div>
  );
}
