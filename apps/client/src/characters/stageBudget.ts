/**
 * How many character cards play at once (2026-11-15). Every card on a studio board draws itself
 * live: a 3D character is a WebGL context and a frame's worth of skinning, a mesh avatar a canvas of
 * its own, so "all of them" is a budget, not a promise. Cards on screen ask for a place; up to
 * `budget` get one; the card under the pointer always does (the longest-playing one gives way).
 * A card without a place shows its last picture: never an empty frame.
 *
 * The budget follows the frames. While any card plays, frame times are watched: a board that can't
 * hold ~30 fps sheds a card every couple of seconds (down to one), and takes one back on when it has
 * held 50 fps for a while and someone is waiting.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const MIN = 1;
const MAX = 8;
let budget = 6;

interface Claim {
  revoke: () => void;
  grant: () => void;
  at: number;
}
const playing = new Map<object, Claim>();
const waiting = new Map<object, Claim>();

function oldest(): object | undefined {
  let pick: object | undefined;
  let at = Infinity;
  for (const [k, c] of playing) if (c.at < at) ((at = c.at), (pick = k));
  return pick;
}
function shed() {
  const k = oldest();
  if (!k) return;
  const c = playing.get(k)!;
  playing.delete(k);
  waiting.set(k, c);
  c.revoke();
}
function fill() {
  while (playing.size < budget && waiting.size) {
    const [k, c] = waiting.entries().next().value as [object, Claim];
    waiting.delete(k);
    playing.set(k, { ...c, at: performance.now() });
    c.grant();
  }
}

// ---- the frames ----
let raf = 0;
let last = 0;
let ema = 16;
let slowFor = 0;
let fastFor = 0;
function tick(now: number) {
  raf = playing.size ? requestAnimationFrame(tick) : 0;
  if (!raf) return void (last = 0);
  const dt = last ? Math.min(250, now - last) : 16;
  last = now;
  if (document.hidden) return;
  ema += (dt - ema) * 0.08;
  if (ema > 36) ((slowFor += dt), (fastFor = 0));
  else if (ema < 20) ((fastFor += dt), (slowFor = 0));
  else slowFor = fastFor = 0;
  if (slowFor > 2000 && budget > MIN) {
    budget--;
    slowFor = 0;
    while (playing.size > budget) shed();
  } else if (fastFor > 6000 && budget < MAX && waiting.size) {
    budget++;
    fastFor = 0;
    fill();
  }
}
const watch = () => {
  if (!raf && playing.size) raf = requestAnimationFrame(tick);
};

/** for the checks: how many play, how many wait, the budget */
export const stageBudget = () => ({ playing: playing.size, waiting: waiting.size, budget });

/**
 * A card's place on the stage. `want`: it's on screen at a size worth playing. Returns whether it
 * plays now, and `take()`, which the pointer calls: this card plays, whoever has to give way.
 */
export function useStage(want: boolean): { live: boolean; take: () => void } {
  const key = useRef<object>({});
  const [live, setLive] = useState(false);
  const claim = useRef<Claim>({ revoke: () => setLive(false), grant: () => setLive(true), at: 0 });

  useEffect(() => {
    const k = key.current;
    if (!want) return;
    waiting.set(k, claim.current);
    fill();
    watch();
    return () => {
      waiting.delete(k);
      if (playing.delete(k)) fill();
      setLive(false);
    };
  }, [want]);

  const take = useCallback(() => {
    const k = key.current;
    if (playing.has(k)) return;
    if (playing.size >= budget) shed();
    waiting.delete(k);
    playing.set(k, { ...claim.current, at: performance.now() });
    setLive(true);
    watch();
  }, []);
  return { live: live && want, take };
}
