/**
 * The sandbox a live page runs in (#80). A page from somewhere else keeps its
 * own origin (allow-same-origin), so its sign-in and storage work: that origin
 * is its own, not ours, and it can't reach the board. A page served from
 * Foundation's own origin (the app's, or its server's, where uploaded files
 * live) runs as an opaque origin instead: with scripts and same-origin
 * together it could lift its own sandbox and act with the person's session.
 * The postMessage bridge checks the sending window, not its origin, so ports
 * work either way.
 */
export const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** `ours`: the origins that are Foundation (the page's, and the server's when it's elsewhere) */
export function sandboxFor(url: string, ours: string[]): string {
  let origin: string;
  try {
    origin = new URL(url, ours[0]).origin;
  } catch {
    return SANDBOX;
  }
  // an address that doesn't parse to a real origin ("null": data:, blob:, about:) gets the strict one too
  return origin === "null" || ours.includes(origin) ? SANDBOX : `${SANDBOX} allow-same-origin`;
}
