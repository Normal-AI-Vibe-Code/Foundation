/**
 * The card that stands for another grid (`panel: "grid"`), drawn from what the server says that grid
 * holds (`GET /api/boards/:id/outline`): its name, what's in it, **Open the grid →**, and a preview of
 * it: its sections in miniature at their places, each with its cards as small blocks (an image as the
 * image).
 *
 * Two states (2026-11-17, Josh: "still maintain a preview in the Grid it used to be in, and maintain a
 * link to the new location"):
 *  - the grid is inside this one: *A grid inside this one*;
 *  - the grid was here and moved (to the top of All Grids, or into another grid): *A grid that was
 *    here*, a quiet line under the name and what it holds saying where it is now (the other grid's name is a press), and
 *    the same preview and Open. A person may take the card away.
 *
 * Only what it's given: the body (SystemCards) reads the server; `#/design` hands it a made-up grid.
 */

import { serverUrl } from "../lib/api";
import { KIND_GLYPH, type SpaceKind } from "../lib/grids";

export interface OutlineCard {
  id: string;
  kind: string;
  name: string;
  w: number;
  h: number;
  x: number;
  y: number;
  float: boolean;
  thumb?: string;
}
export interface OutlineSection {
  id: string;
  name: string;
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  cards: number;
  grids: number;
  host?: string;
  items: OutlineCard[];
}
export interface Outline {
  id: string;
  name: string;
  parent: string | null;
  parentName: string | null;
  tracks: { cols: number[]; rows: number[] };
  sections: OutlineSection[];
  cards: number;
  updatedAt: number | null;
}

/** a card's mark in the miniature (pictures show themselves) */
const GLYPH: Record<string, string> = {
  note: "▤",
  table: "⊞",
  map: "◍",
  video: "▶",
  image: "▨",
  app: "◳",
  link: "↗",
  file: "▯",
  machine: "▣",
  huddle: "◐",
  slack: "#",
  character: "☺",
  grid: "▦",
  kanban: "▥",
  connector: "⇄",
  agent: "✦",
  crew: "✦",
  ask: "?",
  stage: "◈",
  pipeline: "⇢",
  design: "◆",
  replay: "◷",
  chat: "#",
};

const sum = (xs: number[], a: number, b: number) => xs.slice(a, b).reduce((n, x) => n + x, 0);
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;

/** how many pictures a preview loads; the rest are blocks */
const THUMBS = 8;

