/**
 * The Changes panel's Releases face (shell/Tools.tsx), 2026-11-27, Josh: "keep a strong sense of history in
 * the updates panel, and keep the version number prominent in that panel and the latest changes".
 *
 * On top, this app: its version set large, when it was released, and what it changed (for a checkout, the
 * commits it is ahead of that release by, not released yet). Under it, every release Foundation has had
 * (docs/releases.json, settings/history.ts): a strip of the days they came out on, then each day with its
 * releases, each opening to its changes and, where a person wrote one, its post (docs/blog).
 */

import { useMemo, useState } from "react";
import { Mark } from "../brand/Mark";
import { ReleaseCard, ReleaseKindGlyph } from "./ReleasePage";
import { longDate, releaseKind, type ReleasePost } from "./releases";
import { byDay, changesWord, dayKey, tally, type HistoryRelease, type Standing } from "./history";

/** "Thursday 26 November" for a release's day (as it was written, whatever the zone here) */
const dayWords = (day: string) => {
  const d = new Date(`${day}T12:00:00`);
  return isNaN(+d) ? day : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
};
/** "21:56" for the time a release was cut, in its own offset */
const timeWords = (iso: string) => /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? "";

function Changes({ changes, more }: { changes: string[]; more?: number }) {
  return (
    <ul className="history-changes">
      {changes.map((c, i) => (
        <li key={i}>
          <span className="history-change-glyph">
            <ReleaseKindGlyph kind={releaseKind(c)} size={13} />
          </span>
          {c}
        </li>
      ))}
      {!!more && <li className="history-more">and {changesWord(more)} more</li>}
    </ul>
  );
}

/** this app: the version, large, and its latest changes */
export function ReleaseNow({ st, posts, unreleased }: { st: Standing; posts: ReleasePost[]; unreleased: Array<{ hash: string; subject: string }> | null }) {
  const r = st.release;
  const post = posts.find((p) => p.version === st.version);
  const [notes, setNotes] = useState(false);
  return (
    <section className="history-now" data-history-now={st.kind} aria-label={`This app: Foundation ${st.version}`}>
      <div className="history-now-head">
        <Mark size={40} tone="inherit" className="history-now-mark" />
        <div className="history-now-words">
          <span className="history-eyebrow">{st.kind === "checkout" ? "This app · from the checkout" : "This app"}</span>
          <span className="history-now-version" data-version={st.version}>
            {st.version}
            {st.kind === "checkout" && <span className="history-now-ahead">+{st.ahead}</span>}
          </span>
          <span className="history-now-when">
            {r ? (
              <>
                released {longDate(dayKey(r.date))} · <code>{r.sha}</code>
              </>
            ) : (
              "not in the release history"
            )}
          </span>
        </div>
      </div>
      {st.newer && (
        <p className="history-newer">
          {st.newer.version} is the newest release ({longDate(dayKey(st.newer.date))}){st.kind === "checkout" ? ": this checkout doesn't have it yet." : ": the update card offers it."}
        </p>
      )}
      {st.kind === "checkout" && (
        <div className="history-block">
          <h4 className="history-h">Not released yet · {changesWord(st.ahead)}</h4>
          {unreleased === null ? <p className="tool-note">Reading the commits…</p> : unreleased.length ? <Changes changes={unreleased.map((c) => c.subject)} /> : <p className="tool-note">This checkout is {changesWord(st.ahead)} past {st.version}; the server's commits don't reach back to it.</p>}
        </div>
      )}
      {r && (
        <div className="history-block">
          <h4 className="history-h">
            {st.kind === "checkout" ? `What ${r.version} changed` : "What's new"} · {changesWord(r.changes.length + (r.more ?? 0))}
          </h4>
          <Changes changes={r.changes} more={r.more} />
        </div>
      )}
      {post && (
        <button type="button" className="release-more" aria-expanded={notes} onClick={() => setNotes((n) => !n)}>
          <span className={`release-caret${notes ? " is-open" : ""}`} aria-hidden>
            ›
          </span>
          {notes ? "Fold the notes" : `Read ${post.version}'s release notes`}
        </button>
      )}
      {post && notes && <ReleaseCard post={post} compact />}
    </section>
  );
}

/** releases per day across the whole span, as a strip of bars: how the history has gone */
function Rhythm({ releases }: { releases: HistoryRelease[] }) {
  const days = useMemo(() => {
    if (!releases.length) return [];
    const count = new Map<string, number>();
    for (const r of releases) count.set(dayKey(r.date), (count.get(dayKey(r.date)) ?? 0) + 1);
    const first = new Date(`${dayKey(releases[releases.length - 1].date)}T12:00:00Z`);
    const last = new Date(`${dayKey(releases[0].date)}T12:00:00Z`);
    const out: Array<{ day: string; n: number }> = [];
    for (let d = first; d <= last && out.length < 400; d = new Date(+d + 86_400_000)) {
      const day = d.toISOString().slice(0, 10);
      out.push({ day, n: count.get(day) ?? 0 });
    }
    return out;
  }, [releases]);
  const most = Math.max(1, ...days.map((d) => d.n));
  return (
    <div className="history-rhythm" role="img" aria-label={`Releases per day, ${days.length} days`}>
      {days.map((d) => (
        <span key={d.day} className={`history-rhythm-day${d.n ? "" : " is-none"}`} style={{ height: `${d.n ? 18 + (82 * d.n) / most : 6}%` }} data-tip={`${longDate(d.day)} · ${d.n} ${d.n === 1 ? "release" : "releases"}`} />
      ))}
    </div>
  );
}

/** every release, by day, newest first */
export function ReleaseHistory({ releases, posts, running }: { releases: HistoryRelease[]; posts: ReleasePost[]; running: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const t = tally(releases);
  const days = useMemo(() => byDay(releases), [releases]);
  if (!releases.length) return <p className="tool-note">No releases yet: `node scripts/release.mjs history` writes them from the tags.</p>;
  return (
    <section className="history" aria-label="Every release">
      <h4 className="history-h">History</h4>
      <p className="history-tally">
        <b>{t.releases}</b> releases · <b>{t.changes}</b> changes · on {t.days} days since {t.since ? longDate(t.since) : "the start"}
      </p>
      <Rhythm releases={releases} />
      {days.map(({ day, releases: rs }) => (
        <div key={day} className="history-day">
          <div className="tool-day">
            {dayWords(day)} <span>{rs.length}</span>
          </div>
          <ol className="history-list">
            {rs.map((r) => {
              const post = posts.find((p) => p.version === r.version);
              const isOpen = open === r.version;
              const n = r.changes.length + (r.more ?? 0);
              return (
                <li key={r.version} className={`history-row${isOpen ? " is-open" : ""}${r.version === running ? " is-running" : ""}`} data-history-release={r.version}>
                  <button type="button" className="history-row-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.version)}>
                    <span className="history-pill">{r.version}</span>
                    <span className="history-row-title">{post?.title ?? r.title}</span>
                    <span className="history-row-meta">
                      {r.version === running && <span className="releases-running">this app</span>}
                      {post && <span className="history-has-post">notes</span>}
                      {changesWord(n)} · {timeWords(r.date)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="history-row-body">
                      <Changes changes={r.changes} more={r.more} />
                      <span className="history-row-sha">
                        cut from <code>{r.sha}</code>
                      </span>
                      {post && <ReleaseCard post={post} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}
