/**
 * Foundation's own grids (2026-11-15): the plan and the design language are shown the way everything
 * else is, as a grid. Settings → Plan is one large section that holds a kanban card (the plan board);
 * Settings → Design language is a grid with a section for each chapter, each holding a design card.
 * The server lays them out the first time either is opened, so two people opening one at once don't
 * both seed it. They are ordinary boards after that (people can move the cards, add notes beside them),
 * just not listed in All Grids: they're reached from Settings.
 */

import { DESIGN_CHAPTERS, boardMaps, logActivity, uid, type PanelDoc, type SectionDoc } from "@foundation/protocol";
import { editBoard, ensureBoardRow, getBoard } from "./boards.ts";

export const SYSTEM_GRIDS = {
  plan: { id: "foundation-plan", name: "The plan" },
  design: { id: "foundation-design", name: "Design language" },
} as const;
export type SystemGridKey = keyof typeof SYSTEM_GRIDS;

export const isSystemGridKey = (k: string): k is SystemGridKey => k in SYSTEM_GRIDS;

/** the design grid: four chapters across */
const DESIGN_COLS = 4;
const DESIGN_COL_W = 1320;
const DESIGN_ROW_H = 1680;

function hosted(m: ReturnType<typeof boardMaps>, sec: SectionDoc, panel: "kanban" | "design", name: string, source: string, w: number, h: number) {
  const card: PanelDoc = { id: uid("pnl"), kind: "panel", panel, sectionId: sec.id, name, x: 0, y: 0, float: false, bornAt: Date.now(), w, h, ports: [], source };
  m.objects.set(card.id, card);
  m.sections.set(sec.id, { ...sec, host: card.id });
}

/** the grid's id, made and laid out if this is the first time */
export function openSystemGrid(key: SystemGridKey): { id: string; made: boolean } {
  const { id, name } = SYSTEM_GRIDS[key];
  ensureBoardRow(id, name);
  if (boardMaps(getBoard(id).doc).sections.size > 0) return { id, made: false };
  editBoard(id, "system", (doc) => {
    const m = boardMaps(doc);
    if (m.sections.size > 0) return;
    if (key === "plan") {
      m.grid.set("tracks", { cols: [2480], rows: [1480] });
      const sec: SectionDoc = { id: uid("sec"), name: "The plan", c0: 0, r0: 0, c1: 0, r1: 0 };
      m.sections.set(sec.id, sec);
      hosted(m, sec, "kanban", "The plan", "plan", 2400, 1400);
    } else {
      const rows = Math.ceil(DESIGN_CHAPTERS.length / DESIGN_COLS);
      m.grid.set("tracks", { cols: new Array(DESIGN_COLS).fill(DESIGN_COL_W), rows: new Array(rows).fill(DESIGN_ROW_H) });
      DESIGN_CHAPTERS.forEach((ch, i) => {
        const c = i % DESIGN_COLS;
        const r = Math.floor(i / DESIGN_COLS);
        const sec: SectionDoc = { id: uid("sec"), name: ch.name, c0: c, r0: r, c1: c, r1: r };
        m.sections.set(sec.id, sec);
        hosted(m, sec, "design", ch.name, ch.id, DESIGN_COL_W - 80, DESIGN_ROW_H - 120);
      });
    }
    logActivity(doc, { who: "Foundation", role: "agent", text: key === "plan" ? "laid out the plan as a kanban" : "laid out the design language, a section for each chapter" });
  });
  return { id, made: true };
}
