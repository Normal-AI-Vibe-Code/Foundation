/**
 * A CAD file in a message (ChatForm R1): the part as a still at rest that turns while dragged (CadPreview:
 * one live viewer at a time, then a new still), its size in mm and triangle count, the STEP header's facts
 * (product names, unit) from the server, Download, and **Open on a grid…**: pick a grid and a section and the
 * file lands there as a file card (the grid gets its own record of the same bytes), so a huddle can be held
 * over it. OpenCascade is loaded only when a STEP or IGES is first shown, and only once the card is on
 * screen; a large file waits for a press so a long parse never lands while someone is typing.
 *
 * PlaceOnGrid is the picker, also used by a live huddle's dock ("Bring a file to the grid": one step onto
 * the section the huddle was taken to).
 */

import { useEffect, useRef, useState } from "react";
import type { ChatFile } from "@foundation/protocol";
import { api } from "../lib/api";
import { fileLink } from "../lib/fileSrc";
import { loadGrids, useGrids } from "../lib/grids";
import { activeBoard } from "../sync/board";
import { toast } from "../state/ui";
import { CadPreview } from "../cad/CadPreview";
import { goToCard } from "../panels/HuddleCall";
import { bytes } from "./logic";
import { IconDownload } from "./Icons";
import "../panels/huddlecall.css";

/** past this, the 3D view waits for a press (OpenCascade parses on this page's thread) */
const AUTO_3D_BYTES = 15 * 1024 * 1024;

interface CadFacts {
  format: string;
  unit: string;
  bbox: { size: [number, number, number] } | null;
  products: string[];
  faces: number;
}

