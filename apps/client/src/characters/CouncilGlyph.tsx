/**
 * The council's mark: three figures seated round a table (the middle one a little forward), in the
 * colour of whatever wears it. One drawing for the top bar, a section's tools, menus and ⌘K.
 */
export function CouncilGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg className="council-glyph" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="4.2" r="1.9" />
      <circle cx="2.9" cy="6" r="1.5" />
      <circle cx="13.1" cy="6" r="1.5" />
      <path d="M4.6 12.2c0-2.2 1.5-3.7 3.4-3.7s3.4 1.5 3.4 3.7" />
      <path d="M.9 12.4c0-1.7.9-2.9 2.1-3.2M15.1 12.4c0-1.7-.9-2.9-2.1-3.2" />
      <path d="M1 14.4h14" />
    </svg>
  );
}
