/**
 * A 3D character's still: the model itself, drawn once and kept (2026-11-25).
 *
 * A card at rest used to show the character's drawn sheet, and the model only while it played: a different picture,
 * so going live was a swap, and every card on screen played so that the model was seen at all. Now the model is
 * drawn once, standing in the first frame of its idle clip, on a clear ground with the stage's own lights and camera
 * (actor.ts), and that picture is kept in the image cache, in memory and between launches, under the clips file's id,
 * the framing and the size (stagePolicy.ts modelStillParts): a new model is a new picture, and the old one is never
 * asked for again. The ground is clear and the lights are the stage's, so the picture is the same by day and at
 * night: the room's theme isn't part of its key.
 *
 * Because the still and the live character are the same model in the same pose under the same camera, a card going
 * live is a cross-fade between two pictures that agree (Avatar.tsx, council.css).
 *
 * Drawing one costs a model's download (kept between launches: roster.ts characterBytes), its parse and one frame.
 * So they are drawn one at a time, only for cards that have come near, and only while the camera is calm
 * (lib/calm.ts); one renderer serves them all and is let go a few seconds after the last.
 */

import { useEffect, useState } from "react";
import { whenCalm } from "../lib/calm";
import { derivedImageSrc, loadDerivedImage, peekExactImage, retainCachedImage, type CachedImageEntry, type DerivedImage } from "../lib/imageCache";
import type { Framing } from "./actor";
import { characterBytes, type RosterCharacter } from "./roster";
import { MODEL_STILL_SIZE, modelStillParts } from "./stagePolicy";

/** the image cache's name for a model's still */
export const modelStillSrc = (characterId: string, clipsFile: string, framing: Framing, size = MODEL_STILL_SIZE) => derivedImageSrc("model-still", modelStillParts(characterId, clipsFile, framing, size));

// ---------- the one renderer ----------

type Studio = { canvas: HTMLCanvasElement; renderer: import("three").WebGLRenderer };
let studio: Studio | null = null;
let letGo = 0;
let drawing: Promise<unknown> = Promise.resolve();
/** stills drawn this page (not read from the cache), for the checks */
let drawn = 0;
export const modelStillsDrawn = () => drawn;

async function draw(bytes: ArrayBuffer, framing: Framing, size: number): Promise<Blob | null> {
  const [THREE, { Actor }] = await Promise.all([import("three"), import("./actor")]);
  window.clearTimeout(letGo);
  if (!studio) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    // the picture is read back after the frame: the buffer has to still be there
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    studio = { canvas, renderer };
  }
  const { canvas, renderer } = studio;
  const actor = new Actor();
  try {
    renderer.setSize(size, size, false);
    actor.setFraming(framing, true);
    await actor.load(bytes);
    if (!actor.loaded) return null;
    actor.update(0, 1);
    // shaders compiled off the frame where the browser can (KHR_parallel_shader_compile), so the one frame is short
    await renderer.compileAsync(actor.scene, actor.camera).catch(() => {});
    renderer.setViewport(0, 0, size, size);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.render(actor.scene, actor.camera);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (blob) drawn++;
    return blob;
  } finally {
    actor.dispose();
    // the renderer waits a little for the next still, then gives its context back
    letGo = window.setTimeout(() => {
      studio?.renderer.dispose();
      studio?.renderer.forceContextLoss();
      studio = null;
    }, 4000);
  }
}

/** one at a time, each once the camera is calm */
function drawInTurn(character: Pick<RosterCharacter, "id">, clipsFile: string, framing: Framing, size: number): Promise<DerivedImage | null> {
  const run = drawing.then(async () => {
    await new Promise<void>((calm) => whenCalm(calm));
    try {
      const bytes = await characterBytes(character.id, "clips", clipsFile);
      const blob = await draw(bytes, framing, size);
      return blob ? ({ blob, width: size, natural: [size, size], alpha: true } satisfies DerivedImage) : null;
    } catch {
      return null; // no WebGL, or a model that didn't load: the card keeps its drawn picture
    }
  });
  drawing = run.catch(() => null);
  return run;
}

/** a model's still from the cache, or drawn now and kept; null where it can't be drawn */
export function modelStill(character: Pick<RosterCharacter, "id">, clipsFile: string, framing: Framing, size = MODEL_STILL_SIZE): Promise<CachedImageEntry | null> {
  return loadDerivedImage(modelStillSrc(character.id, clipsFile, framing, size), () => drawInTurn(character, clipsFile, framing, size));
}

/**
 * The address of a model's still for an <img>, once there is one. In memory: there on the first frame (`instant`).
 * `enabled` false: only what's already in memory is shown (a card that hasn't come near draws nothing).
 */
export function useModelStill(character: Pick<RosterCharacter, "id"> | undefined, clipsFile: string | undefined, framing: Framing, enabled = true): { url: string | undefined; instant: boolean } {
  const src = character && clipsFile ? modelStillSrc(character.id, clipsFile, framing) : null;
  const hit = src ? peekExactImage(src, "orig") : null;
  const [out, setOut] = useState<{ of: string; url: string; instant: boolean } | null>(null);
  const id = character?.id;
  useEffect(() => {
    if (!src || !id || !clipsFile) return;
    let live = true;
    let release: (() => void) | null = null;
    const take = (entry: CachedImageEntry, instant: boolean) => {
      if (!live) return;
      release?.();
      release = retainCachedImage(entry.key);
      setOut({ of: src, url: entry.url, instant });
    };
    const have = peekExactImage(src, "orig");
    if (have) take(have, true);
    else if (enabled) void modelStill({ id }, clipsFile, framing).then((entry) => entry && take(entry, false));
    return () => {
      live = false;
      release?.();
    };
  }, [src, id, clipsFile, framing, enabled]);
  if (out && out.of === src) return { url: out.url, instant: out.instant };
  return { url: hit?.url, instant: true };
}
