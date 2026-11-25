/**
 * Which server ChatForm talks to, and how (Josh, 2026-11-21: "Host it on vercel for now. build a rust based
 * server there": `apps/chatserver`).
 *
 * By default ChatForm is on the Foundation server this app is signed in to (lib/api.ts). A device can point
 * ChatForm alone at a **chat server** (Settings → General → ChatForm's server; a build can name one with
 * VITE_CHATFORM_SERVER): channels, direct messages, threads, reactions, read marks, search and the live socket
 * come from there, while grids, files, agents and huddles stay on the Foundation server.
 *
 * A chat server is always another site, so the transport is the bearer one: the app signs in there on its own
 * (Google in the system browser, a code on both screens and a press: `apps/chatserver/src/app_signin.rs`; or the
 * dev login on a local test server), keeps the session in localStorage under that server's origin, and sends it
 * only to that server as `Authorization: Bearer`. A socket takes a one-time ticket. The session never goes in a
 * URL, and the Foundation session is never sent to the chat server (nor the other way round).
 */

import { ApiError, api, authHeaders, openSocket, serverUrl, SERVER } from "../lib/api";
import { builtChatServer, chatServerName, chatServerOrigin, isRemoteChat, KNOWN_CHAT_SERVERS, readUsedChatServers, rememberChatServer, rememberedChatServers, type KnownChatServer } from "./serverLogic";

const KEY = "chatform-server";
/** the addresses this device has used (Settings offers them again) */
const USED_KEY = "chatform-servers";
/** the chat server this build was made for (empty: Foundation's own); the desktop app's is the team's */
export const BUILT_CHAT_SERVER = builtChatServer(import.meta.env.VITE_CHATFORM_SERVER as string | undefined, import.meta.env.MODE);

function chosen(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

const foundationOrigin = (() => {
  try {
    return SERVER ? new URL(SERVER).origin : window.location.origin;
  } catch {
    return typeof window !== "undefined" ? window.location.origin : "";
  }
})();

const picked = chosen();
/** the chat server's origin, or "" when ChatForm is on the Foundation server (an empty choice overrides the build's) */
export const CHAT_SERVER = (() => {
  const raw = picked ?? BUILT_CHAT_SERVER;
  return raw && isRemoteChat(raw, foundationOrigin) ? (chatServerOrigin(raw) ?? "") : "";
})();
/** ChatForm is on a server of its own */
export const CHAT_REMOTE = CHAT_SERVER !== "";
export const CHAT_SERVER_NAME = CHAT_SERVER ? chatServerName(CHAT_SERVER) : "";

function usedServers(): string[] {
  try {
    return readUsedChatServers(localStorage.getItem(USED_KEY));
  } catch {
    return [];
  }
}

/** the servers Settings offers with a Use each: the team's, then the ones this device has used */
export const REMEMBERED_CHAT_SERVERS: KnownChatServer[] = rememberedChatServers(KNOWN_CHAT_SERVERS, [...(CHAT_SERVER ? [CHAT_SERVER] : []), ...usedServers()], foundationOrigin);

/**
 * Point this device's ChatForm at a chat server ("" or the Foundation server's own address: back to Foundation's).
 * The page reloads. Throws when it isn't an address.
 */
export function chooseChatServer(input: string) {
  const t = input.trim();
  const origin = t ? chatServerOrigin(t) : "";
  if (origin === null) throw new Error("That isn't an address. Try chat.example.app, or http://localhost:4420.");
  try {
    // an empty string is a choice too (it overrides a build that names a chat server); no choice at all is the build's
    if (!origin || origin === foundationOrigin) {
      if (BUILT_CHAT_SERVER) localStorage.setItem(KEY, "");
      else localStorage.removeItem(KEY);
    } else if (origin === BUILT_CHAT_SERVER) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, origin);
    if (origin && origin !== foundationOrigin) localStorage.setItem(USED_KEY, JSON.stringify(rememberChatServer(usedServers(), origin)));
  } catch { /* private window */ }
  window.location.reload();
}

const BEARER_KEY = `chatform-bearer:${CHAT_SERVER}`;

