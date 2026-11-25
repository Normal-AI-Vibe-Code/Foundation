/**
 * A fed table's lens (2026-11-24, Josh: "a table that has a prompt or set of filters to pull out information
 * from BomForm"). Shown on a table only while a wire is into it (and after it came off, to say so): where its
 * rows come from, what the server last did with them (reading, how many passed, why it failed), and the lens
 * a person sets — which rows (a filter) and which columns. The server refills the table from it
 * (apps/server/src/flows.ts); the lens is the table's own, so ⌘Z takes a change back.
 */

import { useCallback, useState, useSyncExternalStore } from "react";
import { boardMaps, TABLE_PORT, type FlowState } from "@foundation/protocol";
import { getState, setTableFeed, subscribe, type TableMeta } from "../state/store";
import { useActiveBoard } from "../shell/Presence";
import { endPanel } from "../shell/ports";

const linksOf = () => getState().links;

function useFlow(tableId: string): FlowState | undefined {
  const board = useActiveBoard();
  const sub = useCallback(
    (fn: () => void) => {
      if (!board) return () => {};
      const m = boardMaps(board.doc).flows;
      const on = (e: { keysChanged: Set<string> }) => e.keysChanged.has(tableId) && fn();
      m.observe(on);
      return () => m.unobserve(on);
    },
    [board, tableId],
  );
  return useSyncExternalStore(sub, () => (board ? boardMaps(board.doc).flows.get(tableId) : undefined));
}

export function TableFeed({ table }: { table: TableMeta }) {
  const links = useSyncExternalStore(subscribe, linksOf);
  const flow = useFlow(table.id);
  const feed = Object.values(links)
    .filter((l) => l.to.panel === table.id && l.to.port === TABLE_PORT)
    .pop();
  const [filter, setFilter] = useState(table.feed?.filter ?? "");
  const [columns, setColumns] = useState(table.feed?.columns ?? "");
  const [seen, setSeen] = useState(table.feed);
  // someone else (or an undo) changed the lens: show theirs
  if (seen !== table.feed) {
    setSeen(table.feed);
    setFilter(table.feed?.filter ?? "");
    setColumns(table.feed?.columns ?? "");
  }
  if (!feed && flow?.status !== "unfed") return null;
  const st = getState();
  const from = feed ? (endPanel(feed.from.panel)?.name ?? st.tables[feed.from.panel]?.name ?? st.notes[feed.from.panel]?.name ?? "a card") : flow?.from;
  const commit = () => setTableFeed(table.id, { ...table.feed, filter, columns });
  const say = !feed
    ? { tone: "idle", text: `No longer fed: its wire from ${from ?? "its source"} came off. It keeps its last rows.` }
    : !flow || flow.status === "working"
      ? { tone: "working", text: `Reading ${from}…` }
      : flow.status === "waiting" || flow.status === "unfed"
        ? { tone: "idle", text: `Waiting for ${from}: nothing has arrived yet` }
        : flow.status === "error"
          ? { tone: "bad", text: flow.error ?? "failed" }
          : { tone: "ok", text: `${flow.rows ?? 0} of ${flow.total ?? 0} rows from ${from} pass` };
  const field = (label: string, value: string, set: (v: string) => void, placeholder: string, attr: string) => (
    <label>
      <span>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        {...{ [attr]: "" }}
        onChange={(e) => set(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
  return (
    <div className={`table-feed is-${say.tone}`} data-table-feed={table.id} onPointerDown={(e) => e.stopPropagation()}>
      <span className="table-feed-say">
        <span className="table-feed-dot" aria-hidden />
        {say.text}
      </span>
      {feed && (
        <span className="table-feed-lens">
          {field("Rows where", filter, setFilter, "itemsOpen > 0; stage ~ test", "data-feed-filter")}
          {field("Columns", columns, setColumns, "every column", "data-feed-columns")}
        </span>
      )}
    </div>
  );
}
