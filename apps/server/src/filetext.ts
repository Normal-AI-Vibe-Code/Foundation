/**
 * The inside of documents, for search: PDFs, Word, PowerPoint, Excel and
 * OpenDocument files are read after their upload has answered, one at a
 * time in a worker thread (extract-worker.ts), each with a time and memory
 * limit. What comes out is kept by content (`file_text`, keyed by sha256), so
 * the same bytes uploaded again, or to another board, are searchable at once
 * and never read twice. Until then a document is found by its name.
 *
 * At boot, documents uploaded before this (or before the extractor's version
 * last changed) are read in the background, the way search re-indexes.
 */

import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { config } from "./config.ts";
import { all, indexDoc, one, run } from "./db.ts";
import { docKind, type DocKind } from "./extract.ts";

/** bump when extraction gets better: older results are read again at boot */
export const TEXT_V = 1;
/** bigger documents are found by name only */
const FILE_MAX = 96 * 1024 * 1024;
const JOB_MS = Number(process.env.FOUNDATION_EXTRACT_MS) || 45_000;
const IDLE_MS = 20_000;

interface Row {
  id: string;
  board_id: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  about?: string | null;
}

interface Job {
  sha: string;
  kind: DocKind;
  waiters: Array<(text: string | null) => void>;
}

const queue: Job[] = [];
const queued = new Map<string, Job>();
let worker: Worker | null = null;
let running: Job | null = null;
let seq = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleWaiters: Array<() => void> = [];

/** what a file's text is, if it has been read: the text ("" when it has none), or null */
export function storedText(sha: string): string | null {
  const r = one<{ text: string }>("select text from file_text where sha256 = ? and v >= ? and status = 'ok'", sha, TEXT_V);
  return r ? r.text : null;
}

/** has this content been tried at the current version (ok, empty, failed or skipped)? */
function tried(sha: string) {
  return Boolean(one("select 1 from file_text where sha256 = ? and v >= ?", sha, TEXT_V));
}

export function isDocument(name: string, mime: string) {
  return docKind(name, mime) !== null;
}

/**
 * Read a document's text in the background and put it into search for every
 * live file with those bytes. Resolves with the text (null if it couldn't be
 * read). `urgent` jumps the queue (an agent waiting on read_file).
 */
export function queueFileText(f: { sha256: string; name: string; mime: string; size: number }, urgent = false): Promise<string | null> {
  const kind = docKind(f.name, f.mime);
  if (!kind) return Promise.resolve(null);
  const have = storedText(f.sha256);
  if (have !== null || tried(f.sha256)) return Promise.resolve(have);
  if (f.size > FILE_MAX) {
    save(f.sha256, "skipped", "", `larger than ${FILE_MAX >> 20} MB`);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let job = queued.get(f.sha256);
    if (!job) {
      job = { sha: f.sha256, kind, waiters: [] };
      queued.set(f.sha256, job);
      if (urgent) queue.unshift(job);
      else queue.push(job);
    } else if (urgent && queue.includes(job)) {
      queue.splice(queue.indexOf(job), 1);
      queue.unshift(job);
    }
    job.waiters.push(resolve);
    pump();
  });
}

/** resolves once nothing is queued or being read (tests, and the boot backfill's log) */
export function fileTextIdle(): Promise<void> {
  if (!running && !queue.length) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

/** documents nobody has read yet (or read with an older extractor): read them, in the background */
export function backfillFileText(): number {
  const rows = all<Row>(
    `select f.id, f.name, f.mime, f.size, f.sha256 from files f
       where f.archived_at is null
         and not exists (select 1 from file_text t where t.sha256 = f.sha256 and t.v >= ?)`,
    TEXT_V,
  );
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.sha256) || !isDocument(r.name, r.mime)) continue;
    seen.add(r.sha256);
    void queueFileText(r);
  }
  return seen.size;
}

/** the searchable body of a document file: its text if read, else its name and type */
export function documentBody(f: Row): string {
  const text = storedText(f.sha256);
  return `${text || `${f.name} ${f.mime}`}${f.about ? `\n${f.about}` : ""}`;
}

function save(sha: string, status: "ok" | "failed" | "skipped", text: string, error?: string) {
  run(
    `insert into file_text (sha256, v, status, text, error, at) values (?, ?, ?, ?, ?, ?)
       on conflict(sha256) do update set v = excluded.v, status = excluded.status, text = excluded.text, error = excluded.error, at = excluded.at`,
    sha, TEXT_V, status, text, error ?? null, Date.now(),
  );
}

function reindexSha(sha: string) {
  for (const f of all<Row>("select id, board_id, name, mime, size, sha256, about from files where sha256 = ? and archived_at is null", sha)) {
    indexDoc("file", f.id, f.board_id, f.name, documentBody(f));
  }
}

function startWorker(): Worker {
  // from source the worker is the .ts beside this file; bundled (the desktop app), the .mjs built beside the bundle
  const file = import.meta.url.endsWith(".ts") ? "./extract-worker.ts" : "./extract-worker.mjs";
  const w = new Worker(new URL(file, import.meta.url), {
    resourceLimits: { maxOldGenerationSizeMb: 768 },
    stdout: true,
    stderr: true,
  });
  w.unref();
  w.stdout.resume();
  w.stderr.resume();
  w.on("message", (m: { id: number; text?: string; error?: string }) => finish(m.id, m.text ?? null, m.error));
  w.on("error", (e) => {
    if (worker === w) worker = null;
    if (running) finish(currentId, null, e.message || "the reader stopped");
  });
  w.on("exit", () => {
    if (worker !== w) return;
    worker = null;
    if (running) finish(currentId, null, "the reader stopped");
  });
  return w;
}

let currentId = 0;
let jobTimer: ReturnType<typeof setTimeout> | null = null;

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    for (const r of idleWaiters.splice(0)) r();
    if (!idleTimer && worker) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!running && worker) void worker.terminate();
        worker = null;
      }, IDLE_MS);
      idleTimer.unref();
    }
    return;
  }
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  running = job;
  currentId = ++seq;
  worker ??= startWorker();
  worker.postMessage({ id: currentId, kind: job.kind, path: join(config.dataDir, "files", job.sha) });
  const id = currentId;
  jobTimer = setTimeout(() => {
    // too long: stop the worker (a new one takes the next file)
    const w = worker;
    worker = null;
    void w?.terminate();
    finish(id, null, `took longer than ${Math.round(JOB_MS / 1000)} s`);
  }, JOB_MS);
  jobTimer.unref();
}

function finish(id: number, text: string | null, error?: string) {
  if (id !== currentId || !running) return;
  const job = running;
  running = null;
  if (jobTimer) clearTimeout(jobTimer);
  jobTimer = null;
  queued.delete(job.sha);
  try {
    if (text !== null && !error) save(job.sha, "ok", text);
    else save(job.sha, "failed", "", error);
    reindexSha(job.sha);
  } catch (e) {
    console.warn(`file text: ${(e as Error).message}`);
  }
  if (error) console.warn(`file text: ${job.sha.slice(0, 12)}… not read (${error})`);
  for (const w of job.waiters) w(error ? null : text);
  pump();
}
