/**
 * Text out of documents, so search finds what's inside them: PDF (through
 * unpdf, Mozilla's PDF.js built for servers), Word, PowerPoint and Excel
 * (OOXML: a zip of XML parts), and OpenDocument (also a zip of XML).
 *
 * Nothing here runs what a document carries. The zip reader only inflates the
 * XML parts it names (a macro-enabled .docm's vbaProject.bin is never even
 * read), XML is pulled apart with patterns rather than evaluated, and PDF.js
 * (the serverless build: no eval or `new Function` anywhere in it) is opened
 * with no fonts loaded into anything, no XFA and no scripting; it never runs
 * a PDF's JavaScript outside its viewer's sandbox, which isn't here. Work is capped per file: entries inflate to at most
 * ENTRY_MAX, text stops at TEXT_MAX, PDFs read at most PDF_PAGES pages. The
 * caller (filetext.ts) runs this in a worker thread with a time limit, off
 * the request path.
 */

import { inflateRawSync } from "node:zlib";
import { extname } from "node:path";

export const TEXT_MAX = 200_000;
const ENTRY_MAX = 24 * 1024 * 1024;
const PDF_PAGES = 400;

const OOXML: Record<string, "docx" | "pptx" | "xlsx"> = {
  ".docx": "docx", ".docm": "docx", ".dotx": "docx", ".dotm": "docx",
  ".pptx": "pptx", ".pptm": "pptx", ".potx": "pptx", ".ppsx": "pptx",
  ".xlsx": "xlsx", ".xlsm": "xlsx", ".xltx": "xlsx",
};
const ODF = new Set([".odt", ".ods", ".odp", ".odg"]);
const MIME_KIND: Record<string, DocKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odf",
  "application/vnd.oasis.opendocument.spreadsheet": "odf",
  "application/vnd.oasis.opendocument.presentation": "odf",
};

export type DocKind = "pdf" | "docx" | "pptx" | "xlsx" | "odf";

/** the kind of document a file is, if it's one we read the inside of */
export function docKind(name: string, mime: string): DocKind | null {
  const ext = extname(name).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (OOXML[ext]) return OOXML[ext];
  if (ODF.has(ext)) return "odf";
  return MIME_KIND[mime] ?? null;
}

export async function extractDocText(kind: DocKind, body: Uint8Array): Promise<string> {
  const text = kind === "pdf" ? await pdfText(body) : zipDocText(kind, Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  return tidy(text).slice(0, TEXT_MAX);
}

function tidy(s: string) {
  return s.replace(/[ \t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- PDF ----------

async function pdfText(body: Uint8Array): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(body), {
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const out: string[] = [];
    let size = 0;
    try {
      const { info } = await doc.getMetadata();
      const meta = info as Record<string, unknown>;
      for (const k of ["Title", "Subject", "Author", "Keywords"]) if (typeof meta[k] === "string" && meta[k]) out.push(String(meta[k]));
    } catch {
      /* no metadata */
    }
    const pages = Math.min(doc.numPages, PDF_PAGES);
    for (let n = 1; n <= pages && size < TEXT_MAX; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== "string") continue;
        line += item.str;
        if (item.hasEOL) line += "\n";
        else if (item.str && !item.str.endsWith(" ")) line += " ";
      }
      out.push(line);
      size += line.length;
      page.cleanup();
    }
    return out.join("\n\n");
  } finally {
    await doc.loadingTask.destroy();
  }
}

// ---------- zip (store and deflate; enough for OOXML and ODF) ----------

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  csize: number;
  usize: number;
  offset: number;
}

export function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  const out = new Map<string, ZipEntry>();
  // end of central directory: the last "PK\x05\x06" within 64 KiB + 22 of the end
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const entry: ZipEntry = {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
    };
    out.set(entry.name, entry);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

export function zipRead(buf: Buffer, e: ZipEntry | undefined): string {
  if (!e) return "";
  if (e.flags & 1) return ""; // encrypted
  if (e.csize === 0xffffffff || e.usize > ENTRY_MAX) return ""; // zip64 or too big to bother
  const h = e.offset;
  if (buf.readUInt32LE(h) !== 0x04034b50) return "";
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data.toString("utf8");
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: ENTRY_MAX }).toString("utf8");
  return "";
}

// ---------- XML text ----------

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function unescapeXml(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITY[e] ?? m;
  });
}

/**
 * The text runs of an XML part: what's inside each `<tag>` element, with a
 * line break at the end of each `para` element and a space for tabs and breaks.
 */
function runs(xml: string, tag: string, para: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>|</${para}>|<[a-z]+:(?:tab|br|cr)\\b[^>]*/>`, "g");
  let out = "";
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else out += m[0].startsWith("</") ? "\n" : " ";
  }
  return out;
}

const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

function zipDocText(kind: Exclude<DocKind, "pdf">, buf: Buffer): string {
  const zip = zipEntries(buf);
  const names = [...zip.keys()];
  const read = (n: string) => zipRead(buf, zip.get(n));
  const out: string[] = [];

  if (kind === "docx") {
    const parts = [
      "word/document.xml",
      ...names.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort(byNumber),
      "word/footnotes.xml",
      "word/endnotes.xml",
      "word/comments.xml",
    ];
    for (const p of parts) out.push(runs(read(p), "w:t", "w:p"));
  } else if (kind === "pptx") {
    for (const p of names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber)) out.push(runs(read(p), "a:t", "a:p"));
    for (const p of names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).sort(byNumber)) out.push(runs(read(p), "a:t", "a:p"));
  } else if (kind === "xlsx") {
    out.push(xlsxText(names, read));
  } else {
    out.push(odfText(read("content.xml")));
  }
  out.push(coreProps(read("docProps/core.xml") || read("meta.xml")));
  return out.filter(Boolean).join("\n\n");
}

/** title, subject, keywords, description from the document's properties */
function coreProps(xml: string): string {
  if (!xml) return "";
  const out: string[] = [];
  for (const m of xml.matchAll(/<(?:dc:title|dc:subject|cp:keywords|dc:description|meta:keyword)(?:\s[^>]*)?>([^<]*)</g)) out.push(unescapeXml(m[1]));
  return out.join(" ");
}

/** each sheet: its name, then rows as lines and cells split by tabs (shared strings resolved) */
function xlsxText(names: string[], read: (n: string) => string): string {
  const shared: string[] = [];
  for (const si of read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) s += unescapeXml(t[1]);
    shared.push(s);
  }
  const sheetNames = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
  const out: string[] = [];
  let size = 0;
  const sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber);
  sheets.forEach((p, i) => {
    if (size > TEXT_MAX) return;
    const rows: string[] = [sheetNames[i] ?? ""];
    for (const row of read(p).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
        let v = "";
        if (type === "inlineStr") for (const t of inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) v += unescapeXml(t[1]);
        else {
          const raw = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
          if (raw !== undefined) v = type === "s" ? shared[Number(raw)] ?? "" : unescapeXml(raw);
        }
        if (v) cells.push(v);
      }
      if (cells.length) {
        const line = cells.join("\t");
        rows.push(line);
        size += line.length;
      }
    }
    out.push(rows.join("\n"));
  });
  // a workbook whose sheets can't be read still has its strings
  return out.join("\n\n") || shared.join("\n");
}

function odfText(xml: string): string {
  return unescapeXml(
    xml
      .replace(/<text:(?:tab|s|line-break)\b[^>]*\/>/g, " ")
      .replace(/<\/(?:text:p|text:h|table:table-row)>/g, "\n")
      .replace(/<\/table:table-cell>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  );
}
