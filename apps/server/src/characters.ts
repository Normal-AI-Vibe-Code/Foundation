/**
 * Characters: the art pipeline behind the council's avatars, run on a board.
 *
 * A character is a card (panel "character") whose state the server keeps in
 * the board's `characters` map and in SQLite. Its stages go through Meshy
 * (meshy.ts), one press at a time:
 *
 *   sheet   the character from the front, drawn from the inspiration images and its words
 *   views   model form: the back and one side, turned from the sheet · mesh form: a head-and-shoulders portrait
 *   model   a textured 3D model from the views
 *   rig     a skeleton fitted to the model
 *   clips   one clip per mood, in one file: what a council seat plays
 *   mesh    a .mavatar built from the portrait with mesh-avatar-studio, brought in as a file
 *
 * What's held (test/characters.test.ts):
 *  - every stage that spends credits starts from a person's press (the routes
 *    ask requirePerson); agents can add a character and describe it, not pay for it;
 *  - the request is written down before it is sent, and a send whose outcome
 *    is unknown is never sent again without the person saying so (WildChild:
 *    never resubmit a charged task);
 *  - each task keeps its prompt word for word, its model, and the hashes of
 *    its references (the Vision Archive's lineage);
 *  - results come into the archive as files; a stage done again leaves the
 *    old files there;
 *  - people can't write the `characters` map (boards.ts SERVER_MAPS);
 *  - a character goes with its card: whoever takes the card off the board (a
 *    person, an agent's delete_card), the character leaves the board's map
 *    with it, so every open browser's roster and council follow at once. Its
 *    row and its files stay (the archive is never deleted), and a card that
 *    comes back (a device that was offline) gets its character back.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  boardMaps,
  CHARACTER_STAGES,
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  logActivity,
  MOOD_CLIPS,
  MOODS,
  putNote,
  uid,
  type CharacterFiles,
  type CharacterForm,
  type CharacterStageKey,
  type CharacterState,
  type MediaDoc,
  type PanelDoc,
  type SectionDoc,
  type UserInfo,
} from "@foundation/protocol";
import { config } from "./config.ts";
import { all, db, one, run } from "./db.ts";
import { createBoardRow, editBoard, getBoard, listBoards, onBoardOpen, type Board } from "./boards.ts";
import { storeFile, type FileRow } from "./files.ts";
import { imageSize } from "./construct.ts";
import { HttpError } from "./http.ts";
import { dataUri, meshyBalance, meshyConfigured, meshyCreate, meshyDownload, MeshyError, meshyTask, type MeshyEndpoint, type MeshyTask } from "./meshy.ts";

db.exec(`
create table if not exists characters (
  id text primary key,
  board_id text not null,
  panel_id text not null,
  state text not null,
  created_by text,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists characters_panel on characters(board_id, panel_id);
create table if not exists character_tasks (
  id text primary key,
  character_id text not null,
  stage text not null,
  role text not null,
  endpoint text not null,
  model text,
  prompt text,
  request text not null,
  ref_hashes text not null default '[]',
  by_user text,
  by_name text,
  started_at integer not null,
  task_id text,
  status text not null,
  progress integer not null default 0,
  credits integer not null default 0,
  error text,
  finished_at integer,
  file_id text
);
create index if not exists character_tasks_of on character_tasks(character_id, stage);
create table if not exists character_boards (board_id text primary key, made_by text, made_at integer not null);
create table if not exists crew_avatars (name text primary key, character_id text not null, set_by text, at integer not null);
`);

// ---------- what each stage asks for ----------

/** which task of a stage this is, and so which file its result becomes */
type Role = "front" | "back" | "side" | "portrait" | "model" | "rig" | "clips";

interface TaskRow {
  id: string;
  character_id: string;
  stage: CharacterStageKey;
  role: Role;
  endpoint: MeshyEndpoint;
  model: string | null;
  prompt: string | null;
  request: string;
  ref_hashes: string;
  by_user: string | null;
  by_name: string | null;
  started_at: number;
  task_id: string | null;
  /** submitting: written down, the send's outcome not yet known · running · done · failed */
  status: "submitting" | "running" | "done" | "failed";
  progress: number;
  credits: number;
  error: string | null;
  finished_at: number | null;
  file_id: string | null;
}

interface CharRow {
  id: string;
  board_id: string;
  panel_id: string;
  state: string;
}

const IMAGE_COST: Record<string, number> = { "nano-banana": 3, "nano-banana-2": 6, "nano-banana-2-lite": 3, "nano-banana-2-1": 4, "nano-banana-pro": 9 };
const imageModel = () => (process.env.MESHY_IMAGE_MODEL ?? "nano-banana-pro").trim();
const imageCost = () => IMAGE_COST[imageModel()] ?? 12;

/** credits a stage will ask for, shown on its button before it's pressed */
export function stageCost(form: CharacterForm, stage: CharacterStageKey): number {
  switch (stage) {
    case "sheet":
      return imageCost();
    case "views":
      return form === "model" ? imageCost() * 2 : imageCost();
    case "model":
      return 30;
    case "rig":
      return 5;
    case "clips":
      return 3 * MOODS.length;
    case "mesh":
      return 0;
  }
}

