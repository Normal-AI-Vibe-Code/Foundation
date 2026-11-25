/**
 * A stand-in for Anthropic's API on loopback (ANTHROPIC_BASE_URL points here), so no test reaches the network:
 * the model list (a key it knows, or a federated bearer), the Messages API streaming a little reasoning and a
 * reply, and the workload-identity token exchange. It records what it was sent.
 */

import { createServer, type Server } from "node:http";

export const GOOD_KEY = `sk-ant-api03-${"k".repeat(40)}GOOD`;
export const FED_ACCESS = "fed-access-token-1";

export interface Seen {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export const MODELS = [
  { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-01T00:00:00Z" },
  { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-10-01T00:00:00Z" },
  { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-08-01T00:00:00Z" },
];

export async function startAnthropicStandin(): Promise<{ base: string; seen: Seen[]; server: Server; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* not JSON */
    }
    const path = (req.url ?? "").split("?")[0];
    seen.push({ method: req.method ?? "", path, headers: req.headers, body });
    const key = req.headers["x-api-key"];
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    // SDK 1.x sends an API key as a bearer (API version 2026-10-21); older ones as x-api-key
    const authed = key === GOOD_KEY || bearer === GOOD_KEY || bearer === FED_ACCESS;
    const json = (status: number, o: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "request-id": "req_standin" });
      res.end(JSON.stringify(o));
    };
    if (path === "/v1/oauth/token" && req.method === "POST") {
      const b = body as { grant_type?: string; assertion?: string };
      if (b?.grant_type !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !b.assertion) return json(400, { error: "invalid_request" });
      return json(200, { access_token: FED_ACCESS, token_type: "Bearer", expires_in: 3600 });
    }
    if (!authed) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (path === "/v1/models" && req.method === "GET") return json(200, { data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS[MODELS.length - 1].id });
    if (path === "/v1/messages" && req.method === "POST") {
      const model = (body as { model?: string })?.model ?? "claude-opus-5-5";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": "req_standin" });
      const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: "msg_standin", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
      ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "The person wants a hello. " } });
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "One short sentence will do." } });
      ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } });
      ev("content_block_stop", { index: 0 });
      ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Hello from the stand-in." } });
      ev("content_block_stop", { index: 1 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
      ev("message_stop", {});
      res.end();
      return;
    }
    json(404, { type: "error", error: { type: "not_found_error", message: path } });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, seen, server, close: () => new Promise((ok) => server.close(() => ok())) };
}
