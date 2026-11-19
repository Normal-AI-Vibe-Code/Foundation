/**
 * Foundation's avatars (protocol avatars.ts): the uploader card, what is wired into it, and the upload.
 *
 * On the Character studio it stands in a section of its own on the left, *Foundation avatars*, hosted (so its
 * wires land on the section's edge), with a wire in from each `Characters · <Set>` section when it's laid.
 * The server follows the board: whenever a wire, a card or a character changes, each uploader works out what
 * is wired into it now (a character card, every character card in a wired section, a collection's
 * characters, an Output node's finished characters). A wire taken off archives the avatars only it brought;
 * one put back approves the ones it archived. The first reading after the uploader is laid changes nobody's
 * approval: that's where it starts from.
 *
 * An upload copies the avatars into main's starter set (`apps/server/starter/characters`) in a worktree of
 * `origin/main`, commits it if it changed, and pushes. Only a server started from a checkout of the repo can
 * (the desktop's bundled server says so on the card), and only a person presses Upload now or sets a timer.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  avatarKey,
  boardMaps,
  CHARACTER_TYPE,
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  logActivity,
  SECTION_PORT,
  uid,
  UPLOAD_EVERY,
  UPLOADER_IN,
  type CharacterState,
  type LinkDoc,
  type PanelDoc,
  type SectionDoc,
  type UploaderEntry,
  type UploaderState,
  type UploadResult,
} from "@foundation/protocol";
import type * as Y from "yjs";
import { config } from "./config.ts";
import { all, db, one, run } from "./db.ts";
import { editBoard, getBoard, listBoards, onBoardOpen, type Board } from "./boards.ts";
import { characterById, giveCharactersAPort, readStarter, setApprovalOf, starterDir, studioLayers, upgradeStudio, type StarterCharacter } from "./characters.ts";
import { fileBytesSync } from "./files.ts";
import { HttpError, readJson, type Router } from "./http.ts";
import { requirePerson } from "./auth.ts";
import { requireWriter } from "./roles.ts";

const ORIGIN = "avatars";
const execFileP = promisify(execFile);

db.exec(`
create table if not exists avatar_timers (panel_id text primary key, board_id text not null, every integer not null, next_at integer not null, by_id text, by_name text);
`);

/** the section on the studio's left, and the uploader's size in it */
export const AVATARS_SECTION = "Foundation avatars";
const UPLOADER_COL_W = 1040;
const UPLOADER_W = 960;
const UPLOADER_H = 1100;
/** where the starter set is in the repo */
const STARTER_REL = "apps/server/starter/characters";
/** the files of a character the starter set carries, in the export script's order */
const ROLES = ["front", "expressions", "back", "side", "portrait", "thumb", "clips", "mavatar"] as const;

const titled = (set: string) => set.trim().replace(/^./, (c) => c.toUpperCase());

// ---------- the uploader on the studio ----------

/**
 * Lay Foundation's avatars on a studio that hasn't got it: a column on the left (every section moves one
 * to the right), a section there hosting the uploader, beside the characters' row, and a wire from each
 * set's Characters section into it. Returns the activity's line, or null when there was nothing to do.
 */
export function layUploader(doc: Y.Doc): string | null {
  const m = boardMaps(doc);
  if ([...m.objects.values()].some((o) => o.kind === "panel" && o.panel === "uploader")) return null;
  const tops = [...m.sections.values()].filter((s) => !s.parent);
  if (!tops.length) return null;
  const chars = tops.filter((s) => /^characters\s*·/i.test(s.name)).sort((a, b) => a.c0 - b.c0);
  const tracks = m.grid.get("tracks") ?? { cols: [DEFAULT_COL_W], rows: [DEFAULT_ROW_H] };
  m.grid.set("tracks", { cols: [UPLOADER_COL_W, ...tracks.cols], rows: tracks.rows });
  for (const s of tops) m.sections.set(s.id, { ...s, c0: s.c0 + 1, c1: s.c1 + 1 });
  const row = chars.length ? Math.min(...chars.map((s) => s.r0)) : tracks.rows.length - 1;
  const id = uid("pnl");
  const port = { id: uid("port"), name: UPLOADER_IN, dir: "in" as const, type: CHARACTER_TYPE };
  const sec: SectionDoc = { id: uid("sec"), name: AVATARS_SECTION, c0: 0, c1: 0, r0: row, r1: row, host: id };
  const card: PanelDoc = { id, kind: "panel", panel: "uploader", sectionId: sec.id, name: "Foundation's avatars", x: 0, y: 0, float: false, bornAt: Date.now(), w: UPLOADER_W, h: UPLOADER_H, ports: [port], createdBy: "Foundation" };
  m.sections.set(sec.id, sec);
  m.objects.set(id, card);
  for (const s of chars) {
    const link: LinkDoc = { id: uid("lnk"), from: { panel: s.id, port: SECTION_PORT }, to: { panel: id, port: port.id }, label: s.name.replace(/^characters\s*·\s*/i, ""), createdBy: "Foundation" };
    m.links.set(link.id, link);
  }
  return `added ${AVATARS_SECTION} on the left: what's wired into it is an avatar on every Foundation${chars.length ? `, and ${chars.map((s) => s.name).join(", ")} are wired in` : ""}`;
}
studioLayers.push(layUploader);

