/**
 * The desktop app's server commands (src-tauri/src/local_server.rs). Only in the desktop app; the
 * page's other code never imports Tauri at load, so this is loaded on first use.
 */

/** the two kinds of server the desktop app can start here (local_server.rs) */
export type LocalKind = "builtIn" | "checkout";

export interface LocalStatus {
  /** something answers on :4410 (this app's server, or one started another way) */
  listening: boolean;
  /** this app started it and it's still running */
  ours: boolean;
  /** which kind this app started */
  kind: LocalKind | null;
  /** the checkout it runs from, or the built-in server's data folder */
  folder: string | null;
  /** this build carries its own server (an installed app; not `tauri dev`) */
  builtIn: boolean;
  /** the one this app started stopped by itself: its exit and the end of its log */
  exited: string | null;
  /** a Foundation server on the port that an earlier run of this app started (it outlives an update's
   * relaunch): which kind. It can be stopped, and so restarted, from here (local_server.rs) */
  adopted?: LocalKind | null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const localStatus = () => call<LocalStatus>("local_server_status");
export const startLocal = (kind: LocalKind, folder?: string) => call<LocalStatus>("start_local_server", { kind, folder: folder ?? null });
export const stopLocal = () => call<LocalStatus>("stop_local_server");

/**
 * Asks the server switch to restart this computer's server (stop, then start the same kind from the same
 * folder): the way out when the server is older than the app, offered where that is found (a machine's
 * Add a desktop). The switch opens and shows it happening; the page reloads when the server is back.
 */
export const RESTART_EVENT = "foundation:restart-server";
export const askRestart = () => window.dispatchEvent(new Event(RESTART_EVENT));

/** whether a Foundation server answers at an origin (its public /auth/config), within a few seconds */
export async function answers(origin: string, ms = 3000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${origin}/auth/config`, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { devLogin?: unknown } | null;
    // a Foundation server says how it signs people in; anything else at that address isn't one
    return !!body && typeof body.devLogin === "boolean";
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
