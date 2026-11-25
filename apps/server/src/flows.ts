/**
 * Data flowing card to card on the server (2026-11-24; the architecture is docs/flows.md, the lens is
 * packages/protocol/src/flows.ts).
 *
 * Before this, the company grid's wires out of BomForm, FactoryForm and the rest carried nothing: no code
 * wrote a connector's `outputs`, and a table couldn't take a wire unless a machine was at the other end, so
 * connecting or disconnecting one changed nothing. Now:
 *
 *   - A connector card with a wire out of it puts what its system says now on its out port, as
 *     `{ from, summary, at, rows }` (rows: the system's main list as records). It reads when the wire is made
 *     and again every minute while wired (the connector cache keeps that to one read per system), and reads
 *     nothing while unwired. An offline system says why on what it feeds.
 *   - A table with a wire into it (port `rows`) has what arrives written into its cells, through the table's
 *     lens (`feed`: filter, columns, limit). Edits upstream flow through; a table fed by a table follows it.
 *   - Taking the wire off stops the flow: the table keeps the rows it last had, and says it's no longer fed.
 *   - Each fed table's state is in the board's `flows` map (working while its source is read, waiting before
 *     anything arrived, ok with how many rows passed the lens, error with why). Written by the server alone;
 *     its writes carry ORIGIN, never a person's, so nobody's undo takes them back and they don't wake it.
 */

import type * as Y from "yjs";
import { appendSection, applyLens, boardMaps, putNote, recordsToRows, setTableCells, TABLE_PORT, uid, type FlowState, type LinkDoc, type MapDoc, type NoteDoc, type PanelDoc, type TableDoc } from "@foundation/protocol";
import { editBoard, getBoard, onBoardOpen, type Board } from "./boards.ts";
import { readConnector, type ConnectorState } from "./connectors.ts";
import { deliver, sourceValue } from "./machineio.ts";

const ORIGIN = "flows";
/** how often a wired connector is read again */
export const CONNECTOR_REFRESH_MS = 60_000;

/** what a connector puts on its out port: its main list as records, with where and when it came from */
export function connectorValue(s: ConnectorState): { from: string; summary: string; at: number; rows: Array<Record<string, unknown>> } {
  let rows: Array<Record<string, unknown>> = [];
  const detail = s.detail as Record<string, unknown> | undefined;
  // the main list: the first list of records the system gave (BomForm's cert programs, FactoryForm's stations …)
  if (detail && typeof detail === "object")
    for (const v of Object.values(detail)) {
      if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
        rows = (v as Array<Record<string, unknown>>).map((r) => Object.fromEntries(Object.entries(r).filter(([, x]) => x === null || typeof x !== "object")));
        break;
      }
    }
  if (!rows.length && s.lists?.length) rows = s.lists.flatMap((l) => l.items.map((i) => ({ list: l.title, text: i.text, tone: i.tone ?? "" })));
  if (!rows.length) rows = s.metrics.map((m) => ({ label: m.label, value: m.value }));
  return { from: s.name, summary: s.summary, at: s.checkedAt, rows };
}

const isConnector = (o: unknown): o is PanelDoc & { connector: string } => {
  const p = o as PanelDoc | undefined;
  return p?.kind === "panel" && p.panel === "connector" && typeof (p as { connector?: unknown }).connector === "string";
};
const outPort = (p: PanelDoc) => p.ports.find((x) => x.dir === "out");

/** the wires into a table's rows, the newest first (the newest is the one that feeds it) */
function feedsOf(links: LinkDoc[], tableId: string): LinkDoc[] {
  return links.filter((l) => l.to.panel === tableId && l.to.port === TABLE_PORT).reverse();
}

const nameOf = (doc: Y.Doc, id: string) => {
  const o = boardMaps(doc).objects.get(id) as { name?: string } | undefined;
  return o?.name ?? "a card";
};

/** the connector reads in flight, by board and connector card: the tables they feed read as working */
const reading = new Map<string, Set<string>>();
/** connectors whose system was offline at the last read, by board and card: why (what they feed says so) */
const offline = new Map<string, Map<string, string>>();
/** what each fed table was last filled from (its source value and lens), so an unchanged source writes nothing */
const filled = new Map<string, string>();