// ---------- what is wired in ----------

interface Wired {
  panel?: string;
  via: string;
}

/** the sections inside a section, and it */
function familyOf(doc: Y.Doc, id: string): Set<string> {
  const m = boardMaps(doc);
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of m.sections.values())
      if (s.parent && out.has(s.parent) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
  }
  return out;
}

/** the characters wired into an uploader now: an original's id → its card here and what brought it */
export function wiredInto(doc: Y.Doc, uploaderId: string): Map<string, Wired> {
  const m = boardMaps(doc);
  const out = new Map<string, Wired>();
  const add = (id: string | undefined, panel: string | undefined, via: string) => {
    if (id && !out.has(id)) out.set(id, { panel, via });
  };
  const original = (panelId: string) => {
    const c = m.characters.get(panelId);
    return c ? (c.copyOf ?? c.id) : undefined;
  };
  for (const l of m.links.values()) {
    if (l.to.panel !== uploaderId) continue;
    const sec = m.sections.get(l.from.panel);
    if (sec) {
      const family = familyOf(doc, sec.id);
      const cards = [...m.objects.values()].filter((o): o is PanelDoc => o.kind === "panel" && o.panel === "character" && family.has(o.sectionId));
      // in the order the section shows them: docked cards by when they were placed
      cards.sort((a, b) => (a.bornAt ?? 0) - (b.bornAt ?? 0));
      for (const o of cards) add(original(o.id), o.id, sec.name);
      continue;
    }
    const o = m.objects.get(l.from.panel);
    if (!o || o.kind !== "panel") continue;
    if (o.panel === "character") add(original(o.id), o.id, "its card");
    else if (o.panel === "collection") {
      for (const it of m.collections.get(o.id)?.items ?? []) if (it.kind === "character" && it.character) add(characterById(it.character)?.copyOf ?? it.character, it.panel, o.name);
    } else if (o.panel === "pipeline" && o.node === "output" && o.source) {
      for (const [pid, c] of m.characters.entries()) if (c.set === o.source.toLowerCase() && c.ready && !c.copyOf) add(c.id, pid, `Output · ${titled(o.source)}`);
    }
  }
  return out;
}

function entryOf(c: CharacterState, w: Wired): UploaderEntry {
  const approval = c.approval ?? "approved";
  const avatar = c.ready && approval === "approved";
  return {
    id: c.id,
    name: c.name,
    set: c.set,
    form: c.form,
    panel: w.panel,
    key: avatarKey(c),
    state: avatar ? "avatar" : "waiting",
    why: avatar ? undefined : !c.ready ? "not finished yet" : approval === "pending" ? "waiting for a person to approve it" : "archived: approve it to make it an avatar",
    via: w.via,
  };
}

/** every character this install has, by its key (an original, the newest where two share one), for what main has that isn't wired */
function characterKeys(): Map<string, { id: string; name: string; set: string; form: string }> {
  const out = new Map<string, { id: string; name: string; set: string; form: string }>();
  for (const r of all<{ id: string; state: string }>("select id, state from characters order by created_at")) {
    const c = JSON.parse(r.state) as CharacterState;
    if (!c.copyOf) out.set(avatarKey(c), { id: c.id, name: c.name, set: c.set, form: c.form });
  }
  return out;
}

/** the server's own fields, never kept in the map: the characters an uploader archived when their wire came off */
type Kept = UploaderState & { withdrawn?: string[] };

