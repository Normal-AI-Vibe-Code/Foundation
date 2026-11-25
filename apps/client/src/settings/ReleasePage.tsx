/**
 * A release, drawn as a release page (2026-11-18, Josh: "Changes should be a little more designed like a
 * release page, perhaps some images, diagrams or icons, a small description below").
 *
 * Each post (docs/blog/<version>.md) is a card: a cover with Foundation's mark and the version set large;
 * the title; the post's opening paragraph as the description; a one-line diagram of what the release is
 * made of (a bar cut in proportion to its parts, in the data colours); and each part as a tile: its icon,
 * its name, one sentence, and how many things it lists. All of it is read from the post itself
 * (settings/releases.ts → outlinePost): nothing is written twice. The full notes open under the tiles, and
 * a tile opens them at its own part.
 *
 * On tokens only, so it wears the theme of the place it's in: white over the room on Today, ink on paper
 * on a grid. Shown by the Changes tool (shell/Tools.tsx) and in Settings → Releases.
 */

import "./release-page.css";
import { useMemo, useRef, useState } from "react";
import { Mark } from "../brand/Mark";
import { renderMarkdown } from "../utils/markdown";
import { longDate, outlinePost, type ReleaseKind, type ReleaseOutline, type ReleasePost } from "./releases";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** a part's icon, by what it's about */
export function ReleaseKindGlyph({ kind, size = 16 }: { kind: ReleaseKind; size?: number }) {
  const d: Record<ReleaseKind, React.ReactNode> = {
    // a four-point spark: something new
    new: <path d="M8 2.2l1.5 4.3 4.3 1.5-4.3 1.5L8 13.8l-1.5-4.3L2.2 8l4.3-1.5z" />,
    // a wrench
    fix: <path d="M10.6 2.4a3.4 3.4 0 00-3.2 4.5L2.6 11.7a1.2 1.2 0 001.7 1.7l4.8-4.8a3.4 3.4 0 004.5-3.2l-2 2-1.7-.5-.5-1.7z" />,
    // three figures: agents
    agent: (
      <>
        <circle cx="8" cy="5" r="2" />
        <path d="M4.4 13c.3-2.2 1.7-3.4 3.6-3.4s3.3 1.2 3.6 3.4M3.2 7.4a1.5 1.5 0 100-3M12.8 7.4a1.5 1.5 0 110-3" />
      </>
    ),
    // columns of cards: the plan
    plan: (
      <>
        <rect x="2.2" y="2.6" width="3.2" height="10.8" rx="1" />
        <rect x="6.4" y="2.6" width="3.2" height="7" rx="1" />
        <rect x="10.6" y="2.6" width="3.2" height="9" rx="1" />
      </>
    ),
    // a box with an arrow coming down into it: a release
    release: <path d="M8 2.2v7M5.2 6.6L8 9.4l2.8-2.8M2.8 10.4v2.2a1 1 0 001 1h8.4a1 1 0 001-1v-2.2" />,
    search: (
      <>
        <circle cx="7" cy="7" r="4.2" />
        <path d="M10.2 10.2l3.4 3.4" />
      </>
    ),
    // the grid's own mark: sections
    grid: (
      <>
        <rect x="2.2" y="2.2" width="11.6" height="4.4" rx="1.2" />
        <rect x="2.2" y="9.4" width="4.8" height="4.4" rx="1.2" />
        <rect x="9" y="9.4" width="4.8" height="4.4" rx="1.2" />
      </>
    ),
    // a speech bubble
    talk: <path d="M3.4 3h9.2a1.2 1.2 0 011.2 1.2v5.6a1.2 1.2 0 01-1.2 1.2H8.2L5 13.6V11H3.4a1.2 1.2 0 01-1.2-1.2V4.2A1.2 1.2 0 013.4 3z" />,
    // a prompt
    machine: (
      <>
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
        <path d="M4.6 6.4l2 1.8-2 1.8M8.4 10.2h3" />
      </>
    ),
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...S}>
      {d[kind]}
    </svg>
  );
}

/** what a release is made of, as one bar: a segment per part, as long as the part lists things */
export function ReleaseBar({ outline }: { outline: ReleaseOutline }) {
  const total = outline.parts.reduce((n, p) => n + p.count, 0) || 1;
  return (
    <div className="release-bar" role="img" aria-label={`${outline.changes} changed or new, ${outline.fixes} fixed, in ${outline.parts.length} parts`}>
      {outline.parts.map((p, i) => (
        <span key={i} className="release-bar-seg" style={{ flexGrow: p.count / total, background: `var(--viz-${(i % 8) + 1})` }} data-tip={`${p.title} · ${p.count}`} />
      ))}
    </div>
  );
}

const things = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ReleaseCard({ post, running, open = false, compact = false }: { post: ReleasePost; running?: boolean; open?: boolean; /** no cover or title: the page around it has them (Settings → Releases) */ compact?: boolean }) {
  const outline = useMemo(() => outlinePost(post.body), [post.body]);
  const html = useMemo(() => renderMarkdown(post.body), [post.body]);
  const [full, setFull] = useState(open);
  const body = useRef<HTMLDivElement>(null);
  /** open the full notes at a part's own heading */
  const goTo = (i: number) => {
    setFull(true);
    requestAnimationFrame(() => body.current?.querySelectorAll("h2")[i]?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  return (
    <article className={`release-card${compact ? " is-compact" : ""}`} data-release={post.version}>
      {!compact && (
        <header className="release-cover">
          <Mark size={44} tone="inherit" className="release-mark" />
          <div className="release-cover-words">
            <span className="release-version">{post.version}</span>
            <span className="release-date">
              {longDate(post.date)}
              {running && <span className="releases-running">this app</span>}
            </span>
          </div>
        </header>
      )}
      {!compact && <h3 className="release-title">{post.title}</h3>}
      {outline.lede && !compact && <p className="release-lede">{outline.lede}</p>}
      <div className="release-made">
        <ReleaseBar outline={outline} />
        <span className="release-counts">
          {things(outline.changes, "change")} · {things(outline.fixes, "fix", "fixes")}
        </span>
      </div>
      <div className="release-tiles">
        {outline.parts.map((p, i) => (
          <button key={i} type="button" className="release-tile" onClick={() => goTo(i)} data-release-part={p.kind}>
            <span className="release-tile-glyph" style={{ color: `var(--viz-${(i % 8) + 1})` }}>
              <ReleaseKindGlyph kind={p.kind} />
            </span>
            <span className="release-tile-name">{p.title}</span>
            <span className="release-tile-count">{p.count}</span>
            <span className="release-tile-what">{p.summary}</span>
          </button>
        ))}
      </div>
      {!compact && (
        <button type="button" className="release-more" aria-expanded={full} onClick={() => setFull((f) => !f)}>
          <span className={`release-caret${full ? " is-open" : ""}`} aria-hidden>
            ›
          </span>
          {full ? "Fold the notes" : `All of ${post.version}'s notes`}
        </button>
      )}
      {(full || compact) && <div ref={body} className="note-rendered releases-body release-body" dangerouslySetInnerHTML={{ __html: html }} />}
    </article>
  );
}
