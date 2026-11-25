/**
 * Files in a message, drawn as what they are: pictures and GIFs as pictures (a press opens them large),
 * video and audio as players, a CAD part as the CAD card's still that turns (`CadPreview`), anything else
 * a row with its name, size and a download. Link previews as a quiet card under the words. Every
 * `/files/…` is read from whichever server ChatForm is on, with that server's own sign-in (chat/chatFiles.tsx):
 * Foundation's archive, or a chat server's files with its bearer.
 *
 * A picture holds its box from the width and height the server kept, so the timeline doesn't move when it lands,
 * and fades in. A GIF is asked for as the file it is, so it plays.
 *
 * A link preview is what the server read from the page (its site, title and description, shown at once). Its
 * picture is at the other site's address, so it follows the rule for every picture from elsewhere (DESIGN.md,
 * "Pictures and links from elsewhere"): a dashed pill naming the host and **Load image**, which loads that one
 * picture, this time, with no referrer. Only a picture the server itself holds (`/files/…`) shows on sight.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import type { ChatFile, ChatLinkPreview } from "@foundation/protocol";
import { CadAttachment } from "./CadAttachment";
import { ChatImage, chatFileLink, useChatFileSrc } from "./chatFiles";
import { CHAT_REMOTE } from "./server";
import { chatPictureTier, pictureBox } from "./serverLogic";
import { bytes, fileKind, previewShape } from "./logic";
import { IconDownload, IconFile } from "./Icons";
import "./bell.css";

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
            <Picture key={f.id} file={f} src={srcOf(f)} many={pictures.length > 1} onOpen={() => setBig(f)} />
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

function Picture({ file, src, many, onOpen }: { file: ChatFile; src: string; many: boolean; onOpen(): void }) {
  // the box it will fill, kept before a byte of it is here (the server's width and height), so nothing below moves
  const box = many ? null : pictureBox(file);
  return (
    <button
      type="button"
      className={`chat-picture${box ? " has-box" : ""}`}
      onClick={onOpen}
      data-tip={`${file.name} · ${bytes(file.size)}`}
      aria-label={`Open ${file.name}`}
      style={box ? { width: box.width, aspectRatio: `${box.width} / ${box.height}` } : undefined}
    >
      <ChatImage src={src} alt={file.name} tier={chatPictureTier(file, many ? 256 : 512)} fit={many || box ? "cover" : undefined} />
    </button>
  );
}

function FileBody({ file, src }: { file: ChatFile; src: string }) {
  const kind = fileKind(file);
  const shown = useChatFileSrc(src, kind === "video" || kind === "audio");
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
  // the CAD card converts and places through Foundation's own server: on a chat server a part is a file to download
  if (kind === "cad" && !CHAT_REMOTE) return <CadAttachment file={file} src={src} />;
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
        <span className="chat-file-name" title={file.name}>{file.name}</span>
        <span className="chat-file-meta">{[bytes(file.size), kindWord(file)].filter(Boolean).join(" · ")}</span>
      </span>
      <a className="chat-icon-btn" {...chatFileLink(src, file.name)} download={file.name} data-tip="Download" aria-label={`Download ${file.name}`}>
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
        <motion.div
          className="chat-lightbox"
          onPointerDown={(e) => e.target === e.currentTarget && onClose()}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          role="dialog"
          aria-modal="true"
          aria-label={file.name}
        >
          <motion.figure initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.98, y: 4 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
            <ChatImage src={src} alt={file.name} tier="orig" fit="contain" />
            <figcaption>
              <span title={file.name}>{file.name}</span>
              <span className="chat-file-meta">{bytes(file.size)}</span>
              <a className="f-pill" {...chatFileLink(src, file.name)} download={file.name}>
                Download
              </a>
              <button type="button" className="f-pill" onClick={onClose}>
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
        <LinkPreview key={p.url} p={p} />
      ))}
    </div>
  );
}

function LinkPreview({ p }: { p: ChatLinkPreview }) {
  // a link straight to a picture or a GIF: the picture, under the words
  if (previewShape(p) === "picture") {
    return (
      <div className="chat-preview is-picture" data-preview="picture">
        <PreviewImage src={p.image!} large link={p.url} />
      </div>
    );
  }
  return (
    <div className="chat-preview" data-preview="card">
      <a className="chat-preview-text" href={p.url} target="_blank" rel="noopener noreferrer">
        <span className="chat-preview-site">{p.site ?? hostOf(p.url)}</span>
        {p.title && <span className="chat-preview-title">{p.title}</span>}
        {p.description && <span className="chat-preview-desc">{p.description}</span>}
      </a>
      {p.image && <PreviewImage src={p.image} />}
    </div>
  );
}

/**
 * A preview's picture. One the server holds (`/files/…`) is read like any chat file. One at another site's address
 * waits for a press: nothing is asked of that site until then, and then only that picture, with no referrer.
 */
function PreviewImage({ src, large, link }: { src: string; large?: boolean; link?: string }) {
  const [load, setLoad] = useState(false);
  const cls = `chat-preview-img${large ? " is-large" : ""}`;
  if (src.startsWith("/files/")) {
    return (
      <span className={cls}>
        <ChatImage src={src} alt="" tier={large ? 512 : 256} fit={large ? undefined : "cover"} />
      </span>
    );
  }
  if (!/^https?:\/\//i.test(src)) return null;
  if (!load) {
    return (
      <span className={`md-img-remote chat-preview-wait${large ? " is-large" : ""}`} data-preview-wait>
        <span className="md-img-remote-label">
          Image from <b>{hostOf(src)}</b>
        </span>
        <button type="button" className="md-img-load" onClick={() => setLoad(true)}>
          Load image
        </button>
      </span>
    );
  }
  const img = <img className={cls} src={src} alt="" decoding="async" referrerPolicy="no-referrer" />;
  return large && link ? (
    <a href={link} target="_blank" rel="noopener noreferrer" className="chat-preview-open">
      {img}
    </a>
  ) : (
    img
  );
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
