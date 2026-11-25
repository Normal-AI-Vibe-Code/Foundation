/**
 * An invitation link (`http://<server>:4410/#/join/<code>`, made at the server's computer: apps/server/src/network.ts).
 * The code rides in the address's fragment, which no browser sends to a server, and it is taken out of the
 * address bar the moment this module loads (before the app reads its route), so it isn't left in history, a
 * screenshot or a shared link. The sign-in page then exchanges it once, by POST (Login.tsx).
 */

const JOIN = /^#\/join\/([A-Za-z0-9_-]{40,64})\/?$/;

function take(): string | null {
  if (typeof window === "undefined") return null;
  const m = JOIN.exec(window.location.hash);
  if (!m) return null;
  try {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {
    window.location.hash = "";
  }
  return m[1];
}

let pending = take();

/** the code this page was opened with, once */
export function takeJoinCode(): string | null {
  const c = pending;
  pending = null;
  return c;
}
