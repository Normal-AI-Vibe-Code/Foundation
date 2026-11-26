/**
 * A fed CAD card's strip (2026-11-25, docs/cad-feed.md): where its model comes from ("From Airform BOM · Fan hub,
 * rev C"), when it last changed and was last checked, what it waits on or what went wrong, and Refresh for people
 * who can write. Cut the wire from the app and it says it's unlinked: it keeps its last model and isn't refreshed.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { cadLinked, type CadFeed } from "@foundation/protocol";
import { getState, subscribe, type PanelMeta } from "../state/store";
import { toast, useUi } from "../state/ui";
import { api } from "../lib/api";
import { activeBoard } from "../sync/board";
import { feedWords } from "./feedWords";

/** the strip as drawn: the design page shows it in every state */
export function CadFeedStripView({ feed, linked, canRefresh, busy, onRefresh, now }: { feed: CadFeed; linked: boolean; canRefresh: boolean; busy?: boolean; onRefresh?: () => void; now: number }) {
  const w = feedWords(feed, linked, now);
  const dot = w.tone === "ok" ? " is-ok" : w.tone === "waiting" ? " is-warn is-live" : w.tone === "error" ? " is-bad" : "";
  return (
    <div className={`cad-feed is-${w.tone}`} role="status">
      <span className={`f-dot${dot}`} aria-hidden />
      <div className="cad-feed-text">
        <div className="cad-feed-source" title={w.source}>
          {w.source}
        </div>
        {(w.note || w.when) && (
          <div className="cad-feed-meta">
            {w.note && <span className="cad-feed-note">{w.note}</span>}
            {w.note && w.when && <span aria-hidden> · </span>}
            {w.when && <span>{w.when}</span>}
          </div>
        )}
      </div>
      {linked && canRefresh && (
        <button className="f-pill cad-feed-refresh" disabled={busy} onClick={onRefresh} data-tip={`Ask ${feed.appName || "the app"} for the model again`}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      )}
    </div>
  );
}

/** the strip on a live card: wired or not, from the board's links; Refresh asks the server */
export function CadFeedStrip({ panel }: { panel: PanelMeta & { feed: CadFeed } }) {
  const linked = useSyncExternalStore(subscribe, () => cadLinked(Object.values(getState().links), panel));
  const canRefresh = useUi().role !== "viewer";
  const [busy, setBusy] = useState(false);
  // the times move on by themselves
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [panel.feed.checkedAt, panel.feed.changedAt]);
  const refresh = async () => {
    const board = activeBoard()?.boardId;
    if (!board || busy) return;
    setBusy(true);
    try {
      await api<{ feed: CadFeed }>(`/api/boards/${encodeURIComponent(board)}/cad/${encodeURIComponent(panel.id)}/refresh`, { method: "POST" });
    } catch (e) {
      toast((e as Error).message || `${panel.feed.appName || "The app"} didn't give the model`, "bad");
    } finally {
      setBusy(false);
    }
  };
  return <CadFeedStripView feed={panel.feed} linked={linked} canRefresh={canRefresh} busy={busy} onRefresh={() => void refresh()} now={now} />;
}
