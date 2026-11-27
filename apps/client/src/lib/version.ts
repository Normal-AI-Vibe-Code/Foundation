/**
 * The version this client was built as (apps/client/package.json, set by vite.config.ts; the desktop
 * app's own version is the same number: `npm run release -- bump` writes them together). The server
 * may name the oldest client it still works with; this is what's compared (update/updater.ts).
 */
declare const __FOUNDATION_VERSION__: string | undefined;

export const CLIENT_VERSION: string = typeof __FOUNDATION_VERSION__ === "string" ? __FOUNDATION_VERSION__ : "0.0.0";

declare const __FOUNDATION_DESCRIBE__: string | null | undefined;
/** `git describe` of the commit this client was built from (vite.config.ts): where it stands among the releases */
export const CLIENT_DESCRIBE: string | null = typeof __FOUNDATION_DESCRIBE__ === "string" ? __FOUNDATION_DESCRIBE__ : null;