// The fixed words of each view. WildChild's v8 rules (tools/meshy_hunter_v8_pipeline.mjs), made general:
// one figure, a pose a skeleton can be fitted to, flat light, nothing else in frame.
const ORIGINAL = "Draw one original character: take the style, mood, materials and palette of the reference images, not a copy of any one of them.";
const MODEL_RULES = [
  "Orthographic full-body character model sheet for 3D modelling: a single figure, centred, head to toe in frame with margin,",
  "standing upright on two legs in an A-pose (arms straight, about 40 degrees out from the body, hands open and clear of the body, feet a shoulder width apart, flat on the ground),",
  "neutral friendly expression with the mouth closed, soft even frontal light, no cast shadows, no ground plane, plain flat off-white background, no text, no labels, no other figures, nothing held in the hands.",
  "Clean readable colour shapes; the head, neck, arms, waist and legs read clearly so a skeleton can be fitted.",
].join(" ");
const MESH_RULES = [
  "Full-body character illustration: a single figure, centred, head to toe in frame with margin, standing relaxed and facing the camera squarely,",
  "arms at the sides and clear of the body, both eyes open and looking at the camera, mouth closed, a soft neutral expression,",
  "flat even light, no cast shadows, plain flat off-white background, no text, no logos, no watermark, no other figures.",
  "Flat colour shapes with clean edges and little shading.",
].join(" ");
const TURN = "The first reference image is the exact character to turn around; match its proportions, height, colours and costume exactly.";
const VIEW: Record<"back" | "side", string> = {
  back: "Back view: the same character seen exactly from behind, same A-pose and scale.",
  side: "Left side view: the same character in strict profile facing the image's left edge, same A-pose and scale; the arms angle out from the body.",
};
const PORTRAIT = [
  "Head-and-shoulders portrait of exactly the character in the first reference image: the same face, hair, colours and clothes, in the same flat style.",
  "Facing the camera squarely, head upright and not tilted, both eyes fully open and looking at the camera, mouth closed, a neutral relaxed expression,",
  "nothing in front of the face, no hands in frame, shoulders and upper chest in frame, a clear margin above the hair and at both sides.",
  // A flat grey ground, not a cleared one: Meshy's remove_background takes white hair and a white blouse with the
  // background (seen 2026-11-14), while a mid-grey ground is cut away cleanly when the mesh avatar is built.
  "Flat even light, no cast shadows, a plain flat mid-grey background with nothing on it, no text, no logos, no watermark.",
].join(" ");

/** the prompt for one image of a character, word for word as it's sent and kept */
export function characterPrompt(c: Pick<CharacterState, "form" | "identity">, role: "front" | "back" | "side" | "portrait"): string {
  const who = c.identity.trim();
  if (role === "front") return `Front view. ${who} ${c.form === "model" ? MODEL_RULES : MESH_RULES} ${ORIGINAL}`;
  if (role === "portrait") return `${PORTRAIT} ${who}`;
  return `${VIEW[role]} ${TURN} ${who} ${MODEL_RULES}`;
}

// ---------- reading and keeping a character ----------

const stateOf = (row: CharRow) => JSON.parse(row.state) as CharacterState;
const rowById = (id: string) => one<CharRow>("select * from characters where id = ?", id);
const rowByPanel = (boardId: string, panelId: string) => one<CharRow>("select * from characters where board_id = ? and panel_id = ?", boardId, panelId);

function mustRow(boardId: string, panelId: string): CharRow {
  const row = rowByPanel(boardId, panelId);
  if (!row) throw new HttpError(404, "no such character on this board");
  return row;
}

/** write a character's state: SQLite, then the board's map (so every browser on the board sees it) */
function keep(row: CharRow, c: CharacterState) {
  c.ready = c.form === "model" ? Boolean(c.files.clips) : Boolean(c.files.mavatar);
  run("update characters set state = ?, updated_at = ? where id = ?", JSON.stringify(c), Date.now(), row.id);
  editBoard(row.board_id, "characters", (doc) => {
    const m = boardMaps(doc);
    if (m.objects.has(row.panel_id)) m.characters.set(row.panel_id, c);
    else m.characters.delete(row.panel_id);
  });
}

/**
 * A character goes with its card. People can't write the `characters` map, so when a person took a
 * character's card off the board the map still held it: the server's roster dropped the character
 * (its card was gone), but no browser heard, and it stayed on every council and in every picker until
 * a reload (2026-11-16, Josh: "I attempted to delete Taro and couldn't"). The server follows the card
 * instead: gone, its character leaves the map; back, it returns from its row. Rows and files stay.
 */
function followCards(board: Board) {
  const m = boardMaps(board.doc);
  m.objects.observe((ev) => {
    const gone: string[] = [];
    const back: string[] = [];
    for (const [id, ch] of ev.changes.keys) {
      if (ch.action === "delete" && m.characters.has(id)) gone.push(id);
      else if (ch.action === "add" && !m.characters.has(id) && (m.objects.get(id) as PanelDoc | undefined)?.panel === "character") back.push(id);
    }
    if (!gone.length && !back.length) return;
    board.doc.transact(() => {
      for (const id of gone) m.characters.delete(id);
      for (const id of back) {
        const row = rowByPanel(board.id, id);
        if (row) m.characters.set(id, stateOf(row));
      }
    }, "characters");
  });
}
onBoardOpen(followCards);

