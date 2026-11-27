/**
 * Notifications on Today (2026-11-26, Josh: the bell was "a bit floating"): what was said to you, beside what wants
 * you. Mentions of you and direct messages in ChatForm (the bell's own list, chat/notify.ts, so pressing one here
 * marks it seen there too), and notes that tag you on a grid (Today's focus, today.ts). Each row is a link back to
 * where it happened: a chat row opens its channel (its thread, for a reply) at the message, flashed; a grid row opens
 * that grid and frames the card, in its section.
 *
 * A server that keeps no list of what was said to me falls back to Today's own chat items, one per conversation,
 * each opening at the message that named you (or the first you haven't read). `todayNotices` is pure and
 * `NoticeList` presentational, so `#/design` draws them from fixtures.
 */

import { PartyAvatar } from "../chat/Avatar";
import { ago } from "../chat/Message";
import { plainPress } from "../lib/goPlace";
import type { TodayNotice } from "./noticesLogic";
export { NOTICE_ROWS, noticeHref, placeHref, todayNotices, type TodayNotice } from "./noticesLogic";

/** one notification as a row of the Today panel: who (or @), the line, who/where/why and when, the place's pill */
export function NoticeItem({ n, now, onOpen, pointed }: { n: TodayNotice; now?: number; onOpen?(n: TodayNotice): void; pointed?: boolean }) {
  return (
    <a
      className={`today-row today-notice${n.unseen ? " is-unseen" : ""}`}
      href={n.href}
      onClick={(e) => {
        if (!onOpen || !plainPress(e)) return;
        e.preventDefault();
        onOpen(n);
      }}
      data-today-notice={n.id}
      data-source={n.source}
      data-unseen={n.unseen || undefined}
      data-tone={n.tone}
      data-pointed={pointed || undefined}
    >
      {n.who ? (
        <span className="today-glyph is-face" aria-hidden>
          <PartyAvatar party={n.who} size={32} />
        </span>
      ) : (
        <span className="today-glyph" aria-hidden>
          @
        </span>
      )}
      <span className="today-row-text">
        <span className="today-row-title">{n.title}</span>
        <span className="today-row-why">
          {n.why}
          {n.at > 0 && (
            <>
              {" · "}
              <time dateTime={new Date(n.at).toISOString()}>{ago(n.at, now)}</time>
            </>
          )}
        </span>
      </span>
      <span className="today-row-board" title={n.source === "chat" ? "Said in ChatForm" : `On ${n.where}`}>
        {n.unseen && <i className="today-notice-dot" aria-label="Not seen yet" />}
        {n.where}
      </span>
    </a>
  );
}

/** the section of the Today panel: its title and count, Mark all read, the rows, the way to all of them */
export function NoticeList(p: { rows: TodayNotice[]; unseen: number; busy?: boolean; now?: number; onOpen?(n: TodayNotice): void; onAll?(): void; onSeeAll?(): void; pointed?: Set<string> }) {
  return (
    <section className="today-group today-notices" aria-label="Notifications" data-today-notices>
      <h2 className="f-eyebrow">
        Notifications <span className="today-count" data-today-notices-count={p.unseen}>{p.unseen || ""}</span>
        {p.onAll && p.unseen > 0 && (
          <button type="button" className="today-notices-act" onClick={p.onAll} data-today-notices-all>
            Mark all read
          </button>
        )}
      </h2>
      {p.rows.length === 0 && (
        <p className="today-empty" role="status">
          {p.busy ? "Looking…" : "Nothing new for you. When someone mentions you, writes to you directly or tags you in a note on a grid, it's listed here, a press from where it was said."}
        </p>
      )}
      {p.rows.map((n) => (
        <NoticeItem key={n.id} n={n} now={p.now} onOpen={p.onOpen} pointed={p.pointed?.has(n.id)} />
      ))}
      {p.onSeeAll && (
        <button type="button" className="today-notices-act is-foot" onClick={p.onSeeAll} data-today-notices-see-all>
          Recent mentions in ChatForm
        </button>
      )}
    </section>
  );
}
