/// <reference lib="webworker" />
/**
 * A still's ground, cut away off the main thread (characters/cutout.ts, 2026-11-25): reading the pixels back, the
 * flood and encoding a PNG happen here, once per picture, and the page only shows the result.
 */

import { cutGround } from "./cutoutCore";

export type CutRequest = { id: number; bitmap: ImageBitmap };
export type CutReply = { id: number; blob: Blob | null; width: number; height: number };

const post = (m: CutReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<CutRequest>) => {
  const { id, bitmap } = e.data;
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("no 2d context");
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = g.getImageData(0, 0, width, height);
    if (!cutGround(image.data, width, height)) return post({ id, blob: null, width, height });
    g.putImageData(image, 0, 0);
    post({ id, blob: await canvas.convertToBlob({ type: "image/png" }), width, height });
  } catch {
    // a picture it can't read: the caller keeps the picture as it is
    post({ id, blob: null, width, height });
  }
};
