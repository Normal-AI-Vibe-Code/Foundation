/**
 * @foundation/protocol — the one schema shared by the client, the server and
 * every agent that touches a board.
 *
 * A board is a Yjs document. People edit it through the grid; agents edit it
 * through the server (the agent runtime, the MCP endpoint, Hermes). Both sides
 * read and write the same maps below, so nothing has a private copy of the
 * board's shape.
 */

import * as Y from "yjs";
import type { CharacterState } from "./characters.ts";
import type { CollectionState } from "./collections.ts";
import type { UploaderState } from "./avatars.ts";
import type { LocalProject, LocalWatch } from "./localdev.ts";
export * from "./characters.ts";
export * from "./collections.ts";
export * from "./chat.ts";
export * from "./replay.ts";
export * from "./avatars.ts";
export * from "./localdev.ts";

// ---------- board document layout ----------

/** top-level Y.Map names inside a board's Y.Doc */
export const BOARD = {
  grid: "grid", // key "tracks" → GridTracks
  sections: "sections", // id → SectionDoc
  objects: "objects", // id → ObjectDoc
  cells: "cells", // tableId → Y.Map<"c,r" → raw> (schema 4: one entry per cell; a plain Record before)
  links: "links", // id → LinkDoc
  meta: "meta", // name, createdAt, ...
  activity: "activity", // Y.Array<ActivityEntry>
  noteText: "noteText", // noteId → Y.Text (schema 3: typing merges character by character)
  huddles: "huddles", // huddle panel id → HuddleState (schema 6: kept by the server alone, off the card)
  machineAsks: "machineAsks", // machine or app panel id → MachineAsk[] (commands agents asked to run, app tools they asked to use; kept by the server alone, off the card)
  slack: "slack", // section id → SlackSectionState (a section kept for a Slack channel; kept by the server alone)
  characters: "characters", // character panel id → CharacterState (the art pipeline's state for that card; kept by the server alone)
  agents: "agents", // place (a section id, or "*": the grid) → PostedAgent[] (who is on that place's council; kept by the server alone)
  collections: "collections", // collection panel id → CollectionState (what it has gathered, and the section it lays out into; kept by the server alone)
  uploaders: "uploaders", // uploader panel id → UploaderState (Foundation's avatars wired into it, its timer and its last upload; kept by the server alone)
  local: "local", // project key → LocalProject (this computer's projects, on the LOCAL_GRID_ID grid; kept by the server alone)
  localWatch: "localWatch", // "state" → LocalWatch (whether this computer is being watched, and when it last looked; kept by the server alone)
  desktopLeave: "desktopLeave", // machine panel id → DesktopLeave (a person's leave for agents to use its desktop, and an agent's ask for it; kept by the server alone, off the card)
} as const;

/** the place that means "the whole grid" in the board's `agents` map */
export const GRID_PLACE = "*";

/**
 * An agent assigned to a section or a grid (2026-11-15): it stays on that place's council until it's
 * taken off, at work or not. `key` names it: "claude" is the server's own agent, "t3:<id>" one of this
 * computer's. What it is (service, where it runs) is the server's reading of it when it was assigned.
 */
export interface PostedAgent {
  key: string;
  name: string;
  /** whose model it is: claude, chatgpt, kimi, deepseek, gemini, grok, cursor, agent */
  provider: string;
  /** cloud: what it's asked goes to a service · local: a model on the server's computer */
  where: "cloud" | "local";
  /** the service in a few words: the plan it's signed in to, the host it talks to */
  service: string;
  model?: string;
  /** it can read and write the grid (false: it works in a folder of its own) */
  tools: boolean;
  by: string;
  byName: string;
  at: number;
  /** this seat (2026-11-17: one agent can sit on a council more than once, each its own seat); absent on older ones, whose key is their seat */
  id?: string;
  /** the seat's own name ("Zephyr"), worn over its head, on its cursor while it works, and the name its character is chosen by; absent on older ones (they go by `name`) */
  alias?: string;
}

export function postedAgentsOf(doc: Y.Doc, place: string): PostedAgent[] {
  const v = doc.getMap<PostedAgent[]>(BOARD.agents).get(place);
  return Array.isArray(v) ? v : [];
}

export interface GridTracks {
  cols: number[];
  rows: number[];
}

export interface SectionDoc {
  id: string;
  name: string;
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  /**
   * A section can host one app (schema 2): that panel fills the section, the
   * section's header is the app's, and the app's ports sit on the section's
   * edges, so data flows section to section.
   */
  host?: string;
  /**
   * Sections are grids within themselves (2026-11-11): a section with a
   * parent sits in that section's own grid, its spans counted in the parent's
   * `grid` tracks (a section without one sits on the board). A section that
   * holds sections holds no cards of its own; cards added to it go to its
   * first section.
   */
  parent?: string;
  /** this section's own grid's tracks, once it has one */
  grid?: GridTracks;
}

/**
 * The board document's schema version (`meta.schema`). 2: sections host apps.
 * 3: note text is a Y.Text. 4: each table's cells are a Y.Map. 5: every table
 * has its cell map from the start (made with the table, never lazily — two
 * people making it at once would each make one, and one would be lost).
 * 6: a huddle's live state lives in `huddles`, not on its card, so moving the
 * card while someone joins can't overwrite who's in it.
 */
export const BOARD_SCHEMA = 6;

/** Panel kinds a section can host — whole apps, not artifacts. */
export const HOSTABLE_KINDS = ["app", "link", "machine", "connector", "grid", "kanban", "design"] as const;

export function isHostable(kind: string): boolean {
  return (HOSTABLE_KINDS as readonly string[]).includes(kind);
}

