/**
 * The client's half of the Rune renderer: loads the wasm module (built from
 * apps/rune by `npm run rune:build` into public/rune/), mounts it on a canvas,
 * keeps it fed with the board (scene.ts) and the camera, and turns what it
 * reports back into the store's own actions.
 *
 * The store stays the board's one writer: sync, viewers, undo and the
 * invariants all live behind it, and Rune never touches them.
 */

import { isNight, onNight } from "@foundation/ui";
import { workbook } from "../engine/workbook";
import { camera, onCamera, toWorld } from "../state/camera";
import {
  CONTENT_PAD,
  SECTION_HEADER,
  addNote,
  cellAtWorld,
  edgeAtWorld,
  moveSectionTo,
  moveSectionToEdge,
  removeSection,
  renameSection,
  requestRemoveSection,
  resizeMedia,
  resizeNote,
  setSectionDragTarget,
  createSectionAt,
  createTable,
  getState,
  moveMap,
  moveMedia,
  moveNote,
  movePanel,
  moveTable,
  sectionCardRect,
  sectionFit,
  setActiveObject,
  setActiveSection,
  setObjectFloat,
  subscribe,
  updateNoteText,
} from "../state/store";
import { floorInsets, getUi } from "../state/ui";
import { getRuneStatus, setRuneStatus, type RuneBuild } from "./engine";
import { runeImageSrc } from "./imageSrc";
import { openExternal } from "../utils/media";
import { runCardTool, runSectionTool, sectionContext } from "./tools";
import { openContextMenu } from "../components/ContextMenu";
import { sectionMenuItems } from "../components/sectionMenu";
import { SCENE_VERSION, TOKEN_VARS, buildScene, type Rgba, type SceneTokens } from "./scene";

const BASE = `${import.meta.env.BASE_URL}rune/`;

/** the wasm module's exports (apps/rune/src/lib.rs) */
interface RuneModule {
  default(input: { module_or_path: string }): Promise<unknown>;
  sceneVersion(): number;
  mount(canvasId: string, transparent: boolean, fonts: string, onEvent: (json: string) => void): void;
  /** the paper's light: where the pointer is over the grid (canvas px), and whether it's there at all */
  setPointer(x: number, y: number, inside: boolean): void;
  setNight(night: boolean): void;
  /** the page's clock, in seconds: the paper's grain steps with it */
  tick(seconds: number): void;
  /** the paper as the last frame drew it: [presence, night, pointer x, y, frames so far, view runs so far] */
  paperDrew(): Float32Array;
  setScene(json: string): void;
  setCamera(x: number, y: number, scale: number): void;
  beginEdit(id: string): void;
  endEdit(): void;
  unmount(): void;
}

type RuneEvent =
  | { t: "section"; id: string }
  | { t: "object"; id: string }
  | { t: "move"; id: string; x: number; y: number }
  | { t: "text"; id: string; text: string }
  | { t: "edit"; id: string | null }
  | { t: "create-section"; c: number; r: number }
  | { t: "section-tool"; id: string; tool: string }
  | { t: "card-tool"; id: string; tool: string }
  | { t: "confirm"; id: string; yes: boolean }
  | { t: "rename"; id: string; name: string }
  | { t: "section-drag"; id: string; x: number; y: number; dx: number; dy: number; phase: "move" | "drop" | "cancel" }
  | { t: "resize"; id: string; w: number; h: number }
  | { t: "menu"; id: string | null; x: number; y: number }
  | { t: "link"; url: string };

/** dev and e2e builds keep the last events Rune reported, for checks */
const seen: RuneEvent[] | null = import.meta.env?.DEV || import.meta.env?.VITE_E2E_HOOKS ? [] : null;

let loading: Promise<RuneModule> | null = null;

