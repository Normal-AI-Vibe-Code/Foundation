/**
 * Workbook: owns all tables' cell data, the cross-table dependency graph,
 * and incremental recalculation with cycle detection.
 */

import {
  AstNode,
  CellRef,
  CellValue,
  FormulaError,
  RangeRef,
  collectRefs,
  evaluate,
  parseFormula,
} from "./formula";

export interface Cell {
  raw: string; // what the user typed
  ast: AstNode | null; // parsed formula (raw starts with '=')
  value: CellValue; // computed value
  error: string | null;
}

export type CellKey = string; // `${tableId}|${col},${row}`

export function cellKey(tableId: string, col: number, row: number): CellKey {
  return `${tableId}|${col},${row}`;
}

export interface TableData {
  id: string;
  name: string;
  cols: number;
  rows: number;
  cells: Map<string, Cell>; // "col,row" -> Cell
}

type TableListener = (changedCells: Set<string>) => void;

export class Workbook {
  private tables = new Map<string, TableData>();
  private nameIndex = new Map<string, string>(); // normalized name -> tableId

  /** cell -> cells it depends on */
  private deps = new Map<CellKey, Set<CellKey>>();
  /** cell -> cells that depend on it */
  private dependents = new Map<CellKey, Set<CellKey>>();

  private listeners = new Map<string, Set<TableListener>>(); // tableId -> listeners

  // ---------- tables ----------

  addTable(id: string, name: string, cols: number, rows: number): TableData {
    const table: TableData = { id, name, cols, rows, cells: new Map() };
    this.tables.set(id, table);
    this.nameIndex.set(normalizeName(name), id);
    return table;
  }

  removeTable(id: string) {
    const table = this.tables.get(id);
    if (!table) return;
    this.nameIndex.delete(normalizeName(table.name));
    // dirty everything that depended on this table's cells
    const affected = new Set<CellKey>();
    for (const key of [...table.cells.keys()]) {
      const ck = cellKey(id, ...parseCoord(key));
      for (const dep of this.dependents.get(ck) ?? []) affected.add(dep);
      this.detachDeps(ck);
      this.dependents.delete(ck);
    }
    this.tables.delete(id);
    this.recalc(affected);
  }

  renameTable(id: string, newName: string): boolean {
    const table = this.tables.get(id);
    if (!table) return false;
    const norm = normalizeName(newName);
    const existing = this.nameIndex.get(norm);
    if (existing && existing !== id) return false; // name collision
    this.nameIndex.delete(normalizeName(table.name));
    table.name = newName;
    this.nameIndex.set(norm, id);
    // formulas referencing the old name now break; re-evaluate all formula cells
    this.recalcAllFormulas();
    return true;
  }

  getTable(id: string): TableData | undefined {
    return this.tables.get(id);
  }

  resize(id: string, cols: number, rows: number) {
    const table = this.tables.get(id);
    if (!table) return;
    table.cols = cols;
    table.rows = rows;
    this.notify(id, new Set());
  }

  // ---------- cells ----------

  getCell(tableId: string, col: number, row: number): Cell | undefined {
    return this.tables.get(tableId)?.cells.get(`${col},${row}`);
  }

  setCell(tableId: string, col: number, row: number, raw: string) {
    const table = this.tables.get(tableId);
    if (!table) return;
    const coord = `${col},${row}`;
    const key = cellKey(tableId, col, row);

    this.detachDeps(key);

    if (raw.trim() === "") {
      table.cells.delete(coord);
    } else {
      const cell: Cell = { raw, ast: null, value: null, error: null };
      if (raw.startsWith(IMG_PREFIX)) {
        // image literal: value is the image's name so text formulas can use it
        cell.value = parseImageRaw(raw)?.name ?? "image";
      } else if (raw.startsWith("=")) {
        try {
          cell.ast = parseFormula(raw.slice(1));
          this.attachDeps(key, tableId, cell.ast);
        } catch (e) {
          cell.error = e instanceof FormulaError ? e.code : "#ERR";
          cell.value = null;
        }
      } else {
        const num = parseNumberLiteral(raw);
        cell.value = num !== null ? num : raw;
      }
      table.cells.set(coord, cell);
    }

    const dirty = new Set<CellKey>([key]);
    this.recalc(dirty);
  }

