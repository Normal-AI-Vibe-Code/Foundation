/**
 * The web client, served by the server itself (FOUNDATION_CLIENT_DIR: a built apps/client/dist).
 *
 * In dev Vite serves the client and the desktop app serves its own window, so this is off. A hosted
 * server turns it on: the pages and the API are then one origin behind one HTTPS name, the sign-in
 * cookie is same-origin, and nothing but this program and a proxy that holds the certificate has to run
 * (docs/hosting.md).
 *
 * Only what the router didn't claim comes here, only for GET and HEAD, and never under the server's own
 * prefixes (a missing API route stays a JSON 404, not a page). A file is served only from inside the
 * folder; any other path a browser asks for as a page gets index.html (the client routes by hash).
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { config } from "./config.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** the server's own paths: nothing of the client is ever served under them */
const SERVER_PATHS = /^\/(api|auth|files|sync|huddle|machines|m|mcp)(\/|$)/;

/** the file in `dir` a path names, or null (outside the folder, not a file, or a name no browser should be given) */
export function clientFile(dir: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0") || rel.includes("\\")) return null;
  // no dot-files (a stray .env or .git beside the build is never a page)
  if (rel.split("/").some((part) => part.startsWith("."))) return null;
  const root = resolve(dir);
  const file = resolve(join(root, rel));
  if (file !== root && !file.startsWith(root + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Serve the client for this request if this server carries one and the path is the client's. True when it answered. */
export function serveClient(req: IncomingMessage, res: ServerResponse, pathname: string, dir = config.clientDir): boolean {
  if (!dir || (req.method !== "GET" && req.method !== "HEAD")) return false;
  if (SERVER_PATHS.test(pathname)) return false;
  let file = clientFile(dir, pathname);
  if (!file) {
    // a page (no file extension, and the browser asks for a document): the app itself
    const wantsPage = pathname === "/" || (!extname(pathname) && String(req.headers.accept ?? "").includes("text/html"));
    const index = join(dir, "index.html");
    if (!wantsPage || !existsSync(index)) return false;
    file = index;
  }
  const ext = extname(file).toLowerCase();
  const size = statSync(file).size;
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "content-length": size,
    // Vite names what's in assets/ by its content, so it never changes; everything else is asked for again
    "cache-control": /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}
