// Dev only: hidden/background panes (test harnesses, headless capture) pause
// requestAnimationFrame; ?rafshim drives frames from a timer so captures show
// the real, settled UI. Imported first in main.tsx so it runs before any
// animation library captures requestAnimationFrame.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("rafshim")) {
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
}
export {};
