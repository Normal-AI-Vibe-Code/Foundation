/**
 * A card full screen (lib/cardUse.ts): the ⤢ that opens it, and the bar across
 * its top while it's open (its name, open in a tab, and the way back).
 */

import { useSyncExternalStore } from "react";
import { fullscreenCard, onFullscreen, toggleFullscreen } from "../lib/cardUse";
import { keys } from "../lib/keys";

/** the card that's full screen now (re-renders as cards enter and leave) */
export function useFullscreenCard(): string | null {
  return useSyncExternalStore(onFullscreen, fullscreenCard, () => null);
}

export function FullscreenButton({ id, round }: { id: string; round?: boolean }) {
  const label = `Full screen (${keys("mod+enter")})`;
  return (
    <button className={round ? "frame-icon fs-open" : "icon-btn fs-open"} data-tip={label} aria-label={label} onClick={() => void toggleFullscreen(id)}>
      <ExpandGlyph />
    </button>
  );
}

export function FullscreenBar({ id, title, url }: { id: string; title: string; url?: string }) {
  return (
    <div className="fs-bar" role="toolbar" aria-label={`${title}, full screen`}>
      <span className="fs-title">{title}</span>
      <span className="fs-hint">Esc to return to the grid</span>
      {url && (
        <button className="f-pill" onClick={() => window.open(url, "_blank", "noopener")}>
          Open in a tab ↗
        </button>
      )}
      <button className="f-pill" onClick={() => void toggleFullscreen(id)} aria-label="Leave full screen">
        Back to the grid
      </button>
    </div>
  );
}

function ExpandGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5l4.5-4.5" />
    </svg>
  );
}
