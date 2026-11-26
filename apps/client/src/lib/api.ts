/**
 * The client's one door to the Foundation server. In dev, Vite proxies /api,
 * /auth, /files, /mcp and /sync to the server (vite.config.ts), so the
 * session cookie is same-origin. VITE_FOUNDATION_SERVER (`.env.desktop` for
 * the packaged app) points a built or Tauri client at another server, and a
 * person can point this device elsewhere (the sign-in page's Server line,
 * kept in localStorage).
 *
 * Two transports, one API:
 *  - **cookie**: the page and the server are one origin (the web app, dev).
 *    The HttpOnly SameSite cookie rides every request and socket, as before.
 *  - **bearer**: the server is another origin (the desktop app's page is
 *    http://localhost:31440; a hosted server is another site, so its SameSite
 *    cookie never arrives). Sign-in asks for a session in the response body;
 *    it's kept in localStorage under that server's origin (never sent to
 *    another server) and goes out only as `Authorization: Bearer`. Sockets
 *    can't carry a header, so each one first trades the bearer for a
 *    one-time, 30-second ticket for that socket's path (`openSocket`).
 *    The session never goes in a URL.
 */

import type { AgentEvent, SearchHit, UserInfo } from "@foundation/protocol";
import { CLIENT_VERSION } from "./version";

const SERVER_KEY = "foundation-server";
/** the server this build was made for (empty: the page's own origin) */
export const BUILT_SERVER = (import.meta.env.VITE_FOUNDATION_SERVER as string | undefined)?.replace(/\/$/, "") ?? "";

function chosenServer(): string | null {
  try {
    return localStorage.getItem(SERVER_KEY);
  } catch {
    return null;
  }
}

export const SERVER = (chosenServer() ?? BUILT_SERVER).replace(/\/$/, "");

/** point this device at another server (empty: the one it was built for); the page reloads */
export function chooseServer(url: string) {
  const u = url.trim().replace(/\/$/, "");
  try {
    if (!u || u === BUILT_SERVER) localStorage.removeItem(SERVER_KEY);
    else localStorage.setItem(SERVER_KEY, new URL(u).origin);
  } catch { /* private window, or not a URL */ }
  window.location.reload();
}

const serverOrigin = (() => {
  try {
    return SERVER ? new URL(SERVER).origin : window.location.origin;
  } catch {
    return window.location.origin;
  }
})();

/** the server is another origin: sign in for a bearer and send it as a header (above) */
export const BEARER = typeof window !== "undefined" && serverOrigin !== window.location.origin;

const BEARER_KEY = `foundation-bearer:${serverOrigin}`;

