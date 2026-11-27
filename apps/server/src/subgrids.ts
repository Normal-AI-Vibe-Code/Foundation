/**
 * A section becomes a grid of its own (2026-11-17, Josh: "Open as its own grid … should create a
 * sub-grid that can be pulled out of the grid collection and moved to other grids, but still maintain
 * a preview in the Grid it used to be in, and maintain a link to the new location").
 *
 * `extractSection` makes a new grid named after the section, inside the grid the section is on, moves
 * what the section held into it, and leaves the section where it was, now holding the card that stands
 * for the new grid (`panel: "grid"`, the same card a grid dragged into another gets).
 *
 * What holds:
 *  - nothing is lost: the new grid is written in full first, and only then are the cards taken off
 *    the grid they were on (a crash in between leaves them in both places, never in neither);
 *  - cards keep their ids, their note text, table cells, files (the new grid gets its own record of
 *    the same bytes) and the wires among them; a wire that crossed the section's edge is let go, and
 *    the log says how many;
 *  - a machine, a huddle and a pipeline stage stay on the grid they were made on (as send_to_board
 *    has it): they stay in the section, beside the new grid's card, and the result names them;
 *  - what the server keeps about a moved card or section goes with it: a character is still a
 *    character on the new grid (its row and its `characters` entry), a section's council (`agents`)
 *    is the same council there;
 *  - a section that follows a Slack channel is refused, in words: Slack's own tables hold it to its grid;
 *  - who may see the new grid is who may see the one it came from (a members-only grid stays so);
 *  - done twice it is done once: a section that already stands for a grid answers with that grid.
 *
 * `gridOutline` is what the card draws its preview from: the grid's tracks, each top-level section's
 * place, and each card as a small block (an image with its file, so the preview can show it).
 */

import {
  BOARD_SCHEMA,
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  GRID_PLACE,
  boardMaps,
  findSection,
  logActivity,
  noteTextOf,
  readTracks,
  setNoteText,
  setTableCells,
  tableCellMap,
  tableCellsOf,
  uid,
  type GridTracks,
  type LinkDoc,
  type ObjectDoc,
  type PanelDoc,
  type PostedAgent,
  type SectionDoc,
  type UserInfo,
} from "@foundation/protocol";
import { adoptChildGrid, createBoardRow, editBoard, getBoard, listBoards, moveLeftover, leftoverLinks } from "./boards.ts";
import { moveCharacter } from "./characters.ts";
import { all, run } from "./db.ts";
import { shareFileWith } from "./files.ts";
import { HttpError } from "./http.ts";
import { canSeeBoard } from "./members.ts";
import { plural } from "./words.ts";
import { SYSTEM_GRIDS } from "./systemgrids.ts";
import { moveNoteFile } from "./medianotes.ts";

/** panel kinds that stay on the grid they were made on (their engine, their sockets and their pipeline are that grid's) */
const STAYS: Record<string, string> = { machine: "machine", huddle: "huddle", stage: "pipeline stage" };
const stays = (o: ObjectDoc) => o.kind === "panel" && o.panel in STAYS;

export interface ExtractResult {
  /** the new grid */
  board: string;
  name: string;
  /** the section on this grid that now stands for it, and the card in it */
  section: string;
  card: string;
  /** cards and sections that moved into the new grid */
  moved: number;
  sections: number;
  /** cards that stayed (a machine, a huddle, a pipeline stage), by name */
  stayed: Array<{ id: string; name: string; kind: string }>;
  wires: { moved: number; dropped: number };
  /** the section already stood for a grid: nothing was done */
  already?: boolean;
}

export interface ExtractBy {
  /** who to record against the new grid's files */
  userId: string;
  name: string;
  role: "human" | "agent";
  for?: string;
}

const sum = (xs: number[], a: number, b: number) => xs.slice(a, b + 1).reduce((n, x) => n + x, 0);

