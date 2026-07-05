import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { workbook, parseImageRaw, isLinkRaw, IMG_PREFIX } from "../engine/workbook";
import { imageFileToDataURL, linkLabel, openExternal } from "../utils/media";
import { colToName } from "../engine/formula";
import {
  CELL_H,
  CELL_W,
  COLHEAD_H,
  HEADER_H,
  ROWNUM_W,
  TableMeta,
  liveObjPos,
  moveTable,
  removeTable,
  renameTable,
  requestSnap,
  resizeTable,
  setObjectFloat,
} from "../state/store";
import {
  endEditingSession,
  startEditingSession,
  tryInsertRef,
} from "../state/editing";
import { Spring2D, presets } from "../physics/spring";

interface Props {
  table: TableMeta;
  /** effective position (flow-layout slot when docked, free when floating) */
  framePos: { x: number; y: number };
  /** current camera scale, for converting screen drag deltas to world space */
  getScale(): number;
}

interface Sel {
  col: number;
  row: number;
}

function formatValue(v: number | string | boolean | null): string {
  if (v === null) return "";
  if (typeof v === "number") {
    if (!isFinite(v)) return "#NUM";
    const abs = Math.abs(v);
    if (abs !== 0 && (abs >= 1e12 || abs < 1e-6)) return v.toExponential(3);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(v);
  }
  return String(v);
}