/**
 * Bring every uploader on a board up to date with its wires. A character whose wire came off (and that was
 * an avatar) is archived; one wired back that the uploader archived is approved again. Approvals are written
 * after the board's edit, and the change they make brings this round again, which then finds nothing to do.
 */
export function reconcile(boardId: string): void {
  const approvals: Array<{ id: string; to: "approved" | "archived"; why: string }> = [];
  const inMain = new Set(mainKeys());
  editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    for (const card of [...m.objects.values()]) {
      if (card.kind !== "panel" || card.panel !== "uploader") continue;
      const was = m.uploaders.get(card.id) as Kept | undefined;
      const withdrawn = new Set(was?.withdrawn ?? []);
      const now = wiredInto(doc, card.id);
      const entries: UploaderEntry[] = [];
      for (const [id, w] of now) {
        const c = characterById(id);
        if (!c) continue;
        if (withdrawn.has(id)) {
          withdrawn.delete(id);
          if (c.ready && c.approval === "archived") {
            approvals.push({ id, to: "approved", why: `it was wired into ${AVATARS_SECTION} again` });
            c.approval = "approved";
          }
        }
        entries.push(entryOf(c, w));
      }
      if (was) {
        for (const e of was.entries) {
          if (now.has(e.id) || e.state !== "avatar") continue;
          approvals.push({ id: e.id, to: "archived", why: `its wire into ${AVATARS_SECTION} was taken off` });
          withdrawn.add(e.id);
        }
      }
      // what an upload would take out of main: everything main has that isn't an avatar here, shown before anyone presses
      const avatars = new Set(entries.filter((e) => e.state === "avatar").map((e) => e.key));
      const leaving = [...inMain].filter((k) => !avatars.has(k));
      if (leaving.length) {
        const known = characterKeys();
        for (const key of leaving) {
          const waiting = entries.find((e) => e.key === key);
          if (waiting) {
            waiting.why = `${waiting.why}; until then it leaves main at the next upload`;
            continue;
          }
          const c = known.get(key);
          const [form, set, name] = key.split(":");
          entries.push({ id: c?.id ?? key, name: c?.name ?? mainNames.get(key) ?? name, set: c?.set ?? set, form: (c?.form ?? form) as UploaderEntry["form"], key, state: "removed", why: c ? (now.has(c.id) ? "not an avatar here" : "in main, but not wired in here") : "in main, but not on this Foundation" });
        }
      }
      const repo = repoInfo();
      const next: Kept = { ...(was ?? {}), entries, inMain: [...inMain], withdrawn: [...withdrawn], cannot: repo.cannot, target: repo.target };
      if (!next.cannot) delete next.cannot;
      if (!next.target) delete next.target;
      if (JSON.stringify(next) !== JSON.stringify(was)) m.uploaders.set(card.id, next);
    }
  });
  for (const a of approvals) setApprovalOf(a.id, a.to, AVATARS_SECTION, a.why);
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
function reconcileSoon(boardId: string) {
  if (pending.has(boardId)) return;
  pending.set(
    boardId,
    setTimeout(() => {
      pending.delete(boardId);
      try {
        reconcile(boardId);
      } catch (e) {
        console.error(`  avatars            reading what's wired on ${boardId} failed: ${(e as Error).message}`);
      }
    }, 60),
  );
}

/** follow a board while it's open: give its character cards a port, and keep its uploaders up to date */
function follow(board: Board) {
  const m = boardMaps(board.doc);
  const has = () => [...m.objects.values()].some((o) => o.kind === "panel" && o.panel === "uploader");
  const on = (_e: unknown, tr: Y.Transaction) => {
    if (tr.origin === ORIGIN || !has()) return;
    reconcileSoon(board.id);
  };
  m.links.observe(on);
  m.objects.observe(on);
  m.characters.observe(on);
  m.sections.observe(on);
  m.collections.observe(on);
  setTimeout(() => {
    try {
      if ([...m.objects.values()].some((o) => o.kind === "panel" && o.panel === "character" && !o.ports.some((p) => p.dir === "out"))) editBoard(board.id, "characters", (doc) => giveCharactersAPort(doc));
    } catch {
      /* a board that closed meanwhile */
    }
  }, 0);
  if (has()) reconcileSoon(board.id);
}
onBoardOpen(follow);

