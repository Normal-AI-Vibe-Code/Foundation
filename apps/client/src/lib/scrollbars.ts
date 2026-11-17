/**
 * Scroll bars show only while a pane is in use: under the pointer (CSS), and
 * while it scrolls. A scroll event marks its pane `.is-scrolling` for a moment
 * after the last one, so a bar moved by the wheel or the keyboard is seen and
 * then goes (shell/spaces.css draws it).
 */

const LINGER = 700;
const timers = new WeakMap<Element, number>();

export function initScrollbars() {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target === document ? document.documentElement : (e.target as Element);
      if (!(el instanceof Element)) return;
      el.classList.add("is-scrolling");
      window.clearTimeout(timers.get(el));
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove("is-scrolling"), LINGER),
      );
    },
    { capture: true, passive: true },
  );
}
