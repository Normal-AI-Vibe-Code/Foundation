/**
 * Write a Duration into a MediaRecorder WebM so a <video> can seek it.
 *
 * Chrome's MediaRecorder writes WebM "live": the Segment's size is the
 * all-ones "unknown" vint and Segment → Info carries no Duration, so a player
 * reports `duration === Infinity` and can't seek until it has played through.
 * This patches the head of the file: it finds Segment → Info and fills its
 * Duration, or inserts one, fixing up Info's size. Nothing after Info moves
 * unless it has to, and the media (Tracks, Clusters) is never touched.
 *
 * EBML in brief (RFC 8794, Matroska/WebM): every element is
 *   ID   — a vint that keeps its length marker (1–4 bytes, e.g. Info = 15 49 A9 66)
 *   size — a vint with the marker stripped (1–8 bytes); all value bits set = "unknown"
 *   data — `size` bytes (children, for a master element)
 * where a vint's length is 1 + the number of leading zero bits in its first byte.
 *
 * Duration is a float in TimecodeScale units (TimecodeScale is nanoseconds per
 * tick, 1,000,000 by default, so by default Duration is in milliseconds).
 *
 * Inserting Duration grows Info by 11 bytes, which shifts everything after it.
 * That's harmless in a live file (no index points into it), so:
 *   - a Void right after Info absorbs the growth if it can (nothing moves);
 *   - otherwise the bytes are inserted only when the Segment's size is unknown
 *     and there's no SeekHead; a finished file with a known size may carry
 *     SeekHead/Cues offsets that would go stale, and that is left alone.
 * Anything unexpected returns the input unchanged: never lose a recording.
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
  Void: 0xec,
} as const;

/** How much of a recording `withWebmDuration` reads: Info sits in the first few hundred bytes. */
const HEAD_BYTES = 64 * 1024;

interface El {
  id: number;
  /** offset of the ID's first byte */
  start: number;
  /** width of the size vint */
  sizeWidth: number;
  /** offset of the data */
  dataStart: number;
  /** data size, or null when it's "unknown" */
  size: number | null;
  /** offset just past the data, or null when the size is unknown */
  end: number | null;
}

/** A vint's width from its first byte: 0x80 → 1, 0x40 → 2, …, 0x01 → 8; 0 → invalid. */
const vintWidth = (first: number) => (first === 0 ? 0 : Math.clz32(first) - 23);

/** Read the element header at `pos`, or null if it doesn't fit or isn't valid. */
function readEl(b: Uint8Array, pos: number): El | null {
  if (pos >= b.length) return null;
  const idWidth = vintWidth(b[pos]);
  if (idWidth < 1 || idWidth > 4 || pos + idWidth > b.length) return null;
  let id = 0;
  for (let i = 0; i < idWidth; i++) id = id * 256 + b[pos + i];

  const sp = pos + idWidth;
  if (sp >= b.length) return null;
  const sizeWidth = vintWidth(b[sp]);
  if (sizeWidth < 1 || sp + sizeWidth > b.length) return null;
  const mask = 0xff >> sizeWidth; // the value bits in the first byte
  let size = b[sp] & mask;
  let unknown = size === mask;
  for (let i = 1; i < sizeWidth; i++) {
    size = size * 256 + b[sp + i];
    unknown &&= b[sp + i] === 0xff;
  }
  const dataStart = sp + sizeWidth;
  return { id, start: pos, sizeWidth, dataStart, size: unknown ? null : size, end: unknown ? null : dataStart + size };
}

/** An unsigned big-endian integer of 0–8 bytes. */
function readUint(b: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[pos + i];
  return v;
}

/** `value` as a size vint `width` bytes wide, or null if it doesn't fit (all-ones is reserved for "unknown"). */
function encodeSize(value: number, width: number): Uint8Array | null {
  if (width < 1 || width > 8 || value < 0 || value > 2 ** (7 * width) - 2) return null;
  const out = new Uint8Array(width);
  let v = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (width - 1);
  return out;
}

/** `value` as a size vint, keeping `preferred` width if it fits, else the narrowest that does. */
function encodeSizeAtLeast(value: number, preferred: number): Uint8Array | null {
  for (let w = preferred; w <= 8; w++) {
    const enc = encodeSize(value, w);
    if (enc) return enc;
  }
  return null;
}

