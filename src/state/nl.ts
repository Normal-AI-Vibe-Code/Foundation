/**
 * Natural-language commands over the workspace. Rule-based: the current
 * focus (active section / object) is the context for creation and edits.
 */

import {
  addNote,
  addSectionAdjacent,
  bindMap,
  createMap,
  createTable,
  deleteTableCols,
  deleteTableRows,
  getObject,
  getState,
  insertTableCols,
  insertTableRows,
  removeMap,
  removeNote,
  removeTable,
  renameSection,
  renameTable,
  requestRemoveSection,
  requestSnap,
  splitSection,
} from "./store";

const NUM_WORDS: Record<string, number> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function countIn(text: string): number {
  const digit = /\b(\d+)\b/.exec(text);
  if (digit) return Math.min(10, parseInt(digit[1], 10));
  for (const [w, n] of Object.entries(NUM_WORDS)) {
    if (new RegExp(`\\b${w}\\b`).test(text)) return n;
  }
  return 1;
}

function directionIn(text: string): "left" | "right" | "above" | "below" | null {
  if (/\bleft\b/.test(text)) return "left";
  if (/\bright\b/.test(text)) return "right";
  if (/\b(above|top|up)\b/.test(text)) return "above";
  if (/\b(below|bottom|under|down)\b/.test(text)) return "below";
  return null;
}

function findTableByName(name: string) {
  const tables = Object.values(getState().tables);
  const n = name.trim().toLowerCase();
  return (
    tables.find((t) => t.name.toLowerCase() === n) ??
    tables.find((t) => t.name.toLowerCase().includes(n)) ??
    null
  );
}

function findMapByName(name: string) {
  const maps = Object.values(getState().maps);
  const n = name.trim().toLowerCase();
  return (
    maps.find((m) => m.name.toLowerCase() === n) ??
    maps.find((m) => m.name.toLowerCase().includes(n)) ??
    null
  );
}

