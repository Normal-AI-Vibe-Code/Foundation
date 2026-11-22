/**
 * What the Inbox, the setup wizards and the Slack guide read from the server (`GET /api/chat/bridges`,
 * `GET /api/chat/slack`), and how they stay current: the chat socket's `{t:"bridge"}` events (model.ts
 * `onBridge`), the window coming back into focus, and a short poll only while someone is waiting on a
 * consent page in another tab.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatBridgeStatus } from "@foundation/protocol";
import { api } from "../../lib/api";
import { onBridge } from "../model";
import { openExternal } from "../../utils/media";

export interface ReplyWindow {
  open: boolean;
  rule: string;
  closesAt?: number;
  why?: string;
}
export interface KeyState {
  key: string;
  what: string;
  set: boolean;
  source: "stored" | "env" | null;
  tail?: string;
  setBy?: string;
  setAt?: number;
}
export interface MailAccount {
  email: string;
  userId: string;
  label: string;
  labelFound: boolean;
  lastSyncAt: number | null;
  connectedAt?: number;
  error: string | null;
}
export interface BridgeView extends ChatBridgeStatus {
  settings: { enabled: boolean; inbox: string[]; puppet: string | null; inboxIsAdmins: boolean };
  list: Array<{ id: string; name: string; topic: string; lastPostAt: number; lastText?: string; unread: number; demo: boolean; window?: ReplyWindow }>;
  canStart: boolean;
  startRule?: string;
  accounts?: MailAccount[];
  /** admins only */
  keys?: KeyState[];
  hook?: string;
}
export interface ServerFacts {
  publicUrl: string;
  reachable: boolean;
  why?: string;
}
export interface SlackLink {
  channel: string;
  name: string;
  kind: string;
  slackId: string;
  slackName: string;
  private: boolean;
  state: "live" | "paused";
  linkedBy: string;
  linkedAt: number;
  lastReadAt: number | null;
  lastInAt: number | null;
  lastOutAt: number | null;
  error?: string;
  errorCode?: string;
}
export interface SlackView {
  status: ChatBridgeStatus;
  admin: boolean;
  token: { set: boolean; source: "stored" | "env" | "app" | null; tail?: string; setBy?: string; setAt?: number };
  app: { ok: boolean; team: string | null; url: string | null; bot: string | null; checkedAt: number; error: string | null } | null;
  scopes: { have: string[] | null; need: string[]; optional: string[]; missing: string[] | null; files: "upload" | "line" | null };
  events: string[];
  mode: "off" | "events" | "polling";
  pollSeconds: number;
  links: SlackLink[];
  history: { channels: number; lastImportAt: number | null };
  nudge: boolean;
  nudgeDismissed: boolean;
}
export interface Bridges {
  bridges: BridgeView[];
  demo: boolean;
  admin: boolean;
  server: ServerFacts;
  slack: SlackView;
}

export const ago = (at: number) => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
export const since = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** the bridges, kept current while mounted; `waitFor(test)` polls every 2 s until test passes (or 3 min) */
export function useBridges() {
  const [data, setData] = useState<Bridges | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const waiting = useRef<{ test: (b: Bridges) => boolean; until: number; timer: number } | null>(null);
  const load = useCallback(
    () =>
      api<Bridges>("/api/chat/bridges").then(
        (d) => {
          setData(d);
          setErr(null);
          const w = waiting.current;
          if (w && (w.test(d) || Date.now() > w.until)) {
            window.clearInterval(w.timer);
            waiting.current = null;
          }
          return d;
        },
        (e: Error) => {
          setErr(e.message);
          return null;
        },
      ),
    [],
  );
  useEffect(() => {
    void load();
    let t = 0;
    const soon = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void load(), 150);
    };
    const off = onBridge(soon);
    window.addEventListener("focus", soon);
    return () => {
      off();
      window.clearTimeout(t);
      window.removeEventListener("focus", soon);
      if (waiting.current) window.clearInterval(waiting.current.timer);
    };
  }, [load]);
  const waitFor = useCallback(
    (test: (b: Bridges) => boolean) => {
      if (waiting.current) window.clearInterval(waiting.current.timer);
      waiting.current = { test, until: Date.now() + 180_000, timer: window.setInterval(() => void load(), 2000) };
    },
    [load],
  );
  return { data, err, load, waitFor };
}

/** copy to the clipboard; true when it went */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** open a page outside Foundation: the system browser in the desktop app, a new tab on the web (utils/media.ts) */
export function openOutside(url: string) {
  void openExternal(url);
}

/** a long random string for a verify token or a key: `n` characters from letters and digits */
export function randomKey(n: number): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}
