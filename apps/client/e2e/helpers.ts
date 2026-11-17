import type { Browser, BrowserContext, Page } from "@playwright/test";

/** :1450 by default; E2E_CLIENT_PORT moves it (Windows can reserve 1437–1536 at boot) */
export const CLIENT = `http://localhost:${process.env.E2E_CLIENT_PORT ?? 1450}`;

/** a signed-in person in their own browser context (cookies apart) */
export async function person(browser: Browser, name: string, email: string, board = "company"): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const res = await context.request.post(`${CLIENT}/auth/dev`, { data: { name, email } });
  if (!res.ok()) throw new Error(`dev login for ${email}: ${res.status()} ${await res.text()}`);
  // a clean floor: no side pane, no tabs, no search (what's remembered is per context anyway)
  await context.addInitScript(() => localStorage.setItem("foundation-floor", JSON.stringify({ pane: false, tabs: [], tab: null, search: false })));
  const page = await context.newPage();
  await page.goto(`/?board=${encodeURIComponent(board)}`);
  await waitLive(page);
  return { context, page };
}

/** the board has synced (the dev hook sees sections and the sync says live) */
export async function waitLive(page: Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as { __foundation?: { getState(): { sections: object } }; __foundationBoard?: () => { status: string } | null };
    return !!w.__foundation && Object.keys(w.__foundation.getState().sections).length > 0 && w.__foundationBoard?.()?.status === "live";
  }, undefined, { timeout: 30_000 });
}

/** let springs and transitions settle */
export const settle = (page: Page, ms = 900) => page.waitForTimeout(ms);

export interface Problems {
  cellClash: string[];
  overlap: string[];
  spill: string[];
  offGrid: string[];
  clipped: string[];
}

/**
 * What would look wrong: two sections claiming one cell, two section cards
 * overlapping on screen, a docked card spilling out of its section, or a
 * section outside the grid's tracks.
 */
export function layoutProblems(page: Page): Promise<Problems> {
  return page.evaluate(() => {
    type Sec = { id: string; name: string; c0: number; c1: number; r0: number; r1: number; host?: string };
    const st = (window as unknown as { __foundation: { getState(): { sections: Record<string, Sec>; grid: { cols: number[]; rows: number[] }; notes: Record<string, { float: boolean; sectionId: string; name: string }>; panels: Record<string, { float: boolean; sectionId: string; name: string }>; tables: Record<string, { float: boolean; sectionId: string; name: string }>; media: Record<string, { float: boolean; sectionId: string; name: string }> } } }).__foundation.getState();
    const out = { cellClash: [] as string[], overlap: [] as string[], spill: [] as string[], offGrid: [] as string[], clipped: [] as string[] };
    const owner = new Map<string, string>();
    for (const s of Object.values(st.sections)) {
      if (s.c0 < 0 || s.r0 < 0 || s.c1 >= st.grid.cols.length || s.r1 >= st.grid.rows.length || s.c1 < s.c0 || s.r1 < s.r0) out.offGrid.push(`${s.name} c${s.c0}-${s.c1} r${s.r0}-${s.r1}`);
      for (let c = s.c0; c <= s.c1; c++)
        for (let r = s.r0; r <= s.r1; r++) {
          const k = `${c},${r}`;
          if (owner.has(k)) out.cellClash.push(`${owner.get(k)} & ${s.name} at ${k}`);
          else owner.set(k, s.name);
        }
    }
    const rects = [...document.querySelectorAll<HTMLElement>(".section-card[data-section-id]")].map((el) => ({ id: el.dataset.sectionId!, r: el.getBoundingClientRect() }));
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r, b = rects[j].r;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) out.overlap.push(`${st.sections[rects[i].id]?.name} × ${st.sections[rects[j].id]?.name}`);
      }
    const all = { ...st.notes, ...st.panels, ...st.tables, ...st.media };
    for (const el of document.querySelectorAll<HTMLElement>("[data-obj-id]")) {
      const o = all[el.dataset.objId!];
      if (!o || o.float) continue;
      const sec = document.querySelector<HTMLElement>(`.section-card[data-section-id="${o.sectionId}"]`);
      const card = el.querySelector<HTMLElement>(".frame-card") ?? el;
      if (!sec) continue;
      const s = sec.getBoundingClientRect(), c = card.getBoundingClientRect();
      if (c.width < 2) continue;
      // a section fits its cards to its body; only one that has stopped shrinking (it says "n more") hides any
      if (sec.querySelector(".section-more")) continue;
      // a docked card should sit inside its section's width
      if (c.left < s.left - 2 || c.right > s.right + 2) out.spill.push(`${o.name} in ${st.sections[o.sectionId]?.name}: card ${Math.round(c.left)}–${Math.round(c.right)} vs section ${Math.round(s.left)}–${Math.round(s.right)}`);
    }
    // an empty section's welcome must fit inside it
    for (const box of document.querySelectorAll<HTMLElement>(".section-empty")) {
      const card = box.querySelector<HTMLElement>(".empty-card");
      if (!card) continue;
      const b = box.getBoundingClientRect(), c = card.getBoundingClientRect();
      if (c.top < b.top - 1 || c.bottom > b.bottom + 1 || c.left < b.left - 1 || c.right > b.right + 1) {
        const id = box.closest<HTMLElement>("[data-section-id]")?.dataset.sectionId;
        out.clipped.push(`welcome in ${id ? st.sections[id]?.name : "?"}: ${Math.round(c.height)} tall in ${Math.round(b.height)}`);
      }
    }
    return out;
  });
}

/** grid cells no section covers */
export function holes(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Sec = { c0: number; c1: number; r0: number; r1: number };
    const st = (window as unknown as { __foundation: { getState(): { sections: Record<string, Sec>; grid: { cols: number[]; rows: number[] } } } }).__foundation.getState();
    let n = 0;
    for (let c = 0; c < st.grid.cols.length; c++)
      for (let r = 0; r < st.grid.rows.length; r++) if (!Object.values(st.sections).some((s) => s.c0 <= c && c <= s.c1 && s.r0 <= r && r <= s.r1)) n++;
    return n;
  });
}

/** the section's screen rect */
export async function sectionBox(page: Page, name: string) {
  const id = await page.evaluate((n) => {
    const st = (window as unknown as { __foundation: { getState(): { sections: Record<string, { id: string; name: string }> } } }).__foundation.getState();
    return Object.values(st.sections).find((s) => s.name === n)?.id ?? null;
  }, name);
  if (!id) throw new Error(`no section ${name}`);
  const box = await page.locator(`.section-card[data-section-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`section ${name} not on screen`);
  return { id, ...box };
}

export async function frame(page: Page, kind: "all" | "section", id?: string) {
  await page.evaluate(([k, i]) => {
    (window as unknown as { __foundation: { setState(p: object): void } }).__foundation.setState({ snapRequest: k === "all" ? { kind: "all", nonce: Math.random() } : { kind: "section", id: i, nonce: Math.random() } });
  }, [kind, id] as const);
  await settle(page, 1200);
}
