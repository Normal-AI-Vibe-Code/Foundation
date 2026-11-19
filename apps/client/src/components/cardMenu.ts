/**
 * A card's right-click menu (2026-11-18, Josh: "You should be able to right click on primitives and get some
 * contextual menus, such as removing an item, minimizing it, showing its inputs and outputs in greater
 * detail"). One menu for every kind of card, built from what the card is: a plain list (ContextMenu.tsx).
 *
 *   the card's name
 *   Frame it · Full screen · Minimize / Restore
 *   Pin to the section / Unpin (a table) · Let it fill the section / Show as a card (an app) · Float / Dock
 *   Inputs and outputs… (anything wired, or with ports: opens them in the right pane)
 *   Open as a tab (an app or a page) · Copy a link to it
 *   Remove
 *
 * A viewer gets the ones that change nothing: frame, full screen, inputs and outputs, copy the link.
 * A table's cells keep their own menu (rows, columns); this one is its header's and every other card's.
 */

import { isHostable } from "@foundation/protocol";
import { toggleFullscreen } from "../lib/cardUse";
import { openDetail } from "../lib/detail";
import { openAppTab } from "../lib/grids";
import { keys } from "../lib/keys";
import { canPin, getObject, getState, hostOf, isPanel, objectsInSection, removeObject, requestSnap, setObjectFloat, setObjectFolded, setObjectPinned, setSectionHost, type AnyObject } from "../state/store";
import { getUi, toast } from "../state/ui";
import { activeBoard } from "../sync/board";
import type { MenuItem } from "./menuLayout";

/** what a card is called in a sentence */
export function kindWord(o: AnyObject): string {
  if (isPanel(o)) return o.panel === "app" ? "app" : o.panel === "link" ? "page" : o.panel === "file" ? "file" : o.panel === "machine" ? "machine" : o.panel;
  if ("cols" in o) return "table";
  if ("sourceTableId" in o) return "map";
  if ("text" in o) return o.rich ? "text box" : "note";
  return o.media === "video" ? "video" : "image";
}

/** does this card have anything coming in or going out: ports of its own, or a wire to it */
export function hasWiring(o: AnyObject): boolean {
  if (isPanel(o) && o.ports.length > 0) return true;
  if ("sourceTableId" in o) return true; // a map reads a table
  const st = getState();
  if ("cols" in o) return Object.values(st.maps).some((m) => m.sourceTableId === o.id);
  return Object.values(st.links).some((l) => l.from.panel === o.id || l.to.panel === o.id);
}

/** ask the card's own frame to remove it (it asks first when that would lose something); cards without one go at once */
export const CARD_REMOVE = "foundation:card-remove";
function remove(id: string) {
  const ev = new CustomEvent(CARD_REMOVE, { detail: { id, handled: false } });
  window.dispatchEvent(ev);
  if (!ev.detail.handled) removeObject(id);
}

/** the items for one card; `null` when it's gone */
export function cardMenuItems(id: string): MenuItem[] | null {
  const o = getObject(id);
  if (!o) return null;
  const viewer = getUi().role === "viewer";
  const sec = getState().sections[o.sectionId];
  const hosted = hostOf(o.sectionId)?.id === o.id;
  const word = kindWord(o);
  const items: MenuItem[] = [{ heading: o.name || word }];

  items.push({ icon: "◎", label: "Frame it", action: () => requestSnap({ kind: "object", id }) });
  items.push({ icon: "⤢", label: `Full screen  ${keys("mod+enter")}`, action: () => void toggleFullscreen(id) });
  if (!viewer && !hosted && !o.pinned && !("media" in o))
    items.push(o.folded ? { icon: "▢", label: "Restore", action: () => setObjectFolded(id, false) } : { icon: "▁", label: "Minimize", action: () => setObjectFolded(id, true) });

  if (!viewer) {
    const place: MenuItem[] = [];
    if (canPin(o)) place.push(o.pinned ? { icon: "◱", label: "Unpin: back to a card", action: () => setObjectPinned(id, false) } : { icon: "⊟", label: "Pin to the section: span it", action: () => setObjectPinned(id, true) });
    if (isPanel(o) && isHostable(o.panel) && sec) {
      if (hosted) place.push({ icon: "◱", label: "Show as a card", action: () => setSectionHost(o.sectionId, null) });
      else if (objectsInSection(o.sectionId).length === 1) place.push({ icon: "◳", label: "Let it fill the section", action: () => setSectionHost(o.sectionId, id) });
    }
    if (!hosted && !o.pinned) place.push(o.float ? { icon: "⌗", label: "Dock into the section", action: () => setObjectFloat(id, false) } : { icon: "✥", label: "Float freely", action: () => setObjectFloat(id, true) });
    if (place.length) items.push({ divider: true }, ...place);
  }

  const more: MenuItem[] = [];
  if (hasWiring(o)) more.push({ icon: "⇄", label: "Inputs and outputs…", action: () => openDetail({ kind: "ports", title: `${o.name}: inputs and outputs`, id }) });
  if (isPanel(o) && o.url && (o.panel === "app" || o.panel === "link") && !viewer)
    more.push({
      icon: "◈",
      label: "Open as a tab",
      action: () => void openAppTab({ url: o.url, name: o.name }).then((err) => err && toast(err, "bad")),
    });
  more.push({
    icon: "⌁",
    label: "Copy a link to it",
    action: () => {
      const url = new URL(window.location.href);
      url.hash = "";
      url.search = "";
      url.searchParams.set("board", activeBoard()?.boardId ?? "company");
      url.searchParams.set("focus", id);
      void navigator.clipboard.writeText(url.toString()).then(
        () => toast("Link copied", "ok"),
        () => toast("The browser wouldn't copy it", "warn"),
      );
    },
  });
  items.push({ divider: true }, ...more);

  if (!viewer) items.push({ divider: true }, { icon: "🗑", label: `Remove this ${word}`, danger: true, action: () => remove(id) });
  return items;
}
