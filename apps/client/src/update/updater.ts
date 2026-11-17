/**
 * Foundation's desktop updates: one small store over Tauri's updater plugin (SPEC §3 "Desktop updates").
 *
 * The feed (`latest.json` on the newest GitHub release, see tauri.conf.json) names the newest version
 * and a signed installer per platform; the plugin refuses anything not signed with Foundation's key.
 * An installed build checks a few seconds after launch (and every few hours while it stays open); a
 * person presses Update before anything downloads. On Windows the installer runs in passive mode and
 * Foundation exits while it does; on macOS and Linux Foundation relaunches itself.
 *
 * In a browser this module is inert: the web client updates with the server.
 */
import { useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  LAUNCH_DELAY_MS,
  RECHECK_MS,
  explainError,
  mayCheckOnLaunch,
  readPrefs,
  minimumOver,
  settleOnLaunch,
  shouldOffer,
  writePrefs,
} from "./policy";
import { authConfig } from "../lib/api";
import { CLIENT_VERSION } from "../lib/version";

export type UpdatePhase = "available" | "downloading" | "installing" | "failed" | "updated" | "checking" | "current" | "unreachable" | "off";

export interface UpdateState {
  phase: UpdatePhase | "idle";
  /** whether the floating card is up (Settings shows the same state inline either way) */
  shown: boolean;
  /** the version running now (null in a browser) */
  current: string | null;
  /** the oldest client the server still works with, when this one is older: the update isn't one to put off */
  required: string | null;
  /** the version on offer, or the version just installed (updated) */
  version: string | null;
  notes: string | null;
  date: string | null;
  received: number;
  total: number | null;
  message: string | null;
}

let state: UpdateState = {
  phase: "idle",
  shown: false,
  current: null,
  required: null,
  version: null,
  notes: null,
  date: null,
  received: 0,
  total: null,
  message: null,
};
const listeners = new Set<() => void>();
function set(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
export const getUpdate = () => state;
export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    getUpdate,
    getUpdate,
  );
}

/** inside the Tauri window (dev or packaged) */
export const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** `tauri dev`: the window shows Vite; installing from it would overwrite the installed app */
const DEV = import.meta.env.DEV;
let offered: Update | null = null;
let laterThisLaunch = false;
let started = false;

/**
 * Ask the server which clients it still works with. If this one is older, the card goes up and stays:
 * in the desktop app it checks the feed at once and offers the update without Later or Skip; in a
 * browser (or `tauri dev`) it says how this copy is brought up to date. Quiet when the server can't be
 * reached, names no minimum, or this client meets it (a minimum that was lifted takes the card's hold off).
 */
export async function learnMinimum() {
  let cfg: Awaited<ReturnType<typeof authConfig>>;
  try {
    cfg = await authConfig();
  } catch {
    return;
  }
  const mine = state.current ?? CLIENT_VERSION;
  const required = minimumOver(mine, cfg.minClient);
  if (!required) {
    if (state.required) set({ required: null, shown: false, phase: state.phase === "off" ? "idle" : state.phase });
    return;
  }
  if (state.required === required && state.shown) return;
  set({ required, current: mine, shown: true });
  if (inDesktop && !DEV) return void checkForUpdate(true);
  set({
    phase: "off",
    message: inDesktop
      ? `This is a development build (${mine}): pull main to bring it up to date.`
      : `This page is Foundation ${mine}${cfg.version ? `, and its server is ${cfg.version}` : ""}. Reload to get the server's own page.`,
  });
}

/** Called once at boot: says what changed if this is a new version's first run, then checks after a pause. */
export function startUpdates() {
  if (started || typeof window === "undefined") return;
  started = true;
  // the server may refuse this client as too old at any time (a socket closed 4426, a ticket's 426): ask it what it needs
  window.addEventListener("foundation:client-too-old", () => void learnMinimum());
  if (!inDesktop) {
    void learnMinimum();
    setInterval(() => navigator.onLine && void learnMinimum(), RECHECK_MS);
    return;
  }
  void (async () => {
    const { getVersion } = await import("@tauri-apps/api/app");
    const current = await getVersion().catch(() => null);
    set({ current });
    if (current) {
      const { whatsNew, prefs } = settleOnLaunch(current, readPrefs());
      writePrefs(prefs);
      if (whatsNew) {
        set({ phase: "updated", shown: true, version: whatsNew.version, notes: whatsNew.notes ?? null, date: whatsNew.date ?? null });
        // the relaunched copy can open behind other windows; the person just pressed Update, so bring it forward
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        void getCurrentWindow().setFocus().catch(() => {});
      }
    }
    // before the quiet check: an update the server needs shouldn't wait eight seconds behind a board that won't sync
    await learnMinimum();
    setInterval(() => navigator.onLine && void learnMinimum(), RECHECK_MS);
    if (!mayCheckOnLaunch({ desktop: true, dev: DEV, online: navigator.onLine })) return;
    setTimeout(() => void checkForUpdate(false), LAUNCH_DELAY_MS);
    setInterval(() => {
      if (navigator.onLine) void checkForUpdate(false);
    }, RECHECK_MS);
  })();
}

