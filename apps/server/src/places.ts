/**
 * Places: folders on the computer the server runs on that a person has
 * approved, so Foundation — people in the search pane, agents through tools —
 * can look in them and pull files out onto a board.
 *
 * Rules (tested in test/places.test.ts):
 *  - **Only an admin, as a person, approves or removes a place.** An agent's
 *    bearer can't: an agent may only read what a person already approved.
 *  - **Nothing outside an approved place is ever read.** Every path is
 *    resolved to its real location first (symlinks and junctions followed) and
 *    must still be inside the place; `..`, absolute paths and links that point
 *    out are refused.
 *  - **Read only.** Foundation never writes, renames or deletes in a place.
 *    Bringing a file copies its bytes into the archive (files.ts), where they
 *    are content-addressed and archived-never-deleted like any upload.
 *  - **Secrets stay put** even inside a place: dotfiles and folders, keys,
 *    certificates, credential stores and `node_modules` are neither listed nor
 *    readable.
 *  - Some folders can't be approved at all: a drive or the filesystem root, a
 *    home folder or anything above it, the system folders, and anything that
 *    holds or sits inside Foundation's own data.
 *  - Removing a place needs `confirm`, and only forgets the approval: the
 *    folder and its files are untouched, and what was already brought stays.
 */

import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { UserInfo } from "@foundation/protocol";
import { config } from "./config.ts";
import { all, db, one, run } from "./db.ts";
import { imageSize } from "./construct.ts";
import { storeFile, type FileRow } from "./files.ts";
import { HttpError } from "./http.ts";

db.exec(`
  create table if not exists places (
    id text primary key, name text not null, path text not null,
    approved_by text not null, approved_at integer not null, removed_at integer
  );
`);

export interface Place {
  id: string;
  name: string;
  path: string;
  approvedBy: string;
  approvedAt: number;
  /** false when the folder is gone or unreadable now (unplugged drive, renamed) */
  reachable: boolean;
}

export interface PlaceEntry {
  name: string;
  /** path inside the place, forward slashes */
  path: string;
  dir: boolean;
  size: number;
  modified: number;
}

/** the most a single file brought from a place may weigh (uploads allow the same) */
export const MAX_BRING = 512 * 1024 * 1024;
const MAX_LIST = 2000;

