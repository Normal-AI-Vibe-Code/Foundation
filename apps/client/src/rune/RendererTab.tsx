/**
 * Settings → Renderer: which engine draws the board on this device, whether
 * Rune can run here, and the parity ledger — what Rune draws the same as the
 * web renderer, what it draws differently, what the web layer still draws
 * over it, and what isn't there yet.
 */

import { useEffect, useState } from "react";
import { PARITY, PARITY_WORD, parityCounts, type Parity } from "./parity";
import { setEngine, useEngine, useRuneStatus, webgpuHere, type Engine, type RuneBuild } from "./engine";
import "./rune.css";

const DOT: Record<Parity, string> = { same: "ok", partial: "warn", web: "plain", missing: "off" };

function useBuild(): RuneBuild | null | undefined {
  const [build, setBuild] = useState<RuneBuild | null>();
  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}rune/rune.json`)
      .then((r) => (r.ok && /json/.test(r.headers.get("content-type") ?? "") ? (r.json() as Promise<RuneBuild>) : null))
      .catch(() => null)
      .then((b) => alive && setBuild(b));
    return () => {
      alive = false;
    };
  }, []);
  return build;
}

export function RendererTab() {
  const engine = useEngine();
  const status = useRuneStatus();
  const build = useBuild();
  const gpu = webgpuHere();
  const n = parityCounts();
  const total = n.same + n.partial + n.web + n.missing;

  const option = (id: Engine, name: string, tag: string, what: string) => (
    <button className={`rune-option${engine === id ? " is-current" : ""}`} role="radio" aria-checked={engine === id} onClick={() => setEngine(id)}>
      <span className="rune-option-radio" />
      <span className="rune-option-text">
        <span className="rune-option-name">
          {name} <span className="rune-option-tag">{tag}</span>
        </span>
        <span className="rune-option-what">{what}</span>
      </span>
    </button>
  );

  return (
    <section className="services rune-tab">
      <p className="design-lede">
        Two engines can draw the board. The web renderer is the one Foundation is built on, and it stays the default. Rune is a GPU renderer with its own layout, text and springs, being brought up beside it one part at a time: the list below is where it stands. The choice is this device's alone, and the board itself is the same either way.
      </p>

      <div className="rune-options" role="radiogroup" aria-label="Renderer">
        {option("web", "Web renderer", "Default", "React and the DOM. Everything works.")}
        {option("rune", "Rune", "Experimental", "Sections, notes, images and tables at rest drawn on the GPU; apps, maps and video stay live over it. The list below says where each part stands.")}
      </div>

      <div className="services-list rune-facts">
        <div className="services-row">
          <span className={`f-dot ${gpu ? "is-ok" : "is-warn"}`} />
          <span className="services-name">WebGPU</span>
          <span className="services-detail">{gpu ? "Available here" : "Not available in this browser: Rune can't run, and the board stays on the web renderer"}</span>
        </div>
        <div className="services-row">
          <span className={`f-dot ${build ? "is-ok" : "is-warn"}`} />
          <span className="services-name">Build</span>
          <span className="services-detail">
            {build === undefined ? "Checking…" : build ? (
              <>
                Rune <code>{build.rune.slice(0, 8)}</code> · {(build.bytes / 1048576).toFixed(1)} MB · built {new Date(build.builtAt).toLocaleString()}
              </>
            ) : (
              <>
                Not built on this copy: <code>npm run rune:build</code>
              </>
            )}
          </span>
        </div>
        {engine === "rune" && status.state === "failed" && (
          <div className="services-row">
            <span className="f-dot is-warn" />
            <span className="services-name">Fell back</span>
            <span className="services-detail">{status.reason}</span>
          </div>
        )}
      </div>

      <h2 className="rune-ledger-title">
        Where Rune stands
        <span className="rune-ledger-count">
          {n.same} of {total} the same · {n.partial} partly · {n.web} still the web layer · {n.missing} not yet
        </span>
      </h2>
      <div className="rune-ledger">
        {PARITY.map((g) => (
          <section key={g.name} className="rune-group">
            <div className="f-eyebrow">{g.name}</div>
            {g.rows.map((r) => (
              <div key={r.what} className="rune-row">
                <span className={`rune-state is-${DOT[r.status]}`}>{PARITY_WORD[r.status]}</span>
                <span className="rune-what">{r.what}</span>
                {r.note && <span className="rune-note">{r.note}</span>}
              </div>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

/** #/design: the mark in each of its states, and the ledger's four words (Settings → Renderer is the live page) */
export function RuneDesign() {
  const marks: Array<["loading" | "ready" | "failed", string, string]> = [
    ["ready", "Rune", "Rune is drawing this board"],
    ["loading", "Rune", "Starting: fetching the module, waiting on the GPU"],
    ["failed", "Rune off", "Asked for, and couldn't run: the web renderer is drawing"],
  ];
  return (
    <div className="rune-design">
      <div className="rune-design-row">
        {marks.map(([state, word, what]) => (
          <div key={state} className="rune-design-cell">
            <span className={`rune-mark f-glass is-${state}`}>
              <span className="rune-mark-dot" />
              <span className="rune-mark-word">{word}</span>
            </span>
            <span className="rune-note">{what}</span>
          </div>
        ))}
      </div>
      <div className="rune-design-row">
        {(Object.keys(PARITY_WORD) as Parity[]).map((p) => (
          <span key={p} className={`rune-state is-${DOT[p]}`}>
            {PARITY_WORD[p]}
          </span>
        ))}
      </div>
    </div>
  );
}