/** Ask the feed. `manual` comes from Settings: it shows every outcome and ignores Later and Skip. */
export async function checkForUpdate(manual: boolean) {
  if (!inDesktop) {
    if (manual) set({ phase: "off", message: "The web app updates with its server. The desktop app checks the feed itself." });
    return;
  }
  if (DEV) {
    if (manual) set({ phase: "off", message: "This is a development build (tauri dev): pull main to update it. Installed builds check the feed." });
    return;
  }
  if (state.phase === "downloading" || state.phase === "installing" || state.phase === "checking") return;
  // an update the server needs is asked for as if by hand: every outcome shows
  manual ||= Boolean(state.required);
  // the "what changed" card stays until it is closed; a quiet check never replaces it
  if (!manual && state.phase === "updated" && state.shown) return;
  // a card already up for a version stays as it is on a quiet re-check
  if (!manual && state.phase === "available") return;
  set({ phase: manual ? "checking" : state.phase, message: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 20_000 });
    if (offered && offered !== update) void offered.close().catch(() => {});
    offered = update;
    if (!update) {
      // a quiet check that finds nothing changes nothing; one the server needs says the feed doesn't have it yet
      if (manual) set({ phase: "current", version: state.current, shown: Boolean(state.required) });
      return;
    }
    if (!shouldOffer(update.version, readPrefs(), { manual, laterThisLaunch, required: Boolean(state.required) })) return;
    set({
      phase: "available",
      // a quiet check puts the card up; a manual one answers in Settings, where it was asked; a needed one is always up
      shown: state.required ? true : manual ? state.shown && state.phase !== "updated" : true,
      version: update.version,
      notes: update.body ?? null,
      date: update.date ?? null,
      current: update.currentVersion || state.current,
    });
  } catch (e) {
    // a quiet check that fails stays silent: Foundation works offline
    if (manual) set({ phase: "unreachable", message: explainError(e, "check"), shown: state.shown || Boolean(state.required) });
  }
}

/**
 * Download, verify and install the version on the card, then restart. Only ever called from a button.
 * The feed is read again first, so Try again picks up a corrected release instead of repeating the
 * one that failed; if the feed now offers another version, the card shows that one and waits for
 * another press rather than installing something unseen.
 */
export async function installUpdate() {
  if (!offered || state.phase === "downloading" || state.phase === "installing") return;
  const wanted = state.version;
  set({ phase: "downloading", shown: true, received: 0, total: null, message: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 20_000 });
    if (offered !== update) void offered?.close().catch(() => {});
    offered = update;
    if (!update) {
      set({ phase: "current", shown: false, version: state.current });
      return;
    }
    if (update.version !== wanted) {
      set({ phase: "available", version: update.version, notes: update.body ?? null, date: update.date ?? null });
      return;
    }
    writePrefs({
      ...readPrefs(),
      pending: { version: update.version, from: state.current ?? update.currentVersion, notes: update.body ?? null, date: update.date ?? null },
    });
    let received = 0;
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") set({ total: ev.data.contentLength ?? null });
      else if (ev.event === "Progress") {
        received += ev.data.chunkLength;
        set({ received });
      } else set({ phase: "installing" });
    });
    // Windows exits inside downloadAndInstall; macOS and Linux arrive here with the new bundle in place
    set({ phase: "installing" });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    const { pending: _dropped, ...rest } = readPrefs();
    writePrefs(rest);
    set({ phase: "failed", shown: true, message: explainError(e, "install") });
  }
}

/** Hide the card until the next launch. */
export function later() {
  // not offered for an update the server needs
  if (state.required) return;
  laterThisLaunch = true;
  set({ shown: false, phase: state.phase === "failed" ? "available" : state.phase });
}

/** Hide this version until a newer one is published. */
export function skipVersion() {
  if (state.required) return;
  if (state.version) writePrefs({ ...readPrefs(), skipped: state.version });
  laterThisLaunch = true;
  set({ shown: false });
}

/** Close the "what changed" card (or an unreachable notice). */
export function closeCard() {
  if (state.required) return;
  set({ shown: false, phase: state.phase === "updated" ? "idle" : state.phase });
}