interface ObjectBaseDoc {
  id: string;
  sectionId: string;
  name: string;
  x: number;
  y: number;
  float: boolean;
  bornAt: number;
  /**
   * Who made it, when it wasn't a person at the board: the crew agent's name
   * (notes and tables an agent writes say so on the card). Panels also carry
   * the actor of the tool call that made them.
   */
  createdBy?: string;
  /**
   * Pinned to its section (2026-11-18): it leaves the flow and spans the section, drawn on the section's own
   * paper from under the header down, at the section's full width; other cards lie over it. One to a section.
   * Unpinned, it is a card again. Tables first (a new section a person adds starts with one).
   */
  pinned?: boolean;
  /** Minimized: drawn as its title bar alone, wherever it sits; its content is kept and comes back when restored */
  folded?: boolean;
}

export interface TableDoc extends ObjectBaseDoc {
  kind: "table";
  cols: number;
  rows: number;
}
export interface MapDoc extends ObjectBaseDoc {
  kind: "map";
  w: number;
  h: number;
  sourceTableId: string | null;
  pitched: boolean;
}
export interface NoteDoc extends ObjectBaseDoc {
  kind: "note";
  w: number;
  h: number;
  /**
   * Only on boards older than schema 3. The text lives in `noteText` (a
   * Y.Text per note) so two people typing in one note merge instead of
   * overwriting each other; read it with noteTextOf, write it with setNoteText.
   */
  text?: string;
  /**
   * A text box: the same markdown in the same Y.Text, written as formatted
   * text (a toolbar, no markup on screen) instead of as markdown source.
   */
  rich?: boolean;
}
export interface MediaDoc extends ObjectBaseDoc {
  kind: "media";
  w: number;
  h: number;
  src: string;
  media: "image" | "video";
  autoplay: boolean;
  muted: boolean;
  /**
   * Images only: shown inverted on a dark ground (night), for a dark drawing
   * or logo on a clear background that would vanish there. Day shows it as it is.
   */
  invert?: boolean;
}

/**
 * Panels are everything that is not a spreadsheet primitive: running apps,
 * uploaded files, web pages, machines, agents, live company data and asks.
 */
export type PanelKind =
  | "app" // a vibe-coded app or any web app, live in a frame, with repo + MCP + ports
  | "link" // a web page
  | "file" // an uploaded file (design, CAD, PDF, text, image, video)
  | "machine" // a VM, container or remote desktop reached by URL (noVNC, ttyd, code-server)
  | "agent" // an agent session working on the board
  | "connector" // live company data (BomForm, FactoryForm, Vision …)
  | "ask" // a Hermes request to a person (e.g. "upload the latest CAD")
  | "stage" // one step of a design pipeline (brief → concept → CAD → simulate → review → release)
  | "huddle" // a video portal: people on the board talk face to face, transcribed and archived
  | "slack" // a Slack channel on the board: read it, post to it, send it board links, invite it to a huddle
  | "crew" // the agents of the section it sits in: who is at work there, what each is doing, and a place to ask one
  | "grid" // a grid inside this one (2026-11-15): the section that holds it stands for a child grid and opens it
  | "kanban" // a kanban board: columns of cards moved between them (the plan is one)
  | "design" // a chapter of the design language, live on its tokens
  | "uploader" // Foundation's avatars: the characters wired into it are avatars on every Foundation; it uploads them to main's starter set, pressed or on a timer (avatars.ts)
  | "collection" // a collector: gathers what the cards wired into it make (pictures, characters) and can lay it out in a section; tiles drag out as copies
  | "pipeline" // a node of the Character studio's flow for one set (`source`: the set; `node`: which one: inspiration, a stage, or output). Without `node`, the whole flow in one card (studios of 2026-11-16)
  | "character" // a character in the making: inspiration, its sheet, its 3D model or mesh avatar, and the presses that pay for each stage
  | "local" // one of this computer's projects (localdev.ts; `source`: the project key, `node`: preview, progress or changes), kept by the server
  | "replay"; // a recorded huddle session's clock (ChatForm R1): scrub it and the section it sits in is drawn as it was then (`sessionId`: the huddle session)

export interface Port {
  id: string;
  name: string;
  dir: "in" | "out";
  /** free-form type hint: "json", "bom", "cad", "image", "text", "number" */
  type?: string;
}

