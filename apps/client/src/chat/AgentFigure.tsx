/**
 * An agent, drawn as a figure standing behind a line (2026-11-20, Josh: "The Avatars should not render in
 * a circle, it's visually off as well, you can have them render on the bottom line, create a line for them
 * to crop behind"). The council's way (characters/council.css): the figure is taller than its window and
 * the window's foot cuts it, chest up. No disc, no ring: a person is a round face on their colour, an
 * agent a cut figure on a violet baseline, so the two differ in shape as well as colour.
 *
 *  - **figure** (20 px and up): the still the agent wears (its portrait, else its thumb, else its front:
 *    `stillRole(…, "bust")`), its flat ground cut away (characters/cutout.ts) so it reads on the paper in
 *    day and night, framed by `figureFrame`; under it a 1 px baseline in the agent's violet mixed toward the
 *    line colour, the window's width. No character: the ✦ stands on the same line. A picture whose ground
 *    can't be cut (a photograph, another origin) sits on a rounded paper tile instead, still not a disc.
 *  - **spark** (under 20 px, where a figure can't be read): the ✦ on the agent's tint, a small paper tile.
 *
 * `figureForm(size)` (sideMenuLogic.ts) decides which; the components that draw a party (PartyAvatar)
 * follow it everywhere ChatForm draws an agent.
 */

import { useState } from "react";
import { useFileSrc } from "../lib/fileSrc";
import { stillRole } from "../characters/Avatar";
import { useCutout } from "../characters/cutout";
import { characterFilePath, readyCharacters, useRoster } from "../characters/roster";
import { figureForm, figureFrame } from "./sideMenuLogic";
import "./figure.css";

/** the still an agent name wears (the one chosen for it, else, for one of the server's crew, Claude's), cut out */
export function useAgentStill(name: string): { src?: string; role: string; cut: boolean } {
  const roster = useRoster();
  const id = roster.avatars[name] ?? roster.avatars[name.replace(/\s+\d+$/, "")] ?? roster.avatars.Claude;
  const worn = id ? readyCharacters(roster).find((c) => c.id === id) : undefined;
  const role = worn ? stillRole(worn, "bust") : null;
  const file = useFileSrc(worn && role ? characterFilePath(worn.id, role) : null);
  const src = useCutout(file);
  return { src, role: role ?? "portrait", cut: !!src && src !== file && src.startsWith("data:") };
}

export interface AgentFigureProps {
  name: string;
  /** the window's height (px); its width is the same unless `width` says otherwise */
  size: number;
  width?: number;
  /** a presence dot, when asked for */
  online?: boolean;
  className?: string;
  /** a still to draw instead of the roster's (the design page, which has no server) */
  still?: { src: string; role?: string; cut?: boolean };
}

export function AgentFigure({ name, size, width, online, className = "", still }: AgentFigureProps) {
  const dot = online !== undefined && <span className={`chat-presence${online ? " is-on" : ""}`} aria-label={online ? "online" : "away"} />;
  if (figureForm(size) === "spark") {
    return (
      <span className={`chat-figure is-spark ${className}`} style={{ width: width ?? size, height: size, fontSize: Math.max(9, Math.round(size * 0.62)) }} aria-hidden data-agent-figure={name} data-figure-form="spark">
        ✦{dot}
      </span>
    );
  }
  return <FigureWindow name={name} w={width ?? size} h={size} dot={dot} className={className} still={still} />;
}

function FigureWindow({ name, w, h, dot, className, still }: { name: string; w: number; h: number; dot: React.ReactNode; className: string; still?: AgentFigureProps["still"] }) {
  const worn = useAgentStill(name);
  const { src, role, cut } = still ? { src: still.src, role: still.role ?? "portrait", cut: still.cut ?? true } : worn;
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const [broken, setBroken] = useState<string | null>(null);
  const has = !!src && broken !== src;
  const f = figureFrame(role, { w, h }, aspect);
  return (
    <span className={`chat-figure${has ? " has-still" : " is-none"}${has && !cut ? " is-tile" : ""} ${className}`} style={{ width: w, height: h }} aria-hidden data-agent-figure={name} data-figure-form="figure">
      <span className="chat-figure-window">
        {has ? (
          <img
            src={src}
            alt=""
            draggable={false}
            style={{ width: f.w, height: f.h, left: f.left, top: f.top }}
            onLoad={(e) => {
              const i = e.currentTarget;
              if (i.naturalWidth && i.naturalHeight) setAspect(i.naturalWidth / i.naturalHeight);
            }}
            onError={() => setBroken(src ?? null)}
          />
        ) : (
          <span className="chat-figure-spark" style={{ fontSize: Math.max(11, Math.round(h * 0.5)) }}>
            ✦
          </span>
        )}
      </span>
      <i className="chat-figure-line" data-figure-baseline />
      {dot}
    </span>
  );
}
