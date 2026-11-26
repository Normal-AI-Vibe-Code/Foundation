/** #/design: a fed CAD card's strip in each state, at 260, 400 and 560 px (cad/CadFeedStrip.tsx). No server, no model. */
import type { CadFeed } from "@foundation/protocol";
import { CadFeedStripView } from "../cad/CadFeedStrip";

const NOW = Date.UTC(2026, 10, 25, 15, 0);
const base: CadFeed = {
  app: "pnl_bom",
  appName: "Airform BOM",
  tool: "get_part_model",
  args: { part: "FH-210" },
  label: "Fan hub, rev C",
  sha: "4be1…",
  checkedAt: NOW - 20_000,
  changedAt: NOW - 3 * 3600_000,
  state: "ok",
  by: "josh",
};

const STATES: Array<{ title: string; feed: CadFeed; linked: boolean; canRefresh: boolean; busy?: boolean }> = [
  { title: "Linked", feed: base, linked: true, canRefresh: true },
  { title: "Refreshing", feed: base, linked: true, canRefresh: true, busy: true },
  { title: "Waiting", feed: { ...base, state: "waiting", note: "Waiting for a person's Allow on Airform BOM's card" }, linked: true, canRefresh: true },
  { title: "Error", feed: { ...base, state: "error", note: "Airform BOM answered: no part FH-210 in this BOM" }, linked: true, canRefresh: true },
  { title: "Unlinked", feed: base, linked: false, canRefresh: true },
  { title: "Viewer", feed: base, linked: true, canRefresh: false },
];

export function CadFeedDemo() {
  return (
    <>
      {[560, 400, 260].map((w) => (
        <div className="adapt-row" key={w}>
          {STATES.filter((_, i) => w === 560 || i % 2 === (w === 400 ? 0 : 1)).map((s) => (
            <div key={s.title} style={{ width: w }}>
              <div className="design-note">
                {s.title} · {w} px
              </div>
              <CadFeedStripView feed={s.feed} linked={s.linked} canRefresh={s.canRefresh} busy={s.busy} now={NOW} />
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
