/**
 * The code-mode worker (codemode.ts starts one per script, then ends it): a
 * fresh QuickJS (WebAssembly) instance, runtime and context run one script.
 *
 * Plain JavaScript on purpose: it needs no TypeScript loader, starts with an
 * empty environment, and is the same file from source and in the bundle.
 *
 * Inside the isolate there is nothing from Node: no require, process, fetch,
 * timers, filesystem or network. The script sees `foundation.<tool>(args)` and
 * `console.log`; each tool call is posted to the server thread, which runs it
 * through runTool with the caller's own context and posts back JSON. Only JSON
 * strings cross in either direction. The server thread holds the real limits
 * (calls, deadline, result size) and terminates this thread at the deadline;
 * the limits here (memory, stack, interrupt) keep the isolate itself in check.
 */

import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";

const { code, names, deadline, memoryBytes, stackBytes, maxCalls, maxLogLines, maxLogChars } = workerData;
/** the wrapper's first line comes before the script's own first line */
const LINE_OFFSET = 1;
const FILE = "run_code.js";

let finished = false;
function finish(msg) {
  if (finished) return;
  finished = true;
  parentPort.postMessage({ t: "done", ...msg });
}

/** an error from inside the isolate, as { message, line? } (line in the script's own numbering) */
function errorOf(dumped) {
  if (dumped && typeof dumped === "object") {
    const name = typeof dumped.name === "string" ? dumped.name : "Error";
    let message = typeof dumped.message === "string" ? dumped.message : String(dumped);
    if (name === "InternalError" && message === "interrupted") message = "the script ran past its time limit and was stopped";
    else if (name === "InternalError" && message === "out of memory") message = "the script ran out of memory (32 MB) and was stopped";
    else if (name === "InternalError" && message === "stack overflow") message = "the script recursed too deeply (stack overflow)";
    else if (name && name !== "Error") message = `${name}: ${message}`;
    const where = `${typeof dumped.stack === "string" ? dumped.stack : ""}\n${typeof dumped.lineNumber === "number" ? `${FILE}:${dumped.lineNumber}` : ""}`;
    const m = where.match(/run_code\.js:(\d+)/);
    const line = m ? Number(m[1]) - LINE_OFFSET : undefined;
    return line && line > 0 ? { message: message.slice(0, 2000), line } : { message: message.slice(0, 2000) };
  }
  return { message: String(dumped).slice(0, 2000) };
}

const replies = new Map(); // call id -> deferred promise in the isolate
let wake = null; // resolves when a reply arrives
parentPort.on("message", (m) => {
  if (!m || m.t !== "reply") return;
  const d = replies.get(m.id);
  if (!d) return;
  replies.delete(m.id);
  d.settle(m);
  if (wake) wake();
});