function setFlow(doc: Y.Doc, id: string, next: FlowState) {
  const m = boardMaps(doc).flows;
  const was = m.get(id);
  if (was && was.status === next.status && was.rows === next.rows && was.total === next.total && was.error === next.error && was.from === next.from) return;
  m.set(id, next);
}

/**
 * Bring every fed table on a board up to date with what's wired into it, through its lens; mark the tables
 * whose wire came off as no longer fed. Synchronous: it reads only the board (connector values are already on
 * their cards). Returns how many tables were written.
 */
export function fill(boardId: string): number {
  let wrote = 0;
  editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    const busy = reading.get(boardId) ?? new Set<string>();
    // a table fed by a table follows it in the same pass: go round until nothing changes (at most a few times)
    for (let pass = 0; pass < 4; pass++) {
      let changed = 0;
      const links = [...m.links.values()];
      for (const o of [...m.objects.values()]) {
        if (o.kind !== "table") continue;
        const t = o as TableDoc;
        const key = `${boardId}:${t.id}`;
        const feed = feedsOf(links, t.id)[0];
        if (!feed) {
          const was = m.flows.get(t.id);
          if (was && was.status !== "unfed") m.flows.set(t.id, { ...was, status: "unfed", error: undefined, at: Date.now() });
          filled.delete(key);
          continue;
        }
        const from = nameOf(doc, feed.from.panel);
        const down = offline.get(boardId)?.get(feed.from.panel);
        if (down) {
          // its system is offline: say so, and keep the rows it last had
          setFlow(doc, t.id, { status: "error", from, error: down, at: Date.now() });
          filled.delete(key);
          continue;
        }
        const value = sourceValue(doc, feed.from);
        if (value === undefined) {
          // its source is being read (a connector): working; else nothing has arrived yet
          if (busy.has(feed.from.panel)) setFlow(doc, t.id, { status: "working", from, at: Date.now() });
          else setFlow(doc, t.id, { status: "waiting", from, at: Date.now() });
          filled.delete(key);
          continue;
        }
        const sig = JSON.stringify([feed.id, value, t.feed ?? null]);
        if (filled.get(key) === sig && m.flows.get(t.id)?.status === "ok") continue;
        const lens = applyLens(value, t.feed);
        if (lens.error) {
          setFlow(doc, t.id, { status: "error", from, error: lens.error, total: lens.total, at: Date.now() });
          filled.set(key, sig);
          continue;
        }
        deliver(doc, { panel: t.id, port: TABLE_PORT }, lens.records.length ? recordsToRows(lens.records) : [["(no rows pass this lens)"]]);
        m.flows.set(t.id, { status: "ok", from, rows: lens.records.length, total: lens.total, at: Date.now() });
        filled.set(key, sig);
        changed++;
      }
      wrote += changed;
      if (!changed) break;
    }
  });
  return wrote;
}

/** how connectors are read: the live systems, or a stand-in (tests) */
let reader: (id: string, fresh: boolean) => Promise<ConnectorState> = readConnector;
export function setConnectorReader(fn: typeof reader | null) {
  reader = fn ?? readConnector;
}

/**
 * Read every wired connector on a board and put what it says on its out port (only those with a wire out:
 * an unwired system isn't read). `fresh` reads past the connector cache.
 */
export async function feedConnectors(boardId: string, fresh = false): Promise<void> {
  const doc = getBoard(boardId).doc;
  const m = boardMaps(doc);
  const links = [...m.links.values()];
  const wired = [...m.objects.values()].filter((o): o is PanelDoc & { connector: string } => isConnector(o) && links.some((l) => l.from.panel === o.id));
  if (!wired.length) return;
  const busy = reading.get(boardId) ?? new Set<string>();
  reading.set(boardId, busy);
  for (const c of wired) busy.add(c.id);
  fill(boardId); // what they feed reads as working while they're read
  await Promise.all(
    wired.map(async (c) => {
      const state = await reader(c.connector, fresh).catch((e: Error) => ({ ok: false, summary: `offline — ${e.message}` }) as ConnectorState);
      busy.delete(c.id);
      const down = offline.get(boardId) ?? new Map<string, string>();
      offline.set(boardId, down);
      if (state.ok) down.delete(c.id);
      else down.set(c.id, `${c.name} is ${state.summary}`);
      // an offline system: its last value stays on the port, and what it feeds says why (fill, below)
      if (!state.ok) return;
      editBoard(boardId, ORIGIN, (d) => {
        const mm = boardMaps(d);
        const card = mm.objects.get(c.id) as PanelDoc | undefined;
        const port = card && outPort(card);
        if (!card || !port) return;
        const value = connectorValue(state);
        const was = card.outputs?.[port.id] as { rows?: unknown } | undefined;
        if (was && JSON.stringify(was.rows) === JSON.stringify(value.rows)) return;
        mm.objects.set(card.id, { ...card, outputs: { ...(card.outputs ?? {}), [port.id]: value } });
      });
    }),
  );
  fill(boardId);
}