/** this device's session with this server, when it holds a bearer (never in a URL) */
export function bearerToken(): string | null {
  try {
    return localStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

function keepBearer(session: string | undefined | null) {
  try {
    if (session) localStorage.setItem(BEARER_KEY, session);
    else localStorage.removeItem(BEARER_KEY);
  } catch { /* private window */ }
}

/** the Authorization header for this server, if this device holds a bearer for it */
export function authHeaders(): Record<string, string> {
  const t = bearerToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

export function serverUrl(path: string) {
  return `${SERVER}${path}`;
}

export function wsUrl(path: string) {
  const base = SERVER || window.location.origin;
  return base.replace(/^http/, "ws") + path;
}

/**
 * Open one of the server's sockets (`/sync/…`, `/huddle/…`, `/machines/…/tty`).
 * With a bearer, first ask for a one-time ticket for exactly this path and put
 * that in the URL; with the cookie, connect as before. Rejects if no ticket
 * could be had (offline, signed out): callers treat it like a dropped socket.
 */
export async function openSocket(path: string, query = ""): Promise<WebSocket> {
  // every socket says which client opens it: a server may refuse one older than it still works with (4426, or 426 for the ticket)
  const q = `?${query ? `${query}&` : ""}client=${encodeURIComponent(CLIENT_VERSION)}`;
  if (!authHeaders().authorization) return new WebSocket(wsUrl(path + q));
  const { ticket } = await api<{ ticket: string }>("/api/ws-ticket", { method: "POST", json: { path, client: CLIENT_VERSION } });
  return new WebSocket(wsUrl(`${path}${q ? `${q}&` : "?"}ticket=${encodeURIComponent(ticket)}`));
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** where the server is, as a person would say it */
export const SERVER_NAME = serverOrigin.replace(/^https?:\/\//, "");

/**
 * fetch, but a server that can't be reached says so. The browser's own error
 * is "Failed to fetch" whatever went wrong; nearly always it means the
 * Foundation server isn't running (or this device points at the wrong one),
 * and that's what the person needs to read. Status 0, as an upload's does.
 */
export async function reach(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, `Can't reach the Foundation server (${SERVER_NAME}). It isn't running, or this device points at the wrong one.`);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await reach(serverUrl(path), {
    credentials: "include",
    ...rest,
    headers: { ...authHeaders(), ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let body: { error?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // not JSON: a proxy answering for a server that's down (Vite's 500/502), or a page from the wrong server
    throw new ApiError(res.ok ? 502 : res.status, res.ok ? `${SERVER_NAME} didn't answer as a Foundation server.` : `Can't reach the Foundation server (${SERVER_NAME}): it answered ${res.status}. It may not be running.`);
  }
  // 426: this client is older than the server still works with. The update card takes it from here (update/updater.ts)
  if (res.status === 426 && typeof window !== "undefined") window.dispatchEvent(new CustomEvent("foundation:client-too-old", { detail: body.error }));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export const me = () => api<{ user: UserInfo | null }>("/api/me");
export const authConfig = () => api<{ google: boolean; devLogin: boolean; flowform?: { url: string }; invite?: boolean; version?: string; minClient?: string | null }>("/auth/config");
/**
 * desktop: Google through flowform in the system browser; the window polls with a secret only it holds, and
 * shows `code`, which the browser shows back before the person presses "This is me"
 */
export const flowformBegin = () => api<{ url: string; poll: string; code: string; expiresIn: number }>("/auth/flowform/begin", { method: "POST" });
export async function flowformPoll(poll: string) {
  // the poll secret is this request's Authorization (it replaces any bearer); with a bearer transport, ask for the session in the body
  const r = await api<{ status: "pending" | "ok" | "error"; user?: UserInfo; error?: string; session?: string }>(`/auth/flowform/poll${BEARER ? "?bearer=1" : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${poll}` },
  });
  if (r.session) keepBearer(r.session);
  return r;
}
export async function devLogin(email: string, name: string) {
  const r = await api<{ user: UserInfo; session?: string }>("/auth/dev", { method: "POST", json: BEARER ? { email, name, bearer: true } : { email, name } });
  if (r.session) keepBearer(r.session);
  return { user: r.user };
}
/**
 * an invitation an admin made at the server's computer, to sign in from another computer on its network
 * (apps/server/src/network.ts): the link's code, or the email and the short code. Exchanged by POST, never kept
 */
export async function inviteSignIn(body: { code: string } | { email: string; short: string }) {
  const r = await api<{ user: UserInfo; session?: string }>("/auth/invite", { method: "POST", json: BEARER ? { ...body, bearer: true } : body });
  if (r.session) keepBearer(r.session);
  return { user: r.user };
}
/** sign out: this device also forgets who you are and the board copies it kept for offline */
export async function logout() {
  try {
    localStorage.removeItem(ME_KEY);
    localStorage.removeItem("foundation-boards");
    for (const k of Object.keys(localStorage)) if (k.startsWith("foundation-pending:")) localStorage.removeItem(k);
  } catch { /* private window */ }
  const { forgetDevice } = await import("../sync/board");
  await forgetDevice();
  const { clearImageCache } = await import("./imageCache");
  await clearImageCache();
  // one sign-in, one sign-out: ChatForm's own server (chat/server.ts) forgets this device too. It gets three
  // seconds to hear it; the device forgets its chat bearer either way
  const chat = await import("../chat/server");
  await Promise.race([chat.chatSignOut(), new Promise((ok) => setTimeout(ok, 3000))]);
  chat.forgetChatBearer();
  // the server forgets the session first (it needs the bearer to know which), then this device does
  try {
    return await api("/auth/logout", { method: "POST" });
  } finally {
    keepBearer(null);
  }
}

const ME_KEY = "foundation-me";

export function rememberMe(user: UserInfo | null) {
  try {
    if (user) localStorage.setItem(ME_KEY, JSON.stringify(user));
    else localStorage.removeItem(ME_KEY);
  } catch { /* private window */ }
}

/**
 * Who's signed in. Remembered on this device, so that when the server can't
 * be reached the app still opens (from the boards this device kept) instead
 * of the sign-in page. The server still checks the session on every request.
 */
export async function whoAmI(): Promise<{ user: UserInfo | null; offline: boolean }> {
  try {
    const { user } = await me();
    rememberMe(user);
    return { user, offline: false };
  } catch (e) {
    // status 0 is a server that couldn't be reached (`reach`): that's offline, not signed out
    if (e instanceof ApiError && e.status > 0 && e.status < 500) return { user: null, offline: false };
    try {
      const kept = localStorage.getItem(ME_KEY);
      return { user: kept ? (JSON.parse(kept) as UserInfo) : null, offline: true };
    } catch {
      return { user: null, offline: true };
    }
  }
}

export function search(q: string, board: string, remote = true, signal?: AbortSignal) {
  return api<{ hits: SearchHit[]; sources: Record<string, number> }>(
    `/api/search?q=${encodeURIComponent(q)}&board=${encodeURIComponent(board)}&remote=${remote ? 1 : 0}`,
    { signal },
  );
}

export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

/** Upload with progress (XHR — fetch can't report upload progress). */
export function uploadFile(file: File, board: string, onProgress?: (f: number) => void): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", serverUrl(`/api/files?board=${encodeURIComponent(board)}&name=${encodeURIComponent(file.name)}`));
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("content-type", file.type || guessMime(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 300) reject(new ApiError(xhr.status, body.error ?? "upload failed"));
        else resolve(body.file);
      } catch {
        reject(new ApiError(xhr.status, "upload failed"));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network error"));
    xhr.send(file);
  });
}

function guessMime(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    step: "model/step", stp: "model/step", iges: "model/iges", igs: "model/iges", stl: "model/stl", obj: "model/obj",
    glb: "model/gltf-binary", gltf: "model/gltf+json", "3mf": "model/3mf", md: "text/markdown", csv: "text/csv", pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Start an agent turn and follow it (SSE over a POST). The first event names the run. */
export function streamAgent(
  /** `section`: the section an ask came from (its timeline records the run there) */
  body: { board: string; prompt: string; runtime?: string; session?: string; persona?: "shiba"; as?: string; section?: string },
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
) {
  return readEvents(
    reach(serverUrl("/api/agent"), {
      method: "POST",
      credentials: "include",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
    onEvent,
  );
}

/** Follow a run that's already going (a reloaded tab): everything so far, then live. */
export function followRun(id: string, onEvent: (e: AgentEvent) => void, signal: AbortSignal) {
  return readEvents(reach(serverUrl(`/api/agent/runs/${encodeURIComponent(id)}/events`), { credentials: "include", headers: authHeaders(), signal }), onEvent);
}

/** fetch a file of this server's (`/files/…`) with this device's session, wherever the server is */
export function fetchFile(path: string, init: RequestInit = {}) {
  return fetch(path.startsWith("/") ? serverUrl(path) : path, { credentials: "include", ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
}

/**
 * Follow a server-sent event stream with fetch (EventSource can't send a
 * header, and the bearer transport needs one). Reconnects with backoff until
 * stopped; returns the stop function.
 */
export function eventStream(path: string, onData: (data: string) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  let tries = 0;
  const loop = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await fetch(serverUrl(path), { credentials: "include", headers: { ...authHeaders(), accept: "text/event-stream" }, signal: ctrl.signal });
        if (res.ok && res.body) {
          tries = 0;
          await readStream(res.body, onData);
        }
      } catch {
        /* dropped: try again */
      }
      if (stopped) return;
      await new Promise((ok) => setTimeout(ok, Math.min(30_000, 1000 * 2 ** tries++)));
    }
  };
  void loop();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

async function readStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onData(line.slice(6));
    }
  }
}

async function readEvents(req: Promise<Response>, onEvent: (e: AgentEvent) => void) {
  const res = await req;
  if (!res.ok || !res.body) {
    const t = await res.text();
    let why = "";
    try {
      why = (t && JSON.parse(t).error) || "";
    } catch { /* a proxy's page, not the server's JSON */ }
    throw new ApiError(res.status, why || (res.status >= 500 ? `Can't reach the Foundation server (${SERVER_NAME}): it answered ${res.status}. It may not be running.` : "agent unavailable"));
  }
  await readStream(res.body, (data) => onEvent(JSON.parse(data) as AgentEvent));
}
