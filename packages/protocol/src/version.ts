/**
 * Versions, compared the one way, on both sides of the wire: the server says the oldest client it
 * still works with (`FOUNDATION_MIN_CLIENT`), a client says which it is, and both ask the same
 * question of the same two strings.
 */

/** Semver order for the parts Foundation uses (`1.2.3`, `1.2.3-rc.1`); a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

const VERSION = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
export const isVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);

/**
 * Whether a client of this version is older than the minimum. No minimum (unset, or not a version)
 * refuses nobody; a client that doesn't say a readable version isn't refused on a guess.
 */
export function belowMinimum(client: unknown, min: unknown): boolean {
  return isVersion(client) && isVersion(min) && compareVersions(client, min) < 0;
}
