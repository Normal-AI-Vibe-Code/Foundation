import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  // a machine's web port, relayed (apps/server/src/machineshare.ts): a pattern, so /machine.html stays the page's
  "^/m/": { target: server, ws: true, changeOrigin: false },
  // the built-in terminal's socket (apps/server/src/hostterm.ts)
  "/host": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: false },
};

// Foundation's client. 1430 (Vision's browser edition owns 1420). The server's
// routes are proxied so the session cookie is same-origin in dev.
export default defineConfig(async () => ({
  plugins: [react()],
  define: { __FOUNDATION_VERSION__: JSON.stringify(version) },
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