export interface PanelDoc extends ObjectBaseDoc {
  kind: "panel";
  panel: PanelKind;
  w: number;
  h: number;
  url?: string;
  /** "owner/name" on GitHub, or a full git URL */
  repo?: string;
  /** MCP endpoint the app exposes (streamable HTTP) */
  mcp?: string;
  fileId?: string;
  mime?: string;
  text?: string;
  ports: Port[];
  /** the child grid a "grid" card stands for (a board id); kept by the server when a grid is put inside another */
  board?: string;
  /** what a "kanban" card shows ("plan": Foundation's own plan) or which chapter a "design" card draws */
  source?: string;
  /** which node of the Character studio's flow a "pipeline" card is (characters.ts PIPELINE_NODES); absent on the one-card flow of 2026-11-16 */
  node?: string;
  /** connector id for panel === "connector" */
  connector?: string;
  /** Slack channel id — a "slack" card's channel, or the channel a huddle was opened for */
  channel?: string;
  /**
   * Only on boards older than schema 6. A huddle's live state lives in the
   * board's `huddles` map, written by the server alone, so a person moving
   * the card while someone joins can't overwrite it; read it with
   * huddleStateOf. Readers ignore this field.
   */
  huddle?: HuddleState;
  /** a huddle card that is a view of a ChatForm channel's huddle (its id is the huddle's; it signals on /huddle/chat/:id, and `channel` is the chat channel's id) */
  home?: "chat";
  /** agent session id for panel === "agent"; the huddle session (hs_…) for panel === "replay" */
  sessionId?: string;
  /** for asks: who, and whether it's done */
  assignee?: string;
  status?: "open" | "done" | "running" | "idle" | "error";
  /** last value each output port emitted (JSON-able) */
  outputs?: Record<string, unknown>;
  // ---- design pipeline stages (panel === "stage") ----
  pipeline?: string;
  stage?: StageKey;
  artifacts?: Artifact[];
  checklist?: Array<{ text: string; done: boolean }>;
  /** stage-specific settings, e.g. { analysis: "CFD", loads: "…" } */
  settings?: Record<string, string>;
  // ---- machines on a container engine (panel === "machine" without a url) ----
  /** a Linux machine or container this card runs on Kiri or Docker, kept by the server (machines.ts) */
  machine?: MachineState;
  /** A full OS on the server's native QEMU backend; distinct from a container. */
  vm?: LocalVmState;
  /**
   * A page opened from a machine card's port pill: which card and which
   * container port (and the machine's name then, for when the card is gone).
   * The page follows that machine: live while it runs, an honest stopped
   * state otherwise, reloaded when it runs again. Optional, so no migration.
   */
  fromMachine?: { panel: string; port: number; name: string };
  /**
   * How a page card ("app" or "link" with a `url`) is shown. Absent: a frame. "browser": a tab of the built-in
   * browser on the server's computer (hostbrowser.ts), for a site that refuses framing or sits behind a sign-in
   * (everything on HyperForm). Far away the card shows the picture last saved of it (`seenAt`); near, the live page.
   * "frame": a frame, chosen by a person for a page that would otherwise go to the browser (`pageInBrowser`).
   */
  via?: "browser" | "frame";
  /** when the picture of a `via: "browser"` page was last saved (GET /api/boards/:id/pages/:panel/picture) */
  seenAt?: number;
}

// ---------- machines: Linux machines and containers on a local engine ----------

/**
 * A machine card's engine-side state. The engine is the truth: the server
 * reads it back (by the container's labels) and writes what it finds here,
 * so everyone sees the same state. Starting needs a person; agents propose.
 */
/** Native full-system VM. The card is a projection; host configuration and paths stay server-owned. */
export interface LocalVmState {
  name: string;
  os: string;
  state: "ready" | "starting" | "running" | "stopping" | "stopped" | "error" | "archived";
  isoName: string;
  memoryMB: number;
  cpus: number;
  diskGB: number;
  acceleration: "native" | "software";
  bootIso: boolean;
  detail?: string;
  guestAgent?: boolean;
}

export interface MachineState {
  /** Setup intent only. Native VM configuration is held by the server, never trusted from this flag. */
  wantVm?: boolean;
  /** machine name; the container is `machine-<name>` (Kiri's convention, so `kiri machine shell <name>` finds it) */
  name: string;
  /** image it runs ("ubuntu:24.04"): picked by a person on the card, or proposed by an agent */
  image?: string;
  /** "kiri" | "docker"; unset: the first engine that answers, Kiri first */
  engine?: string;
  state: "absent" | "pulling" | "starting" | "running" | "stopped" | "error";
  /** words for the state: pull progress, why it stopped, the error */
  detail?: string;
  containerId?: string;
  /** container ports to publish on 127.0.0.1 */
  wantPorts?: number[];
  /** what the engine published: container port → host port on 127.0.0.1 */
  ports?: Array<{ port: number; host: number }>;
  proposedBy?: string;
  startedBy?: string;
  /** when it entered this state */
  since?: number;
  /** start it with a graphical desktop: added right after it first runs (a person's Start asked for it) */
  wantDesktop?: boolean;
  /**
   * The graphical desktop inside it (an X server, a window manager and VNC,
   * installed in the machine behind a person's press and reached through
   * Foundation, never a published port). Unset: no desktop. It lives on the
   * machine's disk, so Remove clears it.
   */
  desktop?: MachineDesktop;
  // whether agents may use the desktop is not on the card (a writer's socket could set it there): the board's
  // `desktopLeave` map, which only the server writes (desktopLeaveOf)
  /** what agents last did on the desktop, newest last (a few kept): the card shows who is driving */
  agentActs?: MachineAgentAct[];
  /** the machine's pipes: when /foundation/in was last written and /foundation/out last read, and what was in them */
  io?: MachineIo;
  /**
   * Public links to its ports (2026-11-17): a tunnel (Cloudflare's quick tunnels, cloudflared on this computer)
   * a person opened, with who and when. Anyone with the link reaches that port; Stop, the machine stopping or
   * Foundation restarting ends it.
   */
  shares?: MachineShare[];
  /** a pull under way, in bytes, for the card's bar (detail keeps the words) */
  pull?: { done: number; total: number };
  /** what the machine offers as functions: executables in /foundation/functions, read when the card looks */
  functions?: MachineFunction[];
  /**
   * A node of a Kubernetes cluster (k3s; 2026-11-17, Josh: "options to start a kubernetes cluster and pods"):
   * the cluster's id and name, this node's role, and for a worker the server's machine name (it joins it by
   * name on the cluster's own network). Every node is a machine card of its own, so it can be moved anywhere.
   */
  cluster?: { id: string; name: string; role: "server" | "agent"; server?: string };
  /** a pod opened as a card of its own: its terminal is `kubectl exec` through the cluster's server */
  pod?: { server: string; ns: string; name: string; node?: string; phase?: string };
  /** per function: the keys of the pictures it has had (the next run takes only new ones), the last 400 */
  fnDone?: Record<string, string[]>;
  /** its Start puts ImageMagick and the example picture functions in it (a machine laid by Process in a machine) */
  wantFunctions?: boolean;
  /** the example functions going in, or why they didn't */
  fnSetup?: { state: "installing" | "error"; by: string; at: number; detail?: string };
}

