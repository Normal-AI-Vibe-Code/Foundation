/**
 * How pictures arrive (2026-11-25): a section's pictures come in as a wave from the middle of the screen outward,
 * not popping at random as their fetches happen to land. Each picture's reveal waits a few steps by how far it is
 * from the viewport's centre; the step's length is a motion token (progressive-image.css: `--arrive-step` times
 * half of `--dur-press`), so the whole wave is a quarter of a second at most and nothing waits long for it.
 *
 * Pure: distances in, steps out. The fetch scheduler (imageCache.ts) already asks for the nearest first; this is
 * the same order, made visible.
 */

/** the most steps a picture waits: the far edge of the wave */
export const ARRIVAL_STEPS = 6;
/** the distance from the centre (CSS px) at which a picture waits the most */
export const ARRIVAL_REACH = 900;

/** how many steps a picture `distance` px from the viewport's centre waits before it shows (0: at once) */
export function arrivalStep(distance: number, reach = ARRIVAL_REACH, steps = ARRIVAL_STEPS): number {
  if (!Number.isFinite(distance) || distance <= 0 || reach <= 0 || steps <= 0) return 0;
  return Math.min(steps, Math.floor((distance / reach) * steps));
}

/** the order pictures show in: nearest the centre first, ties as they were given */
export function arrivalOrder<T extends { distance: number }>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i, step: arrivalStep(item.distance) }))
    .sort((a, b) => a.step - b.step || a.item.distance - b.item.distance || a.i - b.i)
    .map((x) => x.item);
}

/** the inline style that carries a picture's step to the stylesheet (nothing when it shows at once) */
export function arrivalStyle(distance: number): Record<string, string> | undefined {
  const step = arrivalStep(distance);
  return step ? { "--arrive-step": String(step) } : undefined;
}
