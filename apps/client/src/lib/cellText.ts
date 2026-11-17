/**
 * How a table cell's computed value reads, shared by both renderers (the web
 * table in components/TableView.tsx and the Rune scene in rune/scene.ts).
 */
export function formatValue(v: number | string | boolean | null): string {
  if (v === null) return "";
  if (typeof v === "number") {
    if (!isFinite(v)) return "#NUM";
    const abs = Math.abs(v);
    if (abs !== 0 && (abs >= 1e12 || abs < 1e-6)) return v.toExponential(3);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(v);
  }
  return String(v);
}