const cardThere = (row: CharRow) => boardMaps(getBoard(row.board_id).doc).objects.has(row.panel_id);

export interface RosterEntry extends CharacterState {
  boardId: string;
  panelId: string;
}

/** every character whose card still stands, and who wears which (by agent name) */
export function roster(): { characters: RosterEntry[]; avatars: Record<string, string> } {
  const boards = new Set(listBoards().map((b) => b.id));
  const characters = all<CharRow>("select * from characters order by created_at")
    .filter((r) => boards.has(r.board_id) && cardThere(r))
    .map((r) => ({ ...stateOf(r), boardId: r.board_id, panelId: r.panel_id }));
  const live = new Set(characters.map((c) => c.id));
  const avatars: Record<string, string> = {};
  for (const a of all<{ name: string; character_id: string }>("select name, character_id from crew_avatars")) if (live.has(a.character_id)) avatars[a.name] = a.character_id;
  return { characters, avatars };
}

/** a character's file by role, for any signed-in person on any board: characters are the company's, like the crew's names */
export function characterFile(id: string, role: string): string {
  const row = rowById(id);
  const file = row && (stateOf(row).files as Record<string, string | undefined>)[role];
  if (!file) throw new HttpError(404, "that character has no such file");
  return file;
}

/** choose the character an agent name wears, everywhere (null: back to the steady pick) */
export function setAvatar(user: UserInfo, name: string, characterId: string | null) {
  const n = name.trim().slice(0, 60);
  if (!n) throw new HttpError(400, "whose avatar?");
  if (!characterId) {
    run("delete from crew_avatars where name = ?", n);
    return roster().avatars;
  }
  const row = rowById(characterId);
  if (!row || !stateOf(row).ready) throw new HttpError(400, "that character isn't ready to sit on the council yet");
  run("insert into crew_avatars (name, character_id, set_by, at) values (?, ?, ?, ?) on conflict(name) do update set character_id = excluded.character_id, set_by = excluded.set_by, at = excluded.at", n, characterId, user.id, Date.now());
  return roster().avatars;
}

let balanceAt = 0;
let balanceWas: number | null = null;
/** what the buttons say before they're pressed: whether Meshy is connected, what's left, what each stage costs */
export async function costs() {
  const configured = meshyConfigured();
  if (configured && Date.now() - balanceAt > 30_000) {
    balanceWas = await meshyBalance().catch(() => null);
    balanceAt = Date.now();
  }
  const of = (form: CharacterForm) => Object.fromEntries(CHARACTER_STAGES[form].map((s) => [s, stageCost(form, s)]));
  return { configured, balance: configured ? balanceWas : null, imageModel: imageModel(), costs: { model: of("model"), mesh: of("mesh") } };
}

// ---------- the studio board ----------

export const STUDIO_SETS = ["Anime", "Animals", "Abstract"] as const;
const inspirationName = (set: string) => `Inspiration · ${set}`;
const charactersName = (set: string) => `Characters · ${set}`;
const titled = (set: string) => set.trim().replace(/^./, (c) => c.toUpperCase());

function freeCell(doc: import("yjs").Doc): { c: number; r: number } {
  const m = boardMaps(doc);
  const tracks = m.grid.get("tracks") ?? { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] };
  const top = [...m.sections.values()].filter((s) => !s.parent);
  for (let r = 0; r < tracks.rows.length; r++)
    for (let c = 0; c < tracks.cols.length; c++) if (!top.some((s) => c >= s.c0 && c <= s.c1 && r >= s.r0 && r <= s.r1)) return { c, r };
  m.grid.set("tracks", { cols: tracks.cols, rows: [...tracks.rows, DEFAULT_ROW_H] });
  return { c: 0, r: tracks.rows.length };
}