/** turn a section of `boardId` into a grid of its own inside that grid */
export function extractSection(boardId: string, sectionRef: string, by: ExtractBy): ExtractResult {
  const row = listBoards().find((b) => b.id === boardId);
  if (!row) throw new HttpError(404, "No such grid");
  if (row.kind !== "grid") throw new HttpError(400, row.kind === "deck" ? "A presentation's sections are its slides; they can't become grids" : "A web page has no sections");
  if (Object.values(SYSTEM_GRIDS).some((g) => g.id === boardId)) throw new HttpError(400, "This grid is Foundation's own (it's laid out from Settings); its sections stay on it");
  const from = getBoard(boardId).doc;
  const src = boardMaps(from);
  const sec = src.sections.get(sectionRef) ?? findSection(from, sectionRef);
  if (!sec) throw new HttpError(404, `No section “${sectionRef}” on this grid`);

  // done already: the section stands for a grid
  const host = sec.host ? src.objects.get(sec.host) : undefined;
  if (host?.kind === "panel" && host.panel === "grid" && host.board) {
    return { board: host.board, name: host.name, section: sec.id, card: host.id, moved: 0, sections: 0, stayed: [], wires: { moved: 0, dropped: 0 }, already: true };
  }

  const everySection = [...src.sections.values()];
  const within = (id: string): SectionDoc[] => everySection.filter((s) => s.parent === id).flatMap((s) => [s, ...within(s.id)]);
  const inner = within(sec.id);
  const ids = new Set([sec.id, ...inner.map((s) => s.id)]);
  const follows = [...ids].map((id) => src.slack.get(id)).find(Boolean);
  if (follows) throw new HttpError(400, `“${sec.name}” follows #${follows.name} on Slack, and Slack keeps a channel's section on the grid it was set up on. It can't become a grid of its own`);

  const cards = [...src.objects.values()].filter((o) => ids.has(o.sectionId));
  const staying = cards.filter(stays);
  const moving = cards.filter((o) => !stays(o));
  // done already, with something that had to stay beside the card: all that could move is the grid's own card
  const only = moving.length === 1 && inner.length === 0 ? moving[0] : undefined;
  if (only?.kind === "panel" && only.panel === "grid" && only.board && listBoards().some((b) => b.id === only.board && b.parent === boardId)) {
    return { board: only.board, name: only.name, section: sec.id, card: only.id, moved: 0, sections: 0, stayed: [], wires: { moved: 0, dropped: 0 }, already: true };
  }
  const movingIds = new Set(moving.map((o) => o.id));
  const links = [...src.links.values()];
  const wiresIn = links.filter((l) => movingIds.has(l.from.panel) && movingIds.has(l.to.panel));
  const wiresCut = links.filter((l) => movingIds.has(l.from.panel) !== movingIds.has(l.to.panel));

  const name = sec.name.trim().slice(0, 80) || "Untitled grid";
  const child = createBoardRow(name);
  // who can see it, and who may only read it, is as on the grid it came from
  run("insert or ignore into board_members (board_id, user_id, role, source, added_at) select ?, user_id, role, source, ? from board_members where board_id = ?", child, Date.now(), boardId);
  run("insert or ignore into board_roles (board_id, user_id, role, set_by, set_at) select ?, user_id, role, set_by, ? from board_roles where board_id = ?", child, Date.now(), boardId);

  // each moved card as it will stand on the new grid: its file is that grid's too
  const landed = moving.map((card) => {
    const next = { ...card } as ObjectDoc & { text?: string; huddle?: unknown };
    if (next.kind === "media") {
      const m = /^\/files\/([^/?#]+)/.exec(next.src);
      if (m) {
        const there = shareFileWith(m[1], child, by.userId);
        next.src = next.src.replace(m[1], there);
        // a voice or video note goes whole: who, when, its wave, and its file on the new grid
        if (next.note) next.note = moveNoteFile(next, m[1], there).note;
      }
    }
    if (next.kind === "panel" && next.fileId) next.fileId = shareFileWith(next.fileId, child, by.userId);
    if (next.kind === "map" && next.sourceTableId && !movingIds.has(next.sourceTableId)) next.sourceTableId = null;
    delete next.text; // a note's text is its Y.Text (legacy field, boards before schema 3)
    return {
      card: next as ObjectDoc,
      text: card.kind === "note" ? noteTextOf(from, card) : undefined,
      cells: card.kind === "table" ? tableCellsOf(from, card.id) : undefined,
      // a character's row goes first, so the new grid finds it when its card arrives
      character: card.kind === "panel" && card.panel === "character" ? (moveCharacter(boardId, child, card.id) ?? src.characters.get(card.id)) : undefined,
    };
  });

  // the new grid: the section's own grid if it had one, or one section the size it was
  const tracksOfHome = sec.parent ? (src.sections.get(sec.parent)?.grid ?? { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] }) : readTracks(from);
  const isGrid = inner.length > 0;
  const tracks: GridTracks = isGrid
    ? (sec.grid ?? { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] })
    : { cols: [sum(tracksOfHome.cols, sec.c0, sec.c1) || DEFAULT_COL_W], rows: [sum(tracksOfHome.rows, sec.r0, sec.r1) || DEFAULT_ROW_H] };
  const hostMoves = !!sec.host && movingIds.has(sec.host);
  const childSections: SectionDoc[] = isGrid
    ? inner.map((s) => {
        if (s.parent !== sec.id) return { ...s };
        const { parent: _top, ...rest } = s;
        return rest;
      })
    : [{ id: sec.id, name: sec.name, c0: 0, r0: 0, c1: 0, r1: 0, ...(hostMoves ? { host: sec.host } : {}) }];
  // a council goes with its section; the council of a section that became the grid itself is the grid's
  const councils: Array<[string, PostedAgent[]]> = [];
  for (const id of ids) {
    const posted = src.agents.get(id);
    if (!Array.isArray(posted) || !posted.length) continue;
    councils.push([isGrid && id === sec.id ? GRID_PLACE : id, posted]);
  }
  const parentName = row.name;
  const who = { who: by.name, role: by.role, ...(by.for ? { for: by.for } : {}) } as const;

  editBoard(child, "system", (doc) => {
    const m = boardMaps(doc);
    m.meta.set("schema", BOARD_SCHEMA);
    m.grid.set("tracks", tracks);
    for (const s of childSections) m.sections.set(s.id, s);
    for (const { card, text, cells, character } of landed) {
      m.objects.set(card.id, card);
      if (text !== undefined) setNoteText(doc, card.id, text);
      if (cells) {
        tableCellMap(doc, card.id);
        setTableCells(doc, card.id, cells);
      }
      if (character) m.characters.set(card.id, character);
    }
    for (const l of wiresIn) m.links.set(l.id, { ...l } as LinkDoc);
    for (const [place, posted] of councils) m.agents.set(place, [...(m.agents.get(place) ?? []), ...posted]);
    logActivity(doc, { ...who, text: `made this grid from the section “${sec.name}” of ${parentName}: ${plural(moving.length, "card")} came with it` });
  });
  adoptChildGrid(child, boardId);
  // an ask's card went with it: the answer has to find the card where it is now (one tied to a pipeline stage stays with its stage)
  for (const id of movingIds) run("update asks set board_id = ? where board_id = ? and panel_id = ? and stage_panel_id is null", child, boardId, id);
  // grids whose cards moved with the section are inside the new grid now (or, for a card left behind by a grid that moved out, remembered there)
  for (const { card } of landed) {
    if (card.kind !== "panel" || card.panel !== "grid" || !card.board) continue;
    const kid = listBoards().find((b) => b.id === card.board);
    if (kid?.parent === boardId) adoptChildGrid(kid.id, child);
    else if (leftoverLinks(card.board).includes(boardId)) moveLeftover(boardId, child, card.board);
  }

  const cardId = uid("pnl");
  editBoard(boardId, "system", (doc) => {
    const m = boardMaps(doc);
    for (const id of movingIds) {
      m.objects.delete(id);
      m.noteText.delete(id);
      m.cells.delete(id);
      m.characters.delete(id);
    }
    for (const l of [...wiresIn, ...wiresCut]) m.links.delete(l.id);
    for (const s of inner) m.sections.delete(s.id);
    for (const id of ids) m.agents.delete(id);
    // what stays is in the section itself now, beside the grid's card
    for (const o of staying) if (o.sectionId !== sec.id) m.objects.set(o.id, { ...o, sectionId: sec.id, float: false, x: 0, y: 0 });
    const panel: PanelDoc = { id: cardId, kind: "panel", panel: "grid", sectionId: sec.id, name, x: 0, y: 0, float: false, bornAt: Date.now(), w: 720, h: 520, ports: [], board: child };
    m.objects.set(cardId, panel);
    const { grid: _grid, host: _host, ...kept } = m.sections.get(sec.id) ?? sec;
    // the card fills the section, unless something had to stay in it
    m.sections.set(sec.id, staying.length ? kept : { ...kept, host: cardId });
    const notes = [
      `made “${sec.name}” a grid of its own, inside this one: ${plural(moving.length, "card")} moved into it`,
      wiresCut.length ? `${plural(wiresCut.length, "wire")} that crossed the section's edge ${wiresCut.length === 1 ? "was" : "were"} let go (the ends that stayed are still here, unwired)` : "",
      staying.length ? `${staying.map((o) => `the ${STAYS[(o as PanelDoc).panel]} “${o.name}”`).join(", ")} stayed here` : "",
    ].filter(Boolean);
    logActivity(doc, { ...who, text: notes.join("; "), objectId: cardId });
  });

  return {
    board: child,
    name,
    section: sec.id,
    card: cardId,
    moved: moving.length,
    sections: childSections.length,
    stayed: staying.map((o) => ({ id: o.id, name: o.name, kind: STAYS[(o as PanelDoc).panel] })),
    wires: { moved: wiresIn.length, dropped: wiresCut.length },
  };
}

