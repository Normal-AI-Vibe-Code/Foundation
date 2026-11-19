/**
 * Just enough tar (ustar) to put files into a machine and take them back out through the Engine API's
 * `PUT /containers/{id}/archive` and `GET …/archive` (machinefunctions.ts): plain files and folders, names
 * under 100 characters on the way in; on the way out, pax and GNU long names are read too.
 */

const BLOCK = 512;

function header(name: string, size: number, type: "0" | "5", mode: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  const put = (s: string, at: number, len: number) => h.write(s.slice(0, len), at, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  if (Buffer.byteLength(name) > 100) throw new Error(`a name too long for this tar: ${name}`);
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put("root", 265, 32);
  put("root", 297, 32);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export interface TarEntry {
  name: string;
  body?: Buffer;
  /** a folder (no body) */
  dir?: boolean;
  mode?: number;
}

/** a tar of these entries (folders end with "/") */
export function packTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.dir) {
      parts.push(header(e.name.endsWith("/") ? e.name : `${e.name}/`, 0, "5", e.mode ?? 0o777));
      continue;
    }
    const body = e.body ?? Buffer.alloc(0);
    parts.push(header(e.name, body.length, "0", e.mode ?? 0o644), body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

const str = (b: Buffer, at: number, len: number) => {
  const s = b.subarray(at, at + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString("utf8");
};
const num = (b: Buffer, at: number, len: number) => parseInt(str(b, at, len).trim() || "0", 8) || 0;

/** the plain files in a tar, by their full names (folders, links and the rest left out) */
export function readTar(tar: Buffer): Array<{ name: string; body: Buffer }> {
  const out: Array<{ name: string; body: Buffer }> = [];
  let at = 0;
  let longName: string | null = null;
  while (at + BLOCK <= tar.length) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = num(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    const body = tar.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      longName = path ? path[1] : null;
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    longName = null;
    if (type === "0" || type === "\0" || type === "7") out.push({ name, body: Buffer.from(body) });
  }
  return out;
}
