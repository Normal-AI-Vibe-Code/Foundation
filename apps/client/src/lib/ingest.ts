/**
 * Every file that lands on Foundation goes to the server (shared, searchable,
 * archived). Images and videos show at once from a local blob while the
 * upload runs, then swap to the shared URL; other files become file panels
 * with an upload bar — CAD included. Uploads go through one queue and one
 * tray (lib/uploads.ts, shell/UploadTray.tsx).
 *
 * Three ways in: dropped on a section (files, or whole folders, walked and
 * laid out as a group under a note naming the folder), pasted onto the board
 * (where the pointer is, in the section under it), or picked (⌘U).
 */

import { addMedia, addNote, addPanel, getState, placeAtWorld, removeMedia, requestSnap, resizeNote, sectionAtWorld, setMediaSrc, updatePanel } from "../state/store";
import { activeBoard } from "../sync/board";
import { getUi, toast } from "../state/ui";
import { toWorld } from "../state/camera";
import { queueUpload } from "./uploads";

/** a dropped folder brings at most this many files (the rest are named in a notice) */
export const FOLDER_MAX = 400;
const SKIP_DIRS = new Set(["node_modules", "__MACOSX", ".git", ".svn", ".hg"]);
const SKIP_FILES = new Set(["Thumbs.db", "desktop.ini", "Icon\r"]);

/** read natural media dimensions so cards start with the right aspect */
function probeMedia(file: File): Promise<{ src: string; w: number; h: number }> {
  const src = URL.createObjectURL(file);
  return new Promise((resolve) => {
    if (file.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ src, w: v.videoWidth || 640, h: v.videoHeight || 360 });
      v.onerror = () => resolve({ src, w: 640, h: 360 });
      v.src = src;
    } else {
      const img = new Image();
      img.onload = () => resolve({ src, w: img.naturalWidth || 480, h: img.naturalHeight || 360 });
      img.onerror = () => resolve({ src, w: 480, h: 360 });
      img.src = src;
    }
  });
}

const isMedia = (f: File) => f.type.startsWith("image/") || f.type.startsWith("video/");
/** the flow orders cards by when they were made: a tick apart keeps a group in order */
const tick = () => new Promise((r) => setTimeout(r, 2));

export interface IngestOptions {
  /** put the cards down here (world px), floating, a little apart; else they join the section's flow */
  at?: { x: number; y: number };
  /** where each file sat in a dropped folder, parallel to the files */
  paths?: string[];
  /** a dropped folder's name: a note heads the group (folders join the flow; not with `at`) */
  folder?: string;
}

export async function ingest(sectionId: string, files: FileList | File[], opts: IngestOptions = {}) {
  const list = [...files];
  if (!list.length) return;
  if (getUi().role === "viewer") {
    toast("View only — you can't add files to this board. An admin can make you a member.", "warn");
    return;
  }
  const board = activeBoard()?.boardId ?? "company";
  const one = list.length === 1 && !opts.folder;
  // one file dropped into the flow is framed; pasted ones stay where they were put, under your pointer
  const focus = one && !opts.at;
  // media dimensions first (in parallel), so the cards can be made in order
  const probes = await Promise.all(list.map((f) => (isMedia(f) ? probeMedia(f) : null)));
  const made: Array<Promise<void>> = [];
  if (opts.folder) {
    const n = addNote(sectionId, `## ${opts.folder}\n\n${list.length} file${list.length === 1 ? "" : "s"} from the folder`, { focus: false });
    resizeNote(n.id, 300, 120);
    await tick();
  }
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const path = opts.paths?.[i];
    const probe = probes[i];
    let id: string;
    if (probe) {
      const kind = file.type.startsWith("video/") ? "video" : "image";
      const m = addMedia(sectionId, probe.src, kind, file.name, probe.w, probe.h, { focus });
      id = m.id;
      made.push(
        queueUpload(file, board, { path })
          .then((up) => setMediaSrc(m.id, up.url))
          .catch((e: Error) => {
            // given up: its picture was only ever on this screen
            removeMedia(m.id);
            URL.revokeObjectURL(probe.src);
            toast(`${file.name} wasn't added: ${e.message}`, "bad");
          }),
      );
    } else {
      const p = addPanel(sectionId, { panel: "file", name: file.name, mime: file.type, status: "running", text: "0" }, { focus });
      id = p.id;
      let shown = 0;
      made.push(
        queueUpload(file, board, {
          path,
          // the card's bar is shared with everyone on the board: tenths are enough
          onProgress: (f) => {
            const step = Math.floor(f * 10) / 10;
            if (step > shown) updatePanel(p.id, { text: (shown = step).toFixed(1) });
          },
        })
          .then((up) => updatePanel(p.id, { fileId: up.id, mime: up.mime, status: undefined, text: undefined }))
          .catch((e: Error) => {
            updatePanel(p.id, { status: "error", text: e.message });
            toast(`${file.name} wasn't added: ${e.message}`, "bad");
          }),
      );
    }
    // several pasted at once fan out a little, so each can be seen and taken
    if (opts.at) placeAtWorld(id, opts.at.x + 28 * (i % 8), opts.at.y + 28 * (i % 8));
    if (list.length > 1) await tick();
  }
  if (!one && !opts.at) requestSnap({ kind: "section", id: sectionId });
  await Promise.all(made);
}