export function CadAttachment({ file, src, onOpenOnGrid }: { file: Pick<ChatFile, "id" | "name" | "size" | "mime">; src: string; onOpenOnGrid?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [asked, setAsked] = useState(file.size <= AUTO_3D_BYTES);
  const [facts, setFacts] = useState<CadFacts | null>(null);
  const [placing, setPlacing] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver !== "function") return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const isStep = /\.(step|stp)$/i.test(file.name);
  useEffect(() => {
    if (!seen || !isStep || !src.startsWith("/files/")) return;
    let on = true;
    api<CadFacts>(`/api/files/${encodeURIComponent(file.id)}/cad`)
      .then((f) => on && setFacts(f))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [seen, isStep, file.id, src]);
  const ext = file.name.split(".").pop()?.toUpperCase() ?? "CAD";
  const size = facts?.bbox?.size;
  return (
    <div ref={box} className="chat-cad" data-cad-attachment={file.name}>
      <div className="chat-cad-view">
        {seen && asked ? (
          <CadPreview url={src} name={file.name} />
        ) : (
          <button type="button" className="chat-cad-wait" onClick={() => setAsked(true)} disabled={!seen}>
            <span className="chat-cad-ext">{ext}</span>
            <span>{asked ? "…" : `Show in 3D · ${bytes(file.size)}`}</span>
          </button>
        )}
      </div>
      <div className="chat-cad-facts">
        <span className="chat-file-name" title={file.name}>{file.name}</span>
        <span className="chat-file-meta">
          {[bytes(file.size), ext, facts?.products[0] ? `“${facts.products[0]}”` : "", size ? `${size.map((n) => Math.round(n)).join(" × ")} ${facts?.unit || ""}`.trim() : ""].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="chat-cad-actions">
        <a className="f-pill" {...fileLink(src, file.name)} download={file.name}>
          <IconDownload /> Download
        </a>
        <button type="button" className="f-pill" onClick={() => (onOpenOnGrid ? onOpenOnGrid() : setPlacing((p) => !p))} aria-expanded={placing} data-cad-open-grid>
          Open on a grid…
        </button>
      </div>
      {placing && <PlaceOnGrid fileId={file.id} name={file.name} onClose={() => setPlacing(false)} />}
    </div>
  );
}

interface Outline {
  sections: Array<{ id: string; name: string }>;
}

/** pick a grid and a section; the file lands there as a card, then Go there (or `to`: straight onto that place) */
export function PlaceOnGrid({ fileId, name, onClose, to }: { fileId: string; name: string; onClose(): void; to?: { board: string; section?: string } }) {
  const grids = useGrids().filter((g) => (g.kind ?? "grid") === "grid" && g.role !== "viewer");
  const [board, setBoard] = useState<string>(() => to?.board ?? activeBoard()?.boardId ?? "");
  const [sections, setSections] = useState<Outline["sections"] | null>(null);
  const [section, setSection] = useState(to?.section ?? "");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ board: string; card: string; label: string } | null>(null);
  useEffect(() => void loadGrids(), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  useEffect(() => {
    if (!board) return;
    setSections(null);
    api<Outline>(`/api/boards/${encodeURIComponent(board)}/outline`)
      .then((o) => {
        setSections(o.sections);
        setSection((s) => (s && o.sections.some((x) => x.id === s) ? s : (o.sections[0]?.id ?? "")));
      })
      .catch(() => setSections([]));
  }, [board]);
  const place = async () => {
    setBusy(true);
    try {
      const r = await api<{ result: { id: string; section: string } }>(`/api/boards/${encodeURIComponent(board)}/tools/place_file`, { method: "POST", json: { file: fileId, section, request_id: `place:${fileId}:${board}:${section}` } });
      const g = grids.find((x) => x.id === board);
      const s = sections?.find((x) => x.id === r.result.section);
      setDone({ board, card: r.result.id, label: `${g?.name ?? board} › ${s?.name ?? "section"}` });
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="huddle-place f-glass chat-cad-place" role="dialog" aria-label={`Open ${name} on a grid`} data-place-file={fileId}>
      {done ? (
        <>
          <p className="huddle-pop-note">
            <b>{name}</b> is on <b>{done.label}</b>.
          </p>
          <div className="huddle-place-foot">
            <button type="button" className="f-pill is-accent" onClick={() => (goToCard(done.board, done.card), onClose())} data-place-go>
              Go there
            </button>
            <button type="button" className="f-pill" onClick={onClose}>
              Stay here
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="huddle-pop-head">Open {name} on a grid</div>
          <label className="huddle-place-field">
            <span>Grid</span>
            <select value={board} onChange={(e) => setBoard(e.target.value)} aria-label="Grid">
              <option value="">Choose a grid</option>
              {grids.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="huddle-place-field">
            <span>Section</span>
            <select value={section} onChange={(e) => setSection(e.target.value)} disabled={!sections?.length} aria-label="Section">
              {!sections ? <option>…</option> : !sections.length ? <option value="">No sections</option> : sections.map((s) => <option key={s.id} value={s.id}>{s.name || "Untitled"}</option>)}
            </select>
          </label>
          <div className="huddle-place-foot">
            <button type="button" className="f-pill is-accent" disabled={!board || !section || busy} onClick={() => void place()} data-place-take>
              {busy ? "Putting it there…" : "Put it there"}
            </button>
            <button type="button" className="f-pill" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * In a live huddle's dock, once the huddle has been taken to a grid: "Bring a file to the grid" lists the
 * files shared in the channel (CAD first, newest first) and one press puts one on the section the huddle is
 * on, as a file card, for everyone in the call to look at there.
 */
export function BringFileToGrid({ files, board, section }: { files: Array<Pick<ChatFile, "id" | "name" | "size" | "mime">>; board: string; section?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);
  const list = [...new Map(files.map((f) => [f.id, f])).values()].sort((a, b) => Number(/\.(step|stp|iges|igs|stl|obj|glb)$/i.test(b.name)) - Number(/\.(step|stp|iges|igs|stl|obj|glb)$/i.test(a.name)));
  const bring = async (f: (typeof list)[number]) => {
    setBusy(f.id);
    try {
      const r = await api<{ result: { id: string } }>(`/api/boards/${encodeURIComponent(board)}/tools/place_file`, { method: "POST", json: { file: f.id, ...(section ? { section } : {}), request_id: `bring:${f.id}:${board}:${section ?? ""}` } });
      toast(`${f.name} is on the grid beside the huddle`, "ok");
      setOpen(false);
      void r;
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="huddle-ctl-anchor">
      <button type="button" className="f-pill" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-bring-file>
        Bring a file to the grid
      </button>
      {open && (
        <div className="huddle-place f-glass" role="dialog" aria-label="Bring a file to the grid">
          <div className="huddle-pop-head">Shared in this conversation</div>
          {!list.length && <p className="huddle-pop-note">No files shared here yet. Drop one in the conversation first.</p>}
          <div className="chat-attach-list">
            {list.slice(0, 12).map((f) => (
              <button key={f.id} type="button" className="chat-attach-row" disabled={Boolean(busy)} onClick={() => void bring(f)} data-bring={f.name}>
                <span title={f.name}>{f.name}</span>
                <span className="chat-file-meta">{busy === f.id ? "Bringing…" : bytes(f.size)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
