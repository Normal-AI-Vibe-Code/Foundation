/**
 * Open one of the company's apps in Foundation (Today's ⤢, 2026-11-19): it takes over a section of the grid in use.
 * A new section is added at the grid's right edge and the app fills it (the section's host); pressing again goes
 * to the section it already has. An app behind HyperForm's sign-in is a page of the built-in browser
 * (`via: "browser"`, panels/HostPage.tsx); anything else is a frame, as an app card always was.
 */

import { addPanel, getState, newSectionAtEdge, requestSnap, type PanelMeta } from "../state/store";
import { getUi, toast } from "../state/ui";
import { activeBoard } from "../sync/board";
import { allowPagesLive } from "../panels/HostPage";
import { goGrid } from "./place";

export interface OpenableApp {
  name: string;
  url: string | null;
  role?: string;
  signIn?: "hyperform";
}

const sameAddress = (a: string | undefined, b: string) => {
  try {
    return !!a && new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};

/** the card an app already has on this grid */
export function appCardOn(panels: Record<string, PanelMeta>, url: string): PanelMeta | null {
  return Object.values(panels).find((p) => (p.panel === "app" || p.panel === "link") && !p.fromMachine && sameAddress(p.url, url)) ?? null;
}

/** what the card is made as: a page of the built-in browser behind HyperForm's sign-in, else a frame */
export function appCardOf(app: OpenableApp): Pick<PanelMeta, "panel" | "name" | "url" | "text" | "via"> {
  return { panel: "app", name: app.name, url: app.url ?? undefined, text: app.role || undefined, ...(app.signIn === "hyperform" ? { via: "browser" as const } : {}) };
}

export function openAppOnGrid(app: OpenableApp) {
  if (!app.url) return;
  if (!activeBoard()) return void toast("Open a grid first: the app becomes a section of it.", "warn");
  const ui = getUi();
  const st = getState();
  // a person's press: the browser may run the pages they come near, for this visit (an admin's)
  if (app.signIn === "hyperform" && ui.role === "admin") allowPagesLive();
  const has = appCardOn(st.panels, app.url);
  if (has) {
    goGrid();
    return requestSnap(st.sections[has.sectionId]?.host === has.id ? { kind: "section", id: has.sectionId } : { kind: "object", id: has.id });
  }
  if (ui.role === "viewer") return void toast("You can look at this grid but not change it: ask someone who can to add the app.", "warn");
  const sectionId = newSectionAtEdge("right");
  // into an empty section, an app becomes the section's own (it fills it, and names it)
  addPanel(sectionId, appCardOf(app), { focus: false });
  goGrid();
  requestSnap({ kind: "section", id: sectionId });
}
