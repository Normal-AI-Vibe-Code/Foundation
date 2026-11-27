/**
 * Where the company's other apps are checked out on this computer: next to this repo (../FactoryForm,
 * ../Creation), or at FOUNDATION_SIBLINGS/<Name>. One rule, shared by `scripts/sibling.mjs` (npm run services)
 * and the server's "Start FactoryForm" press (apps/server/src/factorytwin.ts).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** this repo's folder (Foundation, or a worktree of it) */
export const FOUNDATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** the folder sibling checkouts sit in */
export function siblingsBase(env = process.env) {
  return env.FOUNDATION_SIBLINGS ? resolve(env.FOUNDATION_SIBLINGS) : resolve(FOUNDATION_ROOT, "..");
}

/** a sibling app's folder, by its folder name ("FactoryForm") */
export function siblingDir(name, env = process.env) {
  return join(siblingsBase(env), name);
}
