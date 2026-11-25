/**
 * The design page's look at what flows along a wire (2026-11-24): the samples a port's card and a wire's bar
 * show, the chip a wire carries in each of its states, and a fed table's lens bar. Still pieces, drawn from
 * the same components and CSS the grid uses (shell/flowPeek.tsx, shell/flow.css).
 */

import { peek, ValueSample } from "../shell/flowPeek";

const ROWS = [
  { code: "UL-2271", agency: "UL", stage: "testing", itemsOpen: 3 },
  { code: "CE-EMC", agency: "CE", stage: "review", itemsOpen: 2 },
  { code: "FCC-15", agency: "FCC", stage: "done", itemsOpen: 0 },
  { code: "IEC-60335", agency: "IEC", stage: "planned", itemsOpen: 11 },
  { code: "UN-38.3", agency: "UN", stage: "testing", itemsOpen: 1 },
];
// a picture on a wire: the app's own mark stands in (no raw colours in a component: test/design.test.ts)
const PICTURE = "/foundation.svg";

const SAMPLES: Array<{ label: string; value: unknown }> = [
  { label: "rows (a connector's list)", value: { from: "BomForm", summary: "5 cert programs", rows: ROWS } },
  { label: "text", value: "Coil assembly needs a human check: the brazing log shows two joints under temperature." },
  { label: "a picture", value: { fileId: "f1", url: PICTURE, name: "concept-a.png" } },
  { label: "fields", value: { decision: "approved", by: "Ada", at: "2026-11-24", note: "ship it" } },
];

const CHIPS: Array<{ kind: string; text: string; note: string }> = [
  { kind: "ok", text: "2 of 5 rows → Open cert programs", note: "ok: what passed the table's lens" },
  { kind: "working", text: "reading BomForm…", note: "working: the server is reading the source" },
  { kind: "working", text: "generating views · 40%", note: "working: a character stage generating" },
  { kind: "empty", text: "waiting for Parts feed", note: "waiting: wired, nothing arrived yet" },
  { kind: "error", text: "BomForm is offline — the Data Room answered 503", note: "error: why, in the system's words" },
];

export function FlowSpecimens() {
  return (
    <div data-design-flows style={{ display: "grid", gap: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        {SAMPLES.map((s) => (
          <div key={s.label} className="port-card is-placed" style={{ position: "relative", transform: "none", ["--wire-tone" as string]: "var(--color-pulse)" }}>
            <span className="port-label-head">
              <b>{s.label}</b>
              <i>json</i>
              <span className="port-peek">{peek(s.value)}</span>
            </span>
            <ValueSample value={s.value} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 34, paddingTop: 30 }}>
        {CHIPS.map((c) => (
          <div key={c.note} style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ position: "relative", width: 300, height: 1, background: "var(--color-pulse)" }}>
              <div className={`flow-chip is-${c.kind}`} style={{ left: 150, top: 0, ["--wire-tone" as string]: "var(--color-pulse)" }}>
                <span>{c.text}</span>
              </div>
            </div>
            <span style={{ font: "400 var(--text-11) / 1.3 var(--font-sans)", color: "var(--color-dim)" }}>{c.note}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        {(["ok", "working", "bad", "idle"] as const).map((tone) => (
          <div key={tone} className={`table-feed is-${tone}`} style={{ width: 360, border: "1px solid var(--color-line)", borderRadius: "var(--radius-card)" }}>
            <span className="table-feed-say">
              <span className="table-feed-dot" aria-hidden />
              {tone === "ok" ? "2 of 5 rows from BomForm pass" : tone === "working" ? "Reading BomForm…" : tone === "bad" ? '"only open ones" isn\'t a filter: write it as column = value' : "No longer fed: its wire from BomForm came off. It keeps its last rows."}
            </span>
            {tone !== "idle" && (
              <span className="table-feed-lens">
                <label>
                  <span>Rows where</span>
                  <input readOnly value={tone === "bad" ? "only open ones" : "itemsOpen > 0"} />
                </label>
                <label>
                  <span>Columns</span>
                  <input readOnly value="code, agency, stage" />
                </label>
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
