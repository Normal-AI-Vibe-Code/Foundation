/**
 * The upload tray: one glass card at the bottom right while files are on
 * their way (passing chrome, so glass). Its head says how many and how much,
 * a thin meter fills under it, and the files follow as rows: waiting, a
 * percentage, ✓, or what went wrong with Retry. It goes by itself a beat
 * after everything lands; anything that failed keeps it open.
 *
 * It also takes files pasted onto the board (lib/ingest.ts pasteFiles):
 * they land where the pointer is, in the section under it.
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { dismissUploads, foldUploads, retryAllUploads, retryUpload, uploadTotals, useUploads, type UploadItem } from "../lib/uploads";
import { pasteFiles } from "../lib/ingest";
import { floorInsets, getUi, useUi } from "../state/ui";

export function UploadTray() {
  const s = useUploads();
  const ui = useUi();
  usePasteIntake();
  const right = 16 + floorInsets(ui).right;
  return (
    <AnimatePresence>
      {s.items.length > 0 && !ui.presenting && (
        <motion.div
          key="tray"
          className="upload-tray-place"
          style={{ right }}
          initial={{ opacity: 0, y: 18, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 320, damping: 28 }}
        >
          <TrayView items={s.items} folded={s.folded} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const MB = 1024 * 1024;
function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

/** the tray itself; the design page shows it in each state without uploading */
export function TrayView({ items, folded, demo }: { items: UploadItem[]; folded: boolean; demo?: boolean }) {
  const t = uploadTotals(items);
  const tone = t.failed ? "bad" : t.busy ? "busy" : "ok";
  const title = t.busy
    ? `Uploading ${Math.min(t.done + t.failed + 1, t.total)} of ${t.total}`
    : t.failed
      ? `${t.failed} didn't upload`
      : `${t.total} added`;
  const act = (fn: () => void) => (demo ? undefined : fn);
  return (
    <section className={`upload-tray f-glass is-${tone}${folded ? " is-folded" : ""}`} aria-label="Uploads" aria-live="polite">
      <header className="upload-head">
        <span className="upload-state" aria-hidden>
          {tone === "ok" ? "✓" : tone === "bad" ? "!" : <i className="upload-spin" />}
        </span>
        <span className="upload-title">{title}</span>
        <span className="upload-size">
          {t.busy ? `${size(t.loaded)} of ${size(t.size)}` : size(t.size)}
        </span>
        <button className="upload-btn" data-tip={folded ? "Show the files" : "Fold"} aria-label={folded ? "Show the files" : "Fold"} onClick={act(() => foldUploads(!folded))}>
          <span className={`upload-chev${folded ? " is-up" : ""}`}>⌄</span>
        </button>
        {!t.busy && (
          <button className="upload-btn" data-tip="Close" aria-label="Close" onClick={act(dismissUploads)}>
            ✕
          </button>
        )}
      </header>
      <div className="upload-meter" aria-hidden>
        <i style={{ transform: `scaleX(${t.fraction})` }} />
      </div>
      {!folded && (
        <ol className="upload-list">
          {items.map((it) => (
            <Row key={it.id} it={it} onRetry={act(() => retryUpload(it.id))} />
          ))}
        </ol>
      )}
      {!folded && t.failed > 0 && !t.busy && (
        <footer className="upload-foot">
          <span>Their cards wait for them. Close to give up.</span>
          {t.failed > 1 && (
            <button className="f-pill is-accent upload-retry-all" onClick={act(retryAllUploads)}>
              Retry all
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

function Row({ it, onRetry }: { it: UploadItem; onRetry?: () => void }) {
  const dir = it.path && it.path.includes("/") ? it.path.slice(0, it.path.lastIndexOf("/") + 1) : "";
  const pct = it.size ? Math.round((100 * it.loaded) / it.size) : 0;
  return (
    <li className={`upload-row is-${it.state}`}>
      <span className="upload-row-glyph" aria-hidden>
        {it.state === "done" ? "✓" : it.state === "failed" ? "!" : it.state === "sending" ? "↑" : "·"}
      </span>
      <span className="upload-row-main">
        <span className="upload-row-name">
          {dir && <span className="upload-row-dir">{dir}</span>}
          {it.name}
        </span>
        {it.state === "failed" && <span className="upload-row-err">{it.error}</span>}
      </span>
      {it.state === "failed" ? (
        <button className="upload-row-retry" onClick={onRetry}>
          Retry
        </button>
      ) : (
        <span className="upload-row-pct">{it.state === "waiting" ? "waiting" : it.state === "done" ? size(it.size) : `${pct}%`}</span>
      )}
      {it.state === "sending" && (
        <span className="upload-row-bar" aria-hidden>
          <i style={{ transform: `scaleX(${pct / 100})` }} />
        </span>
      )}
    </li>
  );
}

/** paste files onto the board: where the pointer is, unless someone is typing */
function usePasteIntake() {
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    const paste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || getUi().presenting || getUi().command) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), .cm-editor, .xterm")) return;
      const cd = e.clipboardData;
      if (!cd) return;
      let files = [...cd.files];
      if (!files.length) files = [...cd.items].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
      if (pasteFiles(files, pointer.current)) e.preventDefault();
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("paste", paste);
    };
  }, []);
}
