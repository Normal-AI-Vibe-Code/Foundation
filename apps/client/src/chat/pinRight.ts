/**
 * A conversation pinned in the right panel (2026-11-25, Josh: "Chat Form should be able to pin a conversation on the
 * right panel"). One conversation at a time, kept on this device: which one, and whether the panel was open, so a
 * pinned chat is beside the grid again after a reload. It is the tools pane's ChatForm tab (shell/Tools.tsx); the pin
 * itself is a person's press in ChatForm's head, on a chat card's head, or in the panel's own picker.
 */

import { useSyncExternalStore } from "react";
import { getUi, setUi } from "../state/ui";

const KEY = "foundation-chat-pin";

export interface ChatPin {
  /** the conversation's id on this device's chat server, or null for none */
  channel: string | null;
  /** the chat server it is on (a pin made against another server is not looked up on this one) */
  server: string;
}

function read(): ChatPin {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ChatPin> | null;
    if (v && (typeof v.channel === "string" || v.channel === null)) return { channel: v.channel ?? null, server: typeof v.server === "string" ? v.server : "" };
  } catch {
    /* none kept */
  }
  return { channel: null, server: "" };
}

let pin: ChatPin = typeof localStorage === "undefined" ? { channel: null, server: "" } : read();
const subs = new Set<() => void>();

function write(next: ChatPin) {
  pin = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private window */
  }
  for (const fn of subs) fn();
}

export function getChatPin(): ChatPin {
  return pin;
}

export function useChatPin(): ChatPin {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => pin,
    () => pin,
  );
}

/** pin `channel` in the right panel and open it there */
export function pinRight(channel: string, server: string) {
  write({ channel, server });
  setUi({ tool: "chat" });
}

/** take the pin off (the panel shows the picker) */
export function unpinRight() {
  write({ channel: null, server: pin.server });
}

/** is `channel` the one pinned (on `server`)? */
export function isPinnedRight(channel: string | undefined, server: string): boolean {
  return Boolean(channel) && pin.channel === channel && pin.server === server;
}

/** open or close the right panel's ChatForm */
export function toggleChatRight() {
  setUi({ tool: getUi().tool === "chat" ? null : "chat" });
}