export interface MachineShare {
  port: number;
  url: string;
  by: string;
  at: number;
}

/**
 * A function a machine offers (2026-11-17, Josh: "functions that are able to reach into the VM"): an executable
 * in /foundation/functions/<name>. Its first comment lines say what it takes and gives:
 *   # about: Trims each picture and makes it 1024 px
 *   # in: images        (images | text | json | files)
 *   # out: images
 * It runs with IN and OUT set to two folders: what it's given is in IN (one file each, or in.txt / in.json),
 * and what it leaves in OUT comes back.
 */
export interface MachineFunction {
  name: string;
  about?: string;
  in: MachineFunctionKind;
  out: MachineFunctionKind;
  /** its last run: who, when, how many went in and came out, how long, and what it said (or wrote as text) */
  last?: { at: number; by: string; ok: boolean; took: number; made: number; ms: number; said?: string; text?: string };
}
export type MachineFunctionKind = "images" | "text" | "json" | "files";

export interface MachineDesktop {
  state: "installing" | "ready" | "error";
  /** install progress in the package manager's own words, or why it failed */
  detail?: string;
  /** who pressed Add a desktop, and when it reached this state */
  by?: string;
  at?: number;
  /** the screen, in pixels */
  w?: number;
  h?: number;
}

export interface MachineAgentAct {
  by: string;
  for?: string;
  /** what it did, in a few words: "clicked (640, 400)", "typed “hello”", "looked at the screen" */
  did: string;
  at: number;
}

/** how long after an agent's last action the card still says it is using the desktop */
export const MACHINE_AGENT_ACTIVE_MS = 20_000;

export interface MachineIo {
  /** the end of what was last written to /foundation/in, and when */
  inPreview?: string;
  inBytes?: number;
  inAt?: number;
  /** the end of what /foundation/out last held, and when it was read */
  outPreview?: string;
  outBytes?: number;
  outAt?: number;
  /** why the last write or read didn't happen */
  error?: string;
}

/** where a machine's pipes are, inside it */
export const MACHINE_IN_PATH = "/foundation/in";
export const MACHINE_OUT_PATH = "/foundation/out";
/** a machine card's two ports, by name */
export const MACHINE_IN_PORT = "in";
export const MACHINE_OUT_PORT = "out";

/**
 * What a wire's end carries when it isn't an app's port: a note is its text
 * (port "text"), a table its rows (port "rows": an array of arrays of the
 * cells as typed) or one cell (port "B2"). Machines read and write these on
 * the server (machineio.ts), so a note or a table can feed a machine and take
 * what it prints. The wire layer draws card-to-card wires only; these are
 * listed on the machine's card.
 */
export const NOTE_PORT = "text";
export const TABLE_PORT = "rows";

/** "B2" → { c: 1, r: 1 }; null when it isn't a cell */
export function cellRef(port: string): { c: number; r: number } | null {
  const m = /^([A-Za-z]{1,2})([1-9][0-9]{0,3})$/.exec(port.trim());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { c: c - 1, r: Number(m[2]) - 1 };
}

/** Kiri's distro shortcuts (`kiri machine create NAME --distro ubuntu`): these images become long-lived machines */
export const MACHINE_DISTROS: ReadonlyArray<{ id: string; image: string }> = [
  { id: "ubuntu", image: "ubuntu:24.04" },
  { id: "debian", image: "debian:trixie" },
  { id: "alpine", image: "alpine:3.22" },
  { id: "fedora", image: "fedora:42" },
  { id: "arch", image: "archlinux:latest" },
  { id: "rocky", image: "rockylinux:9" },
  { id: "opensuse", image: "opensuse/tumbleweed:latest" },
];

/** a machine name: letters, digits and dashes, not starting with a dash (Kiri's rule), at most 40 */
export function machineName(s: string): string {
  const n = s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return n || "machine";
}

/**
 * A command an agent asked to run in a machine a person started. Nothing runs
 * until a person who can edit the board presses Run on the card (from their
 * browser session; agents and bearer tokens can't approve). The server alone
 * writes these, in the board's `machineAsks` map (off the card, so moving the
 * card can't lose one), and keeps the last few per machine.
 */
export interface MachineAsk {
  id: string;
  /** the command to run; for an app's tool, the tool's name */
  command: string;
  /** the agent's few words on why */
  why?: string;
  /** the agent that asked (a crew name, or "Ada's agent" for an outside one) */
  by: string;
  /** the person it works for */
  for?: string;
  /**
   * Set when this asks to use a tool of a saved app (on an app's card, ADR-001
   * G3) rather than to run a command in a machine. Nothing is called on Allow:
   * Allow lets agents call that tool of that app from then on (until its
   * definition changes), and the agent calls again. Such an ask doesn't wait
   * in the server or time out; it stays until a person answers it.
   */
  tool?: AppToolAsk;
  state: "waiting" | "running" | "done" | "declined" | "timed out" | "withdrawn" | "failed" | "allowed";
  at: number;
  /** the person who pressed Run or Decline */
  decidedBy?: string;
  decidedAt?: number;
  exitCode?: number;
  /** the end of what it printed (the agent gets more) */
  output?: string;
  endedAt?: number;
  /** when a waiting ask gives up, unanswered */
  expiresAt?: number;
}

