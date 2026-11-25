/**
 * The composer's "Attach from…" (R1): files that aren't on this device's disk picker.
 *
 *  - **Vision**: the Vision Archive's projects and their studies' files (the server reads the Archive at its
 *    configured address, read-only; a pick is copied into Foundation's archive as your chat upload, with a
 *    line saying where it came from). When the Archive isn't answering, it says so and where it looked.
 *  - **This computer**: the folders an admin approved (Settings → Places), browsed like the search pane's
 *    Places; a pick is copied in the same way.
 */

import { ErrorCard } from "../components/ErrorCard";
import { useEffect, useState } from "react";
import type { UploadedFile } from "../lib/api";
import { api } from "../lib/api";
import { bytes } from "./logic";

interface VisionListing {
  available: boolean;
  origin: string;
  why?: string;
  seed?: boolean;
  projects: Array<{ name: string; items: Array<{ id: string; title: string; kind: string; revision: number; assets: Array<{ id: string; name: string; kind: string; size: number }> }> }>;
}
interface Place {
  id: string;
  name: string;
  reachable: boolean;
}
interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}

export function AttachFrom({ onPicked, onClose }: { onPicked(f: UploadedFile): void; onClose(): void }) {
  const [tab, setTab] = useState<"vision" | "places">("vision");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bring = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    setErr(null);
    try {
      const r = await api<{ file: UploadedFile }>(path, { method: "POST", json: body });
      onPicked(r.file);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="chat-attach-from f-glass" role="dialog" aria-label="Attach from" data-attach-from>
      <div className="chat-attach-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "vision"} className={`f-pill${tab === "vision" ? " is-primary" : ""}`} onClick={() => setTab("vision")} data-attach-tab="vision">
          From Vision
        </button>
        <button type="button" role="tab" aria-selected={tab === "places"} className={`f-pill${tab === "places" ? " is-primary" : ""}`} onClick={() => setTab("places")} data-attach-tab="places">
          From this computer
        </button>
        <span className="chat-compose-gap" />
        <button type="button" className="f-pill" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {tab === "vision" ? <VisionList busy={busy} onPick={(id) => void bring(id, "/api/chat/attach/vision", { asset: id })} /> : <PlacesList busy={busy} onPick={(place, path) => void bring(`${place}:${path}`, "/api/chat/attach/place", { place, path })} />}
      {err && <ErrorCard message={err} />}
    </div>
  );
}

function VisionList({ busy, onPick }: { busy: string | null; onPick(id: string): void }) {
  const [l, setL] = useState<VisionListing | null>(null);
  const [why, setWhy] = useState("");
  useEffect(() => {
    api<VisionListing>("/api/chat/attach/vision").then(setL, (e: Error) => setWhy(e.message));
  }, []);
  if (!l) return <p className="chat-attach-note" role={why ? "alert" : "status"}>{why || "Reading the Vision Archive…"}</p>;
  if (!l.available) return <p className="chat-attach-note" data-vision-down>{l.why}</p>;
  const files = l.projects.flatMap((p) => p.items.flatMap((it) => it.assets.map((a) => ({ p: p.name, it, a }))));
  return (
    <div className="chat-attach-list">
      {l.seed && <p className="chat-attach-note">The Archive is showing its built-in sample studies: nothing has been saved to this studio yet.</p>}
      {!files.length && <p className="chat-attach-note">The Archive at {l.origin} has no files.</p>}
      {l.projects.map((p) => (
        <div key={p.name}>
          <div className="chat-attach-head">{p.name}</div>
          {p.items.flatMap((it) =>
            it.assets.map((a) => (
              <button key={a.id} type="button" className="chat-attach-row" disabled={Boolean(busy)} onClick={() => onPick(a.id)} data-vision-asset={a.name}>
                <span title={`${it.title} r${it.revision} · ${a.name}`}>
                  {it.title} <span className="chat-file-meta">r{it.revision}</span> · {a.name}
                </span>
                <span className="chat-file-meta">{busy === a.id ? "Copying…" : bytes(a.size)}</span>
              </button>
            )),
          )}
        </div>
      ))}
    </div>
  );
}

function PlacesList({ busy, onPick }: { busy: string | null; onPick(place: string, path: string): void }) {
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [at, setAt] = useState<{ place: Place; dir: string } | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [why, setWhy] = useState("");
  useEffect(() => {
    api<{ places: Place[] }>("/api/places").then((r) => setPlaces(r.places), (e: Error) => setWhy(e.message));
  }, []);
  useEffect(() => {
    if (!at) return;
    setEntries(null);
    api<{ entries: Entry[] }>(`/api/places/${encodeURIComponent(at.place.id)}/list?dir=${encodeURIComponent(at.dir)}`).then(
      (r) => setEntries(r.entries),
      (e: Error) => (setEntries([]), setWhy(e.message)),
    );
  }, [at]);
  if (!places) return <p className="chat-attach-note" role={why ? "alert" : "status"}>{why || "Looking…"}</p>;
  if (!places.length) return <p className="chat-attach-note">No folders on this computer are approved for Foundation yet. An admin adds them in Settings → Places.</p>;
  if (!at)
    return (
      <div className="chat-attach-list">
        {places.map((p) => (
          <button key={p.id} type="button" className="chat-attach-row" disabled={!p.reachable} onClick={() => setAt({ place: p, dir: "" })}>
            <span title={p.name}>▸ {p.name}</span>
            {!p.reachable && <span className="chat-file-meta">not reachable</span>}
          </button>
        ))}
      </div>
    );
  const up = at.dir.split("/").slice(0, -1).join("/");
  return (
    <div className="chat-attach-list">
      <button type="button" className="chat-attach-row" onClick={() => (at.dir ? setAt({ place: at.place, dir: up }) : setAt(null))}>
        ‹ {at.dir ? at.dir.split("/").at(-2) || at.place.name : "All places"}
      </button>
      {!entries ? (
        <p className="chat-attach-note" role="status">Opening…</p>
      ) : (
        entries.map((e) =>
          e.dir ? (
            <button key={e.path} type="button" className="chat-attach-row" onClick={() => setAt({ place: at.place, dir: e.path })}>
              <span title={e.name}>▸ {e.name}</span>
            </button>
          ) : (
            <button key={e.path} type="button" className="chat-attach-row" disabled={Boolean(busy)} onClick={() => onPick(at.place.id, e.path)}>
              <span title={e.name}>{e.name}</span>
              <span className="chat-file-meta">{busy === `${at.place.id}:${e.path}` ? "Copying…" : bytes(e.size)}</span>
            </button>
          ),
        )
      )}
    </div>
  );
}
