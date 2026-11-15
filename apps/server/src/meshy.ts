/**
 * Meshy (api.meshy.ai): the provider behind the character pipeline. Images
 * (image-to-image), models (multi-image-to-3d), skeletons (rigging) and clips
 * (animations) are all tasks: create one, then ask after it until it settles.
 *
 * Off until MESHY_API_KEY is set. Everything here spends credits except
 * `balance`, `task` and `download`, so only characters.ts calls `create`,
 * and only from a person's press.
 *
 * Learned in WildChild (tools/meshy_task.mjs): send images inline as data
 * URIs; download only from Meshy's own hosts; keep the key out of every
 * message.
 */

export type MeshyEndpoint = "text-to-image" | "image-to-image" | "multi-image-to-3d" | "image-to-3d" | "rigging" | "animations";

export interface MeshyTask {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED" | "EXPIRED";
  progress?: number;
  consumed_credits?: number;
  task_error?: { message?: string } | null;
  image_urls?: string[];
  model_urls?: Record<string, string>;
  thumbnail_url?: string;
  thumbnail_urls?: Record<string, string>;
  result?: {
    rigged_character_glb_url?: string;
    animation_glb_url?: string;
    basic_animations?: Record<string, string> | null;
  };
}

export class MeshyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const key = () => (process.env.MESHY_API_KEY ?? "").trim();
// read at call time, so a test can stand in for Meshy
const base = () => (process.env.MESHY_API_BASE ?? "https://api.meshy.ai/openapi/v1").replace(/\/$/, "");

export const meshyConfigured = () => key().length > 0;

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!meshyConfigured()) throw new MeshyError(503, "Meshy isn't connected: set MESHY_API_KEY in Foundation's .env");
  let res: Response;
  try {
    res = await fetch(`${base()}/${path}`, {
      method,
      headers: { authorization: `Bearer ${key()}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new MeshyError(502, `Meshy didn't answer (${(e as Error).message.replaceAll(key(), "[redacted]")})`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 300) };
  }
  if (!res.ok) {
    const said = (data as { message?: string }).message ?? text.slice(0, 300);
    const why = res.status === 402 ? "not enough credits, or this model needs a higher plan" : res.status === 429 ? "too many tasks at once" : said;
    throw new MeshyError(res.status, `Meshy refused (${res.status}): ${String(why).replaceAll(key(), "[redacted]")}`);
  }
  return data as T;
}

export async function meshyBalance(): Promise<number> {
  return (await call<{ balance: number }>("GET", "balance")).balance;
}

/** start a task; this is the call that spends credits */
export async function meshyCreate(endpoint: MeshyEndpoint, request: Record<string, unknown>): Promise<string> {
  const out = await call<{ result?: string }>("POST", endpoint, request);
  if (!out.result) throw new MeshyError(502, "Meshy accepted the task but gave no id");
  return out.result;
}

export const meshyTask = (endpoint: MeshyEndpoint, id: string) => call<MeshyTask>("GET", `${endpoint}/${encodeURIComponent(id)}`);

const DOWNLOAD_EXT = /\.(glb|png|jpe?g|webp)$/i;

/** fetch a result's bytes: Meshy's own hosts only (or the stand-in's), and only the kinds the pipeline keeps */
export async function meshyDownload(url: string): Promise<{ body: Buffer; ext: string }> {
  const u = new URL(url);
  const own = u.hostname === "meshy.ai" || u.hostname.endsWith(".meshy.ai") || u.origin === new URL(base()).origin;
  const ext = DOWNLOAD_EXT.exec(u.pathname)?.[1].toLowerCase();
  if (!own || !ext) throw new MeshyError(502, "Meshy pointed at a file Foundation won't fetch (not its own host, or not a model or image)");
  const res = await fetch(u, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new MeshyError(502, `Meshy's file didn't download (${res.status})`);
  return { body: Buffer.from(await res.arrayBuffer()), ext: ext === "jpeg" ? "jpg" : ext };
}

export const dataUri = (mime: string, body: Buffer) => `data:${mime};base64,${body.toString("base64")}`;
