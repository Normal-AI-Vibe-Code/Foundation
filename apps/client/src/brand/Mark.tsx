/** The mark's own box (apps/client/assets/foundation-mark.svg, as Josh drew it). */
export const MARK_VIEWBOX = "0 0 451 418";

/** The four panels of the mark: two full rows over a row split in two. */
export function MarkPanels() {
  return (
    <>
      <rect width="451" height="124" rx="5" />
      <rect y="147" width="451" height="124" rx="5" />
      <rect y="294" width="216" height="124" rx="5" />
      <rect x="235" y="294" width="216" height="124" rx="5" />
    </>
  );
}

/**
 * The Foundation mark: four panels on a grid (the app icon is the same shape).
 * Drawn in `currentColor`. `tone="pulse"` (the default) is the room's blue, for paper and glass;
 * `tone="on-fill"` is the white original, for solid fills and dark ground; `tone="inherit"` takes
 * the colour it's set in.
 */
export function Mark({ size = 30, tone = "pulse", className }: { size?: number; tone?: "pulse" | "on-fill" | "inherit"; className?: string }) {
  const color = tone === "pulse" ? "var(--color-pulse)" : tone === "on-fill" ? "var(--color-on-fill)" : undefined;
  return (
    <svg className={className} width={size} height={size} viewBox={MARK_VIEWBOX} fill="currentColor" aria-hidden style={color ? { color } : undefined}>
      <MarkPanels />
    </svg>
  );
}
