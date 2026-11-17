/**
 * What a STEP file says about itself, without a CAD kernel: the length unit,
 * the bounding box of every CARTESIAN_POINT, the product names, and how much
 * geometry there is. Enough for the CAD stage to show "212 × 212 × 64 mm" and
 * catch a part modelled in the wrong units before anyone simulates it.
 * (Exact B-rep work stays in Vision's OpenCascade path.)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { one } from "./db.ts";
import type { FileRow } from "./files.ts";

export interface CadSummary {
  format: "STEP" | "IGES" | "other";
  unit: string;
  /** bounding box in the file's unit */
  bbox: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] } | null;
  points: number;
  faces: number;
  products: string[];
  note: string;
}

const UNIT: Record<string, string> = { ".MILLI.": "mm", ".CENTI.": "cm", ".KILO.": "km", ".MICRO.": "µm" };

export function stepSummary(text: string): CadSummary {
  const products = [...text.matchAll(/PRODUCT\s*\(\s*'([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  const unitMatch = /SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)/.exec(text);
  const unit = unitMatch ? (UNIT[unitMatch[1]] ?? "m") : /INCH/i.test(text) ? "in" : "mm";
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let points = 0;
  for (const m of text.matchAll(/CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-+0-9.Ee]+)\s*,\s*([-+0-9.Ee]+)\s*(?:,\s*([-+0-9.Ee]+))?\s*\)\s*\)/g)) {
    const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    if (v.some((n) => !Number.isFinite(n))) continue;
    points++;
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }
  const faces = (text.match(/ADVANCED_FACE\s*\(/g) ?? []).length;
  const bbox = points
    ? { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] as [number, number, number] }
    : null;
  const r = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  const note = bbox
    ? `${r(bbox.size[0])} × ${r(bbox.size[1])} × ${r(bbox.size[2])} ${unit} · ${faces || "no"} faces`
    : `${faces} faces · no geometry points found`;
  return { format: "STEP", unit, bbox, points, faces, products: [...new Set(products)].slice(0, 12), note };
}

export async function cadSummaryForFile(fileId: string): Promise<CadSummary | null> {
  const row = one<FileRow>("select * from files where id = ?", fileId);
  if (!row) return null;
  if (!/\.(step|stp)$/i.test(row.name)) {
    return { format: /\.(iges|igs)$/i.test(row.name) ? "IGES" : "other", unit: "", bbox: null, points: 0, faces: 0, products: [], note: row.name.split(".").pop()?.toUpperCase() ?? "file" };
  }
  // STEP files can be large; the geometry points are spread through, so read it whole (capped)
  const buf = await readFile(join(config.dataDir, "files", row.sha256));
  return stepSummary(buf.subarray(0, 64 * 1024 * 1024).toString("latin1"));
}
