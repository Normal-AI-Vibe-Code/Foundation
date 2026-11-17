/**
 * Today — the first thing a person sees: what wants their attention, their
 * goals, and every company app one press away. The Shiba (the agent's face on
 * this page) reads the same thing through the `today` tool, so what it says
 * and what the page shows never disagree.
 *
 * What lands in "Focus" is worked out from what Foundation already knows,
 * never guessed:
 * - asks (Hermes) assigned to the person, overdue first;
 * - `@name` mentions in notes on any board;
 * - design-pipeline stages they own that are active;
 * - files others dropped on boards they work on, and what changed there;
 * - cards and files that match their job (their profile's focus words), from the search index.
 *
 * Goals are the person's own (this table). The Airform Data Room will be a
 * second source of goals and projects (SPEC §6 #19: an endpoint there, then
 * `DATAROOM_GOALS_URL` here); until then Today says it isn't connected.
 */

import { randomBytes } from "node:crypto";
import type { UserInfo } from "@foundation/protocol";
import { boardMaps, COMPANY_APPS, noteTextOf } from "@foundation/protocol";
import { all, db, one, run } from "./db.ts";
import { getBoard, listBoards } from "./boards.ts";
import { listApps } from "./apps.ts";
import { config } from "./config.ts";

db.exec(`
create table if not exists profiles (
  user_id text primary key references users(id) on delete cascade,
  title text not null default '',
  team text not null default '',
  focus text not null default '',
  updated_at integer not null
);
create table if not exists goals (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  title text not null,
  detail text not null default '',
  status text not null default 'active',
  progress real not null default 0,
  due_at integer,
  board_id text,
  object_id text,
  source text not null default 'foundation',
  external_id text,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists goals_user on goals(user_id, status, updated_at);
`);

// ---------- the company's apps ----------

export interface CompanyApp {
  id: string;
  name: string;
  role: string;
  /** where it opens; null when nobody has told Foundation yet */
  url: string | null;
  repo?: string | null;
  /** a connector Foundation reads live (status on the tile) */
  connector?: string;
  /** a single glyph for the tile */
  glyph: string;
}

/**
 * The vibe-coded apps the company runs (COMPANY_APPS, shared with the Chrome
 * extension), with where each lives on this server: its env variable, else
 * the connector's address. An app with neither shows as "not linked".
 */
export function companyApps(): CompanyApp[] {
  const fallback: Record<string, string> = {
    factoryform: config.connectors.factoryform,
    vision: config.connectors.vision,
    dataroom: config.connectors.dataroom,
    creation: "http://localhost:5173",
    foundation: `${config.clientUrl}/#/board`,
  };
  const base: CompanyApp[] = COMPANY_APPS.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    glyph: a.glyph,
    repo: a.repo ?? null,
    connector: a.connector,
    url: (a.env && process.env[a.env]) || fallback[a.id] || null,
  }));
  // apps people added to the registry (⌘L, the agent) join the shelf after the company's own
  const known = new Set(base.map((a) => a.name.toLowerCase()));
  for (const a of listApps()) {
    if (known.has(a.name.toLowerCase())) {
      const hit = base.find((b) => b.name.toLowerCase() === a.name.toLowerCase())!;
      hit.url ??= a.url;
      hit.repo ??= a.repo;
      continue;
    }
    known.add(a.name.toLowerCase());
    base.push({ id: a.id, name: a.name, role: a.description ?? "", url: a.url, repo: a.repo, glyph: "◳" });
  }
  return base;
}

// ---------- profiles ----------

export interface Profile {
  title: string;
  team: string;
  /** comma-separated words that describe their work: "motors, rim drive, certification" */
  focus: string;
}

export function getProfile(userId: string): Profile {
  return one<Profile>("select title, team, focus from profiles where user_id = ?", userId) ?? { title: "", team: "", focus: "" };
}

export function setProfile(userId: string, p: Partial<Profile>): Profile {
  const cur = getProfile(userId);
  const next = { title: (p.title ?? cur.title).slice(0, 120), team: (p.team ?? cur.team).slice(0, 120), focus: (p.focus ?? cur.focus).slice(0, 400) };
  run(
    "insert into profiles (user_id, title, team, focus, updated_at) values (?, ?, ?, ?, ?) on conflict(user_id) do update set title = excluded.title, team = excluded.team, focus = excluded.focus, updated_at = excluded.updated_at",
    userId, next.title, next.team, next.focus, Date.now(),
  );
  return next;
}

// ---------- goals ----------

