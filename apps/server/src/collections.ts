/**
 * Collections (protocol collections.ts): a card that gathers what the cards wired into it make, keeps it,
 * and can lay it out in a section. The server alone writes a collection's state (the board's `collections`
 * map), so what a collection holds is the same for everyone and nobody can forge an item over the socket.
 *
 * Gathering is the server following the board: whenever its wires, its cards or its characters change, each
 * collection on it asks its sources what they offer now and keeps what it hadn't got. What a source offers:
 *
 * - a node of the Character studio's flow (`panel: "pipeline"`, `node`, `source`: the set):
 *     Inspiration — the pictures in `Inspiration · <Set>`;
 *     Sheet, Expressions, Views, Mesh avatar, Moods — the pictures drawn at that stage for the set's
 *       characters (Views by the port the wire leaves from: the portrait, or the back and the side);
 *     Output — the set's finished characters, as characters;
 * - another collection: what it holds.
 *
 * Nothing is dropped when a source changes (a redrawn sheet is a new picture, and the old one stays): a
 * person takes an item out. Copies are the server's too, because a character's copy needs a row of its own.
 */

import {
  boardMaps,
  COLLECTION_IN,
  COLLECTION_OUT,
  COLLECTION_TYPE,
  leafSectionOf,
  logActivity,
  nodeOf,
  uid,
  type CharacterState,
  type CollectionItem,
  type CollectionState,
  type LinkDoc,
  type MediaDoc,
  type PanelDoc,
  type PipelineNodeKey,
  type SectionDoc,
} from "@foundation/protocol";
import type * as Y from "yjs";
import { editBoard, getBoard, onBoardOpen, type Board } from "./boards.ts";
import { characterById, copyCharacter, FLOW_END_X, FLOW_H, growForFlow, layFlow } from "./characters.ts";
import { imageSize } from "./construct.ts";
import { fileBytesSync } from "./files.ts";
import { HttpError } from "./http.ts";

const ORIGIN = "collections";

/** a collection card's size when it's made (the client's store says the same) */
export const COLLECTION_W = 360;
export const COLLECTION_H = 420;
/** a picture laid out or copied from a collection is this wide; its height keeps the picture's shape */
const PICTURE_W = 300;

const titled = (set: string) => set.trim().replace(/^./, (c) => c.toUpperCase());

/** the two ports every collection has */
export function collectionPorts(): PanelDoc["ports"] {
  return [
    { id: uid("port"), name: COLLECTION_IN, dir: "in", type: COLLECTION_TYPE },
    { id: uid("port"), name: COLLECTION_OUT, dir: "out", type: COLLECTION_TYPE },
  ];
}

export function collectionOf(doc: Y.Doc, id: string): CollectionState {
  return boardMaps(doc).collections.get(id) ?? { items: [] };
}

function mustCollection(doc: Y.Doc, id: string): PanelDoc {
  const card = boardMaps(doc).objects.get(id);
  if (!card || card.kind !== "panel" || card.panel !== "collection") throw new HttpError(404, `no collection ${id} on this board`);
  return card;
}

// ---------- what a source offers ----------

const sizes = new Map<string, { w: number; h: number } | null>();
/** a picture's size, read once from the archive (null when it can't be read) */
function pictureSize(fileId: string): { w: number; h: number } | null {
  if (!sizes.has(fileId)) {
    const f = fileBytesSync(fileId);
    sizes.set(fileId, f ? imageSize(f.body) : null);
  }
  return sizes.get(fileId) ?? null;
}

const ROLE_WORDS: Record<string, string> = { front: "sheet", expressions: "expressions", portrait: "portrait", back: "back", side: "side", thumb: "still" };
const NODE_NAMES: Record<PipelineNodeKey, string> = {
  inspiration: "Inspiration",
  sheet: "Sheet",
  expressions: "Expressions",
  views: "Views",
  mesh: "Mesh avatar",
  model: "Meshy model",
  rig: "Skeleton",
  clips: "Moods",
  output: "Output",
};

/** the pictures a stage node's wire carries, by the node and the port it leaves from */
function rolesFor(node: PipelineNodeKey, portName: string): string[] {
  switch (node) {
    case "sheet":
      return ["front"];
    case "expressions":
      return ["expressions"];
    case "views":
      return portName === "portrait" ? ["portrait"] : portName === "back and side" ? ["back", "side"] : ["portrait", "back", "side"];
    case "mesh":
    case "clips":
      return ["thumb"];
    default:
      return [];
  }
}

function pictureItem(fileId: string, name: string, from: string, more: Partial<CollectionItem> = {}): CollectionItem {
  const size = pictureSize(fileId);
  return { key: `file:${fileId}`, kind: "image", name, src: `/files/${fileId}`, fileId, from, at: Date.now(), ...(size ? { w: size.w, h: size.h } : {}), ...more };
}

