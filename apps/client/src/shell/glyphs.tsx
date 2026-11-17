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

/** search pinned to the right, or not: a pin */
export function PinGlyph({ size = 14, on = false }: { size?: number; on?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M6 2.5h4M6.6 2.5l-.6 5-2 2h8l-2-2-.6-5M8 9.5v4.5" fill={on ? "currentColor" : "none"} />
    </svg>
  );
}

/** present: a play mark */
export function PresentGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M5 3.2v9.6L12.6 8z" />
    </svg>
  );
}

// ---- the built-in tools (shell/Tools.tsx) ----

export function TerminalGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path d="M4.6 6.2l2 1.8-2 1.8M8.4 10.2h3" />
    </svg>
  );
}

export function BrowserGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6" />
    </svg>
  );
}

export function FilesGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M1.8 4.4c0-.8.6-1.4 1.4-1.4h3l1.4 1.6h5.2c.8 0 1.4.6 1.4 1.4v5.6c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4z" />
    </svg>
  );
}

export function ChangesGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <circle cx="4.2" cy="3.8" r="1.5" />
      <circle cx="4.2" cy="12.2" r="1.5" />
      <circle cx="11.8" cy="8" r="1.5" />
      <path d="M4.2 5.3v5.4M5.6 4.6c3 .6 4.6 1.6 4.8 2.6" />
    </svg>
  );
}

/** T3: three agents' threads, side by side */
export function T3Glyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M3 3.5h10M8 3.5v9" />
      <path d="M3.5 8.5h2.5M10 8.5h2.5M3.5 12.5h2.5M10 12.5h2.5" />
    </svg>
  );
}

/** settings for something (the agents, on Ask's pill): three sliders */
export function SlidersGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M2.5 4.5h4.4M10.1 4.5h3.4M2.5 11.5h2M7.7 11.5h5.8M2.5 8h7.6M13.3 8h.2" />
      <circle cx="8.5" cy="4.5" r="1.6" />
      <circle cx="6.1" cy="11.5" r="1.6" />
      <circle cx="11.7" cy="8" r="1.6" />
    </svg>
  );
}

// ---- a machine's tools and features (panels/MachineTools.tsx, the Start well, Add a desktop) ----

/** a machine's graphical desktop: a screen on a stand */
export function DesktopGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.6" />
      <path d="M8 11v2.4M5.4 13.4h5.2" />
    </svg>
  );
}

/** copy what's chosen: two sheets */
export function CopyGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="5.4" y="5.4" width="8.4" height="8.4" rx="1.6" />
      <path d="M10.6 5.4V3.8c0-.9-.7-1.6-1.6-1.6H3.8c-.9 0-1.6.7-1.6 1.6V9c0 .9.7 1.6 1.6 1.6h1.6" />
    </svg>
  );
}

/** copy all of it: a page of lines */
export function CopyAllGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="2.8" y="1.8" width="10.4" height="12.4" rx="1.6" />
      <path d="M5.4 5h5.2M5.4 7.6h5.2M5.4 10.2h3.4" />
    </svg>
  );
}

/** paste from this computer: a clipboard */
export function PasteGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M5.6 3H4.2c-.8 0-1.4.6-1.4 1.4v8.4c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4V4.4c0-.8-.6-1.4-1.4-1.4h-1.4" />
      <rect x="5.6" y="1.8" width="4.8" height="2.6" rx="1" />
      <path d="M8 6.8v4.6M6.2 9.6L8 11.4l1.8-1.8" />
    </svg>
  );
}

/** open in a window of its own: a box with an arrow leaving it */
export function PopOutGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M7 3H4c-.8 0-1.4.6-1.4 1.4V12c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4V9" />
      <path d="M9.6 2.4h4v4M13.6 2.4L7.8 8.2" />
    </svg>
  );
}

/** full screen: four corners */
export function FullGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M2.4 6V2.4H6M10 2.4h3.6V6M13.6 10v3.6H10M6 13.6H2.4V10" />
    </svg>
  );
}

/** packages that go in: a box */
export function PackageGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M8 1.9l5.6 3v6.2L8 14.1l-5.6-3V4.9z" />
      <path d="M2.4 4.9L8 7.9l5.6-3M8 7.9v6.2" />
    </svg>
  );
}

/** pulled from a registry: an arrow down to a line */
export function PullGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M8 2.2v8M4.6 7l3.4 3.4L11.4 7M2.8 13.4h10.4" />
    </svg>
  );
}

/** only this computer can reach it: a lock */
export function LockGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <rect x="3" y="7" width="10" height="7" rx="1.6" />
      <path d="M5.2 7V5a2.8 2.8 0 015.6 0v2" />
    </svg>
  );
}

/** kept apart from this computer: a shield */
export function ShieldGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M8 1.9l5 1.9v4c0 3.1-2.1 5.4-5 6.3-2.9-.9-5-3.2-5-6.3v-4z" />
    </svg>
  );
}

/** an agent: the four-point star, filled, in whatever colour it's given */
export function AgentGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.6c.5 3.4 1.9 5.2 6.4 6.4-4.5 1.2-5.9 3-6.4 6.4-.5-3.4-1.9-5.2-6.4-6.4C6.1 6.8 7.5 5 8 1.6z" fill="currentColor" />
    </svg>
  );
}

/** something went wrong: a triangle with a mark */
export function WarnGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      <path d="M8 2.2l6 10.6H2z" />
      <path d="M8 6.4v3M8 11.2v.1" />
    </svg>
  );
}