/** what an ask to use an app's tool shows a person: which app, where, which tool, and what this call would send */
export interface AppToolAsk {
  /** the saved app (the registry's `apps` row) the card resolved to */
  appId: string;
  app: string;
  /** the saved MCP address Foundation would connect to (the registry's, not the card's) */
  address: string;
  description: string;
  /** the arguments this call wants to send, as JSON (shortened) */
  args: string;
  /** "first": never allowed; "changed": allowed before, but its definition changed since */
  change: "first" | "changed";
  /** sha256 of the tool's name, description and input schema as listed: what Allow allows */
  defHash: string;
}

/** the commands agents asked to run in a machine (and, on an app's card, the tools they asked to use), newest last */
export function machineAsksOf(doc: Y.Doc, panelId: string): MachineAsk[] {
  return boardMaps(doc).machineAsks.get(panelId) ?? [];
}

/**
 * Agents' leave to use a machine's desktop, kept by the server alone in the board's `desktopLeave` map (a
 * writer's sync socket can't set it: only a person's press, through the server, does).
 */
export interface DesktopLeave {
  /**
   * A person let agents use this machine's desktop (look at it, move the pointer, type): who and when.
   * Unset is the default: agents can't. Only a signed-in person who can edit the board sets it, from their
   * browser; anyone who can edit takes it away; Remove clears it.
   */
  agentsMay?: { by: string; at: number };
  /** an agent tried to use the desktop without that leave: the card offers the person the button */
  agentAsked?: { by: string; for?: string; at: number };
}

export function desktopLeaveOf(doc: Y.Doc, panelId: string): DesktopLeave {
  return boardMaps(doc).desktopLeave.get(panelId) ?? {};
}

// ---------- Slack sections: a section kept for a channel ----------

/**
 * A section that follows a Slack channel (the Slack board: one section per
 * channel). The server alone writes this, in the board's `slack` map (off the
 * section, so moving or renaming the section can't lose it): which channel,
 * and how the connection to it stands right now, so everyone sees the same
 * state on the section's Slack mark.
 */
export interface SlackSectionState {
  /** Slack channel id */
  channel: string;
  /** the channel's name, without # */
  name: string;
  private?: boolean;
  /**
   * live: Slack sends what's posted as it's posted (the Slack app's socket) ·
   * polling: read every so often while someone has the board open ·
   * waiting: the Slack app isn't in the channel, so it can't be read ·
   * offline: Slack isn't connected, or wouldn't answer
   */
  state: "live" | "polling" | "waiting" | "offline";
  /** words for the state: why it's waiting or offline, how often it's read */
  detail?: string;
  /** when the channel was last read into the section */
  syncedAt?: number;
  /** when the newest top-level message was posted */
  lastAt?: number;
  /** top-level messages read last time, and images brought into the section so far */
  messages?: number;
  images?: number;
  /** the note that holds the summary, and the one that lists the latest top-level messages */
  summaryNote?: string;
  latestNote?: string;
  /** who wrote the summary: a crew agent's name, or unset while it's the server's own digest */
  summaryBy?: string;
  summaryAt?: number;
  /** agents keep this section current: the person who turned that on (their agents, their runtime) */
  agents?: { by: string; at: number };
}

/** A section's Slack channel and the state of its connection, when it follows one. */
export function slackSectionOf(doc: Y.Doc, sectionId: string): SlackSectionState | undefined {
  return boardMaps(doc).slack.get(sectionId);
}

// ---------- huddles: video portals on the board ----------

export interface HuddleState {
  /** set while anyone is in it */
  liveSince?: number;
  /** names of the people in it now (one entry per person, not per tab) */
  people: string[];
  /** someone pressed Record: every participant's own camera and mic are being archived */
  recording?: { by: string; since: number } | null;
  lastEndedAt?: number;
  /** a channel's huddle shown on a grid whose channel isn't open: the card says whose it is, never who's in it (people stays empty, recording.by "") */
  locked?: boolean;
}

/** one line of a huddle's transcript — spoken (each person's browser transcribes their own mic) or typed */
export interface HuddleLine {
  id: string;
  at: number;
  speaker: string;
  text: string;
  source: "speech" | "typed" | "system" | "agent";
}

/** messages on the huddle socket (/huddle/:board/:huddle) — signalling only; media is peer to peer */
export type HuddleWire =
  | { t: "welcome"; you: string; peers: Array<{ id: string; name: string; color: string; sending: boolean; noRec?: boolean }>; ice: unknown[] }
  | { t: "peer-joined"; id: string; name: string; color: string; sending: boolean }
  | { t: "peer-left"; id: string }
  | { t: "peer-state"; id: string; sending: boolean; muted?: boolean; camOff?: boolean; /** "don't record me": their recorder never starts */ noRec?: boolean }
  | { t: "signal"; from: string; to: string; data: unknown }
  | { t: "line"; line: HuddleLine }
  | { t: "caption"; from: string; name: string; text: string }
  | { t: "recording"; on: boolean; by: string }
  // ---- ChatForm (H1): screen share, agents in the room, a channel huddle's end ----
  /** client → server: share my screen (a second video track on the stream `stream`) or stop; one share per room */
  | { t: "share"; on: boolean; stream?: string }
  /** server → all: who shares now (null: nobody); `stream` is the shared MediaStream's id on that peer's connection */
  | { t: "sharing"; id: string | null; by: string | null; stream?: string }
  /** server → all: the agents seated in the room and what each is doing */
  | { t: "agents"; agents: Array<{ name: string; by: string; state: "listening" | "thinking" | "talking" }> }
  /** server → all: an agent's answer, for every client to speak aloud (speechSynthesis, locally) */
  | { t: "agent-says"; name: string; text: string; id: string }
  /** server → all: a person pressed Stop: stop speaking now */
  | { t: "agent-hush" }
  /** server → all: a channel's huddle ended (the last person left); the socket closes after */
  | { t: "ended"; session: string | null };

