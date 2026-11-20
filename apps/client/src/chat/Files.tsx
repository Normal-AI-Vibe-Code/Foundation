/**
 * Files in a message, drawn as what they are: pictures and GIFs as pictures (a press opens them large),
 * video and audio as players, a CAD part as the CAD card's still that turns (`CadPreview`), anything else
 * a row with its name, size and a download. Link previews as a quiet card under the words. Every
 * `/files/…` goes through `useFileSrc`, so the desktop app (a bearer, another origin) shows them too.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { ChatFile, ChatLinkPreview } from "@foundation/protocol";
import { fileLink, useFileSrc } from "../lib/fileSrc";
import { CadAttachment } from "./CadAttachment";
import { bytes, fileKind } from "./logic";
import { IconDownload, IconFile } from "./Icons";

export const fileSrcOf = (f: Pick<ChatFile, "id">) => `/files/${encodeURIComponent(f.id)}`;

/** `src` overrides where the file is read from (the design page draws fixtures with no server) */
export function ChatFiles({ files, srcOf = fileSrcOf }: { files: ChatFile[]; srcOf?: (f: ChatFile) => string }) {
  const [big, setBig] = useState<ChatFile | null>(null);
  if (!files.length) return null;
  const pictures = files.filter((f) => fileKind(f) === "image");
  const rest = files.filter((f) => fileKind(f) !== "image");
  return (
    <div className="chat-files">
      {pictures.length > 0 && (
        <div className={`chat-pictures${pictures.length > 1 ? " is-many" : ""}`}>
          {pictures.map((f) => (
            <Picture key={f.id} file={f} src={srcOf(f)} onOpen={() => setBig(f)} />
          ))}
        </div>
      )}
      {rest.map((f) => (
        <FileBody key={f.id} file={f} src={srcOf(f)} />
      ))}
      <Lightbox file={big} src={big ? srcOf(big) : ""} onClose={() => setBig(null)} />
    </div>
  );
}

function Picture({ file, src, onOpen }: { file: ChatFile; src: string; onOpen(): void }) {
  const shown = useFileSrc(src);
  const ratio = file.w && file.h ? `${file.w} / ${file.h}` : undefined;
  return (
    <button className="chat-picture" onClick={onOpen} data-tip={`${file.name} · ${bytes(file.size)}`} aria-label={`Open ${file.name}`} style={{ aspectRatio: ratio }}>
      {shown ? <img src={shown} alt={file.name} loading="lazy" decoding="async" draggable={false} /> : <span className="chat-picture-wait" />}
    </button>
  );
}

function FileBody({ file, src }: { file: ChatFile; src: string }) {
  const kind = fileKind(file);
  const shown = useFileSrc(src, kind === "video" || kind === "audio");
  if (kind === "video")
    return (
      <div className="chat-player is-video">
        <video src={shown} controls preload="metadata" playsInline />
        <FileRow file={file} src={src} quiet />
      </div>
    );
  if (kind === "audio")
    return (
      <div className="chat-player is-audio">
        <FileRow file={file} src={src} quiet />
        <audio src={shown} controls preload="metadata" />
      </div>
    );
  if (kind === "cad") return <CadAttachment file={file} src={src} />;
  return <FileRow file={file} src={src} />;
}

/** a file as a row: its mark, name, size and kind, and a download */
export function FileRow({ file, src, quiet }: { file: Pick<ChatFile, "name" | "size" | "mime">; src: string; quiet?: boolean }) {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toUpperCase().slice(0, 4) : "";
  return (
    <div className={`chat-file-row${quiet ? " is-quiet" : ""}`}>
      {!quiet && (
        <span className="chat-file-mark" aria-hidden>
          {ext || <IconFile />}
        </span>
      )}
      <span className="chat-file-text">
        <span className="chat-file-name">{file.name}</span>
        <span className="chat-file-meta">{[bytes(file.size), kindWord(file)].filter(Boolean).join(" · ")}</span>
      </span>
      <a className="chat-icon-btn" {...fileLink(src, file.name)} download={file.name} data-tip="Download" aria-label={`Download ${file.name}`}>
        <IconDownload />
      </a>
    </div>
  );
}

function kindWord(f: Pick<ChatFile, "name" | "mime">): string {
  const k = fileKind(f);
  return k === "cad" ? "CAD" : k === "pdf" ? "PDF" : k === "video" ? "Video" : k === "audio" ? "Audio" : k === "image" ? "Picture" : f.mime && f.mime !== "application/octet-stream" ? f.mime.split("/")[1]?.toUpperCase().slice(0, 12) ?? "" : "File";
}

/** a picture large, over everything; Esc or a press outside puts it back */
export function Lightbox({ file, src, onClose }: { file: ChatFile | null; src: string; onClose(): void }) {
  const shown = useFileSrc(file ? src : null);
  useEffect(() => {
    if (!file) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [file, onClose]);
  return createPortal(
    <AnimatePresence>
      {file && (
        <motion.div className="chat-lightbox" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} role="dialog" aria-label={file.name}>
          <motion.figure onClick={(e) => e.stopPropagation()} initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.98, y: 4 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
            {shown && <img src={shown} alt={file.name} draggable={false} />}
            <figcaption>
              <span>{file.name}</span>
              <span className="chat-file-meta">{bytes(file.size)}</span>
              <a className="f-pill" {...fileLink(src, file.name)} download={file.name}>
                Download
              </a>
              <button className="f-pill" onClick={onClose}>
                Close
              </button>
            </figcaption>
          </motion.figure>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function LinkPreviews({ previews }: { previews?: ChatLinkPreview[] }) {
  if (!previews?.length) return null;
  return (
    <div className="chat-previews">
      {previews.slice(0, 3).map((p) => (
        <a key={p.url} className="chat-preview" href={p.url} target="_blank" rel="noopener noreferrer">
          <span className="chat-preview-text">
            <span className="chat-preview-site">{p.site ?? hostOf(p.url)}</span>
            {p.title && <span className="chat-preview-title">{p.title}</span>}
            {p.description && <span className="chat-preview-desc">{p.description}</span>}
          </span>
          {p.image && <PreviewImage src={p.image} />}
        </a>
      ))}
    </div>
  );
}

function PreviewImage({ src }: { src: string }) {
  const shown = useFileSrc(src);
  return shown ? <img className="chat-preview-img" src={shown} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