export interface Goal {
  id: string;
  title: string;
  detail: string;
  status: "active" | "done" | "dropped";
  progress: number;
  dueAt: number | null;
  board: string | null;
  objectId: string | null;
  source: string;
  updatedAt: number;
}

interface GoalRow {
  id: string;
  title: string;
  detail: string;
  status: Goal["status"];
  progress: number;
  due_at: number | null;
  board_id: string | null;
  object_id: string | null;
  source: string;
  updated_at: number;
}
const toGoal = (r: GoalRow): Goal => ({ id: r.id, title: r.title, detail: r.detail, status: r.status, progress: r.progress, dueAt: r.due_at, board: r.board_id, objectId: r.object_id, source: r.source, updatedAt: r.updated_at });

export function listGoals(userId: string, includeClosed = false): Goal[] {
  return all<GoalRow>(
    `select * from goals where user_id = ? ${includeClosed ? "" : "and (status = 'active' or (status = 'done' and updated_at > ?))"}
      order by case status when 'active' then 0 else 1 end, coalesce(due_at, 9e15), created_at`,
    ...(includeClosed ? [userId] : [userId, Date.now() - 3 * 864e5]),
  ).map(toGoal);
}

export interface GoalInput {
  id?: string;
  title?: string;
  detail?: string;
  status?: Goal["status"];
  progress?: number;
  dueAt?: number | null;
  board?: string | null;
  objectId?: string | null;
}

/** add a goal, or change one of the person's own (an id that isn't theirs is refused) */
export function saveGoal(userId: string, g: GoalInput): Goal {
  const now = Date.now();
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  if (g.id) {
    const cur = one<GoalRow>("select * from goals where id = ? and user_id = ?", g.id, userId);
    if (!cur) throw new Error("no such goal of yours");
    if (cur.source !== "foundation") throw new Error(`that goal comes from ${cur.source}; change it there`);
    const status = g.status ?? (g.progress !== undefined && g.progress >= 1 ? "done" : cur.status);
    run(
      "update goals set title = ?, detail = ?, status = ?, progress = ?, due_at = ?, board_id = ?, object_id = ?, updated_at = ? where id = ?",
      (g.title ?? cur.title).slice(0, 200), (g.detail ?? cur.detail).slice(0, 2000), status,
      clamp(g.progress ?? (status === "done" ? 1 : cur.progress)), g.dueAt === undefined ? cur.due_at : g.dueAt,
      g.board === undefined ? cur.board_id : g.board, g.objectId === undefined ? cur.object_id : g.objectId, now, cur.id,
    );
    return toGoal(one<GoalRow>("select * from goals where id = ?", cur.id)!);
  }
  if (!g.title?.trim()) throw new Error("a goal needs a title");
  const id = `goal_${randomBytes(5).toString("hex")}`;
  run(
    "insert into goals (id, user_id, title, detail, status, progress, due_at, board_id, object_id, source, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'foundation', ?, ?)",
    id, userId, g.title.trim().slice(0, 200), (g.detail ?? "").slice(0, 2000), g.status ?? "active", clamp(g.progress ?? 0),
    g.dueAt ?? null, g.board ?? null, g.objectId ?? null, now, now,
  );
  return toGoal(one<GoalRow>("select * from goals where id = ?", id)!);
}

// ---------- focus ----------

export type FocusKind = "ask" | "mention" | "stage" | "file" | "changes" | "related";

export interface FocusItem {
  id: string;
  kind: FocusKind;
  title: string;
  /** why it's here, in a few words: "Kai asked you · 2 d overdue" */
  why: string;
  board: string;
  boardName: string;
  objectId?: string;
  /** opens the place on the board (or the file) */
  href: string;
  at: number;
  tone?: "warn" | "bad" | "agent";
}

const DAY = 864e5;

function ago(at: number, now: number) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < DAY / 1000) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** the ways a person is named in an @mention or an assignee field */
export function handlesOf(user: Pick<UserInfo, "name" | "email">) {
  const first = user.name.trim().split(/\s+/)[0] ?? "";
  const local = user.email.split("@")[0] ?? "";
  return [user.name.trim(), first, user.email, local].map((s) => s.toLowerCase()).filter((s) => s.length >= 2);
}

function names(user: UserInfo, s: string | undefined) {
  if (!s) return false;
  const hs = handlesOf(user);
  return s
    .toLowerCase()
    .split(/[,;&]|\band\b/)
    .map((x) => x.trim())
    .some((x) => hs.includes(x));
}

/** `@Josh`, `@josh.leong`, `@"Josh Leong"`: anywhere a note names the person */
export function mentions(user: UserInfo, text: string) {
  const t = text.toLowerCase();
  return handlesOf(user).some((h) => {
    const i = t.indexOf(`@${h}`);
    if (i < 0) return false;
    const next = t[i + 1 + h.length];
    return next === undefined || !/[a-z0-9_]/.test(next);
  });
}