/** stop following (tests, shutdown) */
export function stopAvatars() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function stateOf(boardId: string, panelId: string): Kept {
  const doc = getBoard(boardId).doc;
  const card = boardMaps(doc).objects.get(panelId);
  if (!card || card.kind !== "panel" || card.panel !== "uploader") throw new HttpError(404, `no uploader ${panelId} on this board`);
  return (boardMaps(doc).uploaders.get(panelId) as Kept | undefined) ?? { entries: [], inMain: mainKeys() };
}

function patch(boardId: string, panelId: string, p: Partial<Kept>) {
  editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    const was = (m.uploaders.get(panelId) as Kept | undefined) ?? { entries: [], inMain: mainKeys() };
    const next = { ...was, ...p } as Record<string, unknown>;
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    m.uploaders.set(panelId, next as unknown as UploaderState);
  });
}

// ---------- where an upload goes ----------

interface RepoInfo {
  dir?: string;
  branch: string;
  cannot?: string;
  target?: string;
}
let repoCache: RepoInfo | null = null;
let mainCache: string[] | null = null;

/** the checkout an upload is made from (the server's own, or FOUNDATION_AVATARS_REPO), and whether it can */
export function repoInfo(): RepoInfo {
  if (repoCache) return repoCache;
  const branch = (process.env.FOUNDATION_AVATARS_BRANCH ?? "main").trim() || "main";
  const named = process.env.FOUNDATION_AVATARS_REPO;
  if (named === "") return (repoCache = { branch, cannot: "Uploading is turned off on this server." });
  const dir = resolve(named ?? config.root);
  if (!existsSync(join(dir, ".git")) || !existsSync(join(dir, "apps/server"))) {
    return (repoCache = { branch, cannot: "Only a Foundation server started from a checkout of its code can upload. This one runs from its install: what main has arrives here when its server starts." });
  }
  let target = `origin · ${branch}`;
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: dir, encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    const gh = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
    target = `${gh ? gh[1] : url.replace(/^.*[\\/]/, "")} · ${branch}`;
  } catch {
    return (repoCache = { dir, branch, cannot: "This checkout has no remote called origin to upload to." });
  }
  return (repoCache = { dir, branch, target });
}