const win = process.platform === "win32";
const norm = (p: string) => (win ? p.toLowerCase() : p);
/** is `inner` the same folder as `outer`, or inside it */
function within(outer: string, inner: string) {
  const rel = relative(norm(outer), norm(inner));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** names that are never listed or read, wherever they are */
const SECRET = [
  /^\./, // dotfiles and dot-folders: .env, .git, .ssh, .aws, .npmrc …
  /^node_modules$/i,
  /\.(pem|key|pfx|p12|jks|keystore|kdbx|ppk|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /credential/i,
  /^secrets?(\.|$)/i,
  /^ntuser\./i,
  /^(desktop\.ini|thumbs\.db)$/i,
];
export const isSecretName = (name: string) => SECRET.some((r) => r.test(name));

function real(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

function requireAdminPerson(by: UserInfo, person: boolean, what: string) {
  if (!person) throw new HttpError(403, `${what} needs a person: an agent can read approved places, not change which are approved.`);
  if (by.role !== "admin") throw new HttpError(403, `Only an admin can ${what.toLowerCase()}: it decides what on this computer Foundation may read.`);
}

const row = (r: { id: string; name: string; path: string; approved_by: string; approved_at: number }): Place => ({
  id: r.id,
  name: r.name,
  path: r.path,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  reachable: real(r.path) !== null,
});

export function listPlaces(): Place[] {
  return all<{ id: string; name: string; path: string; approved_by: string; approved_at: number }>("select * from places where removed_at is null order by approved_at").map(row);
}

/** why this folder can't be approved, or null when it can */
export function refusal(path: string): string | null {
  const home = real(homedir()) ?? homedir();
  const data = real(config.dataDir) ?? config.dataDir;
  if (dirname(path) === path) return "A whole drive (or the filesystem root) can't be approved. Pick a folder inside it.";
  if (within(path, home)) return "Your home folder, or anything above it, can't be approved: it holds sign-ins and keys. Pick a folder inside it (Documents, a project).";
  if (within(path, data) || within(data, path)) return "That folder holds Foundation's own data (or sits inside it), so it can't be approved.";
  const system = win
    ? [process.env.SystemRoot, process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    : ["/etc", "/private/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/proc", "/sys", "/dev", "/var/db", "/var/root", "/root"];
  for (const s of system) if (s && (within(s, path) || within(path, s))) return "System and app-data folders can't be approved.";
  if (path.split(sep).some((part) => part && isSecretName(part) && !/^[a-z]:$/i.test(part))) return "That folder is hidden or holds keys, so it can't be approved.";
  return null;
}

/** approve a folder. `person` is requirePerson's verdict for this request (a browser or the desktop app, not an agent's bearer). */
export function approvePlace(by: UserInfo, person: boolean, input: { path?: string; name?: string }): Place {
  requireAdminPerson(by, person, "Approving a place");
  const asked = (input.path ?? "").trim().replace(/^"|"$/g, "");
  if (!asked || !isAbsolute(asked)) throw new HttpError(400, "Give the folder's full path, like C:\\Users\\you\\Documents\\Drawings or /Users/you/Drawings.");
  const path = real(resolve(asked));
  if (!path) throw new HttpError(404, `There's no folder at ${asked} on the computer Foundation's server runs on.`);
  if (!statSync(path).isDirectory()) throw new HttpError(400, "That's a file. Approve the folder it's in.");
  const no = refusal(path);
  if (no) throw new HttpError(400, no);
  const same = listPlaces().find((p) => norm(p.path) === norm(path));
  if (same) return same;
  const id = `pl_${randomBytes(6).toString("hex")}`;
  run("insert into places (id, name, path, approved_by, approved_at) values (?, ?, ?, ?, ?)", id, (input.name ?? "").trim().slice(0, 80) || basename(path), path, by.id, Date.now());
  return getPlace(id);
}

/** forget an approval (needs confirm). The folder and what was already brought are untouched. */
export function removePlace(by: UserInfo, person: boolean, id: string, confirm: unknown) {
  requireAdminPerson(by, person, "Removing a place");
  if (confirm !== true) throw new HttpError(400, "Removing a place needs confirm: true. It only forgets the approval; the folder isn't touched.");
  getPlace(id);
  run("update places set removed_at = ? where id = ?", Date.now(), id);
}

export function getPlace(id: string): Place {
  const r = one<{ id: string; name: string; path: string; approved_by: string; approved_at: number }>("select * from places where id = ? and removed_at is null", id);
  if (!r) throw new HttpError(404, "That place isn't approved (or was removed).");
  return row(r);
}

/**
 * The real location of `rel` inside a place, or a refusal. The one door every
 * read goes through: whatever `rel` says, the answer is inside the place.
 */
export function resolveInPlace(place: Place, rel = ""): string {
  const root = real(place.path);
  if (!root) throw new HttpError(404, `“${place.name}” isn't reachable right now (${place.path}). Was it moved, or is its drive unplugged?`);
  const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (isAbsolute(rel) || /^[a-z]:/i.test(clean) || clean.split("/").includes("..")) throw new HttpError(400, "That path leaves the place.");
  if (clean.split("/").some((part) => part && isSecretName(part))) throw new HttpError(403, "Hidden files, keys and credentials stay where they are, even inside an approved place.");
  const target = real(join(root, clean));
  if (!target) throw new HttpError(404, `Nothing at ${clean || "/"} in “${place.name}”.`);
  // a link or junction inside the place that points out of it
  if (!within(root, target)) throw new HttpError(403, "That's a link to somewhere outside the place, so it isn't followed.");
  // …or to something secret under another name
  if (relative(root, target).split(sep).some((part) => part && isSecretName(part))) throw new HttpError(403, "Hidden files, keys and credentials stay where they are, even inside an approved place.");
  return target;
}

/** what's in a folder of a place: folders first, then files, by name; secrets and links out left off */
export async function listPlace(id: string, dir = ""): Promise<{ place: Place; dir: string; entries: PlaceEntry[]; more: number }> {
  const place = getPlace(id);
  const at = resolveInPlace(place, dir);
  if (!(await stat(at)).isDirectory()) throw new HttpError(400, "That's a file, not a folder.");
  const root = real(place.path)!;
  const entries: PlaceEntry[] = [];
  for (const name of await readdir(at)) {
    if (isSecretName(name)) continue;
    const target = real(join(at, name));
    if (!target || !within(root, target)) continue;
    try {
      const s = await stat(target);
      if (!s.isDirectory() && !s.isFile()) continue;
      entries.push({ name, path: relative(root, join(at, name)).split(sep).join("/"), dir: s.isDirectory(), size: s.isFile() ? s.size : 0, modified: Math.round(s.mtimeMs) });
    } catch {
      /* unreadable: leave it off */
    }
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { place, dir: relative(root, at).split(sep).join("/"), entries: entries.slice(0, MAX_LIST), more: Math.max(0, entries.length - MAX_LIST) };
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".step": "model/step", ".stp": "model/step", ".iges": "model/iges", ".igs": "model/iges", ".stl": "model/stl", ".obj": "model/obj", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".3mf": "model/3mf",
};
export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

/** copy one file out of a place into the archive, for a board. The original is only read. */
export async function bringFromPlace(by: { id: string }, id: string, rel: string, boardId: string | null): Promise<FileRow> {
  return (await bringForCard(by, id, rel, boardId)).file;
}

/** the same, with the picture's size when it is one, for whoever makes its card */
export async function bringForCard(by: { id: string }, id: string, rel: string, boardId: string | null): Promise<{ file: FileRow; image: { w: number; h: number } | null }> {
  const place = getPlace(id);
  const at = resolveInPlace(place, rel);
  const s = await stat(at);
  if (!s.isFile()) throw new HttpError(400, "That's a folder. Bring its files one at a time.");
  if (s.size > MAX_BRING) throw new HttpError(413, `${basename(at)} is ${Math.round(s.size / 1048576)} MB; the most that can be brought is ${MAX_BRING / 1048576} MB.`);
  const body = await readFile(at);
  const file = await storeFile(body, { name: basename(at), mime: mimeOf(at), boardId, userId: by.id, about: `From “${place.name}” on this computer: ${rel.replace(/\\/g, "/")}` });
  return { file, image: /^image\/(png|jpeg|gif|webp)$/.test(file.mime) ? imageSize(body) : null };
}

/** the start of a text file in a place, for an agent deciding what's worth bringing */
export async function readPlaceText(id: string, rel: string, max = 20_000): Promise<string> {
  const place = getPlace(id);
  const at = resolveInPlace(place, rel);
  const s = await stat(at);
  if (!s.isFile()) throw new HttpError(400, "That's a folder.");
  if (s.size > 8 * 1024 * 1024) return `(${basename(at)} is ${Math.round(s.size / 1048576)} MB: too big to read here. Bring it onto the board instead.)`;
  const buf = await readFile(at);
  if (buf.subarray(0, 4096).includes(0)) return `(${basename(at)} isn't text: ${mimeOf(at)}, ${s.size} bytes. Bring it onto the board to see it.)`;
  const text = buf.toString("utf8");
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}
