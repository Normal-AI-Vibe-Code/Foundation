/**
 * The picture kept of a page card (2026-11-19): what a `via: "browser"` card shows from far away, and to anyone who
 * can't open the built-in browser (it is an admin's). The built-in browser saves the page as it last drew it while
 * someone was looking (hostbrowser.ts), one JPEG per card, replaced each time: `data/pages/<board>/<card>.jpg`.
 *
 * It is a picture of a signed-in page, so it is the board's: only someone who can see the board is served it
 * (index.ts asks requireBoard), and it is only ever taken while the tab is at the card's own site (never of a
 * sign-in provider's page the tab passed through).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** a screenshot of a page at 2× is a few hundred kB; anything far past that isn't one */
export const PICTURE_MAX = 4_000_000;

export interface PageOf {
  board: string;
  card: string;
}

export const pageIdsOk = (board: unknown, card: unknown): boolean => typeof board === "string" && typeof card === "string" && ID.test(board) && ID.test(card);

function pathOf(p: PageOf): string | null {
  if (!pageIdsOk(p.board, p.card)) return null;
  return join(config.dataDir, "pages", p.board, `${p.card}.jpg`);
}

/** a JPEG begins FF D8 FF */
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** keep this picture of the card's page; returns when it was kept (ms), or null if it wasn't one to keep */
export function savePagePicture(p: PageOf, jpeg: Buffer): number | null {
  const path = pathOf(p);
  if (!path || !isJpeg(jpeg) || jpeg.length > PICTURE_MAX) return null;
  try {
    mkdirSync(join(config.dataDir, "pages", p.board), { recursive: true });
    // written beside it and moved over: a reader never gets half a picture
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, jpeg);
    renameSync(tmp, path);
    return Math.round(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

export function readPagePicture(p: PageOf): { jpeg: Buffer; at: number } | null {
  const path = pathOf(p);
  if (!path || !existsSync(path)) return null;
  try {
    return { jpeg: readFileSync(path), at: Math.round(statSync(path).mtimeMs) };
  } catch {
    return null;
  }
}

export function dropPagePicture(p: PageOf) {
  const path = pathOf(p);
  if (path) rmSync(path, { force: true });
}