/** the keys main's starter set has: what origin's branch holds, as last fetched or uploaded; else this build's own set */
export function mainKeys(): string[] {
  if (mainCache) return mainCache;
  const repo = repoInfo();
  if (repo.dir && !repo.cannot) {
    try {
      const text = execFileSync("git", ["show", `origin/${repo.branch}:${STARTER_REL}/manifest.json`], { cwd: repo.dir, encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      return (mainCache = keysOf(JSON.parse(text) as { characters?: StarterCharacter[] }));
    } catch {
      /* no set on main yet: this build's */
    }
  }
  const dir = starterDir();
  return (mainCache = dir ? keysOf({ characters: readStarter(dir) }) : []);
}
/** main's characters' names as main spells them, by key (for one main has that this Foundation hasn't) */
const mainNames = new Map<string, string>();
const keysOf = (m: { characters?: StarterCharacter[] }) =>
  (m.characters ?? []).map((c) => {
    const key = avatarKey(c);
    mainNames.set(key, c.name);
    return key;
  });

/** forget what was read (tests, and after an upload) */
export function forgetRepo() {
  repoCache = null;
  mainCache = null;
}

// ---------- the upload ----------

type ManifestFile = { file: string; mime: string; source?: string };
type ManifestCharacter = Omit<StarterCharacter, "files"> & { files: Partial<Record<string, ManifestFile>> };

/**
 * Write the starter set for these characters into `out`, reusing what's there: a file whose source (the
 * archive's sha256) hasn't changed is kept as it is, so an upload that changes one character changes only
 * its files. A set written before sources were kept (2026-11-17 and earlier) is taken as it is for pictures
 * (they were re-encoded as JPEG) and compared byte for byte for the playable file.
 */
export function exportSet(ids: string[], out: string): { added: string[]; removed: string[]; kept: number } {
  const manifestPath = join(out, "manifest.json");
  const prev = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: number; madeAt?: string; characters?: ManifestCharacter[] }) : {};
  const prevBy = new Map((prev.characters ?? []).map((c) => [avatarKey(c), c]));
  const chars = ids.map((id) => characterById(id)).filter((c): c is CharacterState => Boolean(c?.ready));
  const wanted = new Map(chars.map((c) => [avatarKey(c), c]));
  // main's order first, then the new ones in the order they're wired
  const order = [...(prev.characters ?? []).map(avatarKey).filter((k) => wanted.has(k)), ...[...wanted.keys()].filter((k) => !prevBy.has(k))];
  const stage = mkdtempSync(join(tmpdir(), "foundation-avatars-set-"));
  try {
    const written = new Set<string>();
    const slugs = new Set<string>();
    const characters: ManifestCharacter[] = [];
    let kept = 0;
    for (const key of order) {
      const c = wanted.get(key)!;
      const before = prevBy.get(key);
      let slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
      if (slugs.has(slug)) slug = `${slug}-${c.form}`;
      slugs.add(slug);
      const files: Record<string, ManifestFile> = {};
      const bySha = new Map<string, ManifestFile>();
      for (const role of ROLES) {
        const id = (c.files as Record<string, string | undefined>)[role];
        if (!id) continue;
        const f = one<{ name: string; mime: string; sha256: string }>("select name, mime, sha256 from files where id = ?", id);
        if (!f) continue;
        if (bySha.has(f.sha256)) {
          files[role] = bySha.get(f.sha256)!;
          continue;
        }
        const old = before?.files[role];
        const oldPath = old && /^[a-z0-9][a-z0-9._-]*$/i.test(old.file) ? join(out, old.file) : null;
        const same = old && oldPath && existsSync(oldPath) && (old.source ? old.source === f.sha256 : role === "clips" || role === "mavatar" ? sha256(readFileSync(oldPath)) === f.sha256 : true);
        let entry: ManifestFile;
        if (same && old) {
          if (!written.has(old.file)) copyFileSync(oldPath!, join(stage, old.file));
          entry = { file: old.file, mime: old.mime, source: f.sha256 };
          kept++;
        } else {
          const bytes = fileBytesSync(id);
          if (!bytes) continue;
          const name = `${slug}-${role}${extname(f.name).toLowerCase() || ".bin"}`;
          writeFileSync(join(stage, name), bytes.body);
          entry = { file: name, mime: f.mime, source: f.sha256 };
        }
        written.add(entry.file);
        bySha.set(f.sha256, entry);
        files[role] = entry;
      }
      characters.push({ name: c.name, set: c.set, form: c.form, identity: c.identity, height: c.height, files });
    }
    // the day the set last changed: kept while it's the same characters
    const sameSet = order.length === (prev.characters ?? []).length && order.every((k) => prevBy.has(k));
    const madeAt = sameSet && prev.madeAt ? prev.madeAt : new Date().toISOString().slice(0, 10);
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify({ version: prev.version ?? 1, madeAt, characters }, null, 2)}\n`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const n of readdirSync(stage)) copyFileSync(join(stage, n), join(out, n));
    const name = (k: string) => (wanted.get(k) ?? prevBy.get(k))!.name;
    return { added: order.filter((k) => !prevBy.has(k)).map(name), removed: [...prevBy.keys()].filter((k) => !wanted.has(k)).map(name), kept };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const git = (args: string[], cwd: string) => execFileP("git", args, { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });

const list = (names: string[]) => (names.length <= 6 ? names.join(", ") : `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`);

/** one try: a worktree of origin's branch, the set written into it, a commit if it changed, a push */
async function pushOnce(repo: RepoInfo & { dir: string }, ids: string[], by: string, how: "manual" | "timer"): Promise<UploadResult> {
  await git(["fetch", "--quiet", "origin", repo.branch], repo.dir);
  const tmp = mkdtempSync(join(tmpdir(), "foundation-avatars-"));
  try {
    await git(["worktree", "add", "--quiet", "--detach", tmp, `origin/${repo.branch}`], repo.dir);
    const { added, removed } = exportSet(ids, join(tmp, STARTER_REL));
    await git(["add", "-A", STARTER_REL], tmp);
    const changed = await git(["diff", "--cached", "--quiet"], tmp).then(
      () => false,
      () => true,
    );
    const at = Date.now();
    if (!changed) return { at, outcome: "same", text: `Main already has these ${ids.length} avatars: nothing to upload.`, by, how };
    const files = (await git(["diff", "--cached", "--name-only"], tmp)).stdout.split("\n").filter(Boolean);
    const onlyManifest = files.every((f) => f.endsWith("/manifest.json"));
    const what = [added.length ? `+${list(added)}` : "", removed.length ? `−${list(removed)}` : ""].filter(Boolean).join(", ") || (onlyManifest ? "the manifest: where each file came from" : "new pictures or files");
    const message = [
      `Characters: Foundation's avatars from the Character studio (${what})`,
      "",
      `The ${ids.length} characters wired into ${AVATARS_SECTION}, uploaded to the starter set${how === "timer" ? " by a timer" : ""}.`,
      added.length ? `Added: ${added.join(", ")}.` : "",
      removed.length ? `Taken out (every Foundation archives them when its server next starts): ${removed.join(", ")}.` : "",
      `${how === "timer" ? "Timer set by" : "Uploaded by"} ${by}, from ${config.publicUrl}.`,
    ]
      .filter((l, i) => l || i === 1)
      .join("\n");
    await git(["commit", "--quiet", "-m", message], tmp);
    const commit = (await git(["rev-parse", "HEAD"], tmp)).stdout.trim();
    await git(["push", "--quiet", "origin", `HEAD:${repo.branch}`], tmp);
    return { at, outcome: "pushed", text: `Uploaded ${ids.length} avatars to ${repo.target ?? repo.branch}${added.length || removed.length ? ` (${what})` : ""}.`, commit, by, how, added, removed };
  } finally {
    await git(["worktree", "remove", "--force", tmp], repo.dir).catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
    await git(["worktree", "prune"], repo.dir).catch(() => undefined);
  }
}