/** fetch and start the module once; says plainly why it can't */
function load(): Promise<RuneModule> {
  loading ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) throw new Error("This browser has no WebGPU, which Rune draws with.");
    const adapter = await gpu.requestAdapter().catch(() => null);
    if (!adapter) throw new Error("WebGPU is here, but no GPU adapter answered (a blocked or software-only GPU).");
    // the dev server answers a missing file with the app's own page: ask for the build's stamp, which is JSON
    const stamp = await fetch(`${BASE}rune.json`).then((r) => (r.ok && /json/.test(r.headers.get("content-type") ?? "") ? (r.json() as Promise<RuneBuild>) : null)).catch(() => null);
    if (!stamp) throw new Error("The Rune renderer isn't built here: run `npm run rune:build`.");
    setRuneStatus({ state: "loading", build: stamp });
    const mod = (await import(/* @vite-ignore */ `${BASE}foundation_rune.js?v=${encodeURIComponent(stamp.builtAt)}`)) as RuneModule;
    await mod.default({ module_or_path: `${BASE}foundation_rune_bg.wasm?v=${encodeURIComponent(stamp.builtAt)}` });
    if (mod.sceneVersion() !== SCENE_VERSION) throw new Error(`The Rune build is out of date (scene ${mod.sceneVersion()}, the app speaks ${SCENE_VERSION}): run \`npm run rune:build\`.`);
    return mod;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

// ---------- tokens: the design language, resolved to what Rune can draw ----------

let probe: CanvasRenderingContext2D | null = null;
/** any CSS colour (a token, a color-mix, mid night-fade) as sRGB: painted, then read back */
function resolve(css: string): Rgba {
  probe ??= Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  if (!probe) return [0, 0, 0, 1];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  // straight alpha back out of the canvas's own
  return a === 0 ? [0, 0, 0, 0] : [r / 255, g / 255, b / 255, a / 255];
}

export function readTokens(el: Element = document.body): SceneTokens {
  const style = getComputedStyle(el);
  const out = {} as SceneTokens;
  for (const [name, v] of Object.entries(TOKEN_VARS) as Array<[keyof SceneTokens, string]>) out[name] = resolve(style.getPropertyValue(v).trim() || "transparent");
  return out;
}

// ---------- the mounted renderer ----------

export interface RuneHost {
  /** open a note for writing */
  beginEdit(id: string): void;
  /** the note Rune's field is open on, if any */
  editing(): string | null;
  /** something the scene reads outside the store changed (the floor's panes, my role): send the board again */
  refresh(): void;
  /** the paper as Rune last drew it: [the pointer's presence, night, pointer x, y, frames drawn, view runs] */
  paper(): number[] | null;
  dispose(): void;
}

/**
 * Mount Rune on `canvas` and keep it in step until disposed. `transparent`:
 * the canvas is see-through and the WebGL paper under it shows (else Rune
 * paints the paper).
 */
