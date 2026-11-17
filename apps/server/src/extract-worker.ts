/**
 * The extraction worker (filetext.ts starts it): one file at a time, its text
 * back to the server. A worker so a long PDF never holds up a request; the
 * server ends it if a file takes too long.
 */

import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { extractDocText, type DocKind } from "./extract.ts";

parentPort?.on("message", async (job: { id: number; kind: DocKind; path: string }) => {
  try {
    const body = await readFile(job.path);
    const text = await extractDocText(job.kind, body);
    parentPort?.postMessage({ id: job.id, text });
  } catch (e) {
    parentPort?.postMessage({ id: job.id, error: (e as Error).message || String(e) });
  }
});
