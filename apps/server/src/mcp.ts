/**
 * Foundation as an MCP server (streamable HTTP, stateless) at /mcp?board=<id>.
 * Claude Code, Codex, Vision's agent — any MCP client — gets the same board
 * tools the built-in agent uses. Auth: a session bearer (the person the agent
 * acts for) or the service token.
 *
 *   claude mcp add foundation --transport http http://localhost:4410/mcp?board=company \
 *     --header "Authorization: Bearer <token from Settings → Agents>"
 */

import type { ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { z } from "zod";
import { TOOLS, runTool, toolContent } from "./tools.ts";
import { readBody, type Req } from "./http.ts";
import type { UserInfo } from "@foundation/protocol";
import { crewMember } from "./crew.ts";

/** a Foundation run's MCP calls name their crew member; it only counts for its own person and board */
export function crewFor(crewId: string | undefined, user: UserInfo, boardId: string) {
  const member = crewMember(crewId);
  return member && member.userId === user.id && member.boardId === boardId ? member : undefined;
}

function buildServer(boardId: string, user: UserInfo, crewId?: string) {
  const crew = crewFor(crewId, user, boardId);
  const server = new McpServer({ name: "foundation", version: "0.1.0" });
  for (const t of TOOLS) {
    const shape = (t.schema as z.ZodObject<z.ZodRawShape>).shape;
    server.registerTool(t.name, { description: t.description, inputSchema: shape }, async (args: unknown) => {
      try {
        const actor = crew ? crew.name : user.id === "agent" ? "Agent (MCP)" : `${user.name}'s agent`;
        const out = await runTool({ boardId, actor, userId: user.id, crew: crew?.id, door: "mcp" }, t.name, args);
        // a picture in the result (a machine's screen) goes to the model as a picture, the rest as text
        const { text, image } = toolContent(out);
        return { content: [...(image ? [{ type: "image" as const, data: image.base64, mimeType: image.mime }] : []), { type: "text" as const, text }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
      }
    });
  }
  return server;
}

export async function handleMcp(req: Req, res: ServerResponse, user: UserInfo) {
  const boardId = req.query.get("board") || "company";
  const server = buildServer(boardId, user, req.query.get("crew") ?? undefined);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  let body: unknown;
  if (req.method === "POST") {
    const raw = await readBody(req, 8 * 1024 * 1024);
    body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  }
  await transport.handleRequest(req, res, body);
}
