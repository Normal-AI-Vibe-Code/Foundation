/**
 * The council's mark: three people side by side, the middle one forward. Solid heads over solid
 * shoulders (2026-11-17: the outlined version read as a frowning face at 13 px, a circle over a
 * downturned arc; filled figures can't be mistaken for one). One drawing for the top bar, a section's
 * tools, menus and ⌘K, in the colour of whatever wears it.
 */
export function CouncilGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg className="council-glyph" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      {/* the two at the sides, a step back */}
      <g opacity="0.62">
        <circle cx="3.2" cy="5.4" r="1.7" />
        <path d="M0.4 13.2c0-2.6 1.1-4.3 2.8-4.3 0.9 0 1.6 0.4 2.1 1.1-0.7 0.9-1 2-1 3.2z" />
        <circle cx="12.8" cy="5.4" r="1.7" />
        <path d="M15.6 13.2c0-2.6-1.1-4.3-2.8-4.3-0.9 0-1.6 0.4-2.1 1.1 0.7 0.9 1 2 1 3.2z" />
      </g>
      {/* the one in the middle */}
      <circle cx="8" cy="4.3" r="2.2" />
      <path d="M4.6 14c0-3.4 1.4-5.6 3.4-5.6s3.4 2.2 3.4 5.6z" />
    </svg>
  );
}
