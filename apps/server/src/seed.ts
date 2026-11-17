/**
 * The company board — Foundation's original view: every app the company runs,
 * live, and how data passes between them. Seeded once on an empty database;
 * after that it belongs to the people (and agents) who edit it.
 */

import { boardMaps, DEFAULT_COL_W, DEFAULT_ROW_H, putNote, uid, type LinkDoc, type NoteDoc, type PanelDoc, type SectionDoc } from "@foundation/protocol";
import { editBoard, getBoard } from "./boards.ts";
import { COMPANY_FLOWS, CONNECTORS } from "./connectors.ts";
import { saveApp } from "./apps.ts";


export function seedCompanyBoard() {
  const board = getBoard("company");
  const m = boardMaps(board.doc);
  if (m.sections.size > 0) return;

  editBoard("company", "seed", (doc) => {
    const maps = boardMaps(doc);
    maps.meta.set("schema", 1); // laid out as cards, then migrated (migrate.ts) like any board
    maps.meta.set("name", "Form Industries");
    maps.grid.set("tracks", { cols: [2280, DEFAULT_COL_W * 0.75], rows: [900, DEFAULT_ROW_H * 0.8] });

    const company: SectionDoc = { id: uid("sec"), name: "Company", c0: 0, r0: 0, c1: 0, r1: 0 };
    const hermes: SectionDoc = { id: uid("sec"), name: "Asks & agents", c0: 1, r0: 0, c1: 1, r1: 0 };
    const apps: SectionDoc = { id: uid("sec"), name: "Apps", c0: 0, r0: 1, c1: 0, r1: 1 };
    const design: SectionDoc = { id: uid("sec"), name: "Design", c0: 1, r0: 1, c1: 1, r1: 1 };
    for (const s of [company, hermes, apps, design]) maps.sections.set(s.id, s);

    // a designed layout: design flows left to right into manufacturing and the
    // data room; Foundation sits under it all, reading everything
    const PLACE: Record<string, [number, number]> = {
      creation: [0, 0],
      vision: [540, 0],
      bomform: [1080, 0],
      dataroom: [1620, 0],
      foundation: [0, 420],
      factoryform: [1080, 420],
    };
    const panels = new Map<string, PanelDoc>();
    CONNECTORS.forEach((c, i) => {
      const at = PLACE[c.id];
      const p: PanelDoc = {
        id: uid("pnl"),
        kind: "panel",
        panel: "connector",
        connector: c.id,
        sectionId: company.id,
        name: c.name,
        text: c.role,
        x: at ? at[0] : 0,
        y: at ? at[1] : 0,
        float: Boolean(at),
        bornAt: Date.now() + i,
        w: 440,
        h: 300,
        ports: [
          { id: uid("port"), name: "in", dir: "in", type: "json" },
          { id: uid("port"), name: "out", dir: "out", type: "json" },
        ],
        createdBy: "Foundation",
      };
      panels.set(c.id, p);
      maps.objects.set(p.id, p);
    });
    for (const f of COMPANY_FLOWS) {
      const a = panels.get(f.from);
      const b = panels.get(f.to);
      if (!a || !b) continue;
      const l: LinkDoc = { id: uid("lnk"), from: { panel: a.id, port: a.ports[1].id }, to: { panel: b.id, port: b.ports[0].id }, label: f.carries, createdBy: "Foundation" };
      maps.links.set(l.id, l);
    }

    const welcome: NoteDoc & { text: string } = {
      id: uid("note"),
      kind: "note",
      sectionId: hermes.id,
      name: "Start here",
      x: 0,
      y: 0,
      float: false,
      bornAt: Date.now(),
      w: 440,
      h: 360,
      text:
        "## Foundation\n\nThe company's shared grid. Everyone here, every app we run, and the agents that work with us.\n\n- **⌘K** (Ctrl+K on Windows and Linux) searches everything — cards, files, CAD, Slack, GitHub\n- **⌘J** talks to the agent (or hold **Space** to speak)\n- **Drop files** anywhere — designs, CAD, PDFs, video\n- **⌘L** opens a link or an app as a live panel\n- **P** presents the board\n- **A** shows the agent layer: who is working on what, and how apps are wired",
    };
    putNote(doc, welcome);

    const brief: NoteDoc & { text: string } = {
      id: uid("note"),
      kind: "note",
      sectionId: design.id,
      name: "How design flows",
      x: 0,
      y: 0,
      float: false,
      bornAt: Date.now(),
      w: 420,
      h: 280,
      text:
        "## Vision ↔ Foundation\n\nAsk the agent for a design and it writes a **brief** here, opens **Vision**, and asks reviewers through **Hermes**. CAD that comes back lands on the brief's ask card and flows to BomForm.",
    };
    putNote(doc, brief);
  });

  for (const a of [
    { name: "Airform Data Room", url: "https://airformdata.com", repo: "joshleong/AirformDataRoom", description: "Programs, economics and simulations for investors" },
    { name: "FactoryForm", url: "http://localhost:3001", repo: "josh-normal/FactoryForm", description: "Factory operations: inventory, stations, work orders", mcp: "http://localhost:3001/mcp" },
    { name: "Vision", url: "http://localhost:1420", repo: "torotron/Vision", description: "Design, simulation and CAD studio" },
    { name: "Creation", url: "http://localhost:5173", repo: "joshleong/Creation", description: "Brand, merchandise and design lab" },
  ]) {
    saveApp(a, "seed");
  }
}