export function mountRune(canvas: HTMLCanvasElement, opts: { transparent: boolean }): RuneHost {
  let mod: RuneModule | null = null;
  let disposed = false;
  let editing: string | null = null;
  let frame = 0;
  let last = "";
  const offs: Array<() => void> = [];
  // the right button, as the page sees it: Rune may report a right-click on the press or on the release
  const right = { down: false, downX: 0, downY: 0, x: 0, y: 0, onUp: null as null | (() => void) };
  const onRight = (ev: PointerEvent) => {
    if (ev.type === "pointerdown" && ev.button === 2) Object.assign(right, { down: true, downX: ev.clientX, downY: ev.clientY, x: ev.clientX, y: ev.clientY, onUp: null });
    else if (ev.type === "pointermove" && right.down) Object.assign(right, { x: ev.clientX, y: ev.clientY });
    else if ((ev.type === "pointerup" || ev.type === "pointercancel") && ev.button === 2) {
      Object.assign(right, { down: false, x: ev.clientX, y: ev.clientY });
      const then = right.onUp;
      right.onUp = null;
      then?.();
    }
  };
  for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
    window.addEventListener(t, onRight, true);
    offs.push(() => window.removeEventListener(t, onRight, true));
  }

  const push = () => {
    frame = 0;
    if (!mod || disposed) return;
    const ui = getUi();
    const f = floorInsets(ui);
    const scene = buildScene(getState(), {
      insets: { left: f.left, top: f.top, right: f.right },
      readOnly: ui.role === "viewer",
      tokens: readTokens(canvas.parentElement ?? document.body),
      paper: !opts.transparent,
      imageSrc: runeImageSrc,
    });
    const json = JSON.stringify(scene);
    if (json === last) return;
    last = json;
    try {
      mod.setScene(json);
    } catch (e) {
      console.error("rune: scene refused", e);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(push);
  };

  const onEvent = (json: string) => {
    let e: RuneEvent;
    try {
      e = JSON.parse(json) as RuneEvent;
    } catch {
      return;
    }
    if (seen) seen.push(e), seen.length > 50 && seen.shift();
    const st = getState();
    if (e.t === "section") setActiveSection(e.id);
    else if (e.t === "object") setActiveObject(e.id);
    else if (e.t === "text") updateNoteText(e.id, e.text);
    else if (e.t === "edit") {
      editing = e.id;
      // Rune's field types through its own hidden <textarea> (IME, autocorrect, the clipboard) once that has
      // the keyboard. A field opened from here, not by a tap on it, is handed the keyboard the same way, so
      // the app's own keys (Space to talk, A, P, 0, F…) see someone typing, as they do in any field.
      if (e.id) requestAnimationFrame(() => requestAnimationFrame(() => {
        const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text input"]');
        if (editing && field && (document.activeElement === canvas || document.activeElement === document.body)) field.focus({ preventScroll: true });
      }));
    }
    else if (e.t === "create-section") createSectionAt(e.c, e.r);
    // a link in a note: http(s) only, opened as the web note opens one
    else if (e.t === "link") {
      if (/^https?:\/\//i.test(e.url)) void openExternal(e.url);
    }
    else if (e.t === "section-tool") runSectionTool(e.id, e.tool);
    else if (e.t === "menu") {
      // a right press that travelled was a pan of the grid (GridViewport), not a menu: wait for the release to know
      const section = e.id ? st.sections[e.id] : null;
      if (!section || getUi().role === "viewer") return;
      const open = () => {
        if (Math.hypot(right.x - right.downX, right.y - right.downY) >= 4) return;
        setActiveSection(section.id);
        const now = getState();
        const s = now.sections[section.id];
        if (s) openContextMenu(e.x, e.y, sectionMenuItems(s, toWorld(e.x - camera.left, e.y - camera.top), sectionContext(now, s)));
      };
      if (right.down) right.onUp = open;
      else open();
    }
    else if (e.t === "card-tool") runCardTool(e.id, e.tool);
    else if (e.t === "confirm") e.yes ? removeSection(e.id) : requestRemoveSection(null);
    else if (e.t === "rename") {
      if (e.name.trim()) renameSection(e.id, e.name);
    } else if (e.t === "resize") st.notes[e.id] ? resizeNote(e.id, e.w, e.h) : resizeMedia(e.id, e.w, e.h);
    else if (e.t === "section-drag") {
      // the same rule as the web section's header: the cell under the pointer, or past the board's edge, that whole side
      const pt = toWorld(e.x - camera.left, e.y - camera.top);
      const cell = cellAtWorld(pt.x, pt.y);
      const edge = cell ? null : edgeAtWorld(pt.x, pt.y);
      // its web cards (the islands) go along with the section Rune is moving
      const shell = canvas.parentElement?.querySelector<HTMLElement>(`.is-rune-shell[data-section-id="${CSS.escape(e.id)}"]`);
      if (e.phase === "move") {
        if (shell) shell.style.translate = `${e.dx}px ${e.dy}px`;
        setSectionDragTarget(cell ? { sectionId: e.id, c: cell.c, r: cell.r } : edge ? { sectionId: e.id, c: -1, r: -1, edge } : null);
      } else {
        if (shell) shell.style.translate = "";
        setSectionDragTarget(null);
        if (e.phase === "drop" && cell) moveSectionTo(e.id, cell.c, cell.r);
        else if (e.phase === "drop" && edge) moveSectionToEdge(e.id, edge);
        // nowhere to land: the same board goes back, so the section lets go and returns
        last = "";
        schedule();
      }
    }
    else if (e.t === "move") {
      // let go at a world point: floating there in its own section (carrying between sections is the ledger's)
      const key = (["notes", "media", "tables", "maps", "panels"] as const).find((k) => st[k][e.id]);
      const obj = key && st[key][e.id];
      const sec = obj && st.sections[obj.sectionId];
      if (!key || !obj || !sec || sec.host === e.id) return schedule();
      const card = sectionCardRect(st.grid, sec);
      const fit = sectionFit(sec.id);
      const x = Math.max(0, Math.round((e.x - card.x - 1) / fit - CONTENT_PAD));
      const y = Math.max(0, Math.round((e.y - card.y - 1 - SECTION_HEADER) / fit - CONTENT_PAD));
      setObjectFloat(e.id, true);
      ({ notes: moveNote, media: moveMedia, tables: moveTable, maps: moveMap, panels: movePanel })[key](e.id, x, y);
      // the store may answer with the same board (a viewer's move snaps back): send it again so the card lets go
      last = "";
      schedule();
    }
  };

  setRuneStatus({ state: "loading" });
  load()
    .then((m) => {
      if (disposed) return;
      m.mount(canvas.id, opts.transparent, `${BASE}fonts/`, onEvent);
      mod = m;
      m.setCamera(camera.x, camera.y, camera.scale);
      m.setNight(isNight());
      // the paper's light follows the pointer over the grid, as the web paper's does (GridViewport). Heard at the
      // window, on the way down: Rune's canvas keeps its pointer events from bubbling
      const grid = canvas.parentElement;
      let at: { x: number; y: number; inside: boolean } | null = null;
      let lit = 0;
      const light = () => {
        lit = 0;
        if (at && !disposed) m.setPointer(at.x, at.y, at.inside);
      };
      const onMove = (ev: PointerEvent) => {
        const inside = !!grid && ev.target instanceof Node && grid.contains(ev.target);
        if (!inside && !at?.inside) return;
        const r = canvas.getBoundingClientRect();
        at = { x: ev.clientX - r.left, y: ev.clientY - r.top, inside };
        lit ||= requestAnimationFrame(light);
      };
      const onLeave = () => {
        if (!at?.inside) return;
        at = { ...at, inside: false };
        lit ||= requestAnimationFrame(light);
      };
      window.addEventListener("pointermove", onMove, true);
      document.documentElement.addEventListener("pointerleave", onLeave);
      // the grain steps twice a second; a hidden page draws nothing
      const grain = window.setInterval(() => document.visibilityState === "visible" && m.tick(performance.now() / 1000), 500);
      offs.push(
        () => window.removeEventListener("pointermove", onMove, true),
        () => document.documentElement.removeEventListener("pointerleave", onLeave),
        () => cancelAnimationFrame(lit),
        () => window.clearInterval(grain),
      );
      offs.push(
        onCamera((c) => m.setCamera(c.x, c.y, c.scale)),
        subscribe(schedule),
        // a table at rest is Rune's: its cells are the workbook's, which recalculates apart from the store
        workbook.subscribeAll(schedule),
        // the night fade mixes every token over 1.4 s: Rune springs between what it's handed
        onNight((n) => {
          m.setNight(n);
          [0, 500, 1500].forEach((ms) => setTimeout(schedule, ms));
        }),
      );
      const ro = new ResizeObserver(schedule);
      ro.observe(canvas);
      offs.push(() => ro.disconnect());
      push();
      setRuneStatus({ state: "ready" });
    })
    .catch((err: unknown) => {
      if (disposed) return;
      console.warn("rune:", err);
      setRuneStatus({ state: "failed", reason: err instanceof Error ? err.message : String(err) });
    });

  return {
    beginEdit: (id) => mod?.beginEdit(id),
    paper: () => (mod ? Array.from(mod.paperDrew()) : null),
    editing: () => editing,
    refresh: schedule,
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      offs.forEach((off) => off());
      try {
        mod?.unmount();
      } catch (e) {
        console.warn("rune: unmount", e);
      }
      mod = null;
    },
  };
}

// dev and e2e builds: what Rune is handed and where the camera is, for checks that press on what it drew
if ((import.meta.env?.DEV || import.meta.env?.VITE_E2E_HOOKS) && typeof window !== "undefined") {
  (window as unknown as { __foundationRune: unknown }).__foundationRune = {
    camera,
    status: getRuneStatus,
    scene: () => buildScene(getState(), { insets: floorInsets(getUi()), readOnly: getUi().role === "viewer", tokens: readTokens(), paper: false, imageSrc: runeImageSrc }),
    addNote,
    createTable,
    events: () => seen,
    paper: () => (current as (RuneHost & { paper?(): number[] }) | null)?.paper?.() ?? null,
  };
}

let current: RuneHost | null = null;
/** the renderer that's mounted now (the grid asks it to open a note) */
export const runeHost = () => current;
export const setRuneHost = (h: RuneHost | null) => (current = h);
