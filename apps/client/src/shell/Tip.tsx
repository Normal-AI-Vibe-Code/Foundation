import { useEffect, useRef } from "react";

/**
 * One roll-over label for every chrome button. Anything with `data-tip` (and
 * optionally `data-kbd`) names itself here after a short pause; moving along a
 * toolbar, the next label follows at once. It lives in screen space, not the
 * zoomed world, so it reads the same at any zoom, and it is one element for
 * the whole app.
 */
export function Tip() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let target: HTMLElement | null = null;
    let timer = 0;
    let lastShown = 0;

    const hide = () => {
      window.clearTimeout(timer);
      if (el.classList.contains("is-on")) lastShown = performance.now();
      el.classList.remove("is-on");
      target = null;
    };

    const show = (t: HTMLElement) => {
      const label = t.dataset.tip;
      if (!label || !t.isConnected) return;
      el.replaceChildren(label);
      if (t.dataset.kbd) {
        const k = document.createElement("span");
        k.className = "f-kbd";
        k.textContent = t.dataset.kbd;
        el.append(k);
      }
      const r = t.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      // under the button; above it when there's no room below
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = r.top - h - 8;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.classList.add("is-on");
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const t = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tip]") ?? null;
      if (t === target) return;
      const wasOn = el.classList.contains("is-on");
      hide();
      target = t;
      if (!t) return;
      const warm = wasOn || performance.now() - lastShown < 400;
      timer = window.setTimeout(() => target === t && show(t), warm ? 0 : 320);
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  return <div ref={ref} className="f-tip" role="tooltip" aria-hidden />;
}