function characterItem(id: string, c: CharacterState, panel: string | undefined, from: string): CollectionItem {
  return { key: `chr:${c.copyOf ?? c.id}`, kind: "character", name: c.name, character: c.id, panel, form: c.form, from, at: Date.now(), ...(c.files.thumb ? { src: `/api/characters/${encodeURIComponent(c.id)}/files/thumb` } : {}) };
}

/** what the card at a wire's start offers a collection now */
function offers(doc: Y.Doc, link: LinkDoc): CollectionItem[] {
  const m = boardMaps(doc);
  const src = m.objects.get(link.from.panel);
  if (!src) return [];
  if (src.kind === "panel" && src.panel === "collection") return collectionOf(doc, src.id).items.map((it) => ({ ...it, from: it.from || src.name }));
  if (src.kind !== "panel" || src.panel !== "pipeline" || !src.node || !src.source) return [];
  const node = src.node as PipelineNodeKey;
  const set = src.source.toLowerCase();
  const from = `${NODE_NAMES[node] ?? node} · ${titled(set)}`;
  if (node === "inspiration") {
    const secs = new Set([...m.sections.values()].filter((s) => s.name.trim().toLowerCase() === `inspiration · ${set}`).map((s) => s.id));
    return [...m.objects.values()]
      .filter((o): o is MediaDoc => o.kind === "media" && o.media === "image" && secs.has(o.sectionId))
      .sort((a, b) => a.bornAt - b.bornAt)
      .flatMap((o) => {
        const f = /^\/files\/([^/?#]+)/.exec(o.src);
        return f ? [pictureItem(f[1], o.name, from)] : [];
      });
  }
  const port = src.ports.find((p) => p.id === link.from.port)?.name ?? "";
  const characters = [...m.characters.entries()].filter(([id, c]) => m.objects.has(id) && c.set === set && !c.copyOf);
  if (node === "output") return characters.filter(([, c]) => nodeOf(c) === "output").map(([id, c]) => characterItem(id, c, id, from));
  const roles = rolesFor(node, port);
  const out: CollectionItem[] = [];
  for (const [id, c] of characters)
    for (const role of roles) {
      const file = (c.files as Record<string, string | undefined>)[role];
      if (file) out.push(pictureItem(file, `${c.name} · ${ROLE_WORDS[role] ?? role}`, from, { character: c.id, panel: id }));
    }
  return out;
}

// ---------- gathering and laying out ----------

/** a card for an item, docked in a section (its flow places it) or floating where it was let go */
function placeItem(doc: Y.Doc, boardId: string, it: CollectionItem, place: { sectionId: string; x?: number; y?: number; float?: boolean }, actor: { name: string; id: string }, bornAt = Date.now()): string | null {
  const m = boardMaps(doc);
  if (it.kind === "character") {
    if (!it.character || !characterById(it.character)) return null;
    return copyCharacter(boardId, it.character, place, actor).panelId;
  }
  if (!it.src) return null;
  const w = PICTURE_W;
  const h = it.w && it.h ? Math.round((w * it.h) / it.w) : w;
  const card: MediaDoc = { id: uid("media"), kind: "media", sectionId: place.sectionId, name: it.name, x: Math.max(0, Math.round(place.x ?? 0)), y: Math.max(0, Math.round(place.y ?? 0)), float: place.float ?? false, bornAt, w, h, src: it.src, media: "image", autoplay: false, muted: true, createdBy: actor.name };
  m.objects.set(card.id, card);
  return card.id;
}

/**
 * Bring every collection on a board up to date: what its sources offer that it hasn't got, and, when it is
 * piped into a section, a card there for each item not yet laid. Returns how many items arrived.
 */
export function gather(boardId: string): number {
  let arrived = 0;
  editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    const links = [...m.links.values()];
    for (const card of [...m.objects.values()]) {
      if (card.kind !== "panel" || card.panel !== "collection") continue;
      const was = collectionOf(doc, card.id);
      const known = new Set(was.items.map((i) => i.key));
      const fresh: CollectionItem[] = [];
      for (const l of links.filter((l) => l.to.panel === card.id))
        for (const it of offers(doc, l)) {
          if (known.has(it.key)) continue;
          known.add(it.key);
          fresh.push(it);
        }
      const items = fresh.length ? [...was.items, ...fresh] : was.items;
      const laid = { ...(was.laid ?? {}) };
      const into = was.into ? m.sections.get(was.into) : undefined;
      let placed = 0;
      if (into) {
        const target = leafSectionOf(doc, into);
        const now = Date.now();
        for (const it of items) {
          if (laid[it.key]) continue;
          const id = placeItem(doc, boardId, it, { sectionId: target.id }, { name: card.name, id: "collection" }, now + placed);
          if (id) {
            laid[it.key] = id;
            placed++;
          }
        }
      }
      if (!fresh.length && !placed) continue;
      m.collections.set(card.id, { ...was, items, laid });
      arrived += fresh.length;
      if (fresh.length) logActivity(doc, { who: card.name, role: "system", text: `gathered ${fresh.length === 1 ? `“${fresh[0].name}”` : `${fresh.length} things`}${placed && into ? `, laid out in ${into.name}` : ""}`, objectId: card.id });
    }
  });
  return arrived;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** gather soon (changes come in bursts: a stage landing writes a character and its card) */
function gatherSoon(boardId: string) {
  if (pending.has(boardId)) return;
  pending.set(
    boardId,
    setTimeout(() => {
      pending.delete(boardId);
      try {
        gather(boardId);
      } catch (e) {
        console.error(`  collections        gathering on ${boardId} failed: ${(e as Error).message}`);
      }
    }, 60),
  );
}

/** follow a board while it's open: a collection there, its wires, or what its sources make changed */
function follow(board: Board) {
  const m = boardMaps(board.doc);
  const has = () => [...m.objects.values()].some((o) => o.kind === "panel" && o.panel === "collection");
  const on = (_e: unknown, tr: Y.Transaction) => {
    if (tr.origin === ORIGIN || !has()) return;
    gatherSoon(board.id);
  };
  m.links.observe(on);
  m.objects.observe(on);
  m.characters.observe(on);
  if (has()) gatherSoon(board.id);
}
onBoardOpen(follow);

/** stop following (tests, shutdown): pending gathers are dropped */
export function stopGathering() {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
}

// ---------- what people and agents do with a collection ----------

/** wait a moment for a section a browser has just made (it arrives over the socket, maybe after the request) */
async function sectionSoon(boardId: string, id: string): Promise<SectionDoc | null> {
  for (let i = 0; i < 30; i++) {
    const sec = boardMaps(getBoard(boardId).doc).sections.get(id);
    if (sec) return sec;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function findSectionSoon(boardId: string, nameOrId: string): Promise<SectionDoc> {
  const m = boardMaps(getBoard(boardId).doc);
  const named = [...m.sections.values()].find((s) => s.name.trim().toLowerCase() === nameOrId.trim().toLowerCase());
  const sec = named ?? (await sectionSoon(boardId, nameOrId));
  if (!sec) throw new HttpError(404, `no section ${nameOrId} on this board`);
  return sec;
}

/**
 * Pipe a collection into a section (or stop: null). Everything it holds is laid there at once, each as a card
 * the section's flow arranges, and what it gathers later follows. Returns how many cards were laid.
 */
export async function layOut(boardId: string, collection: string, section: string | null, by: string): Promise<{ into: string | null; laid: number }> {
  const sec = section ? await findSectionSoon(boardId, section) : null;
  editBoard(boardId, ORIGIN, (doc) => {
    const card = mustCollection(doc, collection);
    const was = collectionOf(doc, collection);
    const m = boardMaps(doc);
    // a new section starts afresh: what was laid elsewhere stays there, and is laid here too
    // a section just made for it ("Section 4") takes the collection's name
    if (sec && /^section\s*\d*$/i.test(sec.name.trim())) m.sections.set(sec.id, { ...sec, name: card.name });
    const next: CollectionState = sec ? { ...was, into: sec.id, laid: was.into === sec.id ? (was.laid ?? {}) : {}, intoBy: by, intoAt: Date.now() } : { items: was.items };
    m.collections.set(collection, next);
    logActivity(doc, { who: by, role: "human", text: sec ? `piped ${card.name} into ${sec.name}` : `stopped laying ${card.name} out${was.into ? ` in ${m.sections.get(was.into)?.name ?? "its section"}` : ""}`, objectId: collection });
  });
  const before = Object.keys(collectionOf(getBoard(boardId).doc, collection).laid ?? {}).length;
  gather(boardId);
  const after = Object.keys(collectionOf(getBoard(boardId).doc, collection).laid ?? {}).length;
  return { into: sec?.id ?? null, laid: after - before };
}

/** a copy of one of a collection's items, as a card in a section: floating where it was let go, or docked */
export async function copyOut(boardId: string, collection: string, key: string, section: string, at: { x?: number; y?: number } | null, actor: { name: string; id: string }): Promise<{ id: string; kind: CollectionItem["kind"] }> {
  const sec = await findSectionSoon(boardId, section);
  return editBoard(boardId, ORIGIN, (doc) => {
    const card = mustCollection(doc, collection);
    const it = collectionOf(doc, collection).items.find((i) => i.key === key);
    if (!it) throw new HttpError(404, `${card.name} has no item ${key}`);
    const target = leafSectionOf(doc, sec);
    const floating = Boolean(at && (at.x !== undefined || at.y !== undefined));
    const id = placeItem(doc, boardId, it, { sectionId: target.id, x: at?.x, y: at?.y, float: floating }, actor);
    if (!id) throw new HttpError(410, `“${it.name}” can't be copied: what it was made from is gone`);
    logActivity(doc, { who: actor.name, role: "human", text: `copied “${it.name}” out of ${card.name} into ${target.name}`, objectId: id });
    return { id, kind: it.kind };
  });
}

/** take an item out of a collection (the cards laid or copied from it stay where they are) */
export function takeOut(boardId: string, collection: string, key: string, by: string): number {
  return editBoard(boardId, ORIGIN, (doc) => {
    const card = mustCollection(doc, collection);
    const was = collectionOf(doc, collection);
    const it = was.items.find((i) => i.key === key);
    if (!it) throw new HttpError(404, `${card.name} has no item ${key}`);
    boardMaps(doc).collections.set(collection, { ...was, items: was.items.filter((i) => i.key !== key) });
    logActivity(doc, { who: by, role: "human", text: `took “${it.name}” out of ${card.name}`, objectId: collection });
    return was.items.length - 1;
  });
}

/** put a picture (an archive file) or a character into a collection by hand */
export function putIn(boardId: string, collection: string, what: { file?: string; character?: string }, by: string): CollectionItem {
  return editBoard(boardId, ORIGIN, (doc) => {
    const card = mustCollection(doc, collection);
    let it: CollectionItem;
    if (what.character) {
      const m = boardMaps(doc);
      const entry = [...m.characters.entries()].find(([pid, c]) => pid === what.character || c.id === what.character);
      const c = entry?.[1] ?? characterById(what.character);
      if (!c) throw new HttpError(404, `no character ${what.character}`);
      it = characterItem(c.id, c, entry?.[0], by);
    } else if (what.file) {
      const f = fileBytesSync(what.file);
      if (!f || !/^image\//.test(f.row.mime)) throw new HttpError(400, "a collection takes pictures (an image file in the archive) or characters");
      it = pictureItem(what.file, f.row.name, by);
    } else throw new HttpError(400, "file or character required");
    const was = collectionOf(doc, collection);
    if (was.items.some((i) => i.key === it.key)) return was.items.find((i) => i.key === it.key)!;
    boardMaps(doc).collections.set(collection, { ...was, items: [...was.items, it] });
    logActivity(doc, { who: by, role: "human", text: `put “${it.name}” into ${card.name}`, objectId: collection });
    return it;
  });
}

/**
 * The Character studio's process as a primitive on any grid: a set's flow (Inspiration → Sheet → Expressions →
 * Views → Mesh avatar → Output, and the 3D lane) laid into a section, with a collection after Output gathering
 * the finished characters. The section is named `Pipeline · <Set>` (what the flow's nodes read their set by,
 * and where a finished character is moved out of into `Characters · <Set>`).
 */
export function addCharacterPipeline(boardId: string, sectionId: string, set: string, by: string): { section: string; collection: string; nodes: number } {
  const name = titled(set.trim().slice(0, 40)) || "Characters";
  return editBoard(boardId, ORIGIN, (doc) => {
    const m = boardMaps(doc);
    const found = m.sections.get(sectionId);
    if (!found) throw new HttpError(404, `no section ${sectionId} on this board`);
    const sec = leafSectionOf(doc, found);
    if ([...m.objects.values()].some((o) => o.sectionId === sec.id && o.kind === "panel" && o.panel === "pipeline" && o.node)) throw new HttpError(409, `${sec.name} already has a pipeline`);
    const named: SectionDoc = { ...sec, name: `Pipeline · ${name}` };
    m.sections.set(sec.id, named);
    const nodes = layFlow(doc, named, name);
    const output = nodes.get("output")!;
    const coll: PanelDoc = { id: uid("pnl"), kind: "panel", panel: "collection", sectionId: sec.id, name: `Collected · ${name}`, x: FLOW_END_X, y: 0, float: true, bornAt: Date.now(), w: COLLECTION_W, h: Math.max(COLLECTION_H, FLOW_H), ports: collectionPorts(), createdBy: by };
    m.objects.set(coll.id, coll);
    const out = output.ports.find((p) => p.dir === "out")!;
    const link: LinkDoc = { id: uid("lnk"), from: { panel: output.id, port: out.id }, to: { panel: coll.id, port: coll.ports.find((p) => p.dir === "in")!.id }, label: out.name, createdBy: by };
    m.links.set(link.id, link);
    m.collections.set(coll.id, { items: [] });
    growForFlow(doc, named, COLLECTION_W + 56);
    logActivity(doc, { who: by, role: "human", text: `laid the character pipeline for ${name} into ${named.name}, with a collection after Output`, objectId: coll.id });
    return { section: sec.id, collection: coll.id, nodes: nodes.size };
  });
}
