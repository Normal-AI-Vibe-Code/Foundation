/**
 * Every upload goes through here: a queue (three at a time, so a dropped
 * folder of 200 files doesn't open 200 requests) and the state the upload
 * tray shows (shell/UploadTray.tsx). A failed upload waits in the tray for
 * Retry; its card waits with it. Dismissing the tray gives up on what failed.
 */

import { useSyncExternalStore } from "react";
import { uploadFile, type UploadedFile } from "./api";

export type UploadState = "waiting" | "sending" | "done" | "failed";

export interface UploadItem {
  id: number;
  name: string;
  /** where it came from inside a dropped folder ("Renders/front.png") */
  path?: string;
  size: number;
  loaded: number;
  state: UploadState;
  error?: string;
}

export interface UploadTrayState {
  items: UploadItem[];
  /** the tray is folded to its head row */
  folded: boolean;
}

const CONCURRENCY = 3;

interface Job {
  item: UploadItem;
  file: File;
  board: string;
  onProgress?: (f: number) => void;
  resolve: (f: UploadedFile) => void;
  reject: (e: Error) => void;
}

let state: UploadTrayState = { items: [], folded: false };
const listeners = new Set<() => void>();
const jobs = new Map<number, Job>();
const queue: Job[] = [];
let active = 0;
let seq = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/** when the last batch finished (a new upload soon after joins it; later, it starts a new one) */
let doneAt = 0;

function emit(next: Partial<UploadTrayState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function patch(id: number, p: Partial<UploadItem>) {
  emit({ items: state.items.map((it) => (it.id === id ? { ...it, ...p } : it)) });
}

export function getUploads() {
  return state;
}

export function onUploads(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useUploads() {
  return useSyncExternalStore(onUploads, getUploads, getUploads);
}

/** totals for the tray's head */
export function uploadTotals(items: UploadItem[]) {
  let size = 0;
  let loaded = 0;
  let done = 0;
  let failed = 0;
  for (const it of items) {
    size += it.size;
    loaded += it.state === "done" ? it.size : it.loaded;
    if (it.state === "done") done++;
    if (it.state === "failed") failed++;
  }
  const busy = items.length - done - failed;
  return { size, loaded, done, failed, busy, total: items.length, fraction: size ? loaded / size : busy ? 0 : 1 };
}

/**
 * Upload a file through the queue. Resolves when it lands; a failure waits
 * for Retry (the promise stays open) and rejects only when it's given up.
 */
export function queueUpload(file: File, board: string, opts: { path?: string; onProgress?: (f: number) => void } = {}): Promise<UploadedFile> {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  // a batch finished a while ago makes way for the next; one that just finished is still being added to
  // (a folder's cards are made a tick apart, and small files land in between)
  if (state.items.length && state.items.every((it) => it.state === "done") && Date.now() - doneAt > 1200) emit({ items: [] });
  const item: UploadItem = { id: ++seq, name: file.name, path: opts.path, size: file.size, loaded: 0, state: "waiting" };
  emit({ items: [...state.items, item] });
  return new Promise((resolve, reject) => {
    const job: Job = { item, file, board, onProgress: opts.onProgress, resolve, reject };
    jobs.set(item.id, job);
    queue.push(job);
    pump();
  });
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    active++;
    patch(job.item.id, { state: "sending", loaded: 0, error: undefined });
    let last = 0;
    uploadFile(job.file, job.board, (f) => {
      const now = performance.now();
      // the tray redraws at most ~12 times a second per file
      if (now - last < 80 && f < 1) return;
      last = now;
      patch(job.item.id, { loaded: Math.round(f * job.item.size) });
      job.onProgress?.(f);
    })
      .then((up) => {
        patch(job.item.id, { state: "done", loaded: job.item.size });
        jobs.delete(job.item.id);
        job.resolve(up);
      })
      .catch((e: Error) => {
        // a refusal (view only, too big) won't change on retry; a dropped connection might
        patch(job.item.id, { state: "failed", error: e.message || "upload failed" });
        emit({ folded: false });
      })
      .finally(() => {
        active--;
        pump();
        settle();
      });
  }
}

/** all done and nothing failed: the tray goes after a beat */
function settle() {
  const t = uploadTotals(state.items);
  if (t.busy || t.failed || !t.total) return;
  doneAt = Date.now();
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (state.items.every((it) => it.state === "done")) emit({ items: [] });
  }, 2600);
}

export function retryUpload(id: number) {
  const job = jobs.get(id);
  if (!job || job.item.state !== "failed") return;
  patch(id, { state: "waiting", loaded: 0, error: undefined });
  queue.push(job);
  pump();
}

export function retryAllUploads() {
  for (const it of state.items) if (it.state === "failed") retryUpload(it.id);
}

export function foldUploads(folded: boolean) {
  emit({ folded });
}

/** close the tray: what failed is given up (its card says so), what's still going carries on */
export function dismissUploads() {
  for (const it of state.items) {
    if (it.state !== "failed") continue;
    const job = jobs.get(it.id);
    jobs.delete(it.id);
    job?.reject(new Error(it.error ?? "upload failed"));
  }
  emit({ items: state.items.filter((it) => it.state === "waiting" || it.state === "sending") });
}

/** design page and tests: show the tray in a given state without uploading anything */
export function showUploadsForDesign(items: UploadItem[], folded = false) {
  emit({ items, folded });
}