  // ---------- dependency graph ----------

  private attachDeps(key: CellKey, homeTableId: string, ast: AstNode) {
    const collected = { refs: [] as CellRef[], ranges: [] as RangeRef[] };
    collectRefs(ast, collected);
    const depKeys = new Set<CellKey>();
    for (const r of collected.refs) {
      const tid = this.resolveTableId(r.table, homeTableId);
      if (tid) depKeys.add(cellKey(tid, r.col, r.row));
    }
    for (const rg of collected.ranges) {
      const tid = this.resolveTableId(rg.table, homeTableId);
      if (!tid) continue;
      for (let c = rg.c0; c <= rg.c1; c++) {
        for (let r = rg.r0; r <= rg.r1; r++) {
          depKeys.add(cellKey(tid, c, r));
        }
      }
    }
    this.deps.set(key, depKeys);
    for (const d of depKeys) {
      let set = this.dependents.get(d);
      if (!set) {
        set = new Set();
        this.dependents.set(d, set);
      }
      set.add(key);
    }
  }

  private detachDeps(key: CellKey) {
    const old = this.deps.get(key);
    if (old) {
      for (const d of old) this.dependents.get(d)?.delete(key);
      this.deps.delete(key);
    }
  }

  private resolveTableId(name: string | null, homeTableId: string): string | null {
    if (name === null) return homeTableId;
    return this.nameIndex.get(normalizeName(name)) ?? null;
  }

  // ---------- recalculation ----------

  /** Recompute the dirty set plus everything downstream, in topological order. */
  private recalc(seed: Set<CellKey>) {
    // collect affected subgraph
    const affected = new Set<CellKey>();
    const stack = [...seed];
    while (stack.length) {
      const k = stack.pop()!;
      if (affected.has(k)) continue;
      affected.add(k);
      for (const dep of this.dependents.get(k) ?? []) stack.push(dep);
    }

    // topo sort within affected (Kahn); leftovers = cycles
    const indeg = new Map<CellKey, number>();
    for (const k of affected) {
      let d = 0;
      for (const dep of this.deps.get(k) ?? []) {
        if (affected.has(dep)) d++;
      }
      indeg.set(k, d);
    }
    const queue: CellKey[] = [];
    for (const [k, d] of indeg) if (d === 0) queue.push(k);
    const order: CellKey[] = [];
    while (queue.length) {
      const k = queue.shift()!;
      order.push(k);
      for (const dep of this.dependents.get(k) ?? []) {
        if (!affected.has(dep)) continue;
        const nd = indeg.get(dep)! - 1;
        indeg.set(dep, nd);
        if (nd === 0) queue.push(dep);
      }
    }

    const changedByTable = new Map<string, Set<string>>();
    const markChanged = (k: CellKey) => {
      const [tid, coord] = splitKey(k);
      let set = changedByTable.get(tid);
      if (!set) {
        set = new Set();
        changedByTable.set(tid, set);
      }
      set.add(coord);
    };

    for (const k of order) {
      this.evalCell(k);
      markChanged(k);
    }
    // cycle members
    for (const k of affected) {
      if (!order.includes(k)) {
        const cell = this.cellByKey(k);
        if (cell) {
          cell.error = "#CYCLE";
          cell.value = null;
        }
        markChanged(k);
      }
    }

    for (const [tid, coords] of changedByTable) this.notify(tid, coords);
  }

  private recalcAllFormulas() {
    const seed = new Set<CellKey>();
    for (const [tid, table] of this.tables) {
      for (const [coord, cell] of table.cells) {
        if (cell.raw.startsWith("=")) {
          const [c, r] = parseCoord(coord);
          const key = cellKey(tid, c, r);
          // re-resolve deps (names may now point at a different table)
          this.detachDeps(key);
          if (cell.ast) this.attachDeps(key, tid, cell.ast);
          seed.add(key);
        }
      }
    }
    this.recalc(seed);
  }

