/**
 * Settings → Places: the folders on this computer that Foundation may read.
 * An admin approves a folder by its path; from then on people can browse it in
 * the search pane (This computer) and drag files onto a board, and agents can
 * look in it and bring files in. Nothing outside an approved folder is read,
 * nothing in one is changed, and removing an approval touches no file.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { longDate } from "./releases";

interface Place {
  id: string;
  name: string;
  path: string;
  approvedAt: number;
  reachable: boolean;
}

export function PlacesTab() {
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const read = () =>
    api<{ places: Place[]; canApprove: boolean }>("/api/places").then(
      (r) => {
        setPlaces(r.places);
        setCanApprove(r.canApprove);
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
    setErr(null);
    try {
      await api("/api/places", { method: "POST", json: { path, name } });
      setPath("");
      setName("");
      await read();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setErr(null);
    try {
      await api(`/api/places/${encodeURIComponent(id)}/remove`, { method: "POST", json: { confirm: true } });
      setRemoving(null);
      await read();
    } catch (x) {
      setErr((x as Error).message);
    }
  };

  return (
    <section className="services places-tab">
      <p className="design-lede">
        Folders on this computer that Foundation may read. Approve one and it can be browsed from the search pane (<b>This computer</b>) and dragged from onto a board, and agents can look in it and bring files in. Foundation reads only inside these
        folders, never writes to them, and leaves hidden files, keys and credentials where they are.
      </p>
      {canApprove ? (
        <form className="places-form" onSubmit={approve}>
          <input className="places-field is-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder={"The folder's full path, like C:\\Users\\you\\Documents\\Drawings"} aria-label="Folder path" spellCheck={false} />
          <input className="places-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" />
          <button className="f-pill is-accent" disabled={!path.trim() || busy}>
            {busy ? "Checking…" : "Approve folder"}
          </button>
        </form>
      ) : (
        places && <div className="kb-col-empty">Only an admin, signed in here as themselves, can approve or remove a place.</div>
      )}
      {err && <div className="kb-error">{err}</div>}
      {!places && !err && <div className="kb-col-empty">Asking the server…</div>}
      {places && places.length === 0 && <div className="kb-col-empty">No folders are approved. Foundation can't read anything on this computer outside its own data.</div>}
      <div className="services-list">
        {(places ?? []).map((p) => (
          <div key={p.id} className="services-row">
            <span className={`f-dot ${p.reachable ? "is-ok" : "is-warn"}`} />
            <span className="services-name">{p.name}</span>
            <span className="services-detail places-path">{p.path}</span>
            {canApprove && (
              <span className="services-act">
                {removing === p.id ? (
                  <>
                    <button className="f-pill is-danger" onClick={() => remove(p.id)}>
                      Remove
                    </button>
                    <button className="f-pill" onClick={() => setRemoving(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button className="f-pill" onClick={() => setRemoving(p.id)}>
                    Remove…
                  </button>
                )}
              </span>
            )}
            <span className="services-how">
              {removing === p.id
                ? "Remove it? Foundation stops reading this folder. The folder isn't touched, and files already brought onto boards stay."
                : `${p.reachable ? "" : "Not reachable right now (moved, or its drive is unplugged) · "}Approved ${longDate(new Date(p.approvedAt).toLocaleDateString("en-CA"))}`}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