/** run a command; returns user feedback + whether it was understood */
export function runCommand(raw: string): { ok: boolean; message: string } {
  const text = raw.trim().toLowerCase();
  if (!text) return { ok: false, message: "Say or type what you'd like to do" };
  const st = getState();
  const sectionId = st.activeSectionId;
  const activeObj = st.activeObjectId ? getObject(st.activeObjectId) : null;
  const n = countIn(text);

  // ----- deletion -----
  if (/\b(delete|remove|trash)\b/.test(text)) {
    if (/\bsection\b/.test(text)) {
      requestRemoveSection(sectionId);
      return { ok: true, message: "Confirm removing the section" };
    }
    if (/\b(this|it|selected)\b/.test(text) && activeObj) {
      if ("cols" in activeObj) removeTable(activeObj.id);
      else if ("sourceTableId" in activeObj) removeMap(activeObj.id);
      else if ("text" in activeObj) removeNote(activeObj.id);
      return { ok: true, message: `Removed ${activeObj.name}` };
    }
    if (/\brows?\b/.test(text) && activeObj && "cols" in activeObj) {
      deleteTableRows(activeObj.id, activeObj.rows - n, n);
      return { ok: true, message: `Deleted ${n} row${n > 1 ? "s" : ""}` };
    }
    if (/\b(columns?|cols?)\b/.test(text) && activeObj && "cols" in activeObj) {
      deleteTableCols(activeObj.id, activeObj.cols - n, n);
      return { ok: true, message: `Deleted ${n} column${n > 1 ? "s" : ""}` };
    }
    const m = /\b(?:delete|remove|trash)\s+(?:the\s+)?(.+)/.exec(text);
    if (m) {
      const t = findTableByName(m[1]);
      if (t) {
        removeTable(t.id);
        return { ok: true, message: `Removed ${t.name}` };
      }
      const mp = findMapByName(m[1]);
      if (mp) {
        removeMap(mp.id);
        return { ok: true, message: `Removed ${mp.name}` };
      }
    }
    return { ok: false, message: "Couldn't tell what to delete" };
  }

  // ----- rename -----
  const rename = /\brename\b(?:\s+(?:this|it|section|table))?\s*(?:to|as)\s+(.+)/.exec(text);
  if (rename) {
    const newName = raw.slice(raw.toLowerCase().indexOf(rename[1])).trim();
    if (/\bsection\b/.test(text) || !activeObj) {
      renameSection(sectionId, newName);
      return { ok: true, message: `Section renamed to “${newName}”` };
    }
    if ("cols" in activeObj) {
      renameTable(activeObj.id, newName);
      return { ok: true, message: `Table renamed to “${newName}”` };
    }
    return { ok: false, message: "Can't rename that" };
  }

  // ----- connections -----
  const connect = /\b(?:connect|bind|link|wire)\b\s+(?:the\s+)?(.+?)\s+to\s+(?:the\s+)?(.+)/.exec(text);
  if (connect) {
    const t = findTableByName(connect[1]) ?? findTableByName(connect[2]);
    const m = findMapByName(connect[2]) ?? findMapByName(connect[1]);
    if (t && m) {
      bindMap(m.id, t.id);
      return { ok: true, message: `${m.name} now shows ${t.name}` };
    }
    return { ok: false, message: "Couldn't find that table/map pair" };
  }

  // ----- splitting -----
  if (/\bsplit\b/.test(text)) {
    const vertical = /\b(row|vertical|horizontally down|stack)\b/.test(text);
    splitSection(sectionId, vertical ? "v" : "h");
    return { ok: true, message: vertical ? "Section split into rows" : "Section split into columns" };
  }

  // ----- sections -----
  if (/\bsection\b/.test(text)) {
    const dir = directionIn(text) ?? "right";
    addSectionAdjacent(sectionId, dir);
    return { ok: true, message: `New section ${dir === "above" ? "above" : dir}` };
  }

  // ----- rows / columns on the focused table -----
  if (/\b(add|insert|new)\b/.test(text) && /\brows?\b/.test(text)) {
    if (activeObj && "cols" in activeObj) {
      insertTableRows(activeObj.id, activeObj.rows, n);
      return { ok: true, message: `Added ${n} row${n > 1 ? "s" : ""}` };
    }
    return { ok: false, message: "Select a table first" };
  }
  if (/\b(add|insert|new)\b/.test(text) && /\b(columns?|cols?)\b/.test(text)) {
    if (activeObj && "cols" in activeObj) {
      insertTableCols(activeObj.id, activeObj.cols, n);
      return { ok: true, message: `Added ${n} column${n > 1 ? "s" : ""}` };
    }
    return { ok: false, message: "Select a table first" };
  }

  // ----- primitives -----
  if (/\btables?\b/.test(text)) {
    for (let i = 0; i < n; i++) createTable(sectionId);
    return { ok: true, message: n > 1 ? `${n} tables created` : "Table created" };
  }
  if (/\bmaps?\b/.test(text)) {
    const map = createMap(sectionId);
    // "map of/for/showing <table>" binds it immediately
    const of = /\bmap\b(?:\s+\w+)?\s+(?:of|for|showing|with|from)\s+(?:the\s+)?(.+)/.exec(text);
    if (of) {
      const t = findTableByName(of[1]);
      if (t) {
        bindMap(map.id, t.id);
        return { ok: true, message: `Map created, showing ${t.name}` };
      }
    }
    return { ok: true, message: "Map created — drag a wire from a table to feed it" };
  }
  if (/\bnotes?\b/.test(text)) {
    const saying = /\bnote\b\s*(?:saying|that says|:)?\s*(.*)/.exec(raw.trim());
    const body = saying?.[1]?.trim();
    addNote(sectionId, body ? body : undefined);
    return { ok: true, message: "Note created" };
  }

  // ----- navigation -----
  if (/\b(overview|zoom out|show everything|show all)\b/.test(text)) {
    requestSnap({ kind: "all" });
    return { ok: true, message: "Overview" };
  }
  const focus = /\b(?:focus|zoom(?:\s+in)?(?:\s+on)?|go to|show)\s+(?:the\s+)?(.+)/.exec(text);
  if (focus) {
    const t = findTableByName(focus[1]);
    if (t) {
      requestSnap({ kind: "object", id: t.id });
      return { ok: true, message: `Focused ${t.name}` };
    }
    const m = findMapByName(focus[1]);
    if (m) {
      requestSnap({ kind: "object", id: m.id });
      return { ok: true, message: `Focused ${m.name}` };
    }
    const sec = Object.values(st.sections).find((s) =>
      s.name.toLowerCase().includes(focus[1].trim()),
    );
    if (sec) {
      requestSnap({ kind: "section", id: sec.id });
      return { ok: true, message: `Focused ${sec.name}` };
    }
  }

  return {
    ok: false,
    message: "Try: “add a table”, “map of team”, “split this section”, “add 3 rows”…",
  };
}
