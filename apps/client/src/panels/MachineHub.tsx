/**
 * Docker Hub in a machine's Start well (2026-11-17, Josh: "The Loading and choosing VM image can be better and I
 * would like to integrate with docker hub if possible"). One field: what's typed is searched on Docker Hub (the
 * server asks: apps/server/src/machinehub.ts) after a short pause, and the answers come as rows: the official
 * mark or a package, the name at 14/600, what it is in one dim line, its stars and pulls. A row opens its tags
 * (newest first, with their sizes) as chips; a chip is the image Start runs. Enter takes the field as typed
 * (any registry: ghcr.io/…, an exact tag).
 */

import { ErrorCard } from "../components/ErrorCard";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { FindGlyph, PackageGlyph, ShieldGlyph } from "../shell/glyphs";

export interface HubRepo {
  name: string;
  description: string;
  stars: number;
  pulls: number;
  official: boolean;
}
interface HubTag {
  name: string;
  size: number;
}

/** 1234567 → "1.2M" */
export function count(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}
const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

/** the field and its answers. `still`: drawn on #/design with these rows */
export function HubSearch({ image, viewer, onImage, still }: { image: string; viewer: boolean; onImage: (img: string) => void; still?: { q: string; repos: HubRepo[]; open?: string; tags?: HubTag[] } }) {
  const [q, setQ] = useState(still?.q ?? "");
  const [repos, setRepos] = useState<HubRepo[]>(still?.repos ?? []);
  const [state, setState] = useState<"idle" | "looking" | "error">("idle");
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(still?.open ?? null);
  const [tags, setTags] = useState<HubTag[] | null>(still?.tags ?? null);
  const seq = useRef(0);
  useEffect(() => {
    if (still) return;
    const words = q.trim();
    // an exact image (a tag, a registry) is taken as typed; a few letters search
    if (words.length < 2 || /[:@]/.test(words) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(words)) {
      setRepos([]);
      setState("idle");
      return;
    }
    const n = ++seq.current;
    setState("looking");
    const t = setTimeout(() => {
      api<{ repos: HubRepo[] }>(`/api/machines/hub?q=${encodeURIComponent(words)}`)
        .then((r) => n === seq.current && (setRepos(r.repos), setState("idle")))
        .catch((e) => n === seq.current && (setErr((e as Error).message), setState("error")));
    }, 350);
    return () => clearTimeout(t);
  }, [q, still]);
  const openRepo = (name: string) => {
    if (open === name) return setOpen(null);
    setOpen(name);
    setTags(null);
    onImage(name);
    if (still) return;
    api<{ tags: HubTag[] }>(`/api/machines/hub/tags?repo=${encodeURIComponent(name)}`)
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]));
  };
  return (
    <div className="machine-hub" data-machine-hub>
      <label className="machine-hub-field">
        <FindGlyph />
        <input
          value={q}
          disabled={viewer}
          spellCheck={false}
          placeholder="Search Docker Hub, or type any image: postgres:17, ghcr.io/…"
          aria-label="Search Docker Hub or type an image"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && q.trim()) onImage(q.trim());
          }}
        />
        {state === "looking" && <span className="machine-hub-state">Searching…</span>}
        {q.trim() && state !== "looking" && (
          <button type="button" className="f-pill machine-hub-use" onClick={() => onImage(q.trim())} disabled={viewer}>
            Use “{q.trim()}”
          </button>
        )}
      </label>
      {state === "error" && err && <ErrorCard message={err} />}
      {repos.length > 0 && (
        <ul className="machine-hub-list" role="listbox" aria-label="Docker Hub">
          {repos.map((r) => (
            <li key={r.name} className={`machine-hub-row${open === r.name ? " is-open" : ""}${image === r.name || image.startsWith(`${r.name}:`) ? " is-on" : ""}`}>
              <button type="button" className="machine-hub-repo" onClick={() => openRepo(r.name)} disabled={viewer} role="option" aria-selected={open === r.name} data-hub-repo={r.name}>
                <span className={`machine-hub-icon${r.official ? " is-official" : ""}`}>{r.official ? <ShieldGlyph /> : <PackageGlyph />}</span>
                <span className="machine-hub-words">
                  <b>
                    {r.name}
                    {r.official && <span className="machine-hub-badge">Official</span>}
                  </b>
                  <span>{r.description || "No description"}</span>
                </span>
                <span className="machine-hub-nums">
                  <span data-tip="Stars on Docker Hub">★ {count(r.stars)}</span>
                  <span data-tip="Pulls">↓ {count(r.pulls)}</span>
                </span>
              </button>
              {open === r.name && (
                <div className="machine-hub-tags">
                  {tags === null ? (
                    <span className="machine-hub-state">Reading its tags…</span>
                  ) : tags.length === 0 ? (
                    <span className="machine-hub-state">No tags read: Start runs {r.name}:latest</span>
                  ) : (
                    tags.map((t) => (
                      <button key={t.name} type="button" className={`machine-chip is-code${image === `${r.name}:${t.name}` ? " is-on" : ""}`} onClick={() => onImage(`${r.name}:${t.name}`)} disabled={viewer} data-hub-tag={t.name}>
                        {t.name}
                        {t.size > 0 && <span className="machine-hub-size">{size(t.size)}</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
