/**
 * The grid behind the grid (2026-11-26): the agents' work trail laid out the way agenttrail lays out a repo
 * (github.com/sodiumsun/agenttrail, MIT): the grid's sections are the components, a wire between two sections' cards
 * is a "needs" edge, and each agent's run is a trail through the sections it touched. Columns follow the longest chain
 * of wires; a column that grows past five wraps. Sections two agents write in at once are contested; a section one agent
 * picks up after another has finished there is a handoff. Pure: tested in test/trail.test.ts.
 */

export interface TrailStep {
  kind: "tool" | "thought" | "said";
  at: number;
  ms?: number;
  tool: string;
  label: string;
  read: boolean;
  ok?: boolean;
  section: string | null;
  card: string | null;
  input?: Record<string, unknown>;
  summary?: string;
}

export interface TrailFile {
  path: string;
  change: "added" | "changed" | "removed";
  at: number;
  bytes?: number;
}

/** apps/server/src/worktrail.ts TrailLane */
export interface TrailLane {
  crew: string;
  name: string;
  hue: number;
  via: string;
  kind: "t3" | "council";
  askerName: string;
  mine: boolean;
  task: string;
  status: "working" | "done" | "stopped" | "error";
  doing: string;
  started: number;
  ended: number | null;
  private: boolean;
  home: { id: string; name: string } | null;
  sections: Array<{ id: string; name: string; reads: number; writes: number }>;
  cards: Array<{ id: string; name: string; section: string | null; writes: number }>;
  steps: TrailStep[];
  files: TrailFile[];
  thread: string | null;
  plan: { goal: string; steps: Array<{ text: string; status: string }> } | null;
}

export interface GridSection {
  id: string;
  name: string;
  /** where it sits on the grid (its first track), to keep the grid's order */
  c0: number;
  r0: number;
  parent?: string;
}

/** a wire between two sections: data flows from → to (to "needs" from) */
export interface GridWire {
  from: string;
  to: string;
}

export type NodeState = "active" | "failed" | "done" | "touched" | "idle";
export type Activity = "Editing" | "Revising" | "Retrying" | null;

export interface TrailNode {
  id: string;
  kind: "section" | "folder";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: NodeState;
  activity: Activity;
  /** agents in it now (working, last step here or home with no step yet), at most three shown */
  here: string[];
  /** every agent that touched it */
  by: string[];
  reads: number;
  writes: number;
  /** two agents at work have written here in the last two minutes */
  contested: boolean;
  /** a folder: whose, and its files */
  crew?: string;
  files?: TrailFile[];
  /** cards changed here, with who */
  cards: Array<{ id: string; name: string; by: string[] }>;
}

export interface TrailEdge {
  from: string;
  to: string;
  kind: "wire" | "folder";
  /** an agent at work is in one end */
  active: boolean;
}

export interface TrailPath {
  crew: string;
  hue: number;
  nodes: string[];
  ended: boolean;
}

export interface Handoff {
  section: string;
  from: string;
  to: string;
  at: number;
}

export interface TrailLayout {
  nodes: TrailNode[];
  edges: TrailEdge[];
  paths: TrailPath[];
  handoffs: Handoff[];
  width: number;
  height: number;
}

export const NODE_W = 300;
export const NODE_H = 104;
const COL_GAP = 120;
const ROW_GAP = 48;
const PAD = 64;
const WRAP = 5;
const HANDOFF_MS = 10 * 60_000;
const CONTEST_MS = 2 * 60_000;
const RECENT_MS = 60_000;

const toolSteps = (l: TrailLane) => l.steps.filter((s) => s.kind === "tool");

/** where an agent stands now: its last step's section, or its home */
export function whereNow(l: TrailLane): string | null {
  const t = toolSteps(l);
  for (let i = t.length - 1; i >= 0; i--) if (t[i].section) return t[i].section;
  return l.home?.id ?? null;
}

/** the sections an agent went through, in order, each once per visit (agenttrail keeps the last 20) */
export function pathOf(l: TrailLane): string[] {
  const out: string[] = [];
  if (l.home) out.push(l.home.id);
  for (const s of toolSteps(l)) if (s.section && out.at(-1) !== s.section) out.push(s.section);
  return out.slice(-20);
}