const running = new Set<string>();

/**
 * Upload an uploader's avatars to main. Checks what it can at once (a server that can't upload, one under way,
 * an empty set: an upload of nothing would take every character away from every Foundation), then runs in
 * the background: the card follows it in the board's map. Returns the result when it's done.
 */
export function uploadAvatars(boardId: string, panelId: string, by: string, how: "manual" | "timer"): { started: Promise<UploadResult> } {
  stateOf(boardId, panelId);
  reconcile(boardId);
  const st = stateOf(boardId, panelId);
  const repo = repoInfo();
  if (repo.cannot || !repo.dir) throw new HttpError(409, repo.cannot ?? "This server can't upload.");
  if (running.has(panelId)) throw new HttpError(409, "An upload is already under way.");
  const ids = st.entries.filter((e) => e.state === "avatar").map((e) => e.id);
  if (!ids.length) throw new HttpError(409, "Nothing is wired in as an avatar. An upload of nothing would take every character away from every Foundation, so it isn't made.");
  running.add(panelId);
  patch(boardId, panelId, { running: true });
  const dir = repo.dir;
  const started = (async (): Promise<UploadResult> => {
    let result: UploadResult;
    try {
      try {
        result = await pushOnce({ ...repo, dir }, ids, by, how);
      } catch (e) {
        // main moved between the fetch and the push: once more, from the new main
        if (!/rejected|non-fast-forward|fetch first/i.test((e as Error).message)) throw e;
        result = await pushOnce({ ...repo, dir }, ids, by, how);
      }
      if (result.outcome !== "failed") mainCache = ids.map((id) => characterById(id)).filter((c): c is CharacterState => Boolean(c)).map(avatarKey);
    } catch (e) {
      const text = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
      result = { at: Date.now(), outcome: "failed", text: `The upload didn't go: ${text.slice(0, 300)}`, by, how };
    } finally {
      running.delete(panelId);
    }
    try {
      patch(boardId, panelId, { running: undefined, last: result });
      editBoard(boardId, ORIGIN, (doc) => logActivity(doc, { who: how === "timer" ? `${AVATARS_SECTION} (timer)` : by, role: how === "timer" ? "system" : "human", text: result.text, objectId: panelId }));
      reconcile(boardId);
    } catch (e) {
      console.error(`  avatars            after an upload: ${(e as Error).message}`);
    }
    return result;
  })();
  return { started };
}

// ---------- the timer ----------

