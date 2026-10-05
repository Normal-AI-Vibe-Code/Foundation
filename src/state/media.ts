/**
 * Media intake shared by every drop target: MIME sniffing with an
 * extension fallback (Windows often reports an empty MIME for images
 * dragged from Explorer), natural-size probing, and batch ingest.
 */

import { addMedia } from "./store";
import { saveMediaBlob } from "./persist";
import { sfx } from "../sound/sfx";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv)$/i;

export function mediaKind(file: File): "image" | "video" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (IMAGE_EXT.test(file.name)) return "image";
  if (VIDEO_EXT.test(file.name)) return "video";
  return null;
}

/** read natural media dimensions so cards start with the right aspect */
function probeMedia(
  file: File,
  kind: "image" | "video",
): Promise<{ src: string; w: number; h: number }> {
  const src = URL.createObjectURL(file);
  return new Promise((resolve) => {
    if (kind === "video") {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ src, w: v.videoWidth || 640, h: v.videoHeight || 360 });
      v.onerror = () => resolve({ src, w: 640, h: 360 });
      v.src = src;
    } else {
      const img = new Image();
      img.onload = () => resolve({ src, w: img.naturalWidth || 480, h: img.naturalHeight || 360 });
      img.onerror = () => resolve({ src, w: 480, h: 360 });
      img.src = src;
    }
  });
}

/** add every droppable file to a section; nope-sounds when nothing was */
export async function ingestMediaFiles(
  sectionId: string,
  files: FileList | File[],
): Promise<number> {
  let added = 0;
  for (const file of [...files]) {
    const kind = mediaKind(file);
    if (!kind) continue;
    const { src, w, h } = await probeMedia(file, kind);
    const meta = addMedia(sectionId, src, kind, file.name, w, h);
    saveMediaBlob(meta.id, file); // uploads survive restarts
    added++;
  }
  if (added === 0) sfx.nope();
  return added;
}

/** does this drag carry files at all? (type info is unreliable mid-drag) */
export function dragHasFiles(e: React.DragEvent): boolean {
  return [...e.dataTransfer.types].includes("Files");
}