export function chatBearer(): string | null {
  if (!CHAT_REMOTE) return null;
  try {
    return localStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

function keepChatBearer(session: string | null | undefined) {
  try {
    if (session) localStorage.setItem(BEARER_KEY, session);
    else localStorage.removeItem(BEARER_KEY);
  } catch { /* private window */ }
}

/** the Authorization header for whichever server ChatForm is on */
export function chatAuthHeaders(): Record<string, string> {
  if (!CHAT_REMOTE) return authHeaders();
  const t = chatBearer();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export function chatUrl(path: string) {
  return CHAT_REMOTE ? `${CHAT_SERVER}${path}` : serverUrl(path);
}

/** the chat server, called as lib/api's `api` calls Foundation's: JSON in and out, its `error` thrown as words */
async function remote<T>(path: string, init: RequestInit & { json?: unknown } = {}, auth: Record<string, string> = chatAuthHeaders()): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${CHAT_SERVER}${path}`, {
      // no cookie: the bearer is this device's whole sign-in there
      credentials: "omit",
      ...rest,
      headers: { ...auth, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, `Can't reach ChatForm's server (${CHAT_SERVER_NAME}). It isn't running, it doesn't allow this app, or this device is offline.`);
  }
  const text = await res.text();
  let body: { error?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.ok ? 502 : res.status, res.ok ? `${CHAT_SERVER_NAME} didn't answer as a ChatForm server.` : `ChatForm's server (${CHAT_SERVER_NAME}) answered ${res.status}.`);
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

/** ChatForm's door to its server: Foundation's (lib/api) unless this device points ChatForm at a chat server */
export function chatApi<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  return CHAT_REMOTE ? remote<T>(path, init) : api<T>(path, init);
}

/** the chat socket: on a chat server, by a one-time ticket for exactly this path (the bearer can't ride a socket) */
export async function openChatSocket(path: string): Promise<WebSocket> {
  if (!CHAT_REMOTE) return openSocket(path);
  const { ticket } = await remote<{ ticket: string }>("/api/ws-ticket", { method: "POST", json: { path } });
  return new WebSocket(`${CHAT_SERVER.replace(/^http/, "ws")}${path}?ticket=${encodeURIComponent(ticket)}`);
}

// ---------------------------------------------------------------- signing in on a chat server

export interface ChatAccount {
  id: string;
  email: string;
  name: string;
  color: string;
  role: "admin" | "member" | "viewer";
}

export interface ChatServerConfig {
  google: boolean;
  devLogin: boolean;
  /** an app can sign in (the code and the press) */
  app?: boolean;
  /** what of ChatForm this server has; absent on a server that doesn't say */
  features?: string[];
  server?: string;
  version?: string;
}

export const chatConfig = () => remote<ChatServerConfig>("/auth/config", {}, {});
export const chatWho = () => remote<{ user: ChatAccount }>("/api/me");

/** begin: Google's address for the system browser, a poll secret only this window holds, and the code to show */
export const chatBegin = () => remote<{ url: string; poll: string; code: string; expiresIn: number }>("/auth/app/begin", { method: "POST" }, {});

/** has the person pressed "This is me" in the browser yet; on yes, this device keeps the session */
export async function chatPoll(poll: string) {
  const r = await remote<{ status: "pending" | "ok" | "error"; user?: ChatAccount; error?: string; session?: string }>("/auth/app/poll", { method: "POST" }, { authorization: `Bearer ${poll}` });
  if (r.status === "ok" && r.session) keepChatBearer(r.session);
  return { status: r.status, user: r.user, error: r.error };
}

/** a local test server's email-only sign-in (it answers only its own computer, and never when hosted) */
export async function chatDevLogin(email: string, name: string) {
  const r = await remote<{ user: ChatAccount; session?: string }>("/auth/dev", { method: "POST", json: { email, name, bearer: true } }, {});
  keepChatBearer(r.session);
  return r.user;
}

/** sign out of the chat server: it forgets the session first (it needs the bearer to know which), then this device does */
export async function chatSignOut() {
  try {
    if (chatBearer()) await remote("/auth/logout", { method: "POST" });
  } catch { /* unreachable: this device forgets it all the same */ }
  finally {
    keepChatBearer(null);
  }
}

/** the chat server refused the session (expired, or signed out elsewhere): this device stops sending it */
export function forgetChatBearer() {
  keepChatBearer(null);
}
