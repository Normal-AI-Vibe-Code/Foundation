/**
 * The mark a space wears in its tab and in its row of the side menu: ◉ the company, ▦ a grid, ▶ a
 * presentation, ◳ a web page, and for an app opened as a tab, the app's own (T3's; a window with a
 * spark for any other).
 */

import { KIND_GLYPH, type BoardRow } from "../lib/grids";
import { T3Glyph } from "./glyphs";

export function AppGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.2" />
      <path d="M1.8 5.8h12.4M4 4.3h.1M5.8 4.3h.1" />
      <path d="M8 7.6l.7 1.5 1.5.7-1.5.7L8 12l-.7-1.5-1.5-.7 1.5-.7z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SpaceGlyph({ space }: { space: Pick<BoardRow, "id" | "kind" | "app"> }) {
  if (space.id === "company") return <>◉</>;
  if (space.kind === "app") return space.app === "t3" ? <T3Glyph size={14} /> : <AppGlyph />;
  return <>{KIND_GLYPH[space.kind ?? "grid"]}</>;
}
