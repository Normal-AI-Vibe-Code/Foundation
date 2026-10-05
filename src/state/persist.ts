/**
 * Local persistence: the whole document (grid, sections, primitives, and
 * every table's cells) plus uploaded media blobs live in IndexedDB, so the
 * workspace survives restarts — in the browser and in the Tauri shell alike.
 *
 * Layout: one JSON snapshot under kv/doc, one Blob per media card keyed by
 * its id. Saves are debounced off store + workbook changes; orphaned blobs
 * are pruned on each save.
 */

import {
  AppState,
  MediaMeta,
  getState,
  hydrateState,
  subscribe,
} from "./store";
import { workbook } from "../engine/workbook";

const DB_NAME = "foundation";
const DB_VERSION = 1;
const KV = "kv";
const MEDIA = "media";
const DOC_KEY = "doc";

// ---------- tiny promise wrapper over IndexedDB ----------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
        if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idbGet = (store: string, key: string) => tx<unknown>(store, "readonly", (s) => s.get(key));
const idbPut = (store: string, key: string, value: unknown) =>
  tx(store, "readwrite", (s) => s.put(value, key));
const idbDel = (store: string, key: string) => tx(store, "readwrite", (s) => s.delete(key));
const idbKeys = (store: string) => tx<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys());

// ---------- document snapshot ----------

interface SavedTable {
  id: string;
  name: string;
  cols: number;
  rows: number;
  cells: Array<[string, string]>; // "col,row" -> raw text
}

interface SavedDoc {
  version: 1;
  grid: AppState["grid"];
  sections: AppState["sections"];
  tables: AppState["tables"];
  maps: AppState["maps"];
  notes: AppState["notes"];
  media: Record<string, MediaMeta>; // src stripped — blobs live separately
  activeSectionId: string;
  workbook: SavedTable[];
}

function snapshot(): SavedDoc {
  const st = getState();
  const wb: SavedTable[] = [];
  for (const id of Object.keys(st.tables)) {
    const t = workbook.getTable(id);
    if (!t) continue;
    wb.push({
      id,
      name: t.name,
      cols: t.cols,
      rows: t.rows,
      cells: [...t.cells].map(([coord, cell]) => [coord, cell.raw]),
    });
  }
  return {
    version: 1,
    grid: st.grid,
    sections: st.sections,
    tables: st.tables,
    maps: st.maps,
    notes: st.notes,
    media: Object.fromEntries(
      Object.values(st.media).map((m) => [m.id, { ...m, src: "" }]),
    ),
    activeSectionId: st.activeSectionId,
    workbook: wb,
  };
}

// ---------- media blobs ----------

/** stash an uploaded file so its card survives a restart */
export function saveMediaBlob(id: string, blob: Blob) {
  void idbPut(MEDIA, id, blob).catch(() => {});
}

// ---------- save / restore ----------

let ready = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = Promise.resolve();

function scheduleSave() {
  if (!ready) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveNow(), 600);
}

async function saveNow() {
  // serialize saves so a slow write can't be overtaken by the next one
  saving = saving.then(async () => {
    const doc = snapshot();
    await idbPut(KV, DOC_KEY, doc);
    const keep = new Set(Object.keys(doc.media));
    for (const key of await idbKeys(MEDIA)) {
      if (!keep.has(String(key))) await idbDel(MEDIA, String(key));
    }
  }).catch(() => {});
  return saving;
}

/** rebuild workbook + store from IndexedDB; false when nothing usable is saved */
export async function restorePersisted(): Promise<boolean> {
  let doc: SavedDoc | undefined;
  try {
    doc = (await idbGet(KV, DOC_KEY)) as SavedDoc | undefined;
  } catch {
    return false;
  }
  if (!doc || doc.version !== 1 || !Object.keys(doc.sections ?? {}).length) return false;

  // tables first so cross-table names resolve, then cells (formulas recalc)
  for (const t of doc.workbook) workbook.addTable(t.id, t.name, t.cols, t.rows);
  for (const t of doc.workbook) {
    for (const [coord, raw] of t.cells) {
      const [c, r] = coord.split(",");
      workbook.setCell(t.id, parseInt(c, 10), parseInt(r, 10), raw);
    }
  }

  // media blobs come back as fresh object URLs; drop cards whose blob is gone
  const media: Record<string, MediaMeta> = {};
  for (const m of Object.values(doc.media)) {
    try {
      const blob = await idbGet(MEDIA, m.id);
      if (blob instanceof Blob) media[m.id] = { ...m, src: URL.createObjectURL(blob) };
    } catch {
      /* skip this card */
    }
  }

  hydrateState({
    grid: doc.grid,
    sections: doc.sections,
    tables: doc.tables,
    maps: doc.maps,
    notes: doc.notes,
    media,
    activeSectionId: doc.activeSectionId,
  });
  return true;
}

/** begin watching for changes; call once, after restore or first seed */
export function startAutosave() {
  if (ready) return;
  ready = true;
  subscribe(scheduleSave);
  workbook.subscribeAll(scheduleSave);
  // flush promptly when the app is backgrounded or closing
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && timer) {
      clearTimeout(timer);
      timer = null;
      void saveNow();
    }
  });
}