// ---------- following open boards ----------

const followed = new Map<string, Board>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let timer: ReturnType<typeof setInterval> | null = null;

/** work soon (changes come in bursts: a wire made, its card's port added, a cell typed) */
function soon(boardId: string, connectors: boolean) {
  const key = `${boardId}:${connectors ? "c" : "t"}`;
  if (pending.has(key)) return;
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      const run = connectors ? feedConnectors(boardId) : Promise.resolve(void fill(boardId));
      run.catch((e) => console.error(`  flows              on ${boardId} failed: ${(e as Error).message}`));
    }, 40),
  );
}

/** does a board have anything flowing: a wire into a table, or out of a connector */
function flowing(board: Board): { tables: boolean; connectors: boolean } {
  const m = boardMaps(board.doc);
  let tables = false;
  let connectors = false;
  for (const l of m.links.values()) {
    if (l.to.port === TABLE_PORT && m.objects.get(l.to.panel)?.kind === "table") tables = true;
    if (isConnector(m.objects.get(l.from.panel))) connectors = true;
    if (tables && connectors) break;
  }
  return { tables, connectors };
}

function follow(board: Board) {
  followed.set(board.id, board);
  const m = boardMaps(board.doc);
  // a wire made or taken off: read what it now connects (a new wire out of a connector reads it)
  m.links.observe((_e, tr) => {
    if (tr.origin === ORIGIN) return;
    if (flowing(board).connectors) soon(board.id, true);
    soon(board.id, false);
  });
  // a card changed: a table's lens, an app's output, a card removed
  m.objects.observe((_e, tr) => {
    if (tr.origin === ORIGIN) return;
    if (flowing(board).tables || m.flows.size) soon(board.id, false);
  });
  // a cell typed in a table that feeds a table
  m.cells.observeDeep((_e, tr) => {
    if (tr.origin === ORIGIN) return;
    if (flowing(board).tables) soon(board.id, false);
  });
  const f = flowing(board);
  if (f.connectors) soon(board.id, true);
  else if (f.tables) soon(board.id, false);
  if (!timer) {
    timer = setInterval(() => {
      for (const b of followed.values()) if (flowing(b).connectors) soon(b.id, true);
    }, CONNECTOR_REFRESH_MS);
    timer.unref?.();
  }
}
onBoardOpen(follow);

/** stop following (tests, shutdown) */
export function stopFlows() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------- the examples (2026-11-24, Josh: "setup a few examples of it in the Form Industries grid") ----------

export const FLOWS_SECTION = "Flows";

/**
 * Lay worked examples of data piped between primitives into a "Flows" section of a board, each wired so that
 * taking its wire off visibly stops it:
 *
 *   1. BomForm → a table with a lens: the certification programs with items still open, four columns.
 *   2. FactoryForm → a table: its stations as they are now.
 *   3. a table of places → a map: each row with a Lat and Lng is a pin (example rows, to be replaced).
 *
 * A connector card that's already on the board is wired from where it is; one that isn't is put in the
 * section. Reads nothing that costs money; nothing third-party runs. Laid once: a board that has the
 * section with cards in it answers `already`.
 */
