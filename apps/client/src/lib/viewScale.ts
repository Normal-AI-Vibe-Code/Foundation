/**
 * The grid's drawn scale as a CSS number, `--view-scale` on the root, for the few things that must
 * keep a size on the screen however far out the grid is (a card's ✕ stays pressable at 30 %).
 * Written when a zoom settles, never per frame: a root custom property restyles the document.
 */

import { camera, onCamera } from "../state/camera";

let started = false;
export function startViewScale() {
  if (started || typeof document === "undefined") return;
  started = true;
  let timer = 0;
  let last = "";
  const write = () => {
    const v = (Math.round(camera.scale * 20) / 20).toFixed(2);
    if (v === last) return;
    last = v;
    document.documentElement.style.setProperty("--view-scale", v);
  };
  write();
  onCamera(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(write, 140);
  });
}