export const TableView = memo(function TableView({ table, framePos, getScale }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const [sel, setSel] = useState<Sel | null>(null);
  const [editing, setEditing] = useState<Sel | null>(null);
  const [editText, setEditText] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [dropTarget, setDropTarget] = useState<Sel | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pulses = useRef(new Map<string, number>()); // coord -> expiry ts

  // ----- workbook subscription: re-render + pulse changed cells -----
  useEffect(() => {
    return workbook.subscribe(table.id, (changed) => {
      const now = performance.now();
      for (const coord of changed) pulses.current.set(coord, now + 700);
      force((n) => n + 1);
    });
  }, [table.id]);

  // ----- drag by header: spring-follow position for physical weight -----
  const pos = useMemo(
    () => new Spring2D(framePos.x, framePos.y, presets.drag),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table.id],
  );
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (x: number, y: number) => {
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      liveObjPos.set(table.id, { x, y });
    };
    apply(pos.x.value, pos.y.value);
    const unsub = pos.onChange(apply);
    return () => {
      unsub();
      liveObjPos.delete(table.id);
    };
  }, [pos, table.id]);

  // external position updates (flow reflow, dock/undock, other edits)
  useEffect(() => {
    if (!dragRef.current.active) pos.to(framePos.x, framePos.y);
  }, [framePos.x, framePos.y, pos]);

  const dragRef = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, input")) return;
      e.stopPropagation();
      if (!table.float) setObjectFloat(table.id, true); // grabbing undocks it
      const d = dragRef.current;
      d.active = true;
      d.startX = e.clientX;
      d.startY = e.clientY;
      d.origX = pos.x.goal;
      d.origY = pos.y.goal;
      rootRef.current?.classList.add("dragging");
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch { /* synthetic events have no real pointer */ }
    },
    [pos, table.id, table.float],
  );

  const onHeaderPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d.active) return;
      const s = getScale();
      pos.to(d.origX + (e.clientX - d.startX) / s, d.origY + (e.clientY - d.startY) / s);
    },
    [pos, getScale],
  );

  const onHeaderPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    rootRef.current?.classList.remove("dragging");
    moveTable(table.id, pos.x.goal, pos.y.goal);
  }, [pos, table.id]);

  // ----- editing -----
  const commitEdit = useCallback(
    (move: "down" | "right" | "stay" | "none") => {
      if (!editing) return;
      workbook.setCell(table.id, editing.col, editing.row, editText);
      setEditing(null);
      if (move === "down" && editing.row < table.rows - 1) {
        setSel({ col: editing.col, row: editing.row + 1 });
      } else if (move === "right" && editing.col < table.cols - 1) {
        setSel({ col: editing.col + 1, row: editing.row });
      } else if (move !== "none") {
        setSel({ col: editing.col, row: editing.row });
      }
      sheetRef.current?.focus();
    },
    [editing, editText, table.id, table.rows, table.cols],
  );

  const beginEdit = useCallback(
    (col: number, row: number, seed?: string) => {
      const cell = workbook.getCell(table.id, col, row);
      setSel({ col, row });
      setEditing({ col, row });
      setEditText(seed !== undefined ? seed : (cell?.raw ?? ""));
    },
    [table.id],
  );

  // editing session for click-to-insert-reference
  useEffect(() => {
    if (!editing) return;
    const session = {
      tableId: table.id,
      getText: () => inputRef.current?.value ?? editText,
      insertRef: (ref: string) => {
        const input = inputRef.current;
        if (!input) return;
        const next = input.value + ref;
        setEditText(next);
        requestAnimationFrame(() => {
          input.focus();
          input.setSelectionRange(next.length, next.length);
        });
      },
    };
    startEditingSession(session);
    return () => endEditingSession(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, table.id]);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  // ----- keyboard on the table root -----
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing || renaming) return;
      if (!sel) return;
      const move = (dc: number, dr: number) => {
        e.preventDefault();
        setSel({
          col: Math.max(0, Math.min(table.cols - 1, sel.col + dc)),
          row: Math.max(0, Math.min(table.rows - 1, sel.row + dr)),
        });
      };
      switch (e.key) {
        case "ArrowUp":
          return move(0, -1);
        case "ArrowDown":
          return move(0, 1);
        case "ArrowLeft":
          return move(-1, 0);
        case "ArrowRight":
          return move(1, 0);
        case "Tab":
          return move(e.shiftKey ? -1 : 1, 0);
        case "Enter":
          e.preventDefault();
          return beginEdit(sel.col, sel.row);
        case "F2":
          e.preventDefault();
          return beginEdit(sel.col, sel.row);
        case "Delete":
        case "Backspace":
          e.preventDefault();
          workbook.setCell(table.id, sel.col, sel.row, "");
          return;
        default:
          // start typing to replace content
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            beginEdit(sel.col, sel.row, e.key);
          }
      }
    },
    [sel, editing, renaming, table.cols, table.rows, table.id, beginEdit],
  );

  const onCellMouseDown = useCallback(
    (e: React.MouseEvent, col: number, row: number) => {
      e.stopPropagation();
      // if a formula editor elsewhere is open, clicking inserts a reference
      const refA1 = `${colToName(col)}${row + 1}`;
      const isSelfEditingCell = editing && editing.col === col && editing.row === row;
      if (!isSelfEditingCell && tryInsertRef(table.id, table.name, refA1)) {
        e.preventDefault();
        return;
      }
      if (editing) commitEdit("none");
      setSel({ col, row });
      sheetRef.current?.focus();
    },
    [editing, commitEdit, table.id, table.name],
  );

  const editorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit("down");
      } else if (e.key === "Tab") {
        e.preventDefault();
        commitEdit("right");
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditing(null);
        sheetRef.current?.focus();
      }
    },
    [commitEdit],
  );

  // ----- rich content: images and links dropped/pasted into cells -----
  const acceptDrop = useCallback(
    async (dt: DataTransfer, col: number, row: number) => {
      const file = [...dt.files].find((f) => f.type.startsWith("image/"));
      if (file) {
        const src = await imageFileToDataURL(file);
        workbook.setCell(table.id, col, row, `${IMG_PREFIX}${file.name}::${src}`);
        return true;
      }
      const uri = (dt.getData("text/uri-list") || dt.getData("text/plain")).trim();
      const first = uri.split(/\r?\n/).find((l) => l && !l.startsWith("#"));
      if (first && /^https?:\/\//i.test(first)) {
        workbook.setCell(table.id, col, row, first);
        return true;
      }
      return false;
    },
    [table.id],
  );

  const onCellDrop = useCallback(
    (e: React.DragEvent, col: number, row: number) => {
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      setSel({ col, row });
      void acceptDrop(e.dataTransfer, col, row);
    },
    [acceptDrop],
  );

  const onSheetPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (editing || !sel) return;
      const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
      if (item) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          void imageFileToDataURL(file).then((src) =>
            workbook.setCell(table.id, sel.col, sel.row, `${IMG_PREFIX}pasted image::${src}`),
          );
        }
        return;
      }
      const text = e.clipboardData.getData("text/plain").trim();
      if (text) {
        e.preventDefault();
        workbook.setCell(table.id, sel.col, sel.row, text);
      }
    },
    [editing, sel, table.id],
  );

  // ----- render -----
  const now = performance.now();
  const cells = [];
  for (let r = 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      const coord = `${c},${r}`;
      const cell = workbook.getCell(table.id, c, r);
      const selected = sel?.col === c && sel?.row === r;
      const isEditing = editing?.col === c && editing?.row === r;
      const pulseUntil = pulses.current.get(coord) ?? 0;
      const pulsing = pulseUntil > now;
      const isDrop = dropTarget?.col === c && dropTarget?.row === r;

      const image = cell ? parseImageRaw(cell.raw) : null;
      const isLink = cell ? !image && isLinkRaw(cell.raw) : false;
      const display = cell ? (cell.error ? cell.error : formatValue(cell.value)) : "";
      const isNum = cell && typeof cell.value === "number" && !cell.error;

      let content;
      if (isEditing) {
        content = (
          <input
            ref={inputRef}
            className="cell-editor"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={editorKeyDown}
            onBlur={() => commitEdit("none")}
            spellCheck={false}
          />
        );
      } else if (image) {
        content = (
          <motion.img
            className="cell-img"
            src={image.src}
            alt={image.name}
            draggable={false}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
          />
        );
      } else if (isLink) {
        const { label, kind } = linkLabel(cell!.raw);
        content = (
          <motion.button
            className={"link-chip " + kind}
            whileHover={{ scale: 1.05, y: -1 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setSel({ col: c, row: r });
              void openExternal(cell!.raw);
            }}
            title={cell!.raw}
          >
            <span className="link-ico">{kind === "drive" ? "▲" : "⌁"}</span>
            <span className="link-label">{label}</span>
          </motion.button>
        );
      } else {
        content = <span className="cell-text">{display}</span>;
      }

      cells.push(
        <div
          key={coord}
          className={
            "cell" +
            (selected ? " sel" : "") +
            (pulsing ? " pulse" : "") +
            (cell?.error ? " err" : "") +
            (isNum ? " num" : "") +
            (image ? " has-img" : "") +
            (isDrop ? " droppable" : "")
          }
          style={{ gridColumn: c + 2, gridRow: r + 2 }}
          onMouseDown={(e) => onCellMouseDown(e, c, r)}
          onDoubleClick={() => {
            if (image) setLightbox(image);
            else beginEdit(c, r);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isDrop) setDropTarget({ col: c, row: r });
          }}
          onDragLeave={() => {
            if (isDrop) setDropTarget(null);
          }}
          onDrop={(e) => onCellDrop(e, c, r)}
        >
          {content}
        </div>,
      );
    }
  }

  const colHeads = [];
  for (let c = 0; c < table.cols; c++) {
    colHeads.push(
      <div key={c} className={"colhead" + (sel?.col === c ? " hl" : "")} style={{ gridColumn: c + 2, gridRow: 1 }}>
        {colToName(c)}
      </div>,
    );
  }
  const rowNums = [];
  for (let r = 0; r < table.rows; r++) {
    rowNums.push(
      <div key={r} className={"rownum" + (sel?.row === r ? " hl" : "")} style={{ gridColumn: 1, gridRow: r + 2 }}>
        {r + 1}
      </div>,
    );
  }

  return (
    <div
      ref={rootRef}
      className="table-anchor"
      style={{ width: ROWNUM_W + table.cols * CELL_W }}
    >
      <motion.div
        className="table-card"
        initial={{ scale: 0.55, opacity: 0, y: 60, rotate: -1.5 }}
        animate={{ scale: 1, opacity: 1, y: 0, rotate: 0 }}
        transition={{ type: "spring", stiffness: 230, damping: 19, mass: 1.05 }}
      >
        {/* header / drag handle */}
        <div
          className="table-header"
          style={{ height: HEADER_H }}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
          onDoubleClick={(e) => {
            if ((e.target as HTMLElement).closest("button, input")) return;
            requestSnap({ kind: "object", id: table.id });
          }}
        >
          <div className="grip">
            <span /><span /><span />
          </div>
          {renaming ? (
            <input
              className="table-name-input"
              defaultValue={table.name}
              autoFocus
              spellCheck={false}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  renameTable(table.id, (e.target as HTMLInputElement).value);
                  setRenaming(false);
                } else if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={(e) => {
                renameTable(table.id, e.target.value);
                setRenaming(false);
              }}
            />
          ) : (
            <button className="table-name" onClick={() => setRenaming(true)} title="Rename table">
              {table.name}
            </button>
          )}
          <div className="header-actions">
            <motion.button
              className={"icon-btn float-btn" + (table.float ? " floating" : "")}
              whileHover={{ scale: 1.12 }}
              whileTap={{ scale: 0.82 }}
              transition={{ type: "spring", stiffness: 500, damping: 22 }}
              title={table.float ? "Dock into the section grid" : "Floating off — drag to float"}
              onClick={() => setObjectFloat(table.id, !table.float)}
            >
              {table.float ? "✥" : "⌗"}
            </motion.button>
            <motion.button
              className="icon-btn"
              whileHover={{ scale: 1.12 }}
              whileTap={{ scale: 0.82 }}
              transition={{ type: "spring", stiffness: 500, damping: 22 }}
              title="Delete table"
              onClick={() => removeTable(table.id)}
            >
              ✕
            </motion.button>
          </div>
        </div>

        {/* spreadsheet grid */}
        <div
          className="sheet"
          tabIndex={0}
          ref={sheetRef}
          onKeyDown={onKeyDown}
          onPaste={onSheetPaste}
          style={{
            gridTemplateColumns: `${ROWNUM_W}px repeat(${table.cols}, ${CELL_W}px)`,
            gridTemplateRows: `${COLHEAD_H}px repeat(${table.rows}, ${CELL_H}px)`,
          }}
        >
          <div className="corner" style={{ gridColumn: 1, gridRow: 1 }} />
          {colHeads}
          {rowNums}
          {cells}
        </div>

        {/* add row / add column controls */}
        <motion.button
          className="add-btn add-col"
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.8 }}
          transition={{ type: "spring", stiffness: 500, damping: 20 }}
          title="Add column"
          onClick={() => resizeTable(table.id, table.cols + 1, table.rows)}
        >
          +
        </motion.button>
        <motion.button
          className="add-btn add-row"
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.8 }}
          transition={{ type: "spring", stiffness: 500, damping: 20 }}
          title="Add row"
          onClick={() => resizeTable(table.id, table.cols, table.rows + 1)}
        >
          +
        </motion.button>
      </motion.div>

      {/* image lightbox — springs out of the cell into an overlay */}
      {createPortal(
        <AnimatePresence>
          {lightbox && (
            <motion.div
              className="lightbox"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setLightbox(null)}
            >
              <motion.img
                src={lightbox.src}
                alt={lightbox.name}
                initial={{ scale: 0.35, y: 60 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.5, y: 40, opacity: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 24 }}
                draggable={false}
              />
              <motion.div
                className="lightbox-name"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ delay: 0.08 }}
              >
                {lightbox.name}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
});