function sectionNamed(doc: import("yjs").Doc, name: string): SectionDoc {
  const m = boardMaps(doc);
  const found = [...m.sections.values()].find((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (found) return found;
  const at = freeCell(doc);
  const sec: SectionDoc = { id: uid("sec"), name, c0: at.c, r0: at.r, c1: at.c, r1: at.r };
  m.sections.set(sec.id, sec);
  return sec;
}

const HOW = `## Character studio

Characters for the council are made here, a stage at a time:

1. **Inspiration.** Drop images into an *Inspiration* section. They set a set's style, mood and palette.
2. **Sheet.** A character card draws its front view from the images you pick and the words you give it.
3. **Views.** The back and a side (for a 3D character), or a head-and-shoulders portrait (for a mesh avatar).
4. **Model, rig, clips.** A textured model, a skeleton, and a clip for each mood: idle, thinking, working, talking, happy, sad, surprised, waving.
5. **Mesh.** A portrait becomes a mesh avatar that blinks, talks and emotes (built with mesh-avatar-studio and brought in as a \`.mavatar\`).

Each stage is a press, and each button says what it costs before you press it. Look at what came back before paying for the next one. A finished character can sit on the council of any board.`;

/** the Character studio: one board, made once. Its sections are a row of inspiration and a row of characters, a column per set. */
export function openStudio(user: UserInfo): { id: string; made: boolean } {
  const known = new Set(listBoards().map((b) => b.id));
  const was = all<{ board_id: string }>("select board_id from character_boards order by made_at").find((b) => known.has(b.board_id));
  if (was) return { id: was.board_id, made: false };
  const id = createBoardRow("Character studio", { kind: "grid" });
  run("insert into character_boards (board_id, made_by, made_at) values (?, ?, ?)", id, user.id, Date.now());
  editBoard(id, "characters", (doc) => {
    const m = boardMaps(doc);
    m.grid.set("tracks", { cols: new Array(STUDIO_SETS.length).fill(DEFAULT_COL_W), rows: [DEFAULT_ROW_H, DEFAULT_ROW_H] });
    STUDIO_SETS.forEach((set, c) => {
      const insp: SectionDoc = { id: uid("sec"), name: inspirationName(set), c0: c, r0: 0, c1: c, r1: 0 };
      const chars: SectionDoc = { id: uid("sec"), name: charactersName(set), c0: c, r0: 1, c1: c, r1: 1 };
      m.sections.set(insp.id, insp);
      m.sections.set(chars.id, chars);
      if (c === 0) putNote(doc, { id: uid("note"), kind: "note", sectionId: insp.id, name: "How it works", x: 0, y: 0, float: false, bornAt: Date.now(), w: 460, h: 520, text: HOW });
    });
    logActivity(doc, { who: user.name, role: "human", text: "made the Character studio: inspiration and characters, a column for each set" });
  });
  // the board opens at once; the starter set walks on a moment later
  void seedStarter(id, user).catch((e: Error) => console.error(`  characters         the starter set didn't load: ${e.message}`));
  return { id, made: true };
}

// ---------- the starter set ----------

interface StarterCharacter {
  name: string;
  set: string;
  form: CharacterForm;
  identity: string;
  height: number;
  files: Partial<Record<keyof CharacterFiles, { file: string; mime: string }>>;
}

/**
 * Where the starter set is: characters made on Meshy once (2026-11-14) and kept with the code
 * (`apps/server/starter/characters`, written by scripts/characters-export.mjs), so an install has a
 * council to seat without spending anything. Beside the bundled server in the desktop app, beside
 * `src` from source. FOUNDATION_STARTER_DIR names another folder; empty turns it off.
 */
function starterDir(): string | null {
  const named = process.env.FOUNDATION_STARTER_DIR;
  const tries = named !== undefined ? [named] : [join(import.meta.dirname, "starter", "characters"), join(import.meta.dirname, "..", "starter", "characters")];
  return tries.find((d) => d && existsSync(join(d, "manifest.json"))) ?? null;
}

/**
 * Bring the starter set onto a newly made studio board: a card each, in its set's Characters section, its
 * pictures and its playable file in the archive, every stage marked done. Nothing is sent to Meshy. Meshy
 * never made these on this install, so a stage that builds on Meshy's copy (the skeleton, the moods)
 * can't be done again from here without making the model again.
 */
export async function seedStarter(boardId: string, user: UserInfo): Promise<number> {
  const dir = starterDir();
  if (!dir) return 0;
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { characters?: StarterCharacter[] };
  let n = 0;
  for (const s of manifest.characters ?? []) {
    const made = createCharacter(boardId, { name: "Foundation", id: user.id, human: false }, { name: s.name, set: s.set, form: s.form, identity: s.identity, height: s.height });
    const files: CharacterFiles = {};
    for (const [role, f] of Object.entries(s.files) as Array<[keyof CharacterFiles, { file: string; mime: string }]>) {
      // only a plain file name from the manifest's own folder
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(f.file)) continue;
      const body = await readFile(join(dir, f.file)).catch(() => null);
      if (!body) continue;
      const ext = /\.[a-z0-9]+$/i.exec(f.file)?.[0] ?? "";
      files[role] = (await storeFile(body, { name: role === "mavatar" ? `${s.name}.mavatar` : `${s.name} ${role === "front" ? "sheet" : role}${ext}`, mime: f.mime, boardId, userId: user.id, about: `the character ${s.name}, from Foundation's starter set` })).id;
    }
    const row = rowById(made.id);
    if (!row) continue;
    const c = stateOf(row);
    c.files = files;
    for (const stage of CHARACTER_STAGES[c.form]) c.stages[stage] = { state: "done", by: "the starter set" };
    keep(row, c);
    n++;
  }
  if (n) editBoard(boardId, "characters", (doc) => logActivity(doc, { who: "Foundation", role: "system", text: `brought in the starter set: ${n} characters, ready for the council` }));
  return n;
}

/** an image for a set's Inspiration section: into the archive, and onto the board as a picture */
export async function addInspiration(boardId: string, set: string, body: Buffer, f: { name: string; mime: string }, user: UserInfo): Promise<{ id: string; file: string }> {
  if (!/^image\/(png|jpeg|webp)$/.test(f.mime)) throw new HttpError(400, "inspiration is a PNG, JPEG or WebP image");
  const size = imageSize(body);
  if (!size) throw new HttpError(400, "that image couldn't be read");
  const file = await storeFile(body, { name: f.name, mime: f.mime, boardId, userId: user.id, about: `inspiration for the ${titled(set)} characters` });
  const id = uid("media");
  editBoard(boardId, "characters", (doc) => {
    const sec = sectionNamed(doc, inspirationName(titled(set)));
    const w = 300;
    const card: MediaDoc = { id, kind: "media", sectionId: sec.id, name: f.name, x: 0, y: 0, float: false, bornAt: Date.now(), w, h: Math.round((w * size.h) / size.w), src: `/files/${file.id}`, media: "image", autoplay: false, muted: true, createdBy: user.name };
    boardMaps(doc).objects.set(id, card);
  });
  return { id, file: file.id };
}

export interface NewCharacter {
  name?: string;
  set?: string;
  form?: CharacterForm;
  identity?: string;
  refs?: string[];
  height?: number;
  /** the section to put the card in (a name or an id); otherwise the set's Characters section */
  section?: string;
}

const HEIGHT = (h: unknown, form: CharacterForm) => (typeof h === "number" && h > 0.1 && h < 4 ? Math.round(h * 100) / 100 : form === "mesh" ? 1.6 : 1);

function cleanRefs(boardId: string, refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const ok = refs.filter((r): r is string => typeof r === "string").filter((r) => Boolean(one("select 1 from files where id = ? and board_id is ? and archived_at is null and mime like 'image/%'", r, boardId)));
  return [...new Set(ok)].slice(0, 5);
}

/** add a character's card to a board. Spends nothing, so an agent may do it; the stages wait for a person. */
export function createCharacter(boardId: string, actor: { name: string; id: string; human: boolean }, n: NewCharacter): RosterEntry {
  const form: CharacterForm = n.form === "mesh" ? "mesh" : "model";
  const set = titled((n.set ?? "").slice(0, 40)) || "Abstract";
  const name = (n.name ?? "").trim().slice(0, 60) || "New character";
  const c: CharacterState = {
    id: uid("chr"),
    name,
    set: set.toLowerCase(),
    form,
    identity: (n.identity ?? "").trim().slice(0, 1200),
    refs: cleanRefs(boardId, n.refs),
    stages: {},
    files: {},
    height: HEIGHT(n.height, form),
    ready: false,
  };
  const panelId = uid("pnl");
  editBoard(boardId, "characters", (doc) => {
    const m = boardMaps(doc);
    const sec = (n.section && ([...m.sections.values()].find((s) => s.id === n.section || s.name.trim().toLowerCase() === n.section!.trim().toLowerCase()))) || sectionNamed(doc, charactersName(set));
    const panel: PanelDoc = { id: panelId, kind: "panel", panel: "character", sectionId: sec.id, name, x: 0, y: 0, float: false, bornAt: Date.now(), w: 460, h: 620, ports: [], createdBy: actor.name };
    m.objects.set(panelId, panel);
    m.characters.set(panelId, c);
    logActivity(doc, { who: actor.name, role: actor.human ? "human" : "agent", text: `added a character, “${name}” (${form === "model" ? "3D" : "mesh avatar"}, ${set})`, objectId: panelId });
  });
  run("insert into characters (id, board_id, panel_id, state, created_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)", c.id, boardId, panelId, JSON.stringify(c), actor.id, Date.now(), Date.now());
  return { ...c, boardId, panelId };
}

/** change a character's words: its name, what it is, what it's drawn from, how tall. Stages already made stay as they are. */
export function editCharacter(boardId: string, panelId: string, patch: Partial<Pick<NewCharacter, "name" | "identity" | "refs" | "height">>): CharacterState {
  const row = mustRow(boardId, panelId);
  const c = stateOf(row);
  if (typeof patch.name === "string" && patch.name.trim()) c.name = patch.name.trim().slice(0, 60);
  if (typeof patch.identity === "string") c.identity = patch.identity.trim().slice(0, 1200);
  if (patch.refs) c.refs = cleanRefs(boardId, patch.refs);
  if (patch.height !== undefined) c.height = HEIGHT(patch.height, c.form);
  keep(row, c);
  editBoard(boardId, "characters", (doc) => {
    const m = boardMaps(doc);
    const card = m.objects.get(panelId);
    if (card && card.name !== c.name) m.objects.set(panelId, { ...card, name: c.name });
  });
  return c;
}

// ---------- running a stage ----------

const tasksOf = (characterId: string, stage: CharacterStageKey) => all<TaskRow>("select * from character_tasks where character_id = ? and stage = ? order by started_at", characterId, stage);
const lastDone = (characterId: string, role: Role) => one<TaskRow>("select * from character_tasks where character_id = ? and role = ? and status = 'done' order by finished_at desc limit 1", characterId, role);

async function fileBytes(fileId: string): Promise<{ row: FileRow; body: Buffer }> {
  const row = one<FileRow>("select * from files where id = ?", fileId);
  if (!row) throw new HttpError(400, "an image this stage is drawn from is gone");
  return { row, body: await readFile(join(config.dataDir, "files", row.sha256)) };
}

interface Plan {
  role: Role;
  endpoint: TaskRow["endpoint"];
  model?: string;
  prompt?: string;
  /** archive files sent inline, in order */
  images?: string[];
  request: (images: string[]) => Record<string, unknown>;
}

/** what a stage sends: one task per result */
function plan(c: CharacterState, stage: CharacterStageKey): Plan[] {
  const image = (role: "front" | "back" | "side" | "portrait", refs: string[], extra: Record<string, unknown> = {}): Plan => {
    const prompt = characterPrompt(c, role);
    return {
      role,
      endpoint: refs.length ? "image-to-image" : "text-to-image",
      model: imageModel(),
      prompt,
      images: refs,
      request: (uris) => ({ ai_model: imageModel(), prompt, aspect_ratio: "3:4", ...(uris.length ? { reference_image_urls: uris } : {}), ...extra }),
    };
  };
  switch (stage) {
    case "sheet":
      if (!c.identity.trim()) throw new HttpError(400, "Say what the character is first: a line or two of who it is and what it wears");
      return [image("front", c.refs)];
    case "views": {
      if (!c.files.front) throw new HttpError(400, "Draw the sheet first");
      // a turnaround is drawn from the accepted front (and the first inspiration image, for its surface)
      const refs = [c.files.front, ...c.refs.slice(0, 1)];
      return c.form === "model" ? [image("back", refs), image("side", refs)] : [image("portrait", [c.files.front])];
    }
    case "model": {
      if (!c.files.front) throw new HttpError(400, "Draw the sheet first");
      const views = [c.files.front, c.files.back, c.files.side].filter((f): f is string => Boolean(f));
      return [
        {
          role: "model",
          endpoint: "multi-image-to-3d",
          model: "meshy-7.1",
          images: views,
          // WildChild's v8 request. No pose_mode: the sheet is already in an A-pose, and Meshy's own
          // pose conversion stretched stylised bodies into human proportions there.
          request: (uris) => ({ ai_model: "meshy-7.1", should_remesh: true, topology: "triangle", target_polycount: 30000, should_texture: true, enable_pbr: false, texture_resolution: "2k", image_enhancement: false, remove_lighting: true, target_formats: ["glb"], image_urls: uris }),
        },
      ];
    }
    case "rig": {
      const model = lastDone(c.id, "model");
      if (!c.files.model || !model?.task_id) throw new HttpError(400, "Make the model first");
      return [{ role: "rig", endpoint: "rigging", request: () => ({ input_task_id: model.task_id, height_meters: c.height }) }];
    }
    case "clips": {
      const rig = lastDone(c.id, "rig");
      if (!rig?.task_id) throw new HttpError(400, "Fit the skeleton first");
      // one file, one clip per mood, in MOODS' order (a seat finds a mood's clip by that order)
      return [{ role: "clips", endpoint: "animations", request: () => ({ rig_task_id: rig.task_id, action_ids: MOODS.map((m) => MOOD_CLIPS[m].actionId) }) }];
    }
    case "mesh":
      throw new HttpError(400, "A mesh avatar is built with mesh-avatar-studio and brought in as a .mavatar file");
  }
}

const pollMs = () => Number(process.env.FOUNDATION_MESHY_POLL_MS ?? 5000);
const watching = new Set<string>();

/**
 * Start a stage: a person pressed its button. Writes each request down, sends
 * it, and follows it until it settles. Doing a stage again clears the ones
 * after it (their files stay in the archive).
 */
export async function startStage(boardId: string, panelId: string, stage: CharacterStageKey, user: UserInfo, opts: { confirm?: boolean } = {}): Promise<CharacterState> {
  const row = mustRow(boardId, panelId);
  const c = stateOf(row);
  const order = CHARACTER_STAGES[c.form];
  if (!order.includes(stage)) throw new HttpError(400, `a ${c.form === "model" ? "3D character" : "mesh avatar"} has no ${stage} stage`);
  if (!meshyConfigured()) throw new HttpError(503, "Meshy isn't connected: set MESHY_API_KEY in Foundation's .env");
  const running = order.find((s) => c.stages[s]?.state === "running");
  if (running) throw new HttpError(409, `“${c.name}” is still on its ${running} stage`);
  // a request that was written down and sent, with no answer kept: it may have been charged
  const unknown = tasksOf(c.id, stage).some((t) => t.status === "submitting");
  if (unknown && !opts.confirm) throw new HttpError(409, "The last try at this stage was sent but its answer never arrived, so it may have been charged. Check Meshy, then press again to send it anyway.");
  if (unknown) run("update character_tasks set status = 'failed', error = 'sent, never answered', finished_at = ? where character_id = ? and stage = ? and status = 'submitting'", Date.now(), c.id, stage);

  const plans = plan(c, stage);
  // one time for the press and its tasks: settle() counts the tasks started at or after it
  const pressedAt = Date.now();
  const sends: Array<{ id: string; p: Plan; request: Record<string, unknown> }> = [];
  for (const p of plans) {
    const files = await Promise.all((p.images ?? []).map(fileBytes));
    const request = p.request(files.map((f) => dataUri(f.row.mime, f.body)));
    const id = uid("ctk");
    // what's kept is the request without the images' bytes: their hashes say which they were
    const kept = p.request(files.map((f) => `sha256:${f.row.sha256}`));
    run(
      "insert into character_tasks (id, character_id, stage, role, endpoint, model, prompt, request, ref_hashes, by_user, by_name, started_at, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting')",
      id, c.id, stage, p.role, p.endpoint, p.model ?? null, p.prompt ?? null, JSON.stringify(kept), JSON.stringify(files.map((f) => f.row.sha256)), user.id, user.name, pressedAt,
    );
    sends.push({ id, p, request });
  }

  // the stages after this one are about what it's replacing
  for (const s of order.slice(order.indexOf(stage) + 1)) delete c.stages[s];
  const after: Record<CharacterStageKey, Array<keyof CharacterFiles>> = { sheet: ["back", "side", "portrait", "model", "clips", "mavatar", "thumb"], views: ["model", "clips", "mavatar"], model: ["clips"], rig: ["clips"], clips: [], mesh: [] };
  for (const f of after[stage]) delete c.files[f];
  c.stages[stage] = { state: "running", progress: 0, by: user.name, at: pressedAt };
  keep(row, c);
  editBoard(boardId, "characters", (doc) => logActivity(doc, { who: user.name, role: "human", text: `started “${c.name}”’s ${stage} (${stageCost(c.form, stage)} credits)`, objectId: panelId }));

  for (const s of sends) {
    try {
      const taskId = await meshyCreate(s.p.endpoint, s.request);
      run("update character_tasks set task_id = ?, status = 'running' where id = ?", taskId, s.id);
      void follow(s.id);
    } catch (e) {
      // Meshy said no (nothing was charged): the task failed. No answer at all: it stays 'submitting', the outcome unknown.
      const refused = e instanceof MeshyError && e.status !== 502;
      if (refused) run("update character_tasks set status = 'failed', error = ?, finished_at = ? where id = ?", (e as Error).message, Date.now(), s.id);
      else run("update character_tasks set error = ? where id = ?", (e as Error).message, s.id);
    }
  }
  balanceAt = 0;
  return settle(row.id, stage);
}

/** fold a stage's tasks into the character's state; called whenever one of them changes */
function settle(characterId: string, stage: CharacterStageKey): CharacterState {
  const row = rowById(characterId)!;
  const c = stateOf(row);
  const was = c.stages[stage];
  if (!was) return c;
  // only the tasks of this press: the ones started at or after it
  const tasks = tasksOf(characterId, stage).filter((t) => t.started_at >= (was.at ?? 0));
  const live = tasks.filter((t) => t.status === "running");
  const bad = tasks.filter((t) => t.status === "failed" || (t.status === "submitting" && t.error));
  const credits = tasks.reduce((n, t) => n + t.credits, 0);
  if (live.length) c.stages[stage] = { ...was, state: "running", progress: Math.min(...live.map((t) => t.progress)), credits };
  else if (bad.length) c.stages[stage] = { ...was, state: "failed", error: bad[0].error ?? "it failed", credits, progress: undefined };
  else if (tasks.length && tasks.every((t) => t.status === "done")) c.stages[stage] = { ...was, state: "done", credits, progress: undefined, error: undefined };
  for (const k of Object.keys(c.stages[stage]!) as Array<keyof NonNullable<typeof was>>) if (c.stages[stage]![k] === undefined) delete c.stages[stage]![k];
  keep(row, c);
  return c;
}

const MIME: Record<string, string> = { glb: "model/gltf-binary", png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** bring a finished task's result into the archive and onto the character */
async function land(t: TaskRow, task: MeshyTask) {
  const row = rowById(t.character_id)!;
  const c = stateOf(row);
  const bring = async (url: string | undefined, label: string): Promise<string | undefined> => {
    if (!url) return undefined;
    const { body, ext } = await meshyDownload(url);
    const lineage = t.prompt ? `${t.model ?? "meshy"} · ${t.prompt}` : `${t.endpoint} for the character ${c.name}`;
    const file = await storeFile(body, { name: `${c.name} ${label}.${ext}`, mime: MIME[ext], boardId: row.board_id, userId: t.by_user ?? "", about: lineage.slice(0, 2000) });
    return file.id;
  };
  let fileId: string | undefined;
  if (t.role === "front" || t.role === "back" || t.role === "side" || t.role === "portrait") {
    fileId = await bring(task.image_urls?.[0], t.role === "front" ? "sheet" : t.role);
    if (!fileId) throw new Error("Meshy finished the image but gave none");
    // read the state again: another view of the same stage may have landed while this downloaded
    const now = stateOf(rowById(t.character_id)!);
    now.files[t.role] = fileId;
    if (t.role === "front" || t.role === "portrait") now.files.thumb = fileId;
    keep(row, now);
  } else if (t.role === "model") {
    fileId = await bring(task.model_urls?.glb, "model");
    if (!fileId) throw new Error("Meshy finished the model but gave no GLB");
    const thumb = await bring(task.thumbnail_url, "model preview").catch(() => undefined);
    const now = stateOf(rowById(t.character_id)!);
    now.files.model = fileId;
    if (thumb) now.files.thumb = thumb;
    keep(row, now);
  } else if (t.role === "clips") {
    fileId = await bring(task.result?.animation_glb_url, "clips");
    if (!fileId) throw new Error("Meshy finished the clips but gave no GLB");
    const now = stateOf(rowById(t.character_id)!);
    now.files.clips = fileId;
    keep(row, now);
  }
  run("update character_tasks set status = 'done', progress = 100, credits = ?, finished_at = ?, file_id = ? where id = ?", task.consumed_credits ?? 0, Date.now(), fileId ?? null, t.id);
}

/** ask after a task until it settles */
async function follow(taskRowId: string) {
  if (watching.has(taskRowId)) return;
  watching.add(taskRowId);
  try {
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs()));
      const t = one<TaskRow>("select * from character_tasks where id = ?", taskRowId);
      if (!t || t.status !== "running" || !t.task_id) return;
      let task: MeshyTask;
      try {
        task = await meshyTask(t.endpoint, t.task_id);
        misses = 0;
      } catch (e) {
        // Meshy unreachable for a while is not the task failing; a task Meshy no longer knows is
        if (e instanceof MeshyError && e.status === 404) {
          run("update character_tasks set status = 'failed', error = ?, finished_at = ? where id = ?", "Meshy no longer has this task", Date.now(), t.id);
          settle(t.character_id, t.stage);
          return;
        }
        if (++misses > 60) return;
        continue;
      }
      if (task.status === "SUCCEEDED") {
        try {
          await land(t, task);
        } catch (e) {
          run("update character_tasks set status = 'failed', error = ?, credits = ?, finished_at = ? where id = ?", (e as Error).message, task.consumed_credits ?? 0, Date.now(), t.id);
        }
        settle(t.character_id, t.stage);
        const c = stateOf(rowById(t.character_id)!);
        if (c.stages[t.stage]?.state === "done") {
          const row = rowById(t.character_id)!;
          editBoard(row.board_id, "characters", (doc) => logActivity(doc, { who: "Meshy", role: "agent", text: `finished “${c.name}”’s ${t.stage}${c.ready && t.stage === "clips" ? ": ready for the council" : ""}`, objectId: row.panel_id }));
        }
        balanceAt = 0;
        return;
      }
      if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "EXPIRED") {
        run("update character_tasks set status = 'failed', error = ?, finished_at = ? where id = ?", task.task_error?.message || `Meshy ${task.status.toLowerCase()} it`, Date.now(), t.id);
        settle(t.character_id, t.stage);
        return;
      }
      const progress = Math.max(0, Math.min(99, Math.round(task.progress ?? 0)));
      if (progress !== t.progress) {
        run("update character_tasks set progress = ? where id = ?", progress, t.id);
        settle(t.character_id, t.stage);
      }
    }
  } finally {
    watching.delete(taskRowId);
  }
}

