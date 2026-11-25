/**
 * ChatForm's line icons: 16 px, a 1.3 stroke in the current colour, the weight of the shell's glyphs
 * (shell/glyphs.tsx). And ChatForm's own mark: two speech shapes, one behind the other.
 */

import type { ReactNode } from "react";

function Svg({ size = 16, children, sw = 1.3 }: { size?: number; children: ReactNode; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

/** ChatForm's mark: a speech shape in front, its tail at the lower left, and a second one behind it */
export function ChatMark({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size} sw={1.35}>
      <path d="M6.2 3.2h5.6a2.4 2.4 0 0 1 2.4 2.4v2.2a2.4 2.4 0 0 1-2.4 2.4" opacity="0.55" />
      <path d="M2 7.6a2.4 2.4 0 0 1 2.4-2.4h5.2A2.4 2.4 0 0 1 12 7.6v2.6a2.4 2.4 0 0 1-2.4 2.4H5.4L3 14.4v-2.1A2.4 2.4 0 0 1 2 10.2Z" />
    </Svg>
  );
}

export const IconReact = () => (
  <Svg>
    <circle cx="7.5" cy="8.5" r="5.5" />
    <path d="M5.4 10a2.6 2.6 0 0 0 4.2 0M5.6 7h.01M9.4 7h.01" />
    <path d="M13 1.5v3M11.5 3h3" />
  </Svg>
);
export const IconThread = () => (
  <Svg>
    <path d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6a1.7 1.7 0 0 1 1.7 1.7v5.1a1.7 1.7 0 0 1-1.7 1.7H7l-3 2.5v-2.5h.2a1.7 1.7 0 0 1-1.7-1.7Z" />
    <path d="M5.5 5.8h5M5.5 8h3" />
  </Svg>
);
export const IconPin = () => (
  <Svg>
    <path d="M9.8 2.2l4 4-2 .8-2.2 2.2.2 2.8-1 1L2.9 7.1l1-1 2.8.2L8.9 4.1Z" />
    <path d="M5.7 10.3 2.2 13.8" />
  </Svg>
);
export const IconLink = () => (
  <Svg>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
  </Svg>
);
export const IconMore = () => (
  <Svg sw={2}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Svg>
);
export const IconEdit = () => (
  <Svg>
    <path d="M10.6 2.8l2.6 2.6-7.6 7.6-3.1.5.5-3.1Z" />
  </Svg>
);
export const IconClip = () => (
  <Svg>
    <path d="M12.6 7.4 7.8 12.2a3 3 0 0 1-4.2-4.2l5.1-5.1a2 2 0 0 1 2.8 2.8L6.5 10.7a1 1 0 0 1-1.4-1.4l4.6-4.6" />
  </Svg>
);
export const IconSend = () => (
  <Svg>
    <path d="M2.5 8 13.5 2.8 10.6 13.5 7.6 9.1Z" />
    <path d="M7.6 9.1 13.5 2.8" />
  </Svg>
);
export const IconStar = ({ on = false }: { on?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
    <path d="M8 2.2l1.75 3.6 3.95.55-2.86 2.77.68 3.93L8 11.2l-3.52 1.85.68-3.93L2.3 6.35l3.95-.55Z" />
  </svg>
);
export const IconBell = ({ off = false }: { off?: boolean }) => (
  <Svg>
    <path d="M4 11V7.2a4 4 0 0 1 8 0V11l1.2 1.4H2.8Z" />
    <path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" />
    {off && <path d="M2.5 2.5l11 11" />}
  </Svg>
);
export const IconHash = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.8 5.8h11M2.2 10.2h11" />
  </Svg>
);
export const IconLock = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" />
  </Svg>
);
export const IconPlus = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconChevron = ({ open = true }: { open?: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform var(--dur-quick) var(--ease-out-soft)" }}>
    <path d="M3.5 2l3 3-3 3" />
  </svg>
);
export const IconClose = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconSearch = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.3" />
    <path d="M10.2 10.2 13.5 13.5" />
  </Svg>
);
export const IconDownload = () => (
  <Svg>
    <path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10" />
  </Svg>
);
export const IconPeople = () => (
  <Svg>
    <circle cx="6" cy="5.6" r="2.3" />
    <path d="M1.9 13.2a4.1 4.1 0 0 1 8.2 0" />
    <path d="M10.6 3.6a2.2 2.2 0 0 1 0 4.2M12.2 9.6a3.9 3.9 0 0 1 2 3.6" />
  </Svg>
);
export const IconFile = () => (
  <Svg>
    <path d="M4 1.8h5.2L12.5 5v9.2H4Z" />
    <path d="M9 1.8V5.2h3.4" />
  </Svg>
);
export const IconUnread = () => (
  <Svg>
    <path d="M2.5 4.5h7M2.5 8h5M2.5 11.5h4" />
    <circle cx="12.3" cy="5" r="1.8" />
  </Svg>
);
export const IconTrash = () => (
  <Svg>
    <path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.4 4.5l.6 9h6l.6-9" />
  </Svg>
);
export const IconCode = () => (
  <Svg>
    <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
  </Svg>
);
export const IconList = () => (
  <Svg>
    <path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5M2.6 4.5h.01M2.6 8h.01M2.6 11.5h.01" />
  </Svg>
);
export const IconQuote = () => (
  <Svg>
    <path d="M3 3.5v9M6 5h7M6 8h7M6 11h4.5" />
  </Svg>
);
/** the conversations' list, folded away: a panel with its left column, and a caret saying it opens (2026-11-20) */
export const IconSideList = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M6 3v10M8.6 6.6 10 8l-1.4 1.4" />
  </Svg>
);
