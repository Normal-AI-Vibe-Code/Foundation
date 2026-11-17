/**
 * Heavy things start when the camera is calm (2026-11-11). Mounting a live
 * page (an <iframe>: a whole document to parse, lay out and paint) or a
 * video's decoder costs tens of milliseconds each; started in the middle of a
 * pan, a pinch or a glide, they're the frames that stutter. So a card that
 * becomes worth running asks here, and runs once the camera has been still
 * for a moment, one at a time, each in a gap the page has to spare.
 */

import { useEffect, useState } from "react";
import { onCamera } from "../state/camera";

const STILL_MS = 220;
let movedAt = 0;
let watching = false;
const queue: { run: () => void; live: boolean }[] = [];
let pumping = false;

function watch() {
  if (watching) return;
  watching = true;
  onCamera(() => (movedAt = performance.now()));
}

const idle = (fn: () => void) =>
  typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 100 }) : window.setTimeout(fn, 32);

function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    while (queue.length && !queue[0].live) queue.shift();
    if (!queue.length) {
      pumping = false;
      return;
    }
    const still = performance.now() - movedAt;
    if (still < STILL_MS) {
      window.setTimeout(step, STILL_MS - still + 16);
      return;
    }
    idle(() => {
      // the camera may have moved while we waited for the gap
      if (performance.now() - movedAt < STILL_MS) return step();
      const job = queue.shift();
      if (job?.live) job.run();
      // the next one a frame later, so two never land in one frame
      window.setTimeout(step, 16);
    });
  };
  step();
}

/** run `fn` once the camera is calm, in turn; returns a cancel */
export function whenCalm(fn: () => void): () => void {
  watch();
  const job = { run: fn, live: true };
  queue.push(job);
  pump();
  return () => {
    job.live = false;
  };
}

/**
 * For a card: true once it has wanted to run (`want`) through a calm camera.
 * It stays true while `want` holds; when `want` drops, it's asked again next time.
 */
export function useCalmAdmit(want: boolean): boolean {
  const [admitted, setAdmitted] = useState(false);
  useEffect(() => {
    if (!want) {
      setAdmitted(false);
      return;
    }
    return whenCalm(() => setAdmitted(true));
  }, [want]);
  return want && admitted;
}