// ---------- design pipelines: design → CAD → simulation → release ----------

export type StageKey = "brief" | "concept" | "cad" | "simulate" | "review" | "release";

export interface Artifact {
  id: string;
  name: string;
  /** "image" | "cad" | "doc" | "data" | "link" | "decision" */
  kind: string;
  fileId?: string;
  url?: string;
  mime?: string;
  /** e.g. the CAD bounding box "212 × 212 × 64 mm" */
  note?: string;
  by: string;
  at: number;
  chosen?: boolean;
}

export interface StageDef {
  key: StageKey;
  title: string;
  glyph: string;
  /** what this stage hands to the next */
  out: { name: string; type: string };
  purpose: string;
  checklist: string[];
}

/** The six stages, in order. One definition for the server, the client and agents. */
export const STAGES: StageDef[] = [
  {
    key: "brief",
    title: "Brief",
    glyph: "✎",
    out: { name: "brief", type: "json" },
    purpose: "What we're making, for whom, and how we'll know it's right.",
    checklist: ["Goal and use case written", "Constraints: size, mass, cost, materials", "Success criteria agreed"],
  },
  {
    key: "concept",
    title: "Concept",
    glyph: "◈",
    out: { name: "concept", type: "image" },
    purpose: "Sketches and renders — from Vision, the team, or references. Star the one we take forward.",
    checklist: ["At least two directions explored", "One direction chosen (★)"],
  },
  {
    key: "cad",
    title: "CAD",
    glyph: "⬡",
    out: { name: "cad", type: "cad" },
    purpose: "The model. Drop a STEP (or ask the owner — Hermes follows up until it lands).",
    checklist: ["STEP uploaded", "Units and envelope check out", "Part numbers assigned"],
  },
  {
    key: "simulate",
    title: "Simulate",
    glyph: "≋",
    out: { name: "results", type: "data" },
    purpose: "Test it before it's made: CFD, FEA, thermal or RF in Vision. Results land here.",
    checklist: ["Analysis and load cases set", "Run in Vision", "Results attached and read"],
  },
  {
    key: "review",
    title: "Review",
    glyph: "◎",
    out: { name: "approved", type: "decision" },
    purpose: "The people who own it look at the design and the results, and decide.",
    checklist: ["Reviewers asked", "Comments resolved", "Decision recorded"],
  },
  {
    key: "release",
    title: "Release",
    glyph: "⇢",
    out: { name: "release", type: "bom" },
    purpose: "Hand it to BomForm and FactoryForm: part numbers, BOM lines, a revision.",
    checklist: ["BOM lines in BomForm", "Revision tagged", "FactoryForm notified"],
  },
];

export function stageDef(key: StageKey | undefined): StageDef | undefined {
  return STAGES.find((s) => s.key === key);
}

export type ObjectDoc = TableDoc | MapDoc | NoteDoc | MediaDoc | PanelDoc;

export interface LinkDoc {
  id: string;
  from: { panel: string; port: string };
  to: { panel: string; port: string };
  label?: string;
  createdBy?: string;
}

export interface ActivityEntry {
  at: number;
  who: string;
  /** "human" | "agent" | "system" */
  role: "human" | "agent" | "system";
  text: string;
  objectId?: string;
  /** an agent's line: the person it was working for */
  for?: string;
}

export const DEFAULT_COL_W = 1560;
export const DEFAULT_ROW_H = 1160;

// ---------- helpers that work on any side ----------

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function boardMaps(doc: Y.Doc) {
  return {
    grid: doc.getMap<GridTracks>(BOARD.grid),
    sections: doc.getMap<SectionDoc>(BOARD.sections),
    objects: doc.getMap<ObjectDoc>(BOARD.objects),
    cells: doc.getMap<TableCells | Record<string, string>>(BOARD.cells),
    links: doc.getMap<LinkDoc>(BOARD.links),
    meta: doc.getMap<unknown>(BOARD.meta),
    activity: doc.getArray<ActivityEntry>(BOARD.activity),
    noteText: doc.getMap<Y.Text>(BOARD.noteText),
    huddles: doc.getMap<HuddleState>(BOARD.huddles),
    machineAsks: doc.getMap<MachineAsk[]>(BOARD.machineAsks),
    slack: doc.getMap<SlackSectionState>(BOARD.slack),
    characters: doc.getMap<CharacterState>(BOARD.characters),
    agents: doc.getMap<PostedAgent[]>(BOARD.agents),
    collections: doc.getMap<CollectionState>(BOARD.collections),
    uploaders: doc.getMap<UploaderState>(BOARD.uploaders),
    desktopLeave: doc.getMap<DesktopLeave>(BOARD.desktopLeave),
    local: doc.getMap<LocalProject>(BOARD.local),
    localWatch: doc.getMap<LocalWatch>(BOARD.localWatch),
  };
}

// ---------- huddle state (schema 6) ----------

/** A huddle's live state (who's in it now, whether it records), or none before anyone met there. */
export function huddleStateOf(doc: Y.Doc, huddleId: string): HuddleState | undefined {
  return boardMaps(doc).huddles.get(huddleId);
}