/** set or turn off an uploader's timer; it first runs one interval from now */
export function setTimer(boardId: string, panelId: string, every: number, user: { id: string; name: string }): Kept {
  stateOf(boardId, panelId);
  if (!UPLOAD_EVERY.some((o) => o.ms === every)) throw new HttpError(400, `a timer is one of: ${UPLOAD_EVERY.map((o) => o.label).join(", ")}`);
  if (every > 0) {
    const repo = repoInfo();
    if (repo.cannot) throw new HttpError(409, repo.cannot);
    const nextAt = Date.now() + every;
    run("insert or replace into avatar_timers (panel_id, board_id, every, next_at, by_id, by_name) values (?, ?, ?, ?, ?, ?)", panelId, boardId, every, nextAt, user.id, user.name);
    patch(boardId, panelId, { every, everyBy: user.name, nextAt });
  } else {
    run("delete from avatar_timers where panel_id = ?", panelId);
    patch(boardId, panelId, { every: undefined, everyBy: undefined, nextAt: undefined });
  }
  const label = UPLOAD_EVERY.find((o) => o.ms === every)!.label.toLowerCase();
  editBoard(boardId, ORIGIN, (doc) => logActivity(doc, { who: user.name, role: "human", text: every ? `set ${AVATARS_SECTION} to upload ${label}` : `turned off ${AVATARS_SECTION}'s timer`, objectId: panelId }));
  return stateOf(boardId, panelId);
}

let ticker: ReturnType<typeof setInterval> | null = null;

/** run the timers that are due (each moves on by its interval first, so a slow upload never runs twice) */
export function tick(now = Date.now()): Array<Promise<UploadResult>> {
  const boards = new Set(listBoards().map((b) => b.id));
  const out: Array<Promise<UploadResult>> = [];
  for (const t of all<{ panel_id: string; board_id: string; every: number; next_at: number; by_name: string | null }>("select * from avatar_timers where next_at <= ?", now)) {
    const card = boards.has(t.board_id) ? boardMaps(getBoard(t.board_id).doc).objects.get(t.panel_id) : undefined;
    if (!card || card.kind !== "panel" || card.panel !== "uploader") {
      run("delete from avatar_timers where panel_id = ?", t.panel_id);
      continue;
    }
    const nextAt = now + t.every;
    run("update avatar_timers set next_at = ? where panel_id = ?", nextAt, t.panel_id);
    patch(t.board_id, t.panel_id, { nextAt });
    try {
      out.push(uploadAvatars(t.board_id, t.panel_id, t.by_name ?? "a person", "timer").started);
    } catch (e) {
      const text = (e as Error).message;
      patch(t.board_id, t.panel_id, { last: { at: now, outcome: "failed", text: `The timer's upload didn't go: ${text}`, by: t.by_name ?? "a person", how: "timer" } });
    }
  }
  return out;
}

/**
 * At boot: lay Foundation's avatars on every studio that hasn't got it (the studio's upgrade does), give
 * the timers their place on their cards, and start checking them once a minute.
 */
export function startAvatars() {
  const boards = new Set(listBoards().map((b) => b.id));
  for (const s of all<{ board_id: string }>("select board_id from character_boards")) {
    if (!boards.has(s.board_id)) continue;
    try {
      upgradeStudio(s.board_id);
      reconcile(s.board_id);
    } catch (e) {
      console.error(`  avatars            the studio ${s.board_id}: ${(e as Error).message}`);
    }
  }
  if (!ticker) {
    ticker = setInterval(() => {
      try {
        tick();
      } catch (e) {
        console.error(`  avatars            the timer: ${(e as Error).message}`);
      }
    }, 60_000);
    ticker.unref();
  }
}

// ---------- the routes ----------

export function avatarRoutes(r: Router) {
  /** upload now: a person's press (it pushes to main, which publishes a release) */
  r.post("/api/boards/:board/uploaders/:panel/upload", (req) => {
    const u = requirePerson(req, "Uploading Foundation's avatars");
    requireWriter(u, req.params.board);
    const { started } = uploadAvatars(req.params.board, req.params.panel, u.name, "manual");
    started.catch(() => undefined);
    return { running: true };
  });
  /** set the timer (ms; 0 turns it off): a person's, since each run can push to main */
  r.post("/api/boards/:board/uploaders/:panel/timer", async (req) => {
    const u = requirePerson(req, "Setting Foundation's avatars to upload on a timer");
    requireWriter(u, req.params.board);
    const b = await readJson<{ every?: number }>(req);
    return setTimer(req.params.board, req.params.panel, Number(b.every ?? 0), u);
  });
}