// ---------- the undo: a grid put back into its section ----------

export interface DissolveResult {
  /** the grid that was put back (now archived: its row, history and files are kept) */
  board: string;
  name: string;
  /** the section on this grid that holds its cards again */
  section: string;
  moved: number;
  /** sections that came back inside the section (0: its cards went straight into it) */
  sections: number;
  wires: number;
}

/**
 * Put a grid that was made from a section back into it (the undo of `extractSection`; plan
 * *sub-grid-dissolve*). `ref` is the section that stands for the grid, or the grid's card.
 *
 *  - only a grid that is inside this one: a grid that moved elsewhere left a link here, not itself;
 *  - everything comes back with its text, cells, files, wires, characters, councils and asks, and the
 *    grids inside it are inside this one again; a grid of one section gives its cards straight to the
 *    section, a grid of several sections becomes the section's own grid of them;
 *  - a machine, a huddle or a pipeline stage on that grid stays on it (as everywhere), so the press is
 *    refused in words until they are taken off; so is a section that follows a Slack channel;
 *  - this grid is written in full first and only then is the other archived (never deleted);
 *  - it restructures shared work, so it needs `confirm` (the tool) and a person's press (the client).
 */
export function dissolveGrid(boardId: string, ref: string, by: ExtractBy & { canWriteChild: (id: string) => boolean }): DissolveResult {
  const row = listBoards().find((b) => b.id === boardId);
  if (!row) throw new HttpError(404, "No such grid");
  const home = getBoard(boardId).doc;
  const src = boardMaps(home);
  // the grid's card: named directly, or the card in the named section
  const byCard = src.objects.get(ref);
  const sec = byCard ? src.sections.get(byCard.sectionId) : (src.sections.get(ref) ?? findSection(home, ref));
  if (!sec) throw new HttpError(404, `No section “${ref}” on this grid`);
  const isGridCard = (o: ObjectDoc | undefined): o is PanelDoc => o?.kind === "panel" && o.panel === "grid" && !!o.board;
  const card = isGridCard(byCard) ? byCard : isGridCard(sec.host ? src.objects.get(sec.host) : undefined) ? (src.objects.get(sec.host!) as PanelDoc) : [...src.objects.values()].find((o): o is PanelDoc => o.sectionId === sec.id && isGridCard(o));
  if (!card?.board) throw new HttpError(400, `“${sec.name}” doesn't stand for a grid, so there is nothing to put back`);
  const childId = card.board;
  const kid = listBoards().find((b) => b.id === childId);
  if (!kid) throw new HttpError(404, `The grid “${card.name}” isn't there any more`);
  if (kid.parent !== boardId) throw new HttpError(400, `“${kid.name}” isn't inside this grid now (this card is a link to where it went): move it back here first`);
  if (kid.kind !== "grid") throw new HttpError(400, `“${kid.name}” isn't a grid`);
  if (!by.canWriteChild(childId)) throw new HttpError(403, `View only: you can read “${kid.name}” but not change it`);

  const from = getBoard(childId).doc;
  const cm = boardMaps(from);
  const cards = [...cm.objects.values()];
  const staying = cards.filter(stays);
  if (staying.length) {
    throw new HttpError(400, `${staying.map((o) => `the ${STAYS[(o as PanelDoc).panel]} “${o.name}”`).join(", ")} stay${staying.length === 1 ? "s" : ""} on “${kid.name}”, the grid ${staying.length === 1 ? "it was" : "they were"} made on. Take ${staying.length === 1 ? "it" : "them"} off first, then put the grid back`);
  }
  const followed = [...cm.sections.keys()].map((id) => cm.slack.get(id)).find(Boolean);
  if (followed) throw new HttpError(400, `A section of “${kid.name}” follows #${followed.name} on Slack, and Slack keeps it on that grid`);

  // the grid's sections: one alone gives its cards to the section; several become the section's own grid
  const childSections = [...cm.sections.values()];
  const tops = childSections.filter((s) => !s.parent);
  const flat = tops.length === 1 && childSections.length === 1;
  const taken = new Set(src.sections.keys());
  const rename = new Map<string, string>();
  for (const s of childSections) rename.set(s.id, flat ? sec.id : taken.has(s.id) ? uid("sec") : s.id);
  const place = (id: string) => rename.get(id) ?? sec.id;
  const back: SectionDoc[] = flat
    ? []
    : childSections.map((s) => {
        const { parent, ...rest } = s;
        return { ...rest, id: place(s.id), parent: parent ? place(parent) : sec.id, ...(s.host ? { host: s.host } : {}) };
      });
  const onlyHost = flat ? tops[0].host : undefined;

  const ids = new Set(cards.map((o) => o.id));
  const landed = cards.map((o) => {
    const next = { ...o, sectionId: place(o.sectionId) } as ObjectDoc & { text?: string };
    if (next.kind === "media") {
      const mm = /^\/files\/([^/?#]+)/.exec(next.src);
      if (mm) {
        const there = shareFileWith(mm[1], boardId, by.userId);
        next.src = next.src.replace(mm[1], there);
        if (next.note) next.note = moveNoteFile(next, mm[1], there).note;
      }
    }
    if (next.kind === "panel" && next.fileId) next.fileId = shareFileWith(next.fileId, boardId, by.userId);
    if (next.kind === "map" && next.sourceTableId && !ids.has(next.sourceTableId)) next.sourceTableId = null;
    delete next.text;
    return {
      card: next as ObjectDoc,
      text: o.kind === "note" ? noteTextOf(from, o) : undefined,
      cells: o.kind === "table" ? tableCellsOf(from, o.id) : undefined,
      character: o.kind === "panel" && o.panel === "character" ? (moveCharacter(childId, boardId, o.id) ?? cm.characters.get(o.id)) : undefined,
    };
  });
  const wires = [...cm.links.values()];
  const councils: Array<[string, PostedAgent[]]> = [];
  for (const [placeId, posted] of cm.agents.entries()) {
    if (!Array.isArray(posted) || !posted.length) continue;
    councils.push([placeId === GRID_PLACE ? sec.id : place(placeId), posted]);
  }
  const who = { who: by.name, role: by.role, ...(by.for ? { for: by.for } : {}) } as const;

  editBoard(boardId, "system", (doc) => {
    const m = boardMaps(doc);
    for (const s of back) m.sections.set(s.id, s);
    for (const { card: c, text, cells, character } of landed) {
      m.objects.set(c.id, c);
      if (text !== undefined) setNoteText(doc, c.id, text);
      if (cells) {
        tableCellMap(doc, c.id);
        setTableCells(doc, c.id, cells);
      }
      if (character) m.characters.set(c.id, character);
    }
    for (const l of wires) m.links.set(l.id, { ...l } as LinkDoc);
    for (const [p, posted] of councils) {
      const have = m.agents.get(p) ?? [];
      m.agents.set(p, [...have, ...posted.filter((a) => !have.some((h) => h.key === a.key && h.name === a.name))]);
    }
    m.objects.delete(card.id);
    const now = m.sections.get(sec.id) ?? sec;
    const { host: _host, grid: _grid, ...kept } = now;
    m.sections.set(sec.id, {
      ...kept,
      ...(flat ? (onlyHost && ids.has(onlyHost) ? { host: onlyHost } : {}) : { grid: readTracks(from) }),
    });
    logActivity(doc, { ...who, text: `put the grid “${kid.name}” back into the section “${sec.name}”: ${plural(cards.length, "card")} came with it` });
  });
  for (const id of ids) run("update asks set board_id = ? where board_id = ? and panel_id = ? and stage_panel_id is null", boardId, childId, id);
  for (const g of listBoards()) if (g.parent === childId) adoptChildGrid(g.id, boardId);
  for (const r of all<{ child_id: string }>("select child_id from grid_leftovers where board_id = ?", childId)) moveLeftover(childId, boardId, r.child_id);
  editBoard(childId, "system", (doc) => logActivity(doc, { ...who, text: `put this grid back into the section “${sec.name}” of ${row.name}; it is archived, and its history is kept` }));
  run("update boards set archived_at = ? where id = ?", Date.now(), childId);

  return { board: childId, name: kid.name, section: sec.id, moved: cards.length, sections: back.length, wires: wires.length };
}

// ---------- the preview ----------

export interface OutlineCard {
  id: string;
  /** note, table, map, image, video, or a panel's kind (app, link, file, character …) */
  kind: string;
  name: string;
  /** its size on the grid, in the grid's own pixels; x and y only mean something when it floats */
  w: number;
  h: number;
  x: number;
  y: number;
  float: boolean;
  /** an image's file, for a thumbnail */
  thumb?: string;
}

export interface OutlineSection {
  id: string;
  name: string;
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  /** cards in it, and in the sections inside it */
  cards: number;
  /** sections inside it (it is a grid of its own) */
  grids: number;
  /** the card that fills it, when one does */
  host?: string;
  /** the first cards, top-left first */
  items: OutlineCard[];
}

export interface GridOutline {
  id: string;
  name: string;
  /** the grid it's inside now (null: the top of All Grids), and that grid's name when this person may see it */
  parent: string | null;
  parentName: string | null;
  tracks: GridTracks;
  sections: OutlineSection[];
  cards: number;
  updatedAt: number | null;
}

const OUTLINE_SECTIONS = 48;
const OUTLINE_ITEMS = 18;

function outlineCard(o: ObjectDoc): OutlineCard {
  const base = { id: o.id, name: o.name, x: Math.round(o.x), y: Math.round(o.y), float: o.float };
  if (o.kind === "table") return { ...base, kind: "table", w: Math.min(1200, 48 + o.cols * 112), h: Math.min(900, 40 + o.rows * 30) };
  if (o.kind === "media") return { ...base, kind: o.media, w: o.w, h: o.h, ...(o.media === "image" && o.src.startsWith("/files/") ? { thumb: o.src } : {}) };
  if (o.kind === "panel") return { ...base, kind: o.panel, w: o.w, h: o.h, ...(o.panel === "file" && o.fileId && o.mime?.startsWith("image/") ? { thumb: `/files/${o.fileId}` } : {}) };
  return { ...base, kind: o.kind, w: o.w, h: o.h };
}

/** what a grid holds, for the card that stands for it on another grid */
export function gridOutline(id: string, user: UserInfo): GridOutline {
  const row = listBoards().find((b) => b.id === id);
  if (!row) throw new HttpError(404, "No such grid");
  const doc = getBoard(id).doc;
  const m = boardMaps(doc);
  const all = [...m.sections.values()];
  const cards = [...m.objects.values()];
  // a section's cards: its own, and those of every section inside it
  const within = (sec: string): string[] => [sec, ...all.filter((s) => s.parent === sec).flatMap((s) => within(s.id))];
  const sections = all
    .filter((s) => !s.parent)
    .sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0)
    .slice(0, OUTLINE_SECTIONS)
    .map((s): OutlineSection => {
      const inside = new Set(within(s.id));
      const mine = cards.filter((o) => inside.has(o.sectionId));
      return {
        id: s.id,
        name: s.name,
        c0: s.c0,
        r0: s.r0,
        c1: s.c1,
        r1: s.r1,
        cards: mine.length,
        grids: inside.size - 1,
        ...(s.host ? { host: s.host } : {}),
        items: mine.slice(0, OUTLINE_ITEMS).map(outlineCard),
      };
    });
  // a grid this person can't see reads as the top, as it does in their All Grids
  const parent = row.parent ? listBoards().find((b) => b.id === row.parent && canSeeBoard(user, b.id)) : undefined;
  return {
    id,
    name: row.name,
    parent: parent?.id ?? null,
    parentName: parent?.name ?? null,
    tracks: readTracks(doc),
    sections,
    cards: cards.length,
    updatedAt: row.updated_at,
  };
}
