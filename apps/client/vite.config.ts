import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { CSP_HEADER, cspString, framedBySelf } from "./csp";

// the version this client is built as: what it tells a server that names a minimum (src/lib/version.ts)
const version: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const server = process.env.FOUNDATION_SERVER_URL ?? "http://127.0.0.1:4410";

const proxy = {
  "/api": { target: server, changeOrigin: false },
  "/auth": { target: server, changeOrigin: false },
  "/files": { target: server, changeOrigin: false },
  "/mcp": { target: server, changeOrigin: false },
  "/sync": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: false },
  "/huddle": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: false },
  "/machines": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: false },
  "/vms": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: false },
  // a machine's web port, relayed (apps/server/src/machineshare.ts): a pattern, so /machine.html stays the page's
  "^/m/": { target: server, ws: true, changeOrigin: false },
  // the built-in terminal's socket (apps/server/src/hostterm.ts)
  "/host": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: false },
  // ChatForm's socket (apps/server/src/chatsock.ts): exactly /chat (and its query), never /chatsomething or a module under /src/chat/
  "^/chat(\\?.*)?$": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: false },
};

/**
 * The pages' Content Security Policy (csp.ts), on every page the dev server and `vite preview` serve: the shell
 * may be framed by nothing, desktop.html only by the app. Report-only for now (csp.ts says why).
 */
function contentSecurityPolicy(servers: string[]): Plugin {
  const header = (dev: boolean) => (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    res.setHeader(CSP_HEADER, cspString({ dev, servers, framedBySelf: framedBySelf(req.url) }));
    next();
  };
  return {
    name: "foundation-csp",
    configureServer: (s) => void s.middlewares.use(header(true)),
    configurePreviewServer: (s) => void s.middlewares.use(header(false)),
  };
}

// Foundation's client. 1430 (Vision's browser edition owns 1420). The server's
// routes are proxied so the session cookie is same-origin in dev.
export default defineConfig(async ({ mode }) => ({
  plugins: [react(), contentSecurityPolicy([server, loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_").VITE_FOUNDATION_SERVER ?? ""])],
  // the proxied server is Foundation too: a frame never shows it (src/lib/frames.ts)
  define: { __FOUNDATION_VERSION__: JSON.stringify(version), __FOUNDATION_PROXY_TARGET__: JSON.stringify(server) },
  clearScreen: false,
  server: {
    // FOUNDATION_CLIENT_PORT moves it (scripts/dev-orphans-check.mjs runs the whole launcher above 15000)
    port: Number(process.env.FOUNDATION_CLIENT_PORT ?? 1430),
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy,
  },
  // three pages: the app, the page inside a machine card's Desktop view (desktop.html: noVNC in a frame), and a machine in a window of its own (machine.html)
  build: { rollupOptions: { input: { main: fileURLToPath(new URL("./index.html", import.meta.url)), desktop: fileURLToPath(new URL("./desktop.html", import.meta.url)), machine: fileURLToPath(new URL("./machine.html", import.meta.url)) } } },
  // `vite preview` serves the production build the same way (e2e frames on the build: E2E_BUILD=1)
  preview: { proxy },
}));
