/**
 * This computer, in the search pane: the folders an admin approved for
 * Foundation (Settings → Places), browsed like a file panel. Press a folder to
 * open it; pull a file out onto the grid and it's copied into the archive and
 * lands as a card where it was dropped (the original is only read). Nothing
 * outside an approved place is ever listed: the server resolves every path.
 *
 * Approving is here too (2026-11-20, Josh: "the Files system for this computer should have an approval system
 * built into the panel"): an admin, signed in as themselves, approves a folder by its path and takes an approval
 * away, without leaving for Settings → Places. The server decides who may (`canApprove`, and again on the write);
 * taking one away asks first, and touches no file.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { placeHitId } from "../lib/hits";
import { toast } from "../state/ui";
import { Draggable } from "./SearchPane";

interface Place {
  id: string;
  name: string;
  path: string;
  reachable: boolean;
}
interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  modified: number;
}

export function sizeWords(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

export function PlacesBrowser({ filter }: { board?: string; filter: string }) {
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [at, setAt] = useState<{ place: Place; dir: string } | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [more, setMore] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  // approving, here in the panel
  const [canApprove, setCanApprove] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const read = () =>
    api<{ places: Place[]; canApprove?: boolean }>("/api/places").then(
      (r) => {
        setPlaces(r.places);
        setCanApprove(r.canApprove === true);
      },
      (e: Error) => setErr(e.message),
    );
  useEffect(() => {
    void read();
  }, []);

  const approve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    setWhy(null);
    try {
      await api("/api/places", { method: "POST", json: { path, name } });
      setPath("");
      setName("");
      await read();
      toast("Approved: Foundation may read that folder", "ok");
    } catch (x) {
      setWhy((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setWhy(null);
    try {
      await api(`/api/places/${encodeURIComponent(id)}/remove`, { method: "POST", json: { confirm: true } });
      setRemoving(null);
      await read();
    } catch (x) {
      setWhy((x as Error).message);
    }
  };

  useEffect(() => {
    if (!at) return;
    let live = true;
    setEntries(null);
    setErr(null);
    api<{ entries: Entry[]; more: number }>(`/api/places/${encodeURIComponent(at.place.id)}/list?dir=${encodeURIComponent(at.dir)}`).then(
      (r) => live && (setEntries(r.entries), setMore(r.more)),
      (e: Error) => live && (setEntries([]), setErr(e.message)),
    );
    return () => {
      live = false;
    };
  }, [at]);

  if (err && !at) return <div className="places"><div className="pane-empty is-bad">{err}</div></div>;
  if (!places) return <div className="places"><div className="pane-empty">Asking the server…</div></div>;

  if (!at) {
    return (
      <div className="places">
        <div className="pane-eyebrow">Approved places on this computer</div>
        {places.length === 0 && <div className="pane-empty">{canApprove ? "No folders are approved yet. Approve one below, and it can be browsed here and dragged from onto a grid." : "No folders are approved yet. An admin, signed in as themselves, approves the ones Foundation may read."}</div>}
        {places.map((p) => (
          <div key={p.id} className="places-item" data-place={p.id}>
            <button className="search-row is-folder" disabled={!p.reachable} onClick={() => setAt({ place: p, dir: "" })} data-tip={p.path}>
              <span className="search-row-glyph">▱</span>
              <span className="search-row-main">
                <span className="search-row-title">{p.name}</span>
                <span className="search-row-snip">{p.reachable ? p.path : `Not reachable now · ${p.path}`}</span>
              </span>
              <span className="search-row-src">folder</span>
            </button>
            {canApprove && removing !== p.id && (
              <button className="places-remove" onClick={() => setRemoving(p.id)} aria-label={`Take away the approval for ${p.name}`} data-tip="Take away this approval" data-place-remove>
                ✕
              </button>
            )}
            {removing === p.id && (
              <div className="places-ask" role="group" aria-label={`Take away the approval for ${p.name}?`}>
                <span>Stop reading this folder? The folder isn't touched, and files already on grids stay.</span>
                <button className="f-pill is-danger" onClick={() => void remove(p.id)} data-place-remove-yes>
                  Remove
                </button>
                <button className="f-pill" onClick={() => setRemoving(null)}>
                  Keep
                </button>
              </div>
            )}
          </div>
        ))}
        {canApprove ? (
          <form className="places-approve" onSubmit={approve} data-place-approve>
            <div className="pane-eyebrow">Approve a folder</div>
            <input className="places-approve-field is-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder={"The folder's full path, like C:\\Users\\you\\Documents\\Drawings"} aria-label="Folder path" spellCheck={false} autoComplete="off" />
            <div className="places-approve-row">
              <input className="places-approve-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" autoComplete="off" />
              <button className="f-pill is-accent" disabled={!path.trim() || busy}>
                {busy ? "Checking…" : "Approve"}
              </button>
            </div>
            <p className="places-approve-note">Foundation reads only inside approved folders, never writes to them, and leaves hidden files, keys and credentials where they are.</p>
          </form>
        ) : (
          <div className="places-foot">Only an admin, signed in here as themselves, can approve or take away a folder.</div>
        )}
        {why && (
          <div className="pane-empty is-bad" role="alert">
            {why}
          </div>
        )}
      </div>
    );
  }

  const crumbs = at.dir ? at.dir.split("/") : [];
  const term = filter.toLowerCase();
  const shown = (entries ?? []).filter((e) => !term || e.name.toLowerCase().includes(term));
  return (
    <div className="places">
      <nav className="places-crumbs" aria-label="Folder">
        <button onClick={() => setAt(null)}>This computer</button>
        <span>›</span>
        <button className={crumbs.length ? "" : "is-here"} onClick={() => setAt({ place: at.place, dir: "" })}>
          {at.place.name}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="places-crumb">
            <span>›</span>
            <button className={i === crumbs.length - 1 ? "is-here" : ""} onClick={() => setAt({ place: at.place, dir: crumbs.slice(0, i + 1).join("/") })}>
              {c}
            </button>
          </span>
        ))}
      </nav>
      {err && <div className="pane-empty is-bad">{err}</div>}
      {!entries && <div className="pane-empty">Reading the folder…</div>}
      {entries && !err && shown.length === 0 && <div className="pane-empty">{term ? `Nothing named “${filter}” here.` : "This folder is empty."}</div>}
      {shown.map((e) =>
        e.dir ? (
          <button key={e.path} className="search-row is-folder" onClick={() => setAt({ place: at.place, dir: e.path })}>
            <span className="search-row-glyph">▱</span>
            <span className="search-row-main">
              <span className="search-row-title">{e.name}</span>
            </span>
            <span className="search-row-src">›</span>
          </button>
        ) : (
          <Draggable
            key={e.path}
            className="search-row"
            // its id says where it is (lib/hits.ts placeHitId): it's copied into the archive when it's put down
            hit={{ source: "file", id: placeHitId(at.place.id, e.path), title: e.name, snippet: at.place.name, score: 1 }}
            onPress={() => toast("Drag it onto the grid to bring it in")}
          >
            <span className="search-row-glyph">▤</span>
            <span className="search-row-main">
              <span className="search-row-title">{e.name}</span>
            </span>
            <span className="search-row-src places-size">{sizeWords(e.size)}</span>
          </Draggable>
        ),
      )}
      {more > 0 && <div className="pane-empty">…and {more} more. Type to narrow it down.</div>}
    </div>
  );
}