/** A Void element exactly `total` bytes long (≥ 2), zero-filled. */
function voidOf(total: number): Uint8Array | null {
  for (let w = 1; w <= 8; w++) {
    const size = encodeSize(total - 1 - w, w);
    if (size) {
      const out = new Uint8Array(total);
      out[0] = ID.Void;
      out.set(size, 1);
      return out;
    }
  }
  return null;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * `bytes` (a whole WebM, or a prefix that holds Segment → Info) with Info's
 * Duration set to `durationMs`. Returns the same `bytes` object, untouched,
 * if it can't be patched safely.
 */
export function fixWebmDuration(bytes: Uint8Array, durationMs: number): Uint8Array {
  try {
    return patch(bytes, durationMs) ?? bytes;
  } catch {
    return bytes;
  }
}

function patch(b: Uint8Array, durationMs: number): Uint8Array | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

  // EBML header, then the Segment.
  const ebml = readEl(b, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.end === null) return null;
  const seg = readEl(b, ebml.end);
  if (!seg || seg.id !== ID.Segment) return null;
  const segEnd = seg.end === null ? b.length : Math.min(seg.end, b.length);

  // The Segment's children up to Info. Clusters come after Info; meeting one
  // first (or an element we can't step over) means this isn't a file we know.
  let info: El | null = null;
  let seekHead = false;
  for (let pos = seg.dataStart; pos < segEnd; ) {
    const el = readEl(b, pos);
    if (!el || el.end === null || el.id === ID.Cluster) return null;
    if (el.id === ID.SeekHead) seekHead = true;
    if (el.id === ID.Info) {
      info = el;
      break;
    }
    pos = el.end;
  }
  if (!info || info.size === null || info.end === null || info.end > b.length) return null;
  const infoEnd = info.end;

  // Info's children: TimecodeScale (ns per tick) and any Duration already there.
  let scale = 1_000_000;
  let duration: El | null = null;
  let afterScale = info.dataStart; // where a new Duration goes: after TimecodeScale, else first
  for (let pos = info.dataStart; pos < infoEnd; ) {
    const el = readEl(b, pos);
    if (!el || el.end === null || el.end > infoEnd) return null;
    if (el.id === ID.TimecodeScale) {
      if (el.size! < 1 || el.size! > 8) return null;
      scale = readUint(b, el.dataStart, el.size!);
      afterScale = el.end;
    } else if (el.id === ID.Duration) {
      duration = el;
    }
    pos = el.end;
  }
  if (!(scale > 0)) return null;
  const ticks = (durationMs * 1_000_000) / scale;

  // A Duration already there: overwrite it in place, keeping its width. Nothing moves.
  if (duration) {
    const out = b.slice();
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    if (duration.size === 8) dv.setFloat64(duration.dataStart, ticks);
    else if (duration.size === 4) dv.setFloat32(duration.dataStart, ticks);
    else return null;
    return out;
  }

  // No Duration: rebuild Info with one (ID 44 89, size 8, float64 big-endian).
  const durEl = new Uint8Array(11);
  durEl.set([0x44, 0x89, 0x88]);
  new DataView(durEl.buffer).setFloat64(3, ticks);
  const infoSize = encodeSizeAtLeast(info.size + durEl.length, info.sizeWidth);
  if (!infoSize) return null;
  const newInfo = concat([
    b.subarray(info.start, info.dataStart - info.sizeWidth), // Info's ID
    infoSize,
    b.subarray(info.dataStart, afterScale),
    durEl,
    b.subarray(afterScale, infoEnd),
  ]);
  let grow = newInfo.length - (infoEnd - info.start);

  // A Void right after Info can give up the room, so nothing after it moves.
  let filler = new Uint8Array(0);
  let resumeAt = infoEnd;
  const next = infoEnd < segEnd ? readEl(b, infoEnd) : null;
  if (next && next.id === ID.Void && next.end !== null && next.end <= b.length) {
    const left = next.end - next.start - grow;
    const v = left === 0 ? filler : left >= 2 ? voidOf(left) : null;
    if (v) {
      filler = v;
      resumeAt = next.end;
      grow = 0;
    }
  }

  if (grow !== 0) {
    // Everything after Info moves. Only safe when nothing records offsets:
    // a live file (unknown Segment size) with no SeekHead before the Clusters.
    if (seg.end !== null || seekHead) return null;
    for (let pos = infoEnd; pos < segEnd; ) {
      const el = readEl(b, pos);
      if (!el || el.end === null || el.id === ID.Cluster) break;
      if (el.id === ID.SeekHead) return null;
      pos = el.end;
    }
  }

  return concat([b.subarray(0, info.start), newInfo, filler, b.subarray(resumeAt)]);
}

/**
 * A recording Blob with its Duration written in. Reads only the head of the
 * file and splices it back onto the rest, so a long recording isn't copied
 * into memory. Any failure returns the original Blob.
 */
export async function withWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  try {
    const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
    const fixed = fixWebmDuration(head, durationMs);
    if (fixed === head) return blob;
    return new Blob([fixed as Uint8Array<ArrayBuffer>, blob.slice(head.length)], { type: blob.type });
  } catch {
    return blob;
  }
}
