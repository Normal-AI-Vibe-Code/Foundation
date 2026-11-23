/**
 * A machine's functions on its Ins & outs view (2026-11-17, Josh: "should have some functions that are able to
 * reach into the VM"; the server: apps/server/src/machinefunctions.ts).
 *
 * A function is an executable in the machine at /foundation/functions/<name>. Each is a card here: a 40 px
 * round ƒ, its name in code type and what it does, what it takes and gives as two chips (images → images),
 * what's wired into its in port (how many pictures, how many it hasn't had) and where its out port goes; then
 * **Run on n new** (blue: a person's press, it runs code in the machine) and Run on all, and its last run
 * (who, when, in and out, how long; or why it failed, selectable). Text or JSON it wrote shows under it.
 * Above them, **Add the example functions** puts ImageMagick and three picture functions in.
 */

import { ErrorCard } from "../components/ErrorCard";
import { useEffect, useState } from "react";
import type { MachineFunction, MachineState } from "@foundation/protocol";
import { api } from "../lib/api";
import { toast } from "../state/ui";
import { ago, boardId } from "./MachineViewBits";
import { FunctionGlyph, InGlyph, OutGlyph, PackageGlyph } from "../shell/glyphs";

export interface Wiring {
  total: number;
  fresh: number;
  from: string[];
  to: string[];
}

const KIND_WORD: Record<MachineFunction["in"], string> = { images: "pictures", text: "text", json: "JSON", files: "files" };

/** one function's card. Also drawn on #/design. */
export function FunctionCard({ fn, wiring, viewer, busy, onRun, now = Date.now() }: { fn: MachineFunction; wiring?: Wiring; viewer: boolean; busy?: boolean; onRun?: (all: boolean) => void; now?: number }) {
  const last = fn.last;
  const fresh = wiring?.fresh ?? 0;
  return (
    <div className={`machine-fn${last && !last.ok ? " is-failed" : ""}`} data-machine-fn={fn.name}>
      <div className="machine-fn-head">
        <span className="machine-fn-icon">
          <FunctionGlyph size={20} />
        </span>
        <span className="machine-fn-words">
          <code className="machine-fn-name">{fn.name}</code>
          <span>{fn.about ?? "No # about: line in its script"}</span>
        </span>
        <span className="machine-fn-kinds">
          <span className="machine-fn-kind">{KIND_WORD[fn.in]}</span>
          <span className="machine-fn-arrow">→</span>
          <span className="machine-fn-kind">{KIND_WORD[fn.out]}</span>
        </span>
      </div>
      <div className="machine-fn-wires">
        <span className="machine-fn-wire">
          <InGlyph size={15} />
          {wiring?.from.length ? (
            <span>
              <b>{wiring.total}</b> {wiring.total === 1 ? "picture" : "pictures"} from {wiring.from.join(", ")}
              {wiring.total ? ` · ${fresh} new` : ""}
            </span>
          ) : (
            <span className="is-dim">Nothing wired in: drag a collection's out port to its in port ({`fn:${fn.name}`})</span>
          )}
        </span>
        <span className="machine-fn-wire">
          <OutGlyph size={15} />
          {wiring?.to.length ? <span>into {wiring.to.join(", ")}</span> : <span className="is-dim">{fn.out === "images" ? "Its pictures go to the archive: wire its out port to a collection to gather them" : "What it writes shows here"}</span>}
        </span>
      </div>
      <div className="machine-fn-foot">
        {!viewer && (
          <>
            <button className="f-pill is-accent machine-fn-run" disabled={busy || !fresh} onClick={() => onRun?.(false)} data-machine-fn-run={fn.name}>
              {busy ? "Running…" : `Run on ${fresh} new`}
            </button>
            <button className="f-pill machine-fn-run" disabled={busy || !wiring?.total} onClick={() => onRun?.(true)} data-tip="Everything wired in, what it has had too">
              Run on all
            </button>
          </>
        )}
        {last && (
          <span className={`machine-fn-last${last.ok ? "" : " is-bad"}`}>
            <span className={`f-dot ${last.ok ? "is-ok" : "is-bad"}`} />
            {last.ok ? `${last.by} ran it ${ago(last.at, now)} · ${last.took} in, ${last.made} out · ${(last.ms / 1000).toFixed(1)} s` : `Failed ${ago(last.at, now)}`}
          </span>
        )}
      </div>
      {last && !last.ok && last.said && <div className="machine-fn-said machine-copyable" onPointerDown={(e) => e.stopPropagation()}>{last.said}</div>}
      {last?.text && <pre className="machine-fn-text machine-copyable" onPointerDown={(e) => e.stopPropagation()}>{last.text}</pre>}
    </div>
  );
}

