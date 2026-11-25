/**
 * Data flowing card to card (2026-11-24, Josh: "test whether disconnecting or connecting actually makes a
 * difference in the flow of information"). The architecture is docs/flows.md; in short:
 *
 *   - A wire (LinkDoc) is the only thing that moves data. Its source is an end that has a value now: an app's
 *     or connector's `outputs[port]`, a note's text, a table's rows. Nothing is copied while no wire is there.
 *   - A connector card (BomForm, FactoryForm, …) puts what its system says now on its `out` port, but only
 *     while something is wired out of it (the server reads the system; an unwired connector reads nothing).
 *   - A table can take a wire (port `rows`): the server writes what arrives into its cells, through the
 *     table's lens (`TableFeed`: which rows, which columns, how many). Taking the wire off stops the flow; the
 *     table keeps the last rows it was given and says it's no longer fed.
 *   - The server keeps each fed card's state in the board's `flows` map (kept by the server alone): working
 *     while it reads, ok with what it wrote, error with why. The wire's chip shows it.
 *
 * The lens is pure and lives here so the server, the client and the tests read it the same way.
 */

/** A table's lens on what's wired into it: a person's words, kept on the table. */
export interface TableFeed {
  /** clauses joined by ";" or " and ": `stage = testing`, `itemsOpen > 0`, `name ~ motor` (~ contains, !~ doesn't) */
  filter?: string;
  /** the columns to keep, by name, comma separated (empty: every column) */
  columns?: string;
  /** at most this many rows (default 200) */
  limit?: number;
}

/** What the server says about a fed card: kept by the server alone, by the card's id. */
export interface FlowState {
  /** working: its source is being read; waiting: wired, nothing has arrived yet; unfed: its wire came off (it keeps its rows) */
  status: "working" | "waiting" | "ok" | "error" | "unfed";
  /** the card the rows came from, by name */
  from?: string;
  /** rows written / rows that arrived before the lens */
  rows?: number;
  total?: number;
  error?: string;
  at: number;
}

export const FEED_LIMIT = 200;

export type FlowRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is FlowRecord => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Any value as records: records as they are; rows of cells with a header row (the first row);
 * `{ rows | items | data | results: [...] }`; a list of values as `{ value }`; one value as one record.
 */
export function toRecords(v: unknown): FlowRecord[] {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) {
    if (!v.length) return [];
    if (v.every(isRecord)) return v as FlowRecord[];
    if (v.every(Array.isArray)) {
      const rows = v as unknown[][];
      const head = rows[0].map((c, i) => (typeof c === "string" && c.trim() ? c.trim() : `col${i + 1}`));
      return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
    }
    return v.map((x) => ({ value: x }));
  }
  if (isRecord(v)) {
    for (const k of ["rows", "items", "data", "results"]) if (Array.isArray(v[k])) return toRecords(v[k]);
    return [v];
  }
  return [{ value: v }];
}

/** records as rows of cells, their keys heading the columns (in first-seen order) */
export function recordsToRows(recs: FlowRecord[]): unknown[][] {
  const keys = [...new Set(recs.flatMap((r) => Object.keys(r)))];
  return [keys, ...recs.map((r) => keys.map((k) => r[k] ?? ""))];
}

interface Clause {
  key: string;
  op: "=" | "!=" | ">" | "<" | ">=" | "<=" | "~" | "!~";
  value: string;
}

/** the filter's clauses; a clause it can't read is an error, said back in the person's words */
export function parseFilter(filter: string | undefined): { clauses: Clause[]; error?: string } {
  const clauses: Clause[] = [];
  for (const raw of (filter ?? "").split(/;|\s+and\s+/i)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(.+?)\s*(!=|>=|<=|!~|=|>|<|~)\s*(.*)$/.exec(part);
    if (!m) return { clauses, error: `"${part}" isn't a filter: write it as column = value (or != > < >= <= ~ for contains)` };
    clauses.push({ key: m[1].trim(), op: m[2] as Clause["op"], value: m[3].trim().replace(/^["']|["']$/g, "") });
  }
  return { clauses };
}

/** a record's field by a person's name for it: exact, else ignoring case, spaces and underscores */
function field(r: FlowRecord, key: string): unknown {
  if (key in r) return r[key];
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const k = Object.keys(r).find((x) => norm(x) === norm(key));
  return k === undefined ? undefined : r[k];
}

function test(r: FlowRecord, c: Clause): boolean {
  const v = field(r, c.key);
  const s = v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  const a = Number(s);
  const b = Number(c.value);
  const numeric = s !== "" && c.value !== "" && Number.isFinite(a) && Number.isFinite(b);
  switch (c.op) {
    case "=":
      return numeric ? a === b : s.toLowerCase() === c.value.toLowerCase();
    case "!=":
      return numeric ? a !== b : s.toLowerCase() !== c.value.toLowerCase();
    case "~":
      return s.toLowerCase().includes(c.value.toLowerCase());
    case "!~":
      return !s.toLowerCase().includes(c.value.toLowerCase());
    case ">":
      return numeric ? a > b : s > c.value;
    case "<":
      return numeric ? a < b : s < c.value;
    case ">=":
      return numeric ? a >= b : s >= c.value;
    case "<=":
      return numeric ? a <= b : s <= c.value;
  }
}

/** what a table's lens lets through: filtered, its columns picked, cut to its limit */
export function applyLens(value: unknown, feed: TableFeed | undefined): { records: FlowRecord[]; total: number; error?: string } {
  const all = toRecords(value);
  const { clauses, error } = parseFilter(feed?.filter);
  if (error) return { records: [], total: all.length, error };
  let out = clauses.length ? all.filter((r) => clauses.every((c) => test(r, c))) : all;
  const cols = (feed?.columns ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (cols.length) out = out.map((r) => Object.fromEntries(cols.map((c) => [c, field(r, c) ?? ""])));
  return { records: out.slice(0, Math.max(1, Math.min(500, feed?.limit ?? FEED_LIMIT))), total: all.length };
}
