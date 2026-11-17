/**
 * The update card: Foundation tells you a new version is ready, downloads and installs it when you
 * press Update, and says what changed after it restarts. One card, every phase:
 *  - `available`   a newer version is on the feed: Update and restart · Later · Skip this version;
 *  - `downloading` the signed installer is coming down (a bar, in MB when the size is known);
 *  - `installing`  the installer runs; Foundation restarts by itself;
 *  - `failed`      the download, the signature or the installer failed: Try again · Later;
 *  - `updated`     the first launch of a new version: what changed, once;
 *  - `checking` / `current` / `unreachable` / `off` for Settings → Updates.
 * Presentational: `UpdateShelf` passes the store in; `#/design` shows every phase at 260, 400 and
 * 560 px, day and night. Floating, it's glass (passing chrome); inline in Settings, it's paper.
 * It adapts to its own width (container queries), never the window's.
 */
import { AnimatePresence, motion } from "motion/react";
import { springs } from "@foundation/ui";
import { MARK_VIEWBOX, MarkPanels } from "../brand/Mark";
import { noteLines, progressLabel, shortDate } from "./policy";
import { checkForUpdate, closeCard, inDesktop, installUpdate, later, skipVersion, useUpdate, type UpdatePhase } from "./updater";
import { floorInsets, useUi } from "../state/ui";
import "./update.css";

export interface UpdateCardProps {
  phase: UpdatePhase;
  /** the version on offer (available → installing), or the version now running (updated, current) */
  version?: string | null;
  /** the version running now, shown as "You have 0.2.0" while an update is on offer */
  current?: string | null;
  /** release notes as published (Markdown); the card shows the first few lines */
  notes?: string | null;
  /** when the version was published (ISO date) */
  date?: string | null;
  received?: number;
  total?: number | null;
  /** what went wrong (failed), or why updates are off (off) */
  message?: string | null;
  /** the oldest client the server still works with, when this one is older: the card says so and offers no way round */
  required?: string | null;
  onReload?: () => void;
  layout?: "floating" | "inline";
  onUpdate?: () => void;
  onLater?: () => void;
  onSkip?: () => void;
  onCheck?: () => void;
  onClose?: () => void;
}

/** the app's own mark, small: the four panels, in the tile's phase colour */
function Mark() {
  return (
    <svg viewBox={MARK_VIEWBOX} aria-hidden>
      <MarkPanels />
    </svg>
  );
}