/** the section on a running card */
export function Functions({ panelId, m, viewer }: { panelId: string; m: MachineState; viewer: boolean }) {
  const [wiring, setWiring] = useState<Record<string, Wiring>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/boards/${encodeURIComponent(boardId())}/machines/${panelId}/functions`;
  useEffect(() => {
    let stop = false;
    const load = (fresh = false) =>
      api<{ wiring: Record<string, Wiring> }>(`${base}${fresh ? "?fresh=1" : ""}`)
        .then((r) => !stop && setWiring(r.wiring))
        .catch(() => {});
    void load(true);
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [base]);
  const run = async (name: string, all: boolean) => {
    setBusy(name);
    try {
      const r = await api<{ run: { made: unknown[]; took: number; into: string[] } }>(`${base}/${encodeURIComponent(name)}/run`, { method: "POST", json: { all } });
      toast(`${name}: ${r.run.took} in, ${r.run.made.length} out${r.run.into.length ? ", into the collection" : ""}`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  const examples = async () => {
    setBusy("examples");
    try {
      await api(`${base}/examples`, { method: "POST", json: {} });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  return <FunctionsView m={m} wiring={wiring} viewer={viewer} busy={busy} onRun={(n, all) => void run(n, all)} onExamples={() => void examples()} />;
}

/** Also drawn on #/design. */
export function FunctionsView({ m, wiring, viewer, busy, onRun, onExamples, now = Date.now() }: { m: Pick<MachineState, "functions" | "fnSetup">; wiring: Record<string, Wiring>; viewer: boolean; busy?: string | null; onRun?: (name: string, all: boolean) => void; onExamples?: () => void; now?: number }) {
  const fns = m.functions ?? [];
  const setup = m.fnSetup;
  return (
    <section className="machine-fns" data-machine-fns>
      <div className="machine-fns-head">
        <span className="machine-fns-title">
          <FunctionGlyph size={18} /> Functions
        </span>
        <span className="machine-fns-what">
          Executables in <code>/foundation/functions</code>: each takes what's wired into its in port and gives back what it leaves in <code>$OUT</code>
        </span>
        {!viewer && !setup && (
          <button className="f-pill machine-fns-add" disabled={busy === "examples"} onClick={onExamples} data-machine-fns-examples data-tip="Installs ImageMagick in the machine and adds trim-resize, sprite-sheet and describe">
            <PackageGlyph size={14} /> {fns.length ? "Add the examples again" : "Add the example functions"}
          </button>
        )}
      </div>
      {setup?.state === "installing" && (
        <div className="machine-fns-setup">
          <span className="f-dot is-warn is-live" />
          Putting ImageMagick and three picture functions in (a minute or two) · {setup.by}
        </div>
      )}
      {setup?.state === "error" && (
        <ErrorCard message={`They didn't go in: ${setup.detail}`} />
      )}
      {fns.length === 0 && !setup ? (
        <div className="machine-fns-none">
          None yet. Add the examples, or make one from the terminal: an executable in /foundation/functions whose first lines are <code># about: …</code>, <code># in: images</code>, <code># out: images</code>; it reads <code>$IN</code> and writes <code>$OUT</code>.
        </div>
      ) : (
        fns.map((f) => <FunctionCard key={f.name} fn={f} wiring={wiring[f.name]} viewer={viewer} busy={busy === f.name} onRun={(all) => onRun?.(f.name, all)} now={now} />)
      )}
    </section>
  );
}
