// A stand-in for Google's sign-in, for checking a hosted Foundation without a real Google client
// (GOOGLE_ACCOUNTS_BASE / GOOGLE_OAUTH_BASE / GOOGLE_USERINFO_URL point the server here).
//   GET  /o/oauth2/v2/auth   an account chooser; a choice goes back to redirect_uri with ?code=&state=
//   POST /token              a code for an access token (the client secret is checked)
//   GET  /userinfo           who that token is
import { createServer } from "node:http";

const PORT = Number(process.env.STANDIN_PORT ?? 15700);
const people = {
  ada: { email: "ada@formindustries.co", email_verified: true, name: "Ada Lovelace" },
  kai: { email: "kai@formindustries.co", email_verified: true, name: "Kai Moreno" },
  outsider: { email: "someone@gmail.com", email_verified: true, name: "Someone Else" },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/o/oauth2/v2/auth") {
    const back = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const links = Object.entries(people)
      .map(([k, p]) => `<p><a data-account="${k}" href="${esc(`${back}?code=code-${k}&state=${encodeURIComponent(state)}`)}">${esc(p.name)} · ${esc(p.email)}</a></p>`)
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><title>Stand-in Google</title><body style="font:16px system-ui;padding:40px"><h1>Choose an account</h1><p>(a stand-in for Google, for this check)</p>${links}</body>`);
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const who = (form.get("code") ?? "").replace(/^code-/, "");
      if (!people[who] || form.get("client_secret") !== "check-secret") return res.writeHead(400, { "content-type": "application/json" }).end("{}");
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `at-${who}` }));
    }
    const who = people[(req.headers.authorization ?? "").replace(/^Bearer at-/, "")];
    if (url.pathname === "/userinfo" && who) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(who));
    res.writeHead(404).end();
  });
}).listen(PORT, "0.0.0.0", () => console.log(`stand-in Google on :${PORT}`));
