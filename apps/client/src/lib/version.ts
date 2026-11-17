/**
 * The version this client was built as (apps/client/package.json, set by vite.config.ts; the desktop
 * app's own version is the same number: `npm run release -- bump` writes them together). The server
 * may name the oldest client it still works with; this is what's compared (update/updater.ts).
 */
declare const __FOUNDATION_VERSION__: string | undefined;

export const CLIENT_VERSION: string = typeof __FOUNDATION_VERSION__ === "string" ? __FOUNDATION_VERSION__ : "0.0.0";