/** depth of each section along the wires (longest chain of needs), safe on cycles */
export function depths(ids: string[], wires: GridWire[]): Map<string, number> {
  const d = new Map(ids.map((id) => [id, 0]));
  const ws = wires.filter((w) => w.from !== w.to && d.has(w.from) && d.has(w.to));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const w of ws) {
      const want = d.get(w.from)! + 1;
      if (want > d.get(w.to)! && want < ids.length) {
        d.set(w.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return d;
}

/** a section changed by one agent after another finished there, within ten minutes */
export function handoffsOf(lanes: TrailLane[]): Handoff[] {
  const out: Handoff[] = [];
  const writes = new Map<string, Array<{ crew: string; first: number; last: number; ended: number | null }>>();
  for (const l of lanes) {
    const per = new Map<string, { first: number; last: number }>();
    for (const s of toolSteps(l)) {
      if (s.read || !s.section || s.ok === false) continue;
      const e = per.get(s.section);
      if (e) e.last = s.at;
      else per.set(s.section, { first: s.at, last: s.at });
    }
    for (const [sec, e] of per) {
      const list = writes.get(sec) ?? [];
      list.push({ crew: l.crew, ...e, ended: l.ended });
      writes.set(sec, list);
    }
  }
  for (const [section, list] of writes) {
    list.sort((a, b) => a.first - b.first);
    for (let i = 1; i < list.length; i++) {
      const b = list[i];
      // the one before it that had finished when b began here
      for (let j = i - 1; j >= 0; j--) {
        const a = list[j];
        if (a.ended != null && a.ended <= b.first && b.first - a.ended <= HANDOFF_MS && a.last <= b.first) {
          out.push({ section, from: a.crew, to: b.crew, at: b.first });
          break;
        }
      }
    }
  }
  return out;
}

export function layoutTrail(opts: { sections: GridSection[]; wires: GridWire[]; lanes: TrailLane[]; all?: boolean; now?: number }): TrailLayout {
  const now = opts.now ?? Date.now();
  const lanes = opts.lanes;
  const touched = new Set<string>();
  for (const l of lanes) {
    if (l.home) touched.add(l.home.id);
    for (const s of l.sections) touched.add(s.id);
  }
  // the sections shown: every one, or those an agent touched (and what wires them to each other)
  const shown = opts.sections.filter((s) => opts.all || touched.has(s.id));
  const ids = shown.map((s) => s.id);
  const d = depths(ids, opts.wires);
  const cols = new Map<number, GridSection[]>();
  for (const s of shown) {
    const c = d.get(s.id) ?? 0;
    cols.set(c, [...(cols.get(c) ?? []), s]);
  }
  // within a column, the grid's own order (top to bottom, then left to right); long columns wrap
  const order = [...cols.keys()].sort((a, b) => a - b);
  const placed = new Map<string, { col: number; row: number }>();
  let col = 0;
  for (const k of order) {
    const list = cols.get(k)!.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
    for (let i = 0; i < list.length; i++) placed.set(list[i].id, { col: col + Math.floor(i / WRAP), row: i % WRAP });
    col += Math.ceil(list.length / WRAP);
  }
  const foldersAt = col; // agents' folders take the column after the sections
  const posX = (c: number) => PAD + c * (NODE_W + COL_GAP);
  const posY = (r: number) => PAD + r * (NODE_H + ROW_GAP);

  const nodes: TrailNode[] = [];
  const byId = new Map<string, TrailNode>();
  for (const s of shown) {
    const p = placed.get(s.id)!;
    const n: TrailNode = { id: s.id, kind: "section", name: s.name || "Untitled section", x: posX(p.col), y: posY(p.row), w: NODE_W, h: NODE_H, state: "idle", activity: null, here: [], by: [], reads: 0, writes: 0, contested: false, cards: [] };
    nodes.push(n);
    byId.set(s.id, n);
  }

  for (const l of lanes) {
    const working = l.status === "working";
    const at = whereNow(l);
    if (working && at && byId.has(at)) byId.get(at)!.here.push(l.crew);
    for (const s of l.sections) {
      const n = byId.get(s.id);
      if (!n) continue;
      n.reads += s.reads;
      n.writes += s.writes;
      if (!n.by.includes(l.crew)) n.by.push(l.crew);
    }
    for (const c of l.cards) {
      const n = c.section ? byId.get(c.section) : undefined;
      if (!n) continue;
      const e = n.cards.find((x) => x.id === c.id);
      if (e) e.by.push(l.crew);
      else n.cards.push({ id: c.id, name: c.name, by: [l.crew] });
    }
  }

  // state and activity, from each section's own steps
  for (const n of nodes) {
    const steps = lanes.flatMap((l) => toolSteps(l).filter((s) => s.section === n.id).map((s) => ({ s, l })));
    const recent = steps.filter(({ s }) => now - s.at <= RECENT_MS && !s.read);
    const last = steps.sort((a, b) => a.s.at - b.s.at).at(-1);
    if (n.here.length) n.state = "active";
    else if (last && last.s.ok === false && last.l.status !== "working") n.state = "failed";
    else if (n.writes > 0) n.state = "done";
    else if (n.by.length) n.state = "touched";
    if (n.here.length && last?.s.ok === false) n.activity = "Retrying";
    else if (recent.length >= 3) n.activity = "Revising";
    else if (recent.length) n.activity = "Editing";
    const writers = new Set(steps.filter(({ s, l }) => !s.read && l.status === "working" && now - s.at <= CONTEST_MS).map(({ l }) => l.crew));
    n.contested = writers.size > 1;
  }

  // each agent's folder (a T3 thread writes code there), beside the section it was asked in
  let folderRow = 0;
  for (const l of lanes) {
    if (!l.files.length) continue;
    const home = l.home && byId.get(l.home.id);
    const y = home ? home.y : posY(folderRow);
    folderRow++;
    const n: TrailNode = {
      id: `folder:${l.crew}`,
      kind: "folder",
      name: `${l.name}'s folder`,
      x: posX(foldersAt),
      y,
      w: NODE_W,
      h: NODE_H,
      state: l.status === "working" ? "active" : "done",
      activity: l.files.some((f) => now - f.at <= RECENT_MS) ? "Editing" : null,
      here: l.status === "working" ? [l.crew] : [],
      by: [l.crew],
      reads: 0,
      writes: l.files.length,
      contested: false,
      crew: l.crew,
      files: l.files,
      cards: [],
    };
    // folders don't sit on one another
    while (nodes.some((o) => o.kind === "folder" && Math.abs(o.y - n.y) < NODE_H + ROW_GAP / 2)) n.y += NODE_H + ROW_GAP;
    nodes.push(n);
    byId.set(n.id, n);
  }

  const edges: TrailEdge[] = [];
  const seen = new Set<string>();
  const live = new Set(nodes.filter((n) => n.here.length).map((n) => n.id));
  for (const w of opts.wires) {
    if (!byId.has(w.from) || !byId.has(w.to) || w.from === w.to) continue;
    const k = `${w.from}>${w.to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ from: w.from, to: w.to, kind: "wire", active: live.has(w.from) || live.has(w.to) });
  }
  for (const l of lanes) {
    if (l.files.length && l.home && byId.has(l.home.id)) edges.push({ from: l.home.id, to: `folder:${l.crew}`, kind: "folder", active: l.status === "working" });
  }

  const paths: TrailPath[] = lanes
    .map((l) => ({ crew: l.crew, hue: l.hue, nodes: [...pathOf(l), ...(l.files.length ? [`folder:${l.crew}`] : [])].filter((id) => byId.has(id)), ended: l.status !== "working" }))
    .filter((p) => p.nodes.length > 1);
  const handoffs = handoffsOf(lanes).filter((h) => byId.has(h.section));
  const width = Math.max(...nodes.map((n) => n.x + n.w), 0) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + n.h), 0) + PAD;
  return { nodes, edges, paths, handoffs, width, height };
}

/** a file's kind, for its glyph (agenttrail's: code, image, page, doc, data, shell) */
export function fileKind(path: string): "code" | "image" | "page" | "doc" | "data" | "shell" | "file" {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (/^(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|lua|sql|vue|svelte)$/.test(ext)) return "code";
  if (/^(png|jpe?g|gif|webp|svg|avif|ico|stl|step|stp|glb|gltf|obj)$/.test(ext)) return "image";
  if (/^(html?|css|scss)$/.test(ext)) return "page";
  if (/^(md|mdx|txt|pdf|docx?|rtf)$/.test(ext)) return "doc";
  if (/^(json|ya?ml|toml|csv|tsv|xml|ini|env|lock)$/.test(ext)) return "data";
  if (/^(sh|bash|zsh|ps1|bat|cmd)$/.test(ext)) return "shell";
  return "file";
}

/** a cubic from one node's right side to another's left (agenttrail's edge), or around when it runs backwards */
export function edgePath(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): string {
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  if (x2 >= x1) {
    const k = Math.max(40, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`;
  }
  // same column or backwards: leave from the bottom, come in at the top
  const bx1 = a.x + a.w / 2;
  const by1 = a.y + a.h;
  const bx2 = b.x + b.w / 2;
  const by2 = b.y;
  const k = Math.max(30, Math.abs(by2 - by1) / 2);
  return `M${bx1},${by1} C${bx1},${by1 + k} ${bx2},${by2 - k} ${bx2},${by2}`;
}
