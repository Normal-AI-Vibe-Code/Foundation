/**
 * The draggable edge of a floor pane (side pane, session, search). Invisible
 * at rest; the pointer finds a hairline and a grab knob. Double-click resets.
 */

import { useRef, useState } from "react";

interface Props {
  /** which edge of its pane the handle sits on */
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  initial: number;
  onChange(w: number): void;
  label: string;
}

export function FloorEdge({ side, value, min, max, initial, onChange, label }: Props) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const end = () => {
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("is-resizing-floor");
  };
  return (
    <div
      className={`floor-edge is-${side}${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-tip={`Drag to resize · double-click resets`}
      onPointerDown={(e) => {
        e.stopPropagation();
        drag.current = { x: e.clientX, w: value };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        document.body.classList.add("is-resizing-floor");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = (e.clientX - d.x) * (side === "right" ? 1 : -1);
        onChange(Math.round(Math.max(min, Math.min(max, d.w + dx))));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(initial)}
    >
      <span className="floor-edge-line" />
    </div>
  );
}
