/**
 * A look at what travels along a wire (2026-11-24, Josh: "we should do more to give a sample of the data that is
 * coming out of another card"). One way to say a value, used wherever a wire or a port is read:
 *
 *   - `peek(value)`        a few words: "12 rows × 4 columns", "text · 340 characters", "a picture: render.png"
 *   - `<ValueSample/>`     the value itself, small: rows as a little table (4 × 4), a picture as a thumbnail,
 *                          an object as its first fields, text as its first lines
 *
 * Pure and cheap: nothing here subscribes to anything, the caller passes the value it already has.
 */

import "./flow.css";

export type Shape =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "number"; text: string }
  | { kind: "rows"; head: string[] | null; rows: string[][]; total: number; cols: number }
  | { kind: "file"; name: string; url: string; image: boolean }
  | { kind: "fields"; fields: Array<[string, string]>; total: number }
  | { kind: "list"; items: string[]; total: number };

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** what a value is, in a form the sample can draw */
export function shapeOf(v: unknown): Shape {
  if (v === undefined || v === null || v === "") return { kind: "none" };
  if (typeof v === "string") return { kind: "text", text: v };
  if (typeof v === "number" || typeof v === "boolean") return { kind: "number", text: String(v) };
  if (Array.isArray(v)) {
    if (v.length && v.every(Array.isArray)) {
      const all = v as unknown[][];
      const cols = Math.max(0, ...all.map((r) => r.length));
      // a first row of words over the rest reads as a header
      const first = all[0] ?? [];
      const header = all.length > 1 && first.every((c) => typeof c === "string" && c !== "" && !/^-?\d/.test(c));
      const body = header ? all.slice(1) : all;
      return { kind: "rows", head: header ? first.map(cell).slice(0, 4) : null, rows: body.slice(0, 4).map((r) => r.slice(0, 4).map(cell)), total: body.length, cols };
    }
    if (v.length && v.every(isRecord)) {
      const recs = v as Record<string, unknown>[];
      const keys = [...new Set(recs.slice(0, 20).flatMap((r) => Object.keys(r)))];
      return { kind: "rows", head: keys.slice(0, 4), rows: recs.slice(0, 4).map((r) => keys.slice(0, 4).map((k) => cell(r[k]))), total: recs.length, cols: keys.length };
    }
    return { kind: "list", items: v.slice(0, 5).map(cell), total: v.length };
  }
  if (isRecord(v)) {
    const url = typeof v.url === "string" ? v.url : typeof v.src === "string" ? v.src : null;
    if (url && (v.fileId || v.name || IMAGE.test(url))) {
      const name = typeof v.name === "string" ? v.name : (url.split(/[/?#]/).filter(Boolean).pop() ?? "file");
      return { kind: "file", name, url, image: IMAGE.test(url) || IMAGE.test(name) || (typeof v.mime === "string" && v.mime.startsWith("image/")) };
    }
    // rows under a key (a connector's value: { from, summary, rows: [...] })
    for (const k of ["rows", "items", "data", "results"]) if (Array.isArray(v[k]) && (v[k] as unknown[]).length) return shapeOf(v[k]);
    const entries = Object.entries(v);
    return { kind: "fields", fields: entries.slice(0, 5).map(([k, x]) => [k, cell(x)]), total: entries.length };
  }
  return { kind: "text", text: String(v) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** a value in a few words */
export function peek(v: unknown): string {
  const s = shapeOf(v);
  switch (s.kind) {
    case "none":
      return "nothing on it yet";
    case "text": {
      const lines = s.text.split("\n").length;
      return lines > 1 ? `text · ${plural(lines, "line")}` : `text · ${plural(s.text.length, "character")}`;
    }
    case "number":
      return s.text;
    case "rows":
      return `${plural(s.total, "row")} × ${plural(s.cols, "column")}`;
    case "file":
      return `${s.image ? "a picture" : "a file"}: ${s.name}`;
    case "fields":
      return `${plural(s.total, "field")}: ${s.fields.map(([k]) => k).slice(0, 3).join(", ")}${s.total > 3 ? "…" : ""}`;
    case "list":
      return plural(s.total, "item");
  }
}

/** the value, small enough to sit on a wire or in a port's card */
export function ValueSample({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const s = shapeOf(value);
  if (s.kind === "none") return <span className="flow-sample is-none">nothing on it yet</span>;
  if (s.kind === "text" || s.kind === "number") {
    const max = compact ? 90 : 280;
    const t = s.text.length > max ? `${s.text.slice(0, max - 1)}…` : s.text;
    return <span className={`flow-sample is-text${compact ? " is-compact" : ""}`}>{t}</span>;
  }
  if (s.kind === "file") {
    return (
      <span className="flow-sample is-file">
        {s.image && <img src={s.url} alt="" loading="lazy" draggable={false} />}
        <span>{s.name}</span>
      </span>
    );
  }
  if (s.kind === "rows") {
    const rows = compact ? s.rows.slice(0, 3) : s.rows;
    return (
      <span className="flow-sample is-rows">
        <table>
          {s.head && (
            <thead>
              <tr>
                {s.head.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {(s.total > rows.length || s.cols > 4) && (
          <span className="flow-sample-more">
            {s.total > rows.length ? `+${plural(s.total - rows.length, "row")}` : ""}
            {s.total > rows.length && s.cols > 4 ? " · " : ""}
            {s.cols > 4 ? `+${plural(s.cols - 4, "column")}` : ""}
          </span>
        )}
      </span>
    );
  }
  const n = compact ? 3 : 5;
  if (s.kind === "fields") {
    return (
      <span className="flow-sample is-fields">
        {s.fields.slice(0, n).map(([k, v]) => (
          <span key={k}>
            <b>{k}</b> {v}
          </span>
        ))}
        {s.total > n && <span className="flow-sample-more">+{plural(s.total - n, "field")}</span>}
      </span>
    );
  }
  return (
    <span className="flow-sample is-fields">
      {s.items.slice(0, n).map((x, i) => (
        <span key={i}>{x}</span>
      ))}
      {s.total > s.items.length && <span className="flow-sample-more">+{plural(s.total - s.items.length, "item")}</span>}
    </span>
  );
}
