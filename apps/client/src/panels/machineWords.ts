/**
 * Words and numbers a machine card needs that don't need a browser (tested in
 * test/machine-words.test.ts).
 */

/**
 * Why a press on a machine's desktop didn't work, in words for the card. One
 * case gets its own: a server that answers its router's "not found" for the
 * route itself is a Foundation server from before machines had desktops
 * (2026-11-17: the app updates by itself, but a server started from a
 * checkout runs what it was started with until it is restarted; the press
 * said only "not found", in a toast). A 404 with other words is the server's
 * own answer (no such board, no such machine) and is passed on as it is.
 */
export function desktopRefusal(e: unknown, server: string, doing = "add a desktop"): string {
  const err = (e ?? {}) as { status?: number; message?: string };
  if (err.status === 404 && /^not found$/i.test((err.message ?? "").trim())) {
    return `The Foundation server at ${server} is older than this app and can't ${doing} yet. Restart it (the server switch at the bottom right: Stop, then Start; or stop and start it where it runs), then try again. Nothing was changed in the machine.`;
  }
  return err.message || "The server didn't say why.";
}

/**
 * The in-use ring's width in the card's own pixels, for 2 px on the screen: a
 * card is drawn scaled (the camera × its section's fit). Never under 1 or
 * over 8 of the card's pixels (a card drawn at under a quarter, or over
 * double, its size).
 */
export const ringWidth = (drawnScale: number) => (drawnScale > 0 && Number.isFinite(drawnScale) ? Math.round(Math.max(1, Math.min(8, 2 / drawnScale)) * 100) / 100 : 2);