export function UpdateCard(p: UpdateCardProps) {
  const { phase, layout = "floating" } = p;
  const lines = noteLines(p.notes, phase === "updated" ? 6 : 3);
  const when = shortDate(p.date);
  const busy = phase === "downloading" || phase === "installing" || phase === "checking";
  const frac = phase === "downloading" && p.total ? Math.min(1, (p.received ?? 0) / p.total) : null;

  let title: string;
  let meta: string | null = null;
  switch (phase) {
    case "available":
      title = p.required ? `Foundation ${p.version} is needed` : `Foundation ${p.version} is ready`;
      meta = p.required
        ? `This server no longer works with ${p.current ?? "this version"}: boards won't sync until you update.`
        : [p.current ? `You have ${p.current}` : null, when].filter(Boolean).join(" · ") || null;
      break;
    case "downloading":
      title = `Downloading Foundation ${p.version}…`;
      meta = progressLabel(p.received, p.total);
      break;
    case "installing":
      title = `Installing Foundation ${p.version}…`;
      meta = "Foundation closes, installs and opens again by itself. Your boards are saved on this device.";
      break;
    case "failed":
      title = "The update didn’t finish";
      meta = p.message ?? "Nothing was changed. Foundation keeps the version you have.";
      break;
    case "updated":
      title = `Updated to Foundation ${p.version}`;
      meta = when ? `Published ${when}` : null;
      break;
    case "checking":
      title = "Checking for updates…";
      break;
    case "current":
      title = p.version ? `Foundation ${p.version} is up to date` : "Foundation is up to date";
      // the server needs a newer one than the feed has: only whoever publishes can fix that, so say so
      if (p.required) {
        title = `This server needs Foundation ${p.required} or newer`;
        meta = `You have ${p.current ?? p.version}, and no newer version has been published yet. Boards won't sync until one is: tell whoever runs this server.`;
      }
      break;
    case "unreachable":
      title = p.required ? `This server needs Foundation ${p.required} or newer` : "Couldn’t reach the update feed";
      meta = p.required
        ? `You have ${p.current ?? "an older version"}. ${p.message ?? "The update feed couldn't be reached."} Boards won't sync until you update.`
        : (p.message ?? "Foundation works offline as usual and checks again next time it opens.");
      break;
    case "off":
      title = p.required ? `This server needs Foundation ${p.required} or newer` : "Updates come with the desktop app";
      meta = p.message ?? null;
      break;
  }

  return (
    <section
      className={`update-card${layout === "floating" ? " f-glass" : ""}`}
      data-phase={phase}
      data-layout={layout}
      data-required={p.required ? "" : undefined}
      role={layout === "floating" ? "status" : undefined}
      aria-live="polite"
      aria-busy={busy || undefined}
    >
      <div className="update-card-body">
        <span className="update-card-glyph" data-phase={phase}>
          <Mark />
        </span>
        <div className="update-card-text">
          <strong>{title}</strong>
          {meta && <p className={phase === "failed" ? "update-card-error" : undefined}>{meta}</p>}
          {lines.length > 0 && (phase === "available" || phase === "updated") && (
            <ul className="update-card-notes">
              {lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {phase === "downloading" && (
            <div
              className="update-card-bar"
              role="progressbar"
              aria-label="Download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={frac === null ? undefined : Math.round(frac * 100)}
              data-indeterminate={frac === null || undefined}
            >
              {/* scaled, not resized: the bar's fill stays on the compositor */}
              <i style={frac === null ? undefined : { transform: `scaleX(${frac})` }} />
            </div>
          )}
        </div>
        {(phase === "updated" || (layout === "floating" && phase === "unreachable")) && p.onClose && (
          <button className="update-card-close" aria-label="Close" onClick={p.onClose}>
            ×
          </button>
        )}
      </div>

      {phase === "available" && (
        <div className="update-card-actions">
          <button className="f-pill is-accent" onClick={p.onUpdate}>
            Update and restart
          </button>
          {p.onLater && (
            <button className="f-pill" onClick={p.onLater}>
              Later
            </button>
          )}
          {p.onSkip && (
            <button className="update-card-quiet" onClick={p.onSkip}>
              Skip this version
            </button>
          )}
        </div>
      )}
      {phase === "failed" && (
        <div className="update-card-actions">
          <button className="f-pill is-accent" onClick={p.onUpdate}>
            Try again
          </button>
          {p.onLater && (
            <button className="f-pill" onClick={p.onLater}>
              Later
            </button>
          )}
        </div>
      )}
      {(phase === "current" || phase === "unreachable") && p.onCheck && (
        <div className="update-card-actions">
          <button className="f-pill" onClick={p.onCheck}>
            Check again
          </button>
        </div>
      )}
      {phase === "off" && p.required && p.onReload && (
        <div className="update-card-actions">
          <button className="f-pill is-accent" onClick={p.onReload}>
            Reload
          </button>
        </div>
      )}
      {phase === "updated" && layout === "floating" && p.onClose && (
        <div className="update-card-actions">
          <button className="f-pill" onClick={p.onClose}>
            Got it
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The floating card, top right under the bar, while the store says it's shown. Mounted once by the app.
 * `day` pins it to day tokens over the sign-in page, which is always paper whatever the room.
 */
export function UpdateShelf({ day = false }: { day?: boolean }) {
  const u = useUpdate();
  const ui = useUi();
  const show = u.shown && u.phase !== "idle";
  // beside the pane on the right (search, or the agents) when it's open, not over it (a card that has to stay up would sit on it)
  const paneR = floorInsets(ui).right;
  const clear = !day && paneR ? { right: paneR + 16 } : undefined;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className={`update-shelf${day ? " f-day" : ""}`}
          style={clear}
          initial={{ opacity: 0, y: -12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.16 } }}
          transition={{ type: "spring", ...springs.pop }}
        >
          <UpdateCard
            phase={u.phase as UpdatePhase}
            version={u.version}
            current={u.current}
            notes={u.notes}
            date={u.date}
            received={u.received}
            total={u.total}
            message={u.message}
            required={u.required}
            onUpdate={() => void installUpdate()}
            // an update the server needs isn't one to put off: no Later, no Skip, no close
            onLater={u.required ? undefined : later}
            onSkip={u.required ? undefined : skipVersion}
            onClose={u.required ? undefined : closeCard}
            onCheck={u.required ? () => void checkForUpdate(true) : undefined}
            onReload={u.required && !inDesktop ? () => window.location.reload() : undefined}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Settings → Updates: the running version and Check for updates (ignores Later and Skip). */
export function UpdatesSection() {
  const u = useUpdate();
  const phase: UpdatePhase = u.phase === "idle" ? "current" : (u.phase as UpdatePhase);
  return (
    <section className="update-settings" aria-labelledby="update-settings-h">
      <h2 id="update-settings-h">Updates</h2>
      <p className="design-lede">
        The desktop app checks for a new version a few seconds after it opens, and asks before it installs anything. Each installer is signed; one that
        doesn’t match Foundation’s key is refused.
      </p>
      {u.phase === "idle" ? (
        <div className="update-settings-row">
          <span className="update-settings-version">{u.current ? `Foundation ${u.current}` : "Foundation in a browser"}</span>
          <button className="f-pill" onClick={() => void checkForUpdate(true)}>
            Check for updates
          </button>
        </div>
      ) : (
        <UpdateCard
          layout="inline"
          phase={phase}
          version={u.phase === "current" ? u.current : u.version}
          current={u.current}
          notes={u.notes}
          date={u.date}
          received={u.received}
          total={u.total}
          message={u.message}
          required={u.required}
          onUpdate={() => void installUpdate()}
          onCheck={() => void checkForUpdate(true)}
          onClose={closeCard}
        />
      )}
    </section>
  );
}
