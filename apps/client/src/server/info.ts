/**
 * What the server this app uses says it is (`GET /api/server`, apps/server/src/network.ts), and the network
 * switch's calls. Pure helpers are here so they're tested on their own (test/serverInfo.test.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

export interface ServerInfo {
  name: string;
  version: string;
  /** local: this computer only; network: open to the office network; hosted: an address of its own */
  kind: "local" | "network" | "hosted";
  /** where the asker is, seen from the server */
  you: "this-computer" | "network" | "elsewhere";
  serves: string[];
  signIn: { google: boolean; invite: boolean; email: boolean };
  secure: boolean;
  // signed in
  address?: string;
  startedAt?: number;
  /** the code it runs, as `git describe` says it (null: it can't tell); compared with the app's (where.ts serverOlder) */
  build?: string | null;
  people?: number;
  chat?: { channels: number };
  network?: {
    on: boolean;
    active: boolean;
    setBy: "switch" | "environment";
    wide: boolean;
    urls: Array<{ url: string; label: string }>;
    listening: Array<{ address: string; iface: string; ok: boolean; answers: boolean | null; error: string | null }>;
    page: { built: boolean; canBuild: boolean; build?: { state: "idle" | "building" | "done" | "failed"; at: number | null; error: string | null } };
  };
  canManage?: boolean;
  /** an admin's: where its data is */
  data?: string;
}

export interface Invite {
  id: string;
  email: string;
  name: string;
  code: string;
  links: Array<{ url: string; label: string }>;
  expiresAt: number;
}

export interface NetworkSession {
  id: string;
  user_id: string;
  name: string;
  email: string;
  addr: string;
  ua: string;
  via: string;
  created_at: number;
  live: number;
  seen: number | null;
}

export { WHERE_LABEL, WHERE_NOTE, peopleNow, servesLine, serverOlder, upSince, whereIs, type Where } from "./where";

export const getServerInfo = () => api<ServerInfo>("/api/server");
export const setNetwork = (on: boolean) => api<ServerInfo>("/api/server/network", { method: "POST", json: { on } });
export const makeInvite = (email: string, name: string) => api<Invite>("/api/server/invites", { method: "POST", json: { email, name } });
export const cancelInvite = (id: string) => api<{ ok: true }>(`/api/server/invites/${encodeURIComponent(id)}/cancel`, { method: "POST", json: {} });
export const listSessions = () => api<{ sessions: NetworkSession[] }>("/api/server/sessions");
export const signOutSession = (id: string) => api<{ ok: true }>(`/api/server/sessions/${encodeURIComponent(id)}/sign-out`, { method: "POST", json: {} });
export const buildPage = () => api<{ build: unknown }>("/api/server/page/build", { method: "POST", json: {} });

/** the server's own account of itself, asked now and every `every` ms while `on` */
export function useServerInfo(on: boolean, every = 15_000) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const refresh = useCallback(async () => {
    try {
      const i = await getServerInfo();
      setInfo(i);
      return i;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    if (!on) return;
    void refresh();
    const t = setInterval(() => void refresh(), every);
    return () => clearInterval(t);
  }, [on, every, refresh]);
  return { info, setInfo, refresh };
}

/** copy text, also on a plain-http page where the clipboard API isn't offered (a LAN address) */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  t.remove();
  return ok;
}

/** open the server panel from elsewhere (ChatForm's strip): the side menu opens and the switch listens */
export const OPEN_SERVER_PANEL = "foundation:open-server-panel";