const link = (board: string, objectId?: string) => `${config.clientUrl}/?board=${encodeURIComponent(board)}${objectId ? `&focus=${encodeURIComponent(objectId)}` : ""}`;

export function focusFor(user: UserInfo, now = Date.now()): FocusItem[] {
  const items: FocusItem[] = [];
  const boards = listBoards();
  const boardName = (id: string) => boards.find((b) => b.id === id)?.name ?? id;

  // asks assigned to them
  const asks = all<{ id: string; board_id: string; panel_id: string | null; assignee: string; kind: string; prompt: string; created_by: string; created_at: number; due_at: number | null }>(
    "select id, board_id, panel_id, assignee, kind, prompt, created_by, created_at, due_at from asks where status = 'open' order by created_at desc limit 400",
  );
  for (const a of asks) {
    if (!names(user, a.assignee)) continue;
    const overdue = a.due_at && a.due_at < now;
    items.push({
      id: `ask:${a.id}`,
      kind: "ask",
      title: a.prompt,
      why: `${a.created_by} asked you${a.kind === "cad_upload" ? " for CAD" : a.kind === "review" ? " to review" : ""} · ${overdue ? `${ago(a.due_at!, now).replace(" ago", "")} overdue` : ago(a.created_at, now)}`,
      board: a.board_id,
      boardName: boardName(a.board_id),
      objectId: a.panel_id ?? undefined,
      href: link(a.board_id, a.panel_id ?? undefined),
      at: a.created_at,
      tone: overdue ? "bad" : "warn",
    });
  }

  // what's on the boards: mentions, stages they own, what others changed where they work
  for (const b of boards) {
    const doc = getBoard(b.id).doc;
    const m = boardMaps(doc);
    for (const o of m.objects.values()) {
      if (o.kind === "note") {
        const text = noteTextOf(doc, o);
        if (!mentions(user, text)) continue;
        const line = text.split("\n").find((l) => mentions(user, l)) ?? text;
        items.push({
          id: `mention:${b.id}:${o.id}`,
          kind: "mention",
          title: line.replace(/^#+\s*/, "").trim().slice(0, 160),
          why: `You're tagged in a note on ${b.name}`,
          board: b.id,
          boardName: b.name,
          objectId: o.id,
          href: link(b.id, o.id),
          at: o.bornAt ?? b.updated_at,
        });
      } else if (o.kind === "panel" && o.panel === "stage" && o.status === "open" && names(user, o.assignee)) {
        const open = (o.checklist ?? []).filter((c) => !c.done).length;
        items.push({
          id: `stage:${b.id}:${o.id}`,
          kind: "stage",
          title: o.name,
          why: `You own this stage${open ? ` · ${open} to tick` : ""}`,
          board: b.id,
          boardName: b.name,
          objectId: o.id,
          href: link(b.id, o.id),
          at: o.bornAt ?? b.updated_at,
          tone: "warn",
        });
      }
    }
    // changes by others since yesterday, on boards the person has worked on in the last fortnight
    const log = m.activity.toArray();
    const me = handlesOf(user);
    const mine = log.some((e) => e.at > now - 14 * DAY && me.includes(e.who.toLowerCase()));
    if (mine) {
      // not what's already listed (Hermes's ask to them is the ask itself)
      const listed = new Set(items.map((i) => i.objectId).filter(Boolean));
      const theirs = log.filter((e) => e.at > now - DAY && !me.includes(e.who.toLowerCase()) && e.role !== "system" && !(e.objectId && listed.has(e.objectId)));
      if (theirs.length) {
        const who = [...new Set(theirs.map((e) => e.who))].slice(0, 3);
        const last = theirs[theirs.length - 1];
        items.push({
          id: `changes:${b.id}`,
          kind: "changes",
          title: `${theirs.length} change${theirs.length === 1 ? "" : "s"} on ${b.name}`,
          why: `${who.join(", ")}${theirs.length > who.length ? " and others" : ""} · latest: ${last.text.slice(0, 80)}`,
          board: b.id,
          boardName: b.name,
          objectId: last.objectId,
          href: link(b.id, last.objectId),
          at: last.at,
          tone: theirs.some((e) => e.role === "agent") ? "agent" : undefined,
        });
      }
      // files others dropped there in the last three days
      const files = all<{ id: string; name: string; uploaded_by: string | null; created_at: number; uname: string | null }>(
        "select f.id, f.name, f.uploaded_by, f.created_at, u.name as uname from files f left join users u on u.id = f.uploaded_by where f.board_id = ? and f.archived_at is null and f.created_at > ? and (f.uploaded_by is null or f.uploaded_by != ?) order by f.created_at desc limit 4",
        b.id, now - 3 * DAY, user.id,
      );
      for (const f of files) {
        const card = [...m.objects.values()].find((o) => o.kind === "panel" && o.fileId === f.id);
        items.push({
          id: `file:${f.id}`,
          kind: "file",
          title: f.name,
          why: `${f.uname ?? "Someone"} added it to ${b.name} · ${ago(f.created_at, now)}`,
          board: b.id,
          boardName: b.name,
          objectId: card?.id,
          href: card ? link(b.id, card.id) : `${config.publicUrl}/files/${f.id}`,
          at: f.created_at,
        });
      }
    }
  }

  // their job: cards and files matching the words on their profile
  const focus = getProfile(user.id)
    .focus.split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  const seen = new Set(items.map((i) => i.objectId).filter(Boolean));
  for (const word of focus) {
    const q = word.replace(/["'()*:^]/g, " ").split(/\s+/).filter(Boolean).map((t) => `"${t}"*`).join(" ");
    if (!q) continue;
    const rows = all<{ source: string; ref: string; board_id: string | null; title: string }>(
      "select source, ref, board_id, title from search_fts where search_fts match ? and source in ('board', 'file') order by bm25(search_fts, 0, 0, 0, 4, 1) limit 3",
      q,
    );
    for (const r of rows) {
      if (seen.has(r.ref) || !r.board_id) continue;
      seen.add(r.ref);
      items.push({
        id: `related:${r.source}:${r.ref}`,
        kind: "related",
        title: r.title || "Untitled",
        why: `Matches “${word}”, from your work`,
        board: r.board_id,
        boardName: boardName(r.board_id),
        objectId: r.source === "board" ? r.ref : undefined,
        href: r.source === "board" ? link(r.board_id, r.ref) : `${config.publicUrl}/files/${r.ref}`,
        at: 0,
      });
      if (items.filter((i) => i.kind === "related").length >= 6) break;
    }
  }

  const rank: Record<FocusKind, number> = { ask: 0, stage: 1, mention: 2, file: 3, changes: 4, related: 5 };
  return items.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.tone === "bad" ? -1 : 0) - (b.tone === "bad" ? -1 : 0) || b.at - a.at).slice(0, 24);
}

// ---------- the whole page ----------

export interface TodayState {
  person: { name: string; email: string; first: string };
  profile: Profile;
  goals: Goal[];
  focus: FocusItem[];
  apps: CompanyApp[];
  sources: { dataroom: { connected: boolean; note: string } };
  at: number;
}

export function todayFor(user: UserInfo): TodayState {
  return {
    person: { name: user.name, email: user.email, first: user.name.trim().split(/\s+/)[0] || user.name },
    profile: getProfile(user.id),
    goals: listGoals(user.id),
    focus: focusFor(user),
    apps: companyApps(),
    sources: {
      // not built yet (SPEC §6 #19): say so rather than pretend
      dataroom: { connected: false, note: "The Airform Data Room isn't connected yet: its projects and goals will join yours here" },
    },
    at: Date.now(),
  };
}

/** a short plain-text view of Today for the Shiba's prompt (the tool returns the full JSON) */
export function todayDigest(t: TodayState) {
  const lines = [
    `Person: ${t.person.name} <${t.person.email}>${t.profile.title ? ` · ${t.profile.title}` : ""}${t.profile.team ? ` · ${t.profile.team}` : ""}`,
    t.profile.focus ? `Their work: ${t.profile.focus}` : "Their work: not described yet (they can tell you; save it with set_profile)",
    `Date: ${new Date(t.at).toDateString()}`,
    "",
    `Goals (${t.goals.length}):`,
    ...t.goals.map((g) => `- [${g.id}] ${g.title} · ${g.status} · ${Math.round(g.progress * 100)}%${g.dueAt ? ` · due ${new Date(g.dueAt).toDateString()}` : ""}${g.detail ? ` — ${g.detail.slice(0, 160)}` : ""}`),
    "",
    `Focus today (${t.focus.length}):`,
    ...t.focus.map((f) => `- [${f.id}] (${f.kind}) ${f.title} — ${f.why} · board ${f.boardName}`),
    "",
    `Apps: ${t.apps.map((a) => `${a.name}${a.url ? "" : " (not linked)"}`).join(", ")}`,
    t.sources.dataroom.note,
  ];
  return lines.join("\n");
}
