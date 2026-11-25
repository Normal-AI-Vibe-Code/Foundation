/**
 * The server tests' stand-in Anthropic (apps/server/test/anthropic-standin.ts), on a fixed port for the e2e server
 * (ANTHROPIC_BASE_URL points here, playwright.config.ts): the API-key way is checked end to end through the real
 * routes, and nothing reaches the network or spends anything.
 *
 *   npx tsx e2e/anthropic-standin-serve.ts <port>   (from apps/client)
 *   GET /_seen   what it was asked, in order: method, path, and whether it carried the stand-in's good key (never the key)
 */

import { createServer, request } from "node:http";
import { startAnthropicStandin, GOOD_KEY } from "../../server/test/anthropic-standin.ts";

const port = Number(process.argv[2] ?? 4437);
const inner = await startAnthropicStandin();
const target = new URL(inner.base);

createServer((req, res) => {
  if (req.url === "/_seen") {
    const seen = inner.seen.map((s) => ({
      method: s.method,
      path: s.path,
      withKey: s.headers["x-api-key"] === GOOD_KEY || String(s.headers.authorization ?? "") === `Bearer ${GOOD_KEY}`,
      keyInPath: s.path.includes(GOOD_KEY),
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(seen));
    return;
  }
  // everything else is the stand-in's own answer, streamed through as it comes
  const out = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  out.on("error", () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(out);
}).listen(port, "127.0.0.1", () => console.log(`anthropic stand-in on http://127.0.0.1:${port}`));
