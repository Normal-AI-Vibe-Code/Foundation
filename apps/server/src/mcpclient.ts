/**
 * Talk to the MCP servers that apps on the board expose (streamable HTTP),
 * so an agent — or a wire on the grid — can list an app's tools and call them.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function withClient<T>(url: string, headers: Record<string, string>, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "foundation", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function listMcpTools(url: string, headers: Record<string, string> = {}) {
  return withClient(url, headers, async (c) => {
    const { tools } = await c.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
  });
}

export async function callMcpTool(url: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  return withClient(url, headers, async (c) => {
    const result = await c.callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
    const text = content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
    return { isError: Boolean(result.isError), text, structured: result.structuredContent };
  });
}
