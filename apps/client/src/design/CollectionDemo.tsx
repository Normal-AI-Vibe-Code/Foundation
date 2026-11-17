import type { CollectionItem, CollectionState } from "@foundation/protocol";
import { CollectionCard } from "../panels/CollectionView";

/**
 * A collection on `#/design` ("Collections"), drawn by the card the grid uses (panels/CollectionView.tsx
 * `CollectionCard`): empty, folded to its stack, and opened to its grid of tiles, at its own sizes (360 × 420
 * folded, 920 × 700 opened). Nothing here reaches a server; the pictures are stand-ins in a neutral grey that
 * reads on day and night paper.
 */

const picture = (kind: "sheet" | "eight" | "portrait") => {
  const fig = (x: number, y: number, s: number) => `<g transform="translate(${x} ${y}) scale(${s})" fill="gray"><circle cx="48" cy="38" r="20" fill-opacity=".55"/><rect x="30" y="62" width="36" height="52" rx="12" fill-opacity=".4"/></g>`;
  const [w, h, body] =
    kind === "eight" ? [192, 144, Array.from({ length: 8 }, (_, i) => fig((i % 4) * 48, Math.floor(i / 4) * 72, 0.5)).join("")] : kind === "portrait" ? [96, 96, fig(0, 10, 1)] : [96, 144, fig(0, 14, 1)];
  return { src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`, w, h };
};

const at = 0;
const item = (key: string, name: string, from: string, kind: "sheet" | "eight" | "portrait", more: Partial<CollectionItem> = {}): CollectionItem => ({ key, kind: "image", name, from, at, ...picture(kind), ...more });
const ITEMS: CollectionItem[] = [
  item("file:a", "Mira · sheet", "Sheet · Anime", "sheet"),
  item("file:b", "Mira · expressions", "Expressions · Anime", "eight"),
  item("file:c", "Mira · portrait", "Views · Anime", "portrait"),
  item("file:d", "Taro · sheet", "Sheet · Anime", "sheet"),
  { ...item("chr:e", "Taro", "Output · Anime", "portrait"), kind: "character", form: "mesh" },
  { ...item("chr:f", "Kuro", "Output · Anime", "portrait"), kind: "character", form: "model" },
];
const SECTIONS = [
  { id: "sec_pipe", name: "Pipeline · Anime" },
  { id: "sec_shelf", name: "Collected · Anime" },
];
const full: CollectionState = { items: ITEMS, into: "sec_shelf", laid: Object.fromEntries(ITEMS.map((i) => [i.key, "x"])) };

function Frame({ w, h, children }: { w: number; h: number; children: React.ReactNode }) {
  return (
    <div className="frame-card panel-card kind-collection" style={{ width: w, height: h, position: "relative", borderRadius: "var(--radius-card)", background: "var(--color-raise)", boxShadow: "var(--shadow-sheet), 0 0 0 1px var(--color-line)" }}>
      {children}
    </div>
  );
}

export function CollectionDemo() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-6)", alignItems: "flex-start" }} data-design-collections>
      <Frame w={360} h={420}>
        <CollectionCard name="Collection" state={{ items: [] }} sections={SECTIONS} home="sec_pipe" open={false} viewer={false} />
      </Frame>
      <Frame w={360} h={420}>
        <CollectionCard name="Collected · Anime" state={full} sections={SECTIONS} home="sec_pipe" open={false} viewer={false} />
      </Frame>
      <Frame w={920} h={700}>
        <CollectionCard name="Collected · Anime" state={full} sections={SECTIONS} home="sec_pipe" open viewer={false} />
      </Frame>
    </div>
  );
}
