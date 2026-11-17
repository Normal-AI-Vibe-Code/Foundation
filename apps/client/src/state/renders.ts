/**
 * A render counter for the layers that matter to the frame budget (SPEC §5):
 * `window.__renders` counts each component's renders, in the dev server and
 * in a build made for the e2e checks (VITE_E2E_HOOKS) only. `e2e/renders.spec.ts`
 * reads it around a press, a drag and a typing burst. In a shipped build it is
 * a no-op. The dev server runs React's StrictMode, which renders twice.
 */

const on = Boolean((import.meta.env?.DEV || import.meta.env?.VITE_E2E_HOOKS) && typeof window !== "undefined");
const counts: Record<string, number> = on ? ((window as unknown as { __renders?: Record<string, number> }).__renders ??= {}) : {};

export function countRender(name: string): void {
  if (on) counts[name] = (counts[name] ?? 0) + 1;
}