/**
 * Set a huddle's live state. The server alone calls this (huddles.ts); it
 * touches only the huddle's entry in `huddles`, never the card in `objects`.
 * Call inside a transaction.
 */
export function setHuddleState(doc: Y.Doc, huddleId: string, state: HuddleState) {
  boardMaps(doc).huddles.set(huddleId, state);
}

// ---------- table cells (schema 4) ----------

/** A table's cells: "c,r" → the raw text typed (formulas as written). */
export type TableCells = Y.Map<string>;

/** A table's cells as a plain record (either form: before or after schema 4). */
export function tableCellsOf(doc: Y.Doc, tableId: string): Record<string, string> {
  const v = boardMaps(doc).cells.get(tableId);
  if (!v) return {};
  return v instanceof Y.Map ? (v.toJSON() as Record<string, string>) : { ...v };
}

/**
 * The live cell map of a table, made (or upgraded from a plain record) if
 * needed. Call inside a transaction. Make it when the table is made: a map
 * made lazily by two people at once is two maps, and one of them is lost.
 */
export function tableCellMap(doc: Y.Doc, tableId: string): TableCells {
  const m = boardMaps(doc);
  const v = m.cells.get(tableId);
  if (v instanceof Y.Map) return v;
  const map = new Y.Map<string>();
  m.cells.set(tableId, map);
  for (const [k, raw] of Object.entries(v ?? {})) if (raw) map.set(k, raw);
  return map;
}

/**
 * Make a table's cells match `raw`, touching only the cells that differ — so
 * someone editing another cell of the same table keeps their edit. Empty
 * means cleared. Call inside a transaction.
 */
export function setTableCells(doc: Y.Doc, tableId: string, raw: Record<string, string>) {
  const map = tableCellMap(doc, tableId);
  for (const [k, v] of Object.entries(raw)) if (v && map.get(k) !== v) map.set(k, v);
  for (const k of [...map.keys()]) if (!raw[k]) map.delete(k);
}

// ---------- note text (schema 3) ----------

/** The one edit that turns `a` into `b`: keep the common start and end, replace the middle. */
export function textDiff(a: string, b: string): { at: number; remove: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const min = Math.min(a.length, b.length);
  while (start < min && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < min - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  // never split a surrogate pair
  if (start > 0 && start < a.length && isLowSurrogate(a.charCodeAt(start))) start--;
  return { at: start, remove: a.length - start - end, insert: b.slice(start, b.length - end) };
}
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** A note's text: its Y.Text, or the legacy field on a board that hasn't migrated. */
export function noteTextOf(doc: Y.Doc, note: { id: string; text?: string }): string {
  return boardMaps(doc).noteText.get(note.id)?.toString() ?? note.text ?? "";
}

/**
 * Set a note's text as the smallest edit from what's there, so someone typing
 * elsewhere in the same note keeps their characters. Call inside a transaction.
 */
export function setNoteText(doc: Y.Doc, id: string, text: string) {
  const m = boardMaps(doc);
  let t = m.noteText.get(id);
  if (!t) {
    t = new Y.Text();
    m.noteText.set(id, t);
  }
  const d = textDiff(t.toString(), text);
  if (!d) return;
  if (d.remove) t.delete(d.at, d.remove);
  if (d.insert) t.insert(d.at, d.insert);
}

/** Put a note on the board: the card in `objects`, its text in `noteText`. */
export function putNote(doc: Y.Doc, note: NoteDoc & { text: string }) {
  const { text, ...card } = note;
  boardMaps(doc).objects.set(card.id, card);
  setNoteText(doc, card.id, text);
}

export function readTracks(doc: Y.Doc): GridTracks {
  return (
    boardMaps(doc).grid.get("tracks") ?? { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] }
  );
}

/** Add a section as a new column on the right edge of the board's grid (agents use this). */
export function appendSection(doc: Y.Doc, name: string): SectionDoc {
  const m = boardMaps(doc);
  const tracks = readTracks(doc);
  // the board's own grid: sections inside a section count in that section's tracks, not these
  const sections = [...m.sections.values()].filter((s) => !s.parent);
  let sec: SectionDoc;
  if (sections.length === 0) {
    sec = { id: uid("sec"), name, c0: 0, r0: 0, c1: 0, r1: tracks.rows.length - 1 };
  } else {
    const c = tracks.cols.length;
    tracks.cols = [...tracks.cols, DEFAULT_COL_W];
    sec = { id: uid("sec"), name, c0: c, r0: 0, c1: c, r1: tracks.rows.length - 1 };
    m.grid.set("tracks", tracks);
  }
  m.sections.set(sec.id, sec);
  return sec;
}

/**
 * Where a card for this section really goes (2026-11-11: sections are grids
 * within themselves): the section itself, or, when it holds sections, its
 * first one (top-left first), as deep as it goes.
 */
export function leafSectionOf(doc: Y.Doc, sec: SectionDoc): SectionDoc {
  const all = [...boardMaps(doc).sections.values()];
  let at = sec;
  for (let guard = 0; guard < 16; guard++) {
    const kids = all.filter((s) => s.parent === at.id).sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
    if (!kids.length) return at;
    at = kids[0];
  }
  return at;
}

/** "Design › Sketches": a section's place, from the board down */
export function sectionPath(doc: Y.Doc, sec: SectionDoc): string {
  const m = boardMaps(doc);
  const names = [sec.name];
  let at = sec.parent ? m.sections.get(sec.parent) : undefined;
  for (let guard = 0; at && guard < 16; guard++) {
    names.unshift(at.name);
    at = at.parent ? m.sections.get(at.parent) : undefined;
  }
  return names.join(" › ");
}