// ---------- dropped folders ----------

interface Picked {
  file: File;
  path: string;
}

/**
 * What a drop holds, folders walked. Call it inside the drop handler: the
 * browser only lets the entries be read during the event; walking them can
 * finish after.
 */
export function readDrop(dt: DataTransfer): Promise<{ loose: File[]; folders: Array<{ name: string; files: Picked[] }>; skipped: number }> {
  const entries: FileSystemEntry[] = [];
  const plain: File[] = [...dt.files];
  for (const item of [...dt.items]) {
    if (item.kind !== "file") continue;
    const e = item.webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  return (async () => {
    if (!entries.some((e) => e.isDirectory)) return { loose: plain, folders: [], skipped: 0 };
    const loose: File[] = [];
    const folders: Array<{ name: string; files: Picked[] }> = [];
    const budget = { left: FOLDER_MAX, skipped: 0 };
    for (const e of entries) {
      if (e.isFile) {
        if (budget.left-- > 0) loose.push(await fileOf(e as FileSystemFileEntry));
        else budget.skipped++;
      } else if (e.isDirectory) {
        const files: Picked[] = [];
        await walk(e as FileSystemDirectoryEntry, "", files, budget);
        files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
        folders.push({ name: e.name, files });
      }
    }
    return { loose, folders, skipped: budget.skipped };
  })();
}

function fileOf(e: FileSystemFileEntry): Promise<File> {
  return new Promise((ok, fail) => e.file(ok, fail));
}

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  // readEntries hands them over in batches (100 in Chromium) until it hands over none
  return new Promise((ok, fail) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return ok(out);
        out.push(...batch);
        next();
      }, fail);
    next();
  });
}

async function walk(dir: FileSystemDirectoryEntry, prefix: string, out: Picked[], budget: { left: number; skipped: number }) {
  let entries: FileSystemEntry[];
  try {
    entries = await readAll(dir);
  } catch {
    return; // unreadable (permissions): leave it out
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory) {
      if (!SKIP_DIRS.has(e.name)) await walk(e as FileSystemDirectoryEntry, `${prefix}${e.name}/`, out, budget);
    } else if (!SKIP_FILES.has(e.name)) {
      if (budget.left <= 0) {
        budget.skipped++;
        continue;
      }
      budget.left--;
      try {
        out.push({ file: await fileOf(e as FileSystemFileEntry), path: `${prefix}${e.name}` });
      } catch {
        budget.left++;
      }
    }
  }
}

/** a drop on a section: loose files join its flow; each folder comes in as a group headed by its name */
export async function ingestDrop(sectionId: string, dt: DataTransfer) {
  const read = readDrop(dt);
  const { loose, folders, skipped } = await read;
  if (loose.length) await Promise.all([ingest(sectionId, loose), ...folders.map((f) => ingestFolder(sectionId, f))]);
  else await Promise.all(folders.map((f) => ingestFolder(sectionId, f)));
  if (skipped) toast(`Added the first ${FOLDER_MAX} files; ${skipped} more were left out. Drop a smaller folder to bring the rest.`, "warn");
}

function ingestFolder(sectionId: string, f: { name: string; files: Picked[] }) {
  if (!f.files.length) {
    toast(`${f.name} has no files to add`, "warn");
    return Promise.resolve();
  }
  return ingest(
    sectionId,
    f.files.map((p) => p.file),
    { folder: f.name, paths: f.files.map((p) => p.path) },
  );
}

// ---------- paste ----------

/** a pasted image is named for when it was pasted ("image.png" says nothing) */
function pastedName(f: File, i: number) {
  if (f.name && f.name !== "image.png" && f.name !== "image.jpeg" && f.name !== "image.gif") return f;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  return new File([f], `Pasted image ${stamp}${i ? ` (${i + 1})` : ""}.${ext}`, { type: f.type, lastModified: f.lastModified });
}

/** the world point under a screen point, if it's on open grid (not a pane, the bar or a dialog) */
export function gridPointAt(cx: number, cy: number): { x: number; y: number } | null {
  const vp = document.querySelector<HTMLElement>(".grid-viewport");
  if (!vp) return null;
  const top = document.elementFromPoint(cx, cy);
  if (!top || top.closest(".floor-pane, .top-bar, .cmd-pane, .upload-tray") || !vp.contains(top)) return null;
  const r = vp.getBoundingClientRect();
  return toWorld(cx - r.left, cy - r.top);
}

/**
 * Files on the clipboard, pasted onto the board: they land where the pointer
 * is, in the section under it. With the pointer off the grid they go to the
 * section you were last in. Returns false when there was nothing to take.
 */
export function pasteFiles(files: File[], pointer: { x: number; y: number } | null): boolean {
  if (!files.length) return false;
  const st = getState();
  const at = pointer ? gridPointAt(pointer.x, pointer.y) : null;
  const under = at ? sectionAtWorld(at.x, at.y) : null;
  const sec = under ?? st.sections[st.activeSectionId];
  if (!sec) {
    toast("Point at a section, then paste", "warn");
    return true;
  }
  void ingest(sec.id, files.map(pastedName), under && at ? { at } : {});
  return true;
}
