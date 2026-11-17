/**
 * What a search result becomes on the board, and how one that isn't here yet
 * gets here. Shared by the search pane, the Flowform and This-computer
 * browsers, and the clipboard, so a result lands the same way however it was
 * carried (lib/pickup.ts).
 */
import type { SearchHit } from "@foundation/protocol";
import { ApiError, api, type UploadedFile } from "./api";
import { addMedia, addNote, addPanel, getState, placeAtWorld, requestSnap, sectionAtWorld } from "../state/store";
import { toast } from "../state/ui";
import { activeBoard } from "../sync/board";
import { snippetText } from "./snippet";
import { openUrlAsPanel } from "../shell/CommandBar";

export const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
export const VIDEO = /\.(mp4|mov|webm|m4v)$/i;

export const GLYPH: Record<SearchHit["source"], string> = { board: "▦", file: "▤", app: "◳", slack: "#", github: "⌥", activity: "•", huddle: "◉", flowform: "▧" };
/** Flowform's own kinds, drawn as Foundation's marks */
const FLOWFORM_GLYPH: Record<string, string> = { image: "▣", video: "▶", pdf: "▤", doc: "▤", file: "▤", model: "◇" };
export const glyphOf = (h: SearchHit) => (h.source === "flowform" ? (FLOWFORM_GLYPH[h.flowform?.kind ?? ""] ?? "▧") : GLYPH[h.source]);

/** the picture a result shows in a list or in the hand: a file that is an image, or the small one the server names */
export const pictureOf = (h: SearchHit): string | undefined => h.thumb ?? (h.source === "file" && h.url && IMAGE.test(h.title) ? h.url : undefined);

/** a file in an approved folder on this computer, as the This-computer browser names it: `place:<place>:<path>` */
export const placeHitId = (placeId: string, path: string) => `place:${placeId}:${path}`;
const placeRef = (id: string) => /^place:([^:]+):(.+)$/s.exec(id);

/** whether putting this down has to fetch something first (so the card waits where it was dropped) */
export const needsFetch = (h: SearchHit) => Boolean(placeRef(h.id)) || (h.source === "flowform" && Boolean(h.flowform?.revisionId));

const size = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fileHit = (file: UploadedFile): SearchHit => ({ source: "file", id: `file:${file.id}`, title: file.name, snippet: file.mime, url: file.url, score: 1 });

/**
 * The hit a card is made from. Most are themselves. A file in an approved
 * folder is copied into this board's archive first; a Flowform file's bytes are
 * brought in as the person (when they've allowed downloads), and otherwise it
 * lands as a link to where it lives (Slack, Figma) or a note naming it.
 * Null when it couldn't be fetched: a toast has said why.
 */
export async function resolveHit(hit: SearchHit): Promise<SearchHit | null> {
  const board = encodeURIComponent(activeBoard()?.boardId ?? "company");
  const place = placeRef(hit.id);
  if (place) {
    try {
      return fileHit((await api<{ file: UploadedFile }>(`/api/places/${encodeURIComponent(place[1])}/bring?board=${board}`, { method: "POST", json: { path: place[2] } })).file);
    } catch (e) {
      toast(`Couldn't bring ${hit.title}: ${(e as Error).message}`, "bad");
      return null;
    }
  }
  const ff = hit.source === "flowform" ? hit.flowform : undefined;
  if (!ff) return hit;
  if (ff.revisionId) {
    try {
      return fileHit((await api<{ file: UploadedFile }>(`/api/flowform/files/${encodeURIComponent(ff.fileId)}/bring?board=${board}`, { method: "POST", json: { revision: ff.revisionId, name: hit.title } })).file);
    } catch (e) {
      // 409: downloads aren't allowed for this person (or Flowform ended the session): it lands by name instead, below
      if (!(e instanceof ApiError) || e.status !== 409) {
        toast(`Couldn't bring ${hit.title}: ${(e as Error).message}`, "bad");
        return null;
      }
    }
  }
  // a file with an address of its own (Slack, Figma) lands as a link card: an outside page can't be framed as an app
  if (hit.url) return { ...hit, source: "slack", flowform: undefined };
  const a = /^[aeiou]/i.test(ff.kind) ? "An" : "A";
  const where = ff.origin && ff.origin !== "flowform" ? ` (${ff.origin})` : "";
  return {
    source: "board",
    id: hit.id,
    title: hit.title,
    snippet: `${a} ${ff.kind} in Flowform${ff.bytes ? `, ${size(ff.bytes)}` : ""}${where}. Allow Flowform file downloads (Settings → Services) to bring the file itself.`,
    score: 1,
  };
}

/** make the card a (resolved) result stands for, where it was dropped; the new card's id, if one was made */
export async function placeHit(hit: SearchHit, wx: number, wy: number): Promise<string | null> {
  const st = getState();
  const sec = sectionAtWorld(wx, wy) ?? st.sections[st.activeSectionId] ?? Object.values(st.sections)[0];
  if (!sec) return null;
  const existing = hit.objectId && (st.panels[hit.objectId] || st.notes[hit.objectId] || st.tables[hit.objectId] || st.media[hit.objectId] || st.maps[hit.objectId]);
  if (existing) {
    // it's already on the board: show it rather than copy it
    requestSnap({ kind: "object", id: hit.objectId! });
    toast(`“${hit.title}” is already on the board`);
    return null;
  }
  let id: string | null = null;
  if (hit.source === "file" && hit.url && (IMAGE.test(hit.title) || VIDEO.test(hit.title))) {
    const video = VIDEO.test(hit.title);
    const { w, h } = video ? { w: 640, h: 360 } : await imageSize(hit.url);
    id = addMedia(sec.id, hit.url, video ? "video" : "image", hit.title, w, h, { focus: false }).id;
  } else if (hit.source === "file") {
    id = addPanel(sec.id, { panel: "file", name: hit.title, fileId: hit.id.replace(/^file:/, "") }, { focus: false }).id;
  } else if (hit.source === "app" && hit.url) {
    void openUrlAsPanel(hit.url, "app", { name: hit.title, description: hit.snippet }, sec.id, (pid) => placeAtWorld(pid, wx, wy));
    return null;
  } else if (hit.url) {
    id = addPanel(sec.id, { panel: "link", name: hit.title, url: hit.url }, { focus: false }).id;
  } else {
    id = addNote(sec.id, `## ${hit.title}\n\n${snippetText(hit.snippet)}`, { focus: false }).id;
  }
  if (id) placeAtWorld(id, wx, wy);
  return id;
}

function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => ok({ w: img.naturalWidth || 480, h: img.naturalHeight || 360 });
    img.onerror = () => ok({ w: 480, h: 360 });
    img.src = src;
  });
}