export function findSection(doc: Y.Doc, nameOrId: string): SectionDoc | undefined {
  const m = boardMaps(doc);
  const direct = m.sections.get(nameOrId);
  if (direct) return direct;
  const needle = nameOrId.trim().toLowerCase();
  return [...m.sections.values()].find((s) => s.name.trim().toLowerCase() === needle);
}

export function logActivity(doc: Y.Doc, entry: Omit<ActivityEntry, "at">) {
  const arr = boardMaps(doc).activity;
  arr.push([{ ...entry, at: Date.now() }]);
  // keep the log bounded; the server's journal keeps everything
  if (arr.length > 400) arr.delete(0, arr.length - 400);
}

/** Short plain-text digest of a board — what agents read first. */
export function describeBoard(doc: Y.Doc): string {
  const m = boardMaps(doc);
  const lines: string[] = [];
  const all = [...m.sections.values()];
  for (const s of all) {
    const host = s.host ? m.objects.get(s.host) : undefined;
    const kids = all.filter((k) => k.parent === s.id).length;
    const where = s.parent ? ` — inside "${sectionPath(doc, s).split(" › ").slice(0, -1).join(" › ")}"` : "";
    const grid = kids ? ` — a grid of ${kids} section${kids === 1 ? "" : "s"} (cards added to it go to its first)` : "";
    lines.push(`## Section "${s.name}" (${s.id})${where}${grid}${host ? ` — hosts the app "${host.name}" (${host.id}); its ports are the section's` : ""}`);
    for (const o of m.objects.values()) {
      if (o.sectionId !== s.id) continue;
      if (o.kind === "panel") {
        const extra = [o.pipeline && `pipeline=${o.pipeline}`, o.url && `url=${o.url}`, o.repo && `repo=${o.repo}`, o.mcp && `mcp=${o.mcp}`, o.status && `status=${o.status}`, o.assignee && `assignee=${o.assignee}`]
          .filter(Boolean)
          .join(" ");
        const ports = o.ports.map((p) => `${p.dir}:${p.name}`).join(",");
        lines.push(`- ${o.panel} "${o.name}" (${o.id}) ${extra}${ports ? ` ports[${ports}]` : ""}`);
        if (o.text) lines.push(`  ${o.text.slice(0, 240).replace(/\n/g, " ")}`);
      } else if (o.kind === "note") {
        lines.push(`- note "${o.name}" (${o.id}): ${noteTextOf(doc, o).slice(0, 240).replace(/\n/g, " ")}`);
      } else if (o.kind === "table") {
        const cells = tableCellsOf(doc, o.id);
        const head = [0, 1, 2, 3, 4, 5].map((c) => cells[`${c},0`] ?? "").filter(Boolean);
        lines.push(`- table "${o.name}" (${o.id}) ${o.cols}×${o.rows} headers: ${head.join(" | ")}`);
      } else {
        lines.push(`- ${o.kind} "${o.name}" (${o.id})`);
      }
    }
  }
  const links = [...m.links.values()];
  if (links.length) {
    lines.push("## Connections");
    for (const l of links) lines.push(`- ${l.from.panel}.${l.from.port} → ${l.to.panel}.${l.to.port}${l.label ? ` (${l.label})` : ""}`);
  }
  return lines.join("\n") || "(empty board)";
}

// ---------- wire messages (agent stream, server → client) ----------

export type AgentEvent =
  /** first on every stream: the run it belongs to (reattach with GET /api/agent/runs/:id/events) */
  | { type: "run"; id: string }
  /** the visible agent doing this run: its generated name, hue (0–5) and, for a helper, who called it in */
  | { type: "crew"; id: string; name: string; hue: number; lead?: string; leadName?: string }
  /** a helper this run called in: its own run and session, so its tab can be opened */
  | { type: "helper"; name: string; runId: string; session: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "status"; status: string }
  | { type: "done"; runtime: AgentRuntime; usage?: { input: number; output: number } }
  | { type: "error"; message: string };

/**
 * Where an agent turn runs.
 * - "subscription": Claude Code on this machine (`claude -p`), the T3-style
 *   session mechanism — the user's plan pays, never an API key.
 * - "api": the Anthropic API with the workspace key (credits).
 * - "script": a fixed playbook for tests and e2e (FOUNDATION_AGENT_SCRIPT=1
 *   only): the same tools, no model.
 */
export type AgentRuntime = "subscription" | "api" | "script";

export interface SearchHit {
  source: "board" | "file" | "slack" | "github" | "app" | "activity" | "huddle" | "flowform" | "chat";
  id: string;
  title: string;
  snippet: string;
  url?: string;
  objectId?: string;
  score: number;
  /** a small picture of it (a server path under `/files/`), when there is one */
  thumb?: string;
  /** a file Flowform can see for this person (source "flowform"): what's needed to bring its bytes in */
  flowform?: FlowformFileRef;
}

/** one of a person's Flowform files, as Foundation's search and its Flowform browser hand it to the page */
export interface FlowformFileRef {
  fileId: string;
  /** the revision whose bytes can be brought in (absent: Flowform names none, so it lands by name or as a link) */
  revisionId?: string;
  /** Flowform's own word for it: image, video, pdf, doc, model, … */
  kind: string;
  bytes?: number;
  /** where Flowform found it: flowform (an upload or a board's media), slack, figma */
  origin?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  color: string;
  /** account-wide; a board can set its own (viewer: may read, not change) */
  role: "admin" | "member" | "viewer";
}
export * from "./apps.ts";
export * from "./design.ts";

export { belowMinimum, compareVersions, isVersion } from "./version.ts";
