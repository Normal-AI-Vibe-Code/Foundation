/**
 * How a right-click menu is laid out, and how the arrow keys move through it
 * (2026-11-17, Josh: "the right mouse click to open add and live next to each
 * other, and make the grid manipulation buttons in a line on the bottom, with
 * roll-over descriptions, instead of words next to them").
 *
 * A plain menu is a list. A menu whose items name a `group` is laid out in
 * zones:
 *
 *     top    rows across the top (the council)
 *     add    | live      two columns side by side, each under its caption
 *     grid   a row of icon buttons across the bottom, under a hairline; no
 *            words (each names itself on roll-over), the dangerous one last
 *            and set apart
 *
 * Pure: the component (ContextMenu.tsx) draws it, the tests read it.
 */

export type MenuGroup = "add" | "live" | "grid";
export type Zone = "top" | MenuGroup;

export interface MenuItem {
  divider?: true;
  /** a small caption over the group that follows */
  heading?: string;
  /** violet: an agent will act */
  agent?: boolean;
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  action?: () => void;
  /** where it sits in a grouped menu: a column ("add", "live") or the icon row ("grid") */
  group?: MenuGroup;
}

export interface MenuLayout {
  /** false: a plain list, drawn in order with its dividers and headings */
  grouped: boolean;
  top: MenuItem[];
  add: MenuItem[];
  live: MenuItem[];
  grid: MenuItem[];
  captions: { add: string; live: string };
}

const isRow = (it: MenuItem) => !it.divider && !it.heading;

export function layoutMenu(items: readonly MenuItem[]): MenuLayout {
  const grouped = items.some((it) => it.group);
  const of = (g: MenuGroup) => items.filter((it) => it.group === g && isRow(it));
  const caption = (g: MenuGroup, fallback: string) => items.find((it) => it.group === g && it.heading)?.heading ?? fallback;
  return {
    grouped,
    top: grouped ? items.filter((it) => !it.group && isRow(it)) : items.filter(isRow),
    add: of("add"),
    live: of("live"),
    // the dangerous one goes last
    grid: [...of("grid").filter((it) => !it.danger), ...of("grid").filter((it) => it.danger)],
    captions: { add: caption("add", "Add"), live: caption("live", "Live") },
  };
}

// ---------- the arrow keys ----------

export interface Spot {
  zone: Zone;
  i: number;
}
export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";
export const NAV_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];

/** how many things can take the keyboard in each zone (disabled ones left out) */
export type Counts = Record<Zone, number>;

const ORDER: Zone[] = ["top", "add", "live", "grid"];
const clamp = (i: number, n: number) => Math.max(0, Math.min(n - 1, i));

/**
 * Where the keyboard goes next. `at` is where it is (null: nowhere yet);
 * `col` is the column it was last in, so coming back up from the icon row
 * returns to it. Up and down move within a column and on to the zone above or
 * below; left and right cross between the two columns (keeping the row) and
 * walk the icon row. Returns null when there's nothing to go to.
 */
export function nextSpot(n: Counts, at: Spot | null, key: NavKey, col: "add" | "live" = "add"): Spot | null {
  const first = ORDER.find((z) => n[z] > 0);
  if (!first) return null;
  const last = [...ORDER].reverse().find((z) => n[z] > 0)!;
  if (key === "Home") return { zone: first, i: 0 };
  if (key === "End") return { zone: last, i: n[last] - 1 };
  if (!at || n[at.zone] === 0) return key === "ArrowUp" ? { zone: last, i: last === "grid" ? 0 : n[last] - 1 } : { zone: first, i: 0 };
  const { zone, i } = at;
  const column = n[col] > 0 ? col : n.add > 0 ? "add" : n.live > 0 ? "live" : null;
  const below = (z: Zone): Spot | null => {
    if (z === "top") return column ? { zone: column, i: 0 } : n.grid ? { zone: "grid", i: 0 } : null;
    if (z === "add" || z === "live") return n.grid ? { zone: "grid", i: 0 } : null;
    return null;
  };
  const above = (z: Zone): Spot | null => {
    if (z === "grid") return column ? { zone: column, i: n[column] - 1 } : n.top ? { zone: "top", i: n.top - 1 } : null;
    if (z === "add" || z === "live") return n.top ? { zone: "top", i: n.top - 1 } : null;
    return null;
  };
  if (key === "ArrowDown") {
    if (zone !== "grid" && i < n[zone] - 1) return { zone, i: i + 1 };
    return below(zone) ?? { zone: first, i: 0 }; // off the end: round to the top
  }
  if (key === "ArrowUp") {
    if (zone !== "grid" && i > 0) return { zone, i: i - 1 };
    return above(zone) ?? { zone: last, i: last === "grid" ? 0 : n[last] - 1 };
  }
  if (zone === "grid") return { zone, i: clamp(i + (key === "ArrowRight" ? 1 : -1), n.grid) };
  if (zone === "add" && key === "ArrowRight" && n.live) return { zone: "live", i: clamp(i, n.live) };
  if (zone === "live" && key === "ArrowLeft" && n.add) return { zone: "add", i: clamp(i, n.add) };
  return at;
}
