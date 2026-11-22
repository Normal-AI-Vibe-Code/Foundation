/**
 * This computer (2026-11-20, Josh: "visualize automatically in a Grid all the projects that are running … previews in
 * different sections of changes and progress … indicate that these are being generated locally").
 *
 * One grid, `LOCAL_GRID_ID`, that the server keeps for the computer it runs on: a section per project someone is
 * building here (a git repository, its worktrees folded into it), and in each three `local` cards: the latest
 * picture of the work (`node: "preview"`), where the sessions on it stand (`"progress"`), and what changed in the
 * checkout (`"changes"`). The server reads Claude Code's transcripts, T3's threads and git, and writes what it
 * found into two maps that only it writes (like `collections`): `local` (project key → LocalProject) and
 * `localWatch` ("state" → LocalWatch). Nothing here is ever written back to a project.
 */

/** the grid that is this computer's projects (a board id; not under "foundation-", so it's listed in All Grids) */
export const LOCAL_GRID_ID = "this-computer";
export const LOCAL_GRID_NAME = "This computer";

/** what each of a project's three cards shows */
export const LOCAL_NODES = ["preview", "progress", "changes"] as const;
export type LocalNode = (typeof LOCAL_NODES)[number];

/** where a session runs: the Claude desktop app's Code tab, the Claude Code CLI (or SDK), or a T3 / Vision Code thread */
export type LocalSource = "claude-desktop" | "claude-cli" | "t3";

export interface LocalStep {
  text: string;
  state: "done" | "doing" | "todo";
}

export interface LocalSession {
  /** the transcript's session id, or the T3 thread id */
  id: string;
  title: string;
  source: LocalSource;
  /** working: written to in the last two minutes (or T3 says so); waiting: needs a person (T3); idle; error */
  state: "working" | "waiting" | "idle" | "error";
  /** last activity, ms */
  at: number;
  branch?: string;
  /** the worktree's folder name when the session runs in one, not the checkout itself */
  worktree?: string;
  /** the plan the session keeps (its task list), newest */
  steps?: LocalStep[];
  /** the session's latest wrap-up, or what was last asked of it */
  recap?: string;
  pr?: { number: number; url: string };
  /** files it wrote or edited */
  edits: number;
  /** the T3 agent it runs on, or the model */
  agent?: string;
}

export interface LocalFile {
  path: string;
  /** git's two status letters, trimmed: M, A, D, R, ?? … */
  status: string;
}

export interface LocalCommit {
  sha: string;
  subject: string;
  at: number;
}

export interface LocalProject {
  /** the project's folder, normalised (lower-case drive, forward slashes): the map's key and the cards' `source` */
  key: string;
  name: string;
  /** the folder as the computer writes it */
  path: string;
  /** git: the checkout's branch, how far it is from its upstream, what's changed and the last commits */
  git?: { branch: string; ahead: number; behind: number; dirty: number; files: LocalFile[]; commits: LocalCommit[] };
  /** a dev server the project declares (`.claude/launch.json`) and whether it answers now */
  server?: { name: string; port: number; url: string; live: boolean };
  /** the newest picture a session saw of the work (a screenshot), kept in the archive */
  preview?: { fileId: string; at: number; session: string; mime: string };
  sessions: LocalSession[];
  /** newest activity across its sessions, ms */
  at: number;
  /** the folder is gone */
  gone?: boolean;
}

export interface LocalWatch {
  /** who connected this computer, and when */
  by: string;
  byName: string;
  since: number;
  /** watching now, or stopped (the grid stays as it was) */
  on: boolean;
  /** the last time the server looked, and what it could read */
  scannedAt: number;
  every: number;
  projects: number;
  working: number;
  sources: { claude: boolean; t3: boolean; git: boolean };
  /** why something couldn't be read, in words */
  note?: string;
}

/** is the watch live: on, and it looked within three of its intervals */
export function localLive(w: LocalWatch | undefined, now = Date.now()): boolean {
  return !!w && w.on && now - w.scannedAt < Math.max(90_000, w.every * 3);
}

/** a folder as a key: forward slashes, no trailing slash, a Windows drive letter lower-cased */
export function localKey(path: string): string {
  let p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(p)) p = p[0].toLowerCase() + p.slice(1);
  return p;
}
