/**
 * The top bar's line icons, drawn at one weight (16 px, 1.3 stroke, round caps) so they sit together:
 * search beside the council, the agents and the rest.
 */

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function SearchGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.3 10.3l3.5 3.5" />
    </svg>
  );
}

export function GearGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
    </svg>
  );
}

export function PlusGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden {...S}>
      <path d="M7 2.5v9M2.5 7h9" />
    </svg>
  );
}

/** speak to everyone at once */
export function AllGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M2.5 6.4v3.2h2.2l4.6 2.9V3.5L4.7 6.4zM11.6 6.2c.7.5 1.1 1.1 1.1 1.8s-.4 1.3-1.1 1.8M13.2 4.4c1 .9 1.6 2.1 1.6 3.6s-.6 2.7-1.6 3.6" />
    </svg>
  );
}

/** the panel at the right */
export function PanelGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10M11.6 6h.9M11.6 8h.9" />
    </svg>
  );
}

export function MicGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="6" y="2" width="4" height="7.4" rx="2" />
      <path d="M3.8 7.6a4.2 4.2 0 0 0 8.4 0M8 11.8V14" />
    </svg>
  );
}

export function SendGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M8 13V3.4M4.2 7L8 3.2 11.8 7" />
    </svg>
  );
}

/** it runs somewhere else: a cloud */
export function CloudGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M4.6 12.2a2.9 2.9 0 0 1-.4-5.8 4 4 0 0 1 7.7.9 2.5 2.5 0 0 1-.3 4.9z" />
    </svg>
  );
}

/** it runs on this computer */
export function ComputerGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="2.4" y="3" width="11.2" height="7.4" rx="1.4" />
      <path d="M6 13h4M8 10.4V13" />
    </svg>
  );
}

/** not connected: a plug pulled apart */
export function OfflineGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M5.2 7l3.8 3.8-1.2 1.2a2.7 2.7 0 0 1-3.8-3.8zM3.9 12.1l-1.7 1.7M10.8 9l1.2-1.2a2.7 2.7 0 0 0-3.8-3.8L7 5.2M12.1 3.9l1.7-1.7M2.4 2.4l11.2 11.2" />
    </svg>
  );
}

export function CloseGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden {...S}>
      <path d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2" />
    </svg>
  );
}
