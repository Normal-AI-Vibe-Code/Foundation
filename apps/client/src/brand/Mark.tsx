/** The mark's own box (apps/client/assets/foundation-mark.svg, traced from Josh's drawing). */
export const MARK_VIEWBOX = "0 0 1240 1240";

/** The two leaves of the mark: a low one over one twice its height, each rounded at its top left and bottom right. */
export function MarkShape() {
  return (
    <>
      <path d="M396 0H1240A396 396 0 0 1 844 396H0A396 396 0 0 1 396 0Z" />
      <path d="M396 448H1240V844A396 396 0 0 1 844 1240H0V844A396 396 0 0 1 396 448Z" />
    </>
  );
}

/**
 * The Foundation mark: two leaves, one over the other (the app icon is the same shape).
 * Drawn in `currentColor`. `tone="pulse"` (the default) is the room's blue, for paper and glass;
 * `tone="on-fill"` is the white original, for solid fills and dark ground; `tone="inherit"` takes
 * the colour it's set in.
 */
export function Mark({ size = 30, tone = "pulse", className }: { size?: number; tone?: "pulse" | "on-fill" | "inherit"; className?: string }) {
  const color = tone === "pulse" ? "var(--color-pulse)" : tone === "on-fill" ? "var(--color-on-fill)" : undefined;
  return (
    <svg className={className} width={size} height={size} viewBox={MARK_VIEWBOX} fill="currentColor" aria-hidden style={color ? { color } : undefined}>
      <MarkShape />
    </svg>
  );
}