export function layFlowExamples(boardId: string, actor: string): { section: string; already?: boolean; cards: string[]; links: string[] } {
  return editBoard(boardId, "agent", (doc) => {
    const m = boardMaps(doc);
    const had = [...m.sections.values()].find((s) => s.name === FLOWS_SECTION);
    if (had && [...m.objects.values()].some((o) => o.sectionId === had.id)) return { section: had.id, already: true, cards: [], links: [] };
    const sec = had ?? appendSection(doc, FLOWS_SECTION);
    const now = Date.now();
    const cards: string[] = [];
    const links: string[] = [];
    let n = 0;
    const base = (name: string) => ({ id: "", sectionId: sec.id, name, x: 0, y: 0, float: false, bornAt: now + n++, createdBy: actor });

    const connector = (id: string, name: string, role: string): PanelDoc => {
      const on = [...m.objects.values()].find((o) => isConnector(o) && o.connector === id) as PanelDoc | undefined;
      if (on) return on;
      const p = {
        ...base(name),
        id: uid("pnl"),
        kind: "panel",
        panel: "connector",
        connector: id,
        text: role,
        w: 440,
        h: 300,
        ports: [
          { id: uid("port"), name: "in", dir: "in", type: "json" },
          { id: uid("port"), name: "out", dir: "out", type: "json" },
        ],
      } as unknown as PanelDoc;
      m.objects.set(p.id, p);
      cards.push(p.id);
      return p;
    };
    const table = (name: string, feed: TableDoc["feed"], head: string[] = [], rows: string[][] = []): TableDoc => {
      const t: TableDoc = { ...base(name), id: uid("tbl"), kind: "table", cols: Math.max(4, head.length), rows: Math.max(8, rows.length + 1), ...(feed ? { feed } : {}) };
      m.objects.set(t.id, t);
      const raw: Record<string, string> = {};
      head.forEach((h, i) => (raw[`${i},0`] = h));
      rows.forEach((r, ri) => r.forEach((v, ci) => (raw[`${ci},${ri + 1}`] = v)));
      setTableCells(doc, t.id, raw);
      cards.push(t.id);
      return t;
    };
    const wire = (from: PanelDoc, to: TableDoc, label: string) => {
      let port = outPort(from);
      if (!port) {
        port = { id: uid("port"), name: "out", dir: "out", type: "json" };
        m.objects.set(from.id, { ...from, ports: [...from.ports, port] });
      }
      const l: LinkDoc = { id: uid("lnk"), from: { panel: from.id, port: port.id }, to: { panel: to.id, port: TABLE_PORT }, label, createdBy: actor };
      m.links.set(l.id, l);
      links.push(l.id);
    };

    const bom = connector("bomform", "BomForm", "BOMs, certification, critical components");
    const open = table("Open cert programs · from BomForm", { filter: "itemsOpen > 0", columns: "code, agency, stage, itemsOpen" });
    wire(bom, open, "cert programs");

    const ff = connector("factoryform", "FactoryForm", "Inventory, stations, work orders, builds");
    const stations = table("Stations · from FactoryForm", { limit: 30 });
    wire(ff, stations, "stations");

    const places = table("Places · example rows, type yours", undefined, ["Name", "Lat", "Lng", "Note"], [
      ["Port of Los Angeles", "33.7406", "-118.2760", "example"],
      ["Port of Long Beach", "33.7542", "-118.2165", "example"],
      ["Port of Oakland", "37.7956", "-122.2790", "example"],
    ]);
    const map: MapDoc = { ...base("Places · on the map"), id: uid("map"), kind: "map", w: 520, h: 380, sourceTableId: places.id, pitched: false };
    m.objects.set(map.id, map);
    cards.push(map.id);

    const how: NoteDoc & { text: string } = {
      ...base("How these flow"),
      id: uid("note"),
      kind: "note",
      w: 420,
      h: 300,
      text: [
        "Each wire here carries live data. Point at a port to see a sample of what's on it; press a wire for its bar.",
        "",
        "- **BomForm → Open cert programs**: the table's lens keeps programs with items open (`itemsOpen > 0`) and four columns. Change the lens on the table and it refills.",
        "- **FactoryForm → Stations**: its stations as they are now, read again every minute while wired.",
        "- **Places → map**: every row with a Lat and a Lng is a pin. Type your own places over the example rows.",
        "",
        "Take a wire off (press it, then Disconnect, or ⌫) and the table stops following: it keeps its last rows and says it's no longer fed. ⌘Z puts the wire back and it fills again.",
      ].join("\n"),
    };
    putNote(doc, how);
    cards.push(how.id);
    return { section: sec.id, cards, links };
  });
}
