/**
 * Where the shell is: on a grid, on Today, or in Settings. All three are places inside the one
 * Foundation interface (2026-11-15): the top bar and the side menu stay, and only what fills the
 * open paper changes. The address says which:
 *
 *   #/today              Today (and home, unless this device starts on its last grid)
 *   #/board              the grid that's open (also any ?board= / ?focus= link)
 *   #/settings[/<tab>]   Settings, on one of its tabs
 *   #/chat[/<tab>/<rest>] ChatForm: Chat, Agents, Inbox or Huddles; on Chat, rest is a channel (and a thread or a message in it)
 */

export const SETTINGS_TABS = ["general", "agents", "avatars", "plan", "design", "services", "places", "renderer", "releases"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** ChatForm's tabs (`#/chat/<tab>/<rest>`; chat/ChatForm.tsx) */
export const CHAT_TABS = ["chat", "agents", "inbox", "huddles"] as const;
export type ChatTab = (typeof CHAT_TABS)[number];

export type Place = { kind: "grid" } | { kind: "today" } | { kind: "settings"; tab: SettingsTab; rest: string } | { kind: "chat"; tab: ChatTab; rest: string };

const START = "foundation-start";
/** what this device opens on: Today (the default) or the grid it had open last */
export function startsOn(): "today" | "grid" {
  try {
    return localStorage.getItem(START) === "grid" ? "grid" : "today";
  } catch {
    return "today";
  }
}
export function setStartsOn(v: "today" | "grid") {
  try {
    localStorage.setItem(START, v);
  } catch { /* private window */ }
}

export function placeOf(hash: string, search: string = window.location.search): Place {
  if (hash.startsWith("#/settings")) {
    const [tab = "", ...rest] = hash.slice("#/settings".length).replace(/^\//, "").split("/");
    return { kind: "settings", tab: (SETTINGS_TABS as readonly string[]).includes(tab) ? (tab as SettingsTab) : "general", rest: rest.join("/") };
  }
  if (hash === "#/chat" || hash.startsWith("#/chat/")) {
    const [tab = "", ...rest] = hash.slice("#/chat".length).replace(/^\//, "").split("/");
    return { kind: "chat", tab: (CHAT_TABS as readonly string[]).includes(tab) ? (tab as ChatTab) : "chat", rest: rest.join("/") };
  }
  if (hash.startsWith("#/today")) return { kind: "today" };
  if (hash.startsWith("#/board")) return { kind: "grid" };
  const q = new URLSearchParams(search);
  if (q.has("board") || q.has("focus")) return { kind: "grid" };
  return startsOn() === "grid" ? { kind: "grid" } : { kind: "today" };
}

export function goToday() {
  window.location.hash = "#/today";
}
export function goGrid() {
  if (!window.location.hash.startsWith("#/board")) window.location.hash = "#/board";
}
/** ChatForm, on a tab (Chat by default), at a channel or a view of it (`rest`) */
export function goChat(tab: ChatTab = "chat", rest = "") {
  window.location.hash = `#/chat/${tab}${rest ? `/${rest}` : ""}`;
}
export function goSettings(tab?: SettingsTab | string) {
  window.location.hash = tab ? `#/settings/${tab}` : "#/settings";
}
