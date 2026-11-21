/**
 * The one door every program Foundation's server starts goes through (ADR-001 G13). This is the only
 * file under apps/server/src that imports `node:child_process` (test/child-door.test.ts keeps it so).
 *
 * A caller can't hand a program an environment of its own making: it asks `childOptions()` for its
 * options, naming the extra environment names its program needs beyond childenv.ts's BASE (possibly
 * none, each with its reason where it is named) and any values Foundation itself makes for it (a folder,
 * a mode; never a name that looks like a secret). The door then builds the environment from the
 * allowlist when it starts the program: an `env` set on the options any other way is never used, and
 * options that didn't come from `childOptions()` are refused. So the server's keys (.env) reach a
 * program only when its caller names one, and only `gh` does (github.ts, plan.ts).
 */

import * as cp from "node:child_process";
import { childEnv, SECRET_NAME } from "./childenv.ts";

export type { ChildProcess, SpawnOptions, ExecFileOptions, ExecFileSyncOptions } from "node:child_process";

/** what a program's environment is made from */
export interface ChildEnvSpec {
  /** names beyond BASE_ENV this program needs, each with its reason at the call; [] for none */
  readonly extras: readonly string[];
  /** values Foundation itself makes for this program (a folder, a mode): never the server's secrets */
  readonly set?: Readonly<Record<string, string>>;
}

const MADE: unique symbol = Symbol("foundation.child");

/** options only `childOptions()` makes: `env` is shown for reading, and rebuilt by the door when the program starts */
export type ChildOptions<O> = Omit<O, "env"> & { readonly env: Readonly<Record<string, string>>; readonly [MADE]: ChildEnvSpec };

/** the environment a spec makes: the allowlist plus its named extras (childEnv), then its own values */
export function envFor(spec: ChildEnvSpec, from: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Readonly<Record<string, string>> {
  if (!spec || !Array.isArray(spec.extras)) throw new Error("A program's environment needs its extras named (an array, [] for none).");
  const set = spec.set ?? {};
  for (const k of Object.keys(set)) {
    if (SECRET_NAME.test(k)) throw new Error(`${k} looks like a secret: a program gets one only by naming it in extras, never as a value Foundation sets.`);
    if (typeof set[k] !== "string") throw new Error(`${k} must be a string.`);
  }
  const env = childEnv(spec.extras, from, platform);
  if (platform === "win32") {
    // one spelling per name: the value Foundation sets replaces the server's under any case
    const mine = new Set(Object.keys(set).map((k) => k.toUpperCase()));
    for (const k of Object.keys(env)) if (mine.has(k.toUpperCase())) delete env[k];
  }
  return Object.freeze({ ...env, ...set });
}

/** a program's options: `opts` as given (never with an `env`), and the environment `spec` makes */
export function childOptions<O extends object = Record<never, never>>(spec: ChildEnvSpec, opts?: O & { env?: never }): ChildOptions<O> {
  if (opts && "env" in opts) throw new Error("A program's environment comes from its spec (extras, set), not from env.");
  const out = { ...(opts ?? {}), env: envFor(spec) } as Record<string | symbol, unknown>;
  Object.defineProperty(out, MADE, { value: Object.freeze({ extras: [...spec.extras], set: spec.set ? { ...spec.set } : undefined }), enumerable: true });
  return out as unknown as ChildOptions<O>;
}

/** the options a program actually starts with: the door's own environment, whatever `env` says */
function resolved<O>(opts: ChildOptions<O>): O {
  const spec = (opts as unknown as Record<symbol, ChildEnvSpec> | null)?.[MADE];
  if (!spec) throw new Error("A program is started only with options from childOptions() (child.ts): its environment comes from the allowlist.");
  const { [MADE]: _made, env: _env, ...rest } = opts as unknown as Record<string | symbol, unknown>;
  return { ...rest, env: envFor(spec) } as O;
}

type ExecDone = (err: cp.ExecFileException | null, stdout: string, stderr: string) => void;

/** how the door starts a program. Tests swap these (setChildDeps) to see what a program would get, and nothing runs */
export const childDeps: {
  spawn: (cmd: string, args: readonly string[], opts: cp.SpawnOptions) => cp.ChildProcess;
  execFile: (cmd: string, args: readonly string[], opts: cp.ExecFileOptions, done: ExecDone) => cp.ChildProcess;
  execFileSync: (cmd: string, args: readonly string[], opts: cp.ExecFileSyncOptions) => string | Buffer;
} = {
  spawn: (cmd, args, opts) => cp.spawn(cmd, args, opts),
  execFile: (cmd, args, opts, done) => cp.execFile(cmd, args, { encoding: "utf8", ...opts }, (e, out, err) => done(e, String(out), String(err))),
  execFileSync: (cmd, args, opts) => cp.execFileSync(cmd, args, opts),
};
/** for tests: swap how programs start; returns the undo */
export function setChildDeps(d: Partial<typeof childDeps>): () => void {
  const was = { ...childDeps };
  Object.assign(childDeps, d);
  return () => Object.assign(childDeps, was);
}

/** start a program (no shell unless the options say so) */
export function spawnChild(cmd: string, args: readonly string[], opts: ChildOptions<cp.SpawnOptions>): cp.ChildProcess {
  return childDeps.spawn(cmd, args, resolved(opts));
}

/** run a program to its end; `done` gets its output as text */
export function execFileChild(cmd: string, args: readonly string[], opts: ChildOptions<cp.ExecFileOptions>, done: ExecDone = () => {}): cp.ChildProcess {
  return childDeps.execFile(cmd, args, resolved(opts), done);
}

/** run a program to its end: its output as text, or the error it ended with */
export function execFileText(cmd: string, args: readonly string[], opts: ChildOptions<cp.ExecFileOptions>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((ok, no) => {
    try {
      execFileChild(cmd, args, opts, (e, stdout, stderr) => (e ? no(e) : ok({ stdout, stderr })));
    } catch (e) {
      no(e);
    }
  });
}

/** run a program to its end, waiting here */
export function execFileSyncChild(cmd: string, args: readonly string[], opts: ChildOptions<cp.ExecFileSyncOptions>): string | Buffer {
  return childDeps.execFileSync(cmd, args, resolved(opts));
}
