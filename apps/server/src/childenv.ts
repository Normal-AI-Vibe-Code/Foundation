/**
 * The environment a third-party program Foundation starts gets (ADR-001 G13). Never a copy of
 * the server's own: that holds every key in `.env` (Anthropic, Slack, GitHub, Google, Meshy,
 * BomForm, the Data Room, the service token). A child gets a new object with only what a program
 * needs to run at all on Windows, macOS and Linux (BASE), plus the extras its caller names, each
 * for a reason said where it is named. A name that looks like a secret (KEY, TOKEN, SECRET,
 * PASSWORD, CREDENTIAL) never comes from BASE: only a caller naming it lets it through.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export const BASE_ENV = [
  // finding programs, and Windows' own folders and shell
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "COMSPEC", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "PSModulePath",
  // temporary files
  "TEMP", "TMP", "TMPDIR",
  // the user's home and app-data folders (where programs keep their settings and logins)
  "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "ALLUSERSPROFILE", "PUBLIC", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // who and where
  "USERNAME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ",
  // the network as this computer reaches it (either case)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
] as const;

export const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/** a proxy address that carries a user name or password (http://user:pass@proxy:8080): a credential, not just where the network is */
export function proxyWithCredentials(value: string): boolean {
  try {
    const u = new URL(value.includes("://") ? value : `http://${value}`);
    return Boolean(u.username || u.password);
  } catch {
    return /@/.test(value);
  }
}
const PROXY_NAME = /^(https?|all)_proxy$/i;

/**
 * A new environment for a child: BASE plus `extras` (names the caller states, each with its reason
 * at the call), taken from `from` (the server's own by default). On Windows names match in any case
 * (`Path` is PATH), and the child gets each under the name the server has it by.
 */
export function childEnv(extras: readonly string[] = [], from: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const out: Record<string, string> = {};
  const fold = (s: string) => (platform === "win32" ? s.toUpperCase() : s);
  const base = new Set(BASE_ENV.map(fold));
  const named = new Set(extras.map(fold));
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    const f = fold(k);
    if (named.has(f)) out[k] = v;
    // a proxy with a sign-in in its address is passed only to a program whose caller names it
    else if (base.has(f) && !SECRET_NAME.test(k) && !(PROXY_NAME.test(k) && proxyWithCredentials(v))) out[k] = v;
  }
  return out;
}

/**
 * A folder of a program's own under the work folder (config.workDir), made on demand: never `data/`,
 * which holds `secret.key`, the database and other runs' files. `parts` are fixed names and ids
 * Foundation made, never anything a person or an agent typed.
 */
export function workFolder(...parts: string[]): string {
  for (const p of parts) if (!/^[A-Za-z0-9_-]+$/.test(p)) throw new Error(`not a work folder name: ${p}`);
  const dir = join(config.workDir, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