  private evalCell(key: CellKey) {
    const cell = this.cellByKey(key);
    if (!cell) return;
    if (!cell.raw.startsWith("=")) return; // literal, value already set
    if (!cell.ast) return; // parse error already recorded
    const [homeTid] = splitKey(key);
    const ctx = {
      getCell: (ref: CellRef): CellValue => {
        const tid = this.resolveTableId(ref.table, homeTid);
        if (!tid) throw new FormulaError("#REF", `unknown table ${ref.table}`);
        const t = this.tables.get(tid);
        if (!t || ref.col >= t.cols || ref.row >= t.rows || ref.col < 0 || ref.row < 0) {
          throw new FormulaError("#REF");
        }
        const c = t.cells.get(`${ref.col},${ref.row}`);
        if (!c) return null;
        if (c.error) throw new FormulaError(c.error);
        return c.value;
      },
      getRange: (range: RangeRef): CellValue[] => {
        const tid = this.resolveTableId(range.table, homeTid);
        if (!tid) throw new FormulaError("#REF", `unknown table ${range.table}`);
        const out: CellValue[] = [];
        for (let r = range.r0; r <= range.r1; r++) {
          for (let c = range.c0; c <= range.c1; c++) {
            const cell = this.tables.get(tid)?.cells.get(`${c},${r}`);
            if (cell?.error) throw new FormulaError(cell.error);
            out.push(cell ? cell.value : null);
          }
        }
        return out;
      },
    };
    try {
      const v = evaluate(cell.ast, ctx);
      cell.value = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v;
      cell.error = null;
    } catch (e) {
      cell.error = e instanceof FormulaError ? e.code : "#ERR";
      cell.value = null;
    }
  }

  private cellByKey(key: CellKey): Cell | undefined {
    const [tid, coord] = splitKey(key);
    return this.tables.get(tid)?.cells.get(coord);
  }

  // ---------- dependency introspection ----------

  /**
   * Cross-table data-flow edges derived from the live dependency graph:
   * one {source, dependent} pair per pair of tables where a formula in
   * `dependent` reads cells of `source`.
   */
  tableDependencies(): Array<{ source: string; dependent: string }> {
    const seen = new Set<string>();
    const out: Array<{ source: string; dependent: string }> = [];
    for (const [cell, depSet] of this.deps) {
      const dependent = cell.slice(0, cell.indexOf("|"));
      for (const dep of depSet) {
        const source = dep.slice(0, dep.indexOf("|"));
        if (source === dependent) continue;
        const key = `${source}->${dependent}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ source, dependent });
      }
    }
    return out;
  }

  // ---------- subscriptions ----------

  subscribe(tableId: string, fn: TableListener): () => void {
    let set = this.listeners.get(tableId);
    if (!set) {
      set = new Set();
      this.listeners.set(tableId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  /** notified on any change anywhere (recalc, table add/remove/rename) */
  subscribeAll(fn: (tableId?: string) => void): () => void {
    this.globalListeners.add(fn);
    return () => {
      this.globalListeners.delete(fn);
    };
  }

  private globalListeners = new Set<(tableId?: string) => void>();

  private notify(tableId: string, changed: Set<string>) {
    for (const fn of this.listeners.get(tableId) ?? []) fn(changed);
    for (const fn of this.globalListeners) fn(tableId);
  }
}

// ---------- helpers ----------

function splitKey(key: CellKey): [string, string] {
  const i = key.indexOf("|");
  return [key.slice(0, i), key.slice(i + 1)];
}

function parseCoord(coord: string): [number, number] {
  const [c, r] = coord.split(",");
  return [parseInt(c, 10), parseInt(r, 10)];
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------- rich cell primitives ----------

/** raw encoding for image cells: `img::<name>::<dataURL>` */
export const IMG_PREFIX = "img::";

export function parseImageRaw(raw: string): { name: string; src: string } | null {
  if (!raw.startsWith(IMG_PREFIX)) return null;
  const rest = raw.slice(IMG_PREFIX.length);
  const sep = rest.indexOf("::");
  if (sep < 0) return null;
  return { name: rest.slice(0, sep) || "image", src: rest.slice(sep + 2) };
}

export function isLinkRaw(raw: string): boolean {
  return /^https?:\/\/\S+$/i.test(raw.trim());
}

function parseNumberLiteral(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, "");
  if (cleaned === "") return null;
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?%?$/.test(cleaned)) return null;
  if (cleaned.endsWith("%")) {
    const n = parseFloat(cleaned.slice(0, -1));
    return isNaN(n) ? null : n / 100;
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/** the single app-wide workbook */
export const workbook = new Workbook();