/** a grid in miniature: its sections at their places, their cards as blocks */
export function GridPreview({ outline, thumbs = true }: { outline: Outline; thumbs?: boolean }) {
  const { cols, rows } = outline.tracks;
  const W = Math.max(1, sum(cols, 0, cols.length));
  const H = Math.max(1, sum(rows, 0, rows.length));
  let pictures = 0;
  return (
    <div className="grid-preview" style={{ ["--gp-ratio" as string]: String(W / H) }} data-grid-preview={outline.id}>
      {outline.sections.map((s) => {
        const w = Math.max(1, sum(cols, s.c0, s.c1 + 1));
        const hosted = s.host ? s.items.find((i) => i.id === s.host) : undefined;
        return (
          <div
            key={s.id}
            className={`gp-sec${hosted ? " is-hosted" : ""}${s.grids ? " is-grid" : ""}`}
            style={{ left: pct(sum(cols, 0, s.c0) / W), top: pct(sum(rows, 0, s.r0) / H), width: pct(w / W), height: pct(sum(rows, s.r0, s.r1 + 1) / H) }}
            data-gp-section={s.name}
          >
            <span className="gp-head">
              <span className="gp-name">{s.name}</span>
              <span className="gp-count">{s.grids ? `▦ ${s.grids}` : s.cards || ""}</span>
            </span>
            <span className="gp-cards">
              {(hosted ? [hosted] : s.items).map((c) => {
                const picture = thumbs && c.thumb && pictures < THUMBS ? (pictures++, c.thumb) : null;
                return (
                  <span
                    key={c.id}
                    className={`gp-card is-${c.kind}${picture ? " is-picture" : ""}`}
                    style={hosted ? undefined : { width: pct(Math.min(1, c.w / (w * 0.94))), aspectRatio: `${Math.max(1, c.w)} / ${Math.max(1, c.h)}` }}
                    data-gp-card={c.kind}
                    title={c.name}
                  >
                    {picture ? (
                      <img src={serverUrl(picture)} alt="" loading="lazy" decoding="async" draggable={false} />
                    ) : (
                      <>
                        <span className="gp-glyph" aria-hidden>
                          {GLYPH[c.kind] ?? "▫"}
                        </span>
                        <span className="gp-label">{c.name}</span>
                      </>
                    )}
                  </span>
                );
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export interface GridLinkCardProps {
  board: string;
  name: string;
  kind?: SpaceKind;
  outline: Outline | null;
  /** the grid this card is on (null: not known, so it never reads as moved) */
  here: string | null;
  /** the grids inside the one it stands for */
  inside?: Array<{ id: string; name: string; kind?: SpaceKind }>;
  onOpen(): void;
  onOpenGrid?(id: string): void;
  /** open the grid it's inside now, framed on it there */
  onOpenWhere?(parent: string): void;
  /** a writer may take a card for a grid that moved away off this grid */
  onRemove?(): void;
  thumbs?: boolean;
}

export function GridLinkCard({ board, name, kind = "grid", outline, here, inside = [], onOpen, onOpenGrid, onOpenWhere, onRemove, thumbs }: GridLinkCardProps) {
  const moved = !!outline && !!here && outline.parent !== here;
  return (
    <div className={`grid-link${moved ? " is-moved" : ""}`} data-grid-link={board} data-grid-moved={moved ? (outline!.parent ?? "top") : undefined}>
      <div className="grid-link-top">
        <button className="grid-link-open" onClick={onOpen} aria-label={`Open ${name}`}>
          <span className="grid-link-eyebrow f-eyebrow">{moved ? "A grid that was here" : "A grid inside this one"}</span>
          <span className="grid-link-name">
            <span className="grid-link-glyph">{KIND_GLYPH[kind]}</span>
            {name}
          </span>
          <span className="grid-link-facts">
            {outline ? (
              <>
                {outline.sections.length} {outline.sections.length === 1 ? "section" : "sections"} · {outline.cards} {outline.cards === 1 ? "card" : "cards"}
                {inside.length > 0 && ` · ${inside.length} ${inside.length === 1 ? "grid" : "grids"} inside`}
              </>
            ) : (
              "Reading it…"
            )}
          </span>
        </button>
        {moved && (
          <p className="grid-link-moved" data-grid-where>
            <span aria-hidden>↗</span>
            <span>
              Moved out: now{" "}
              {outline!.parent ? (
                <>
                  inside{" "}
                  <button type="button" className="grid-link-where" onClick={() => onOpenWhere?.(outline!.parent!)}>
                    {outline!.parentName ?? "another grid"}
                  </button>
                </>
              ) : (
                "at the top of All Grids"
              )}
              . This is a preview of it.
            </span>
            {onRemove && (
              <button type="button" className="grid-link-remove" onClick={onRemove} data-tip="Take this card off the grid. The grid itself is untouched">
                Remove this link
              </button>
            )}
          </p>
        )}
        <button className="grid-link-go f-pill is-accent" onClick={onOpen} tabIndex={-1}>
          Open the grid →
        </button>
      </div>
      {outline && outline.sections.length > 0 && (
        <button className="grid-link-preview" onClick={onOpen} aria-label={`${name}, in miniature. Open it`} data-tip="Open the grid">
          <GridPreview outline={outline} thumbs={thumbs} />
        </button>
      )}
      {inside.length > 0 && (
        <div className="grid-link-kids">
          {inside.map((k) => (
            <button key={k.id} className="f-pill" onClick={() => onOpenGrid?.(k.id)}>
              {KIND_GLYPH[k.kind ?? "grid"]} {k.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