async function main() {
  const Q = await newQuickJSWASMModuleFromVariant(variant);
  const rt = Q.newRuntime();
  let vm;
  try {
    rt.setMemoryLimit(memoryBytes);
    rt.setMaxStackSize(stackBytes);
    rt.setInterruptHandler(() => Date.now() > deadline);
    vm = rt.newContext();

    let nextId = 0;
    let logLines = 0;
    const call = vm.newFunction("call", (nameH, argsH) => {
      const name = vm.typeof(nameH) === "string" ? vm.getString(nameH) : "";
      const args = vm.typeof(argsH) === "string" ? vm.getString(argsH) : "{}";
      const d = vm.newPromise();
      const id = ++nextId;
      // past the limit nothing more is posted (the server thread refuses it too)
      if (id > maxCalls) {
        const e = vm.newError({ name: "Error", message: `limit: a script makes at most ${maxCalls} tool calls` });
        d.reject(e);
        e.dispose();
        if (id === maxCalls + 1) parentPort.postMessage({ t: "over", name });
        return d.handle;
      }
      replies.set(id, {
        settle: (m) => {
          if (!d.alive) return;
          if (m.ok) {
            const s = typeof m.value === "string" ? vm.newString(m.value) : vm.undefined;
            d.resolve(s);
            if (s !== vm.undefined) s.dispose();
          } else {
            const e = vm.newError({ name: "Error", message: String(m.message ?? "the tool failed") });
            d.reject(e);
            e.dispose();
          }
        },
      });
      parentPort.postMessage({ t: "call", id, name, args });
      return d.handle;
    });
    const log = vm.newFunction("log", (lineH) => {
      if (logLines >= maxLogLines) return;
      logLines++;
      const line = vm.typeof(lineH) === "string" ? vm.getString(lineH) : "";
      parentPort.postMessage({ t: "log", line: line.slice(0, maxLogChars) });
    });

    // the script's world: foundation.<tool>(args) and console; both close over the two host functions,
    // which are never left on the global object
    const prelude = vm.evalCode(
      `(function (call, log, names) {
        "use strict";
        const api = {};
        for (const n of names) {
          Object.defineProperty(api, n, {
            enumerable: true,
            value: (args) => {
              const json = args === undefined ? "{}" : JSON.stringify(args);
              if (typeof json !== "string" || json[0] !== "{") return Promise.reject(new TypeError("foundation." + n + " takes one object of arguments"));
              return call(n, json).then((s) => (s === undefined ? undefined : JSON.parse(s)));
            },
          });
        }
        Object.freeze(api);
        Object.defineProperty(globalThis, "foundation", { value: api, enumerable: false, writable: false, configurable: false });
        const fmt = (a) => {
          if (typeof a === "string") return a;
          try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch (e) { return String(a); }
        };
        const out = (...a) => log(a.map(fmt).join(" "));
        globalThis.console = Object.freeze({ log: out, info: out, warn: out, error: out, debug: out });
      })`,
      "prelude.js",
      { type: "global" },
    );
    if (prelude.error) {
      const e = vm.dump(prelude.error);
      prelude.error.dispose();
      throw new Error(`prelude: ${JSON.stringify(e)}`);
    }
    const namesH = vm.newArray();
    names.forEach((n, i) => {
      const s = vm.newString(n);
      vm.setProp(namesH, i, s);
      s.dispose();
    });
    const setup = vm.callFunction(prelude.value, vm.undefined, call, log, namesH);
    prelude.value.dispose();
    namesH.dispose();
    call.dispose();
    log.dispose();
    if (setup.error) {
      const e = vm.dump(setup.error);
      setup.error.dispose();
      throw new Error(`prelude: ${JSON.stringify(e)}`);
    }
    setup.value.dispose();

    // the script is the body of an async function; its return value, as JSON, is the result
    const wrapped = `(async () => {\n${code}\n})().then((r) => (r === undefined ? undefined : JSON.stringify(r)))`;
    const ran = vm.evalCode(wrapped, FILE, { type: "global" });
    if (ran.error) {
      const e = vm.dump(ran.error);
      ran.error.dispose();
      return finish({ ok: false, error: errorOf(e) });
    }
    const promise = ran.value;
    try {
      for (;;) {
        const jobs = rt.executePendingJobs();
        if (jobs.error) {
          const e = vm.dump(jobs.error);
          jobs.error.dispose();
          return finish({ ok: false, error: errorOf(e) });
        }
        const state = vm.getPromiseState(promise);
        if (state.type === "fulfilled") {
          const t = vm.typeof(state.value);
          const result = t === "string" ? vm.getString(state.value) : null;
          if (!state.notAPromise) state.value.dispose();
          return finish({ ok: true, result });
        }
        if (state.type === "rejected") {
          const e = vm.dump(state.error);
          state.error.dispose();
          return finish({ ok: false, error: errorOf(e) });
        }
        if (replies.size === 0 && !rt.hasPendingJob()) {
          return finish({ ok: false, error: { message: "the script is waiting on something that never finishes (only foundation.* calls can be awaited; there are no timers)" } });
        }
        if (Date.now() > deadline) return finish({ ok: false, error: { message: "the script ran past its time limit and was stopped" } });
        // wait for a tool's answer, or the deadline
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()) + 5);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      promise.dispose();
    }
  } finally {
    // the whole thread ends after this; disposing is tidiness, never something to fail on
    try {
      for (const d of replies.values()) d.settle({ ok: false, message: "the script ended" });
      replies.clear();
      vm?.dispose();
      rt.dispose();
    } catch {
      /* a runtime stopped mid-way may not free cleanly; the thread is about to go */
    }
  }
}

main().catch((e) => {
  const message = e instanceof RangeError ? "the script recursed too deeply (stack overflow)" : `the sandbox failed: ${e?.message ?? String(e)}`;
  finish({ ok: false, error: { message } });
});