/** at boot: pick up the tasks that were running when the server last stopped */
export function resumeCharacters() {
  // a request that was written down but never answered because the server stopped mid-send: its outcome is
  // unknown, so the stage says so (and won't send again until a person confirms), instead of running forever
  for (const t of all<TaskRow>("select * from character_tasks where status = 'submitting' and error is null")) {
    run("update character_tasks set error = ? where id = ?", "Meshy didn't answer before Foundation's server stopped", t.id);
    if (rowById(t.character_id)) settle(t.character_id, t.stage);
  }
  if (!meshyConfigured()) return;
  for (const t of all<TaskRow>("select * from character_tasks where status = 'running'")) void follow(t.id);
}

/** the mesh stage: a .mavatar someone built with mesh-avatar-studio becomes the character's avatar */
export async function attachMavatar(boardId: string, panelId: string, body: Buffer, user: UserInfo): Promise<CharacterState> {
  const row = mustRow(boardId, panelId);
  const c = stateOf(row);
  if (c.form !== "mesh") throw new HttpError(400, "only a mesh avatar takes a .mavatar");
  // a .mavatar is a zip archive (mesh-avatar docs/format.md)
  if (body.length < 4 || body.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, "that isn't a .mavatar file");
  if (body.length > 128 * 1024 * 1024) throw new HttpError(413, "a .mavatar is at most 128 MiB");
  const file = await storeFile(body, { name: `${c.name}.mavatar`, mime: "application/zip", boardId, userId: user.id, about: `mesh avatar of the character ${c.name}` });
  c.files.mavatar = file.id;
  c.stages.mesh = { state: "done", by: user.name, at: Date.now() };
  keep(row, c);
  editBoard(boardId, "characters", (doc) => logActivity(doc, { who: user.name, role: "human", text: `brought in “${c.name}”’s mesh avatar: ready for the council`, objectId: panelId }));
  return c;
}

/** a character's lineage: every request made for it, word for word (never the images' bytes, only their hashes) */
export function characterTasks(boardId: string, panelId: string) {
  const row = mustRow(boardId, panelId);
  return all<TaskRow>("select * from character_tasks where character_id = ? order by started_at", row.id).map((t) => ({
    id: t.id, stage: t.stage, role: t.role, endpoint: t.endpoint, model: t.model, prompt: t.prompt, refHashes: JSON.parse(t.ref_hashes) as string[], by: t.by_name, at: t.started_at, status: t.status, credits: t.credits, error: t.error, fileId: t.file_id,
  }));
}
