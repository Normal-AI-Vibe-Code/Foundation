/**
 * Foundation server — one process, runs locally for testing:
 *
 *   npm run dev:server      → http://localhost:4410
 *
 * HTTP API under /api, auth under /auth, files under /files, MCP at /mcp,
 * live board sync over WebSocket at /sync/:boardId.
 */

import { createServer, type ServerResponse } from "node:http";
import type { PanelDoc, UserInfo } from "@foundation/protocol";
import { WebSocketServer } from "ws";
import { config } from "./config.ts";
import { one } from "./db.ts";
import { HttpError, json, readJson, Router, sse, type Req } from "./http.ts";
import { clearSession, createSession, googleAuthUrl, googleCallback, isAllowed, requireUser, setSessionCookie, signIn, upsertUser, userFromRequest } from "./auth.ts";
import { boardEpoch, editBoard, ensureBoardRow, getBoard, listBoards, presence } from "./boards.ts";
import { archiveFile, listFiles, reindexFilesIfNeeded, serveFile, uploadFile } from "./files.ts";
import { integrationStatus, searchAll } from "./search.ts";
import { listApps, probeApp, saveApp } from "./apps.ts";
import { parseRepo, repoCommits, repoInfo, repoReadme } from "./github.ts";
import { companySnapshot, connectorEvents, readConnector, watchFactoryForm } from "./connectors.ts";
import { createAsk, listAsks, resolveAsk, startHermes } from "./hermes.ts";
import { getJob, listJobs, startJob } from "./jobs.ts";
import { followRun, listSessions, runtimes, sessionTurns, settleOrphanRuns, startRun, stopAllRuns, stopEveryRun, stopRun } from "./agent.ts";
import { t3Thread, t3Threads } from "./t3.ts";
import { pollHandoffs } from "./vision.ts";
import { boardPeople, boardRole, canWrite, requireWriter, setBoardRole } from "./roles.ts";
import { handleUpgrade, issueTicket } from "./sockets.ts";
import { httpToolCtx, runTool, TOOLS } from "./tools.ts";
import { handleMcp } from "./mcp.ts";
import { seedCompanyBoard } from "./seed.ts";
import { addLine, attachRecording, huddleArchive, huddleForInvite, transcriptText, type NewHuddle } from "./huddles.ts";
import { boardLink, channelHistory, channelInfo, inviteText, listChannels, postMessage, shareText, SlackError, slackStatus } from "./slack.ts";
import { appendSection, boardMaps, huddleStateOf } from "@foundation/protocol";
import { migrateAllBoards } from "./migrate.ts";
import * as flowform from "./flowform.ts";
import { approvePlace, bringFromPlace, listPlace, listPlaces, removePlace } from "./places.ts";
import { beginLink, finishLink, flowformCall, flowformTools, landingPage, linkStatus, unlink } from "./flowformlink.ts";
import { canSeeBoard, hiddenBoards, requireBoard } from "./members.ts";
import { isPerson, requirePerson } from "./auth.ts";
import { startGridLog } from "./gridlog.ts";
import { answerAsk, startMachineAsks } from "./machineasks.ts";
import { createPlanCard, movePlanCard, readPlan, syncPlan, type NewCard } from "./plan.ts";
import { startDigest } from "./digest.ts";
import { engineImages, engineStatus, loadImage, reconcileMachine, removeMachine, restartMachine, startMachine, stopMachine } from "./machines.ts";

// people's grid edits go in the activity log, from the first board loaded
startGridLog();
startMachineAsks();

const r = new Router();

r.get("/api/health", () => ({ ok: true, name: "foundation", at: Date.now() }));

// ---------- auth ----------

r.get("/auth/config", () => ({ google: Boolean(config.google.clientId), devLogin: config.devLogin, flowform: { url: flowform.flowformUrl() } }));
r.get("/api/me", (req) => ({ user: userFromRequest(req) }));
r.post("/auth/dev", async (req, res) => {
  if (!config.devLogin) throw new HttpError(403, "dev login is off");
  const { email, name, bearer } = await readJson<{ email?: string; name?: string; bearer?: boolean }>(req);
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "enter an email");
  if (!isAllowed(email)) throw new HttpError(403, `${email} is not on Foundation's allowlist`);
  const user = upsertUser(email, name ?? "");
  return { user, ...signIn(res, user.id, bearer === true) };
});
r.get("/auth/google/start", (_req, res) => {
  res.writeHead(302, { location: googleAuthUrl() });
  res.end();
});
r.get("/auth/google/callback", async (req, res) => {
  const user = await googleCallback(req.query.get("code") ?? "", req.query.get("state") ?? "");
  setSessionCookie(res, createSession(user.id));
  res.writeHead(302, { location: config.clientUrl });
  res.end();
});
// Google through flowform-server — the flowform client's sign-in (flowform.ts)
r.get("/auth/flowform/start", (req, res) => flowform.startWeb(req, res));
r.post("/auth/flowform/begin", (req) => flowform.beginDesktop(req));
r.get("/auth/flowform/done/:nonce", (req, res) => flowform.done(req, res));
r.post("/auth/flowform/poll", (req, res) => flowform.poll(req, res));
// a person's link to Flowform's boards and files, read-only, through its MCP endpoint (flowformlink.ts)
r.get("/api/flowform/link", (req) => linkStatus(requireUser(req).id));
r.post("/api/flowform/link", (req) => beginLink(requirePerson(req, "Connecting Flowform").id));
r.post("/api/flowform/unlink", async (req) => {
  await unlink(requirePerson(req, "Disconnecting Flowform").id);
  return { ok: true };
});
r.get("/auth/flowform/link/callback", async (req, res) => {
  // Flowform sends the person's browser here. No session is needed: the state names who started it, once
  let ok = true;
  let message = "Your Flowform boards and files can now be opened from Foundation. You can close this window.";
  try {
    const refused = req.query.get("error");
    if (refused) throw new HttpError(400, refused === "access_denied" ? "You didn't approve it on Flowform, so nothing was connected." : `Flowform said: ${req.query.get("error_description") ?? refused}`);
    await finishLink(req.query.get("code") ?? "", req.query.get("state") ?? "");
  } catch (e) {
    ok = false;
    message = e instanceof HttpError ? e.message : "Something went wrong finishing the connection. Try again from Foundation.";
    if (!(e instanceof HttpError)) console.error("flowform link:", (e as Error).message);
  }
  const page = landingPage(ok, message);
  res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(page), "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(page);
});
r.get("/api/flowform/tools", async (req) => ({ tools: await flowformTools(requireUser(req).id) }));
r.post("/api/flowform/tools/:name", async (req) => flowformCall(requireUser(req).id, req.params.name, await readJson(req)));
r.post("/auth/logout", (req, res) => {
  clearSession(req, res);
  return { ok: true };
});
/** a one-time, 30-second ticket for one socket, for a client that can't send its session on a WebSocket (sockets.ts) */
r.post("/api/ws-ticket", async (req) => {
  const { path } = await readJson<{ path?: string }>(req);
  return issueTicket(req, path);
});
/** a bearer for an external agent (Claude Code, Codex, Vision) acting as you */
r.post("/api/agent/token", (req) => {
  const u = requireUser(req);
  return { token: createSession(u.id, 30 * 864e5, "agent"), mcp: `${config.publicUrl}/mcp?board=company` };
});

// ---------- boards ----------

r.get("/api/boards", (req) => {
  const u = requireUser(req);
  return { boards: listBoards().map((b) => ({ ...b, role: boardRole(u.id, b.id) })) };
});
r.get("/api/boards/:id/epoch", (req) => {
  requireUser(req);
  return { epoch: boardEpoch(req.params.id) };
});
r.get("/api/boards/:id/people", (req) => {
  requireUser(req);
  return { people: boardPeople(req.params.id) };
});
// ---------- the plan board (docs/plan.json; Settings → Plan) ----------

r.get("/api/plan", (req) => {
  const u = requireUser(req);
  return { plan: readPlan(), canMove: u.role === "admin" };
});
r.post("/api/plan/cards/:id", async (req) => {
  const u = requirePerson(req, "Moving a card on the plan");
  const { status } = await readJson<{ status?: string }>(req);
  if (!status) throw new HttpError(400, "status (a column id) required");
  return { card: movePlanCard(u, req.params.id, status) };
});
r.post("/api/plan/cards", async (req) => {
  const u = requirePerson(req, "Adding a card to the plan");
  return { card: createPlanCard(u, await readJson<NewCard>(req)) };
});
r.post("/api/plan/sync", async (req) => {
  const u = requirePerson(req, "Syncing the plan with GitHub");
  return syncPlan(u);
});

r.post("/api/boards/:id/people", async (req) => {
  const u = requireUser(req);
  const { userId, role } = await readJson<{ userId?: string; role?: "member" | "viewer" | null }>(req);
  if (!userId || (role !== null && role !== "member" && role !== "viewer")) throw new HttpError(400, "userId and role (member, viewer or null) required");
  setBoardRole(u, req.params.id, userId, role);
  return { people: boardPeople(req.params.id) };
});
r.post("/api/boards", async (req) => {
  requireWriter(requireUser(req));
  const { name } = await readJson<{ name?: string }>(req);
  const id = (name ?? "board").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `board-${Date.now().toString(36)}`;
  ensureBoardRow(id, name ?? id);
  // the server lays the first section, so two people opening a new board at once don't both seed it
  const doc = getBoard(id).doc;
  if (boardMaps(doc).sections.size === 0) editBoard(id, "system", (d) => appendSection(d, "Section 1"));
  return { id };
});
r.get("/api/boards/:id/presence", (req) => {
  requireBoard(requireUser(req), req.params.id);
  return { people: presence(req.params.id) };
});
r.get("/api/boards/:id/tools", () => ({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, write: Boolean(t.write) })) }));
r.post("/api/boards/:id/tools/:name", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  const input = await readJson(req);
  // a person's browser acts as them; a bearer token is an agent acting for them (the activity log says which)
  return { result: await runTool(httpToolCtx(req.params.id, u, isPerson(req)), req.params.name, input) };
});

// ---------- files ----------

r.post("/api/files", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.query.get("board"));
  const file = await uploadFile(req, u.id);
  return { file: { ...file, url: `/files/${file.id}` } };
});
r.get("/api/files", (req) => {
  const u = requireUser(req);
  requireBoard(u, req.query.get("board"));
  const hidden = hiddenBoards(u);
  return { files: listFiles(req.query.get("board")).filter((f) => !(f.board_id && hidden.has(f.board_id))).map((f) => ({ ...f, url: `/files/${f.id}` })) };
});
r.delete("/api/files/:id", (req) => {
  requireFileBoard(requireUser(req), req.params.id);
  archiveFile(req.params.id);
  return { archived: true };
});
r.get("/api/files/:id/cad", async (req) => {
  requireFileBoard(requireUser(req), req.params.id);
  const { cadSummaryForFile } = await import("./cad.ts");
  const s = await cadSummaryForFile(req.params.id);
  if (!s) throw new HttpError(404, "no such file");
  return s;
});
r.get("/files/:id", (req, res) => {
  requireFileBoard(requireUser(req), req.params.id);
  serveFile(req, res, req.params.id);
});

/** a file on a members-only board is that board's */
function requireFileBoard(user: UserInfo, fileId: string) {
  requireBoard(user, one<{ board_id: string | null }>("select board_id from files where id = ?", fileId)?.board_id);
}

// ---------- places: folders on this computer a person approved (places.ts) ----------

r.get("/api/places", (req) => {
  const u = requireUser(req);
  return { places: listPlaces(), canApprove: u.role === "admin" && isPerson(req) };
});
r.post("/api/places", async (req) => ({ place: approvePlace(requireUser(req), isPerson(req), await readJson(req)) }));
r.post("/api/places/:id/remove", async (req) => {
  const { confirm } = await readJson<{ confirm?: boolean }>(req);
  removePlace(requireUser(req), isPerson(req), req.params.id, confirm);
  return { ok: true };
});
r.get("/api/places/:id/list", (req) => {
  requireUser(req);
  return listPlace(req.params.id, req.query.get("dir") ?? "");
});
/** copy one file from a place into the archive for a board (?board=; a viewer of it is refused by the write gate) */
r.post("/api/places/:id/bring", async (req) => {
  const u = requireUser(req);
  const board = req.query.get("board");
  requireBoard(u, board);
  const { path } = await readJson<{ path?: string }>(req);
  if (!path) throw new HttpError(400, "which file?");
  const file = await bringFromPlace(u, req.params.id, path, board);
  return { file: { ...file, url: `/files/${file.id}` } };
});

// ---------- search ----------

r.get("/api/search", async (req) => {
  const u = requireUser(req);
  const q = (req.query.get("q") ?? "").trim();
  if (!q) return { hits: [], sources: {} };
  return searchAll(q, { boardId: req.query.get("board") ?? undefined, remote: req.query.get("remote") !== "0", hidden: hiddenBoards(u) });
});
r.get("/api/integrations", (req) => {
  requireUser(req);
  return { ...integrationStatus(), agent: runtimes() };
});

// ---------- apps, repos, company ----------

r.get("/api/apps", (req) => {
  requireUser(req);
  return { apps: listApps() };
});
r.post("/api/apps", async (req) => {
  const u = requireUser(req);
  const body = await readJson<{ name: string; url?: string; repo?: string; mcp?: string; description?: string }>(req);
  if (!body.name) throw new HttpError(400, "name required");
  return { app: saveApp(body, u.id) };
});
r.post("/api/apps/probe", async (req) => {
  requireUser(req);
  const { url } = await readJson<{ url?: string }>(req);
  if (!url || !/^https?:\/\//.test(url)) throw new HttpError(400, "an http(s) URL");
  return probeApp(url);
});
r.get("/api/repo", async (req) => {
  requireUser(req);
  const repo = parseRepo(req.query.get("repo") ?? "");
  if (!repo) throw new HttpError(400, "owner/name or a GitHub URL");
  const [info, readme, commits] = await Promise.all([repoInfo(repo), repoReadme(repo).catch(() => ""), repoCommits(repo).catch(() => [])]);
  return { info, readme: readme.slice(0, 40_000), commits };
});
r.get("/api/company", async (req) => {
  requireUser(req);
  return companySnapshot(req.query.get("fresh") === "1");
});
/** pushed connector changes (FactoryForm's live stream), so cards refetch at once */
r.get("/api/connectors/events", (req, res) => {
  requireUser(req);
  const send = sse(res);
  const on = (id: string) => send({ id });
  connectorEvents.on("change", on);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  res.on("close", () => {
    clearInterval(ping);
    connectorEvents.off("change", on);
  });
});
r.get("/api/connectors/:id", async (req) => {
  requireUser(req);
  return readConnector(req.params.id, req.query.get("fresh") === "1");
});

// ---------- Hermes asks ----------

r.get("/api/asks", (req) => {
  const u = requireUser(req);
  requireBoard(u, req.query.get("board"));
  const hidden = hiddenBoards(u);
  return { asks: listAsks(req.query.get("board") ?? undefined).filter((a) => !hidden.has(a.board_id)) };
});
r.post("/api/asks", async (req) => {
  const u = requireUser(req);
  const b = await readJson<{ board: string; assignee: string; prompt: string; kind?: string; section?: string }>(req);
  requireBoard(u, b.board);
  return createAsk({ boardId: b.board, actor: u.name, userId: u.id }, { assignee: b.assignee, prompt: b.prompt, kind: b.kind ?? "cad_upload", section: b.section });
});
r.post("/api/asks/:id/resolve", async (req) => {
  const u = requireUser(req);
  const { fileId } = await readJson<{ fileId?: string }>(req);
  requireBoard(u, one<{ board_id: string }>("select board_id from asks where id = ?", req.params.id)?.board_id);
  return resolveAsk(req.params.id, u.name, fileId);
});

// ---------- huddles (video portals; media is peer to peer, see huddles.ts) ----------

function huddleOn(boardId: string, id: string) {
  const o = boardMaps(getBoard(boardId).doc).objects.get(id);
  if (!o || o.kind !== "panel" || o.panel !== "huddle") throw new HttpError(404, "no such huddle");
  return o;
}
r.get("/api/huddles/:id", (req) => {
  const u = requireUser(req);
  const board = req.query.get("board") ?? "company";
  requireBoard(u, board);
  const panel = huddleOn(board, req.params.id);
  return { huddle: { id: panel.id, name: panel.name, channel: panel.channel ?? null, state: huddleStateOf(getBoard(board).doc, panel.id) ?? { people: [] } }, sessions: huddleArchive(board, panel.id) };
});
r.post("/api/huddles/:id/lines", async (req) => {
  const u = requireUser(req);
  const b = await readJson<{ board?: string; text?: string }>(req);
  requireBoard(u, b.board ?? "company");
  try {
    return { line: addLine(b.board ?? "company", req.params.id, u, b.text ?? "", "typed") };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
r.post("/api/huddles/:id/recordings", async (req) => {
  const u = requireUser(req);
  const b = await readJson<{ board?: string; fileId?: string; sessionId?: string; startedAt?: number; endedAt?: number }>(req);
  if (!b.fileId) throw new HttpError(400, "fileId required");
  requireBoard(u, b.board ?? "company");
  try {
    return attachRecording(b.board ?? "company", req.params.id, { fileId: b.fileId, person: u.name, sessionId: b.sessionId, startedAt: b.startedAt ?? Date.now(), endedAt: b.endedAt ?? Date.now() });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

// ---------- Slack channels (bot token; posts go out under the person's name) ----------

async function slackDo<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SlackError) throw new HttpError(e.code === "not_configured" ? 503 : 502, e.message);
    throw e;
  }
}
r.get("/api/slack/status", async (req) => {
  requireUser(req);
  return slackStatus();
});
r.get("/api/slack/channels", (req) => {
  requireUser(req);
  return slackDo(async () => ({ channels: await listChannels() }));
});
r.get("/api/slack/channels/:id", (req) => {
  requireUser(req);
  return slackDo(async () => ({ channel: await channelInfo(req.params.id), messages: await channelHistory(req.params.id, 40, req.query.get("fresh") === "1") }));
});
r.post("/api/slack/channels/:id/messages", async (req) => {
  const u = requireUser(req);
  const b = await readJson<{ text?: string }>(req);
  return slackDo(() => postMessage(req.params.id, b.text ?? "", u));
});
/** send the channel a link to a place on the board */
r.post("/api/slack/channels/:id/share", async (req) => {
  const u = requireUser(req);
  const b = await readJson<{ board?: string; objectId?: string; title?: string; note?: string }>(req);
  const board = b.board ?? "company";
  const text = shareText({ by: u.name, board, objectId: b.objectId, title: b.title || "A place", note: b.note });
  return slackDo(async () => ({ ...(await postMessage(req.params.id, text, u, { board, objectId: b.objectId ?? null })), url: boardLink(board, b.objectId) }));
});
/** invite the channel into a huddle on the board */
r.post("/api/slack/channels/:id/invite", async (req) => {
  const u = requireUser(req);
  const b = await readJson<{ board?: string; huddleId?: string; create?: Omit<NewHuddle, "channel"> }>(req);
  const board = b.board ?? "company";
  requireBoard(u, board);
  // a new huddle is made here, then invited, in one request: no waiting for the card to sync first
  let h: PanelDoc;
  if (b.create) {
    requireWriter(u, board);
    try {
      h = huddleForInvite(board, u, { ...b.create, channel: req.params.id });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  } else h = huddleOn(board, b.huddleId ?? "");
  const text = inviteText({ by: u.name, board, huddleId: h.id, huddleName: h.name, live: huddleStateOf(getBoard(board).doc, h.id)?.people ?? [] });
  return slackDo(async () => ({ ...(await postMessage(req.params.id, text, u, { board, huddle: h.id })), url: boardLink(board, h.id) }));
});
/** hand a huddle session's notes (transcript + recordings) to a channel */
r.post("/api/slack/channels/:id/huddle-notes", async (req) => {
  const u = requireUser(req);
  const b = await readJson<{ board?: string; huddleId?: string; sessionId?: string; summary?: string }>(req);
  const board = b.board ?? "company";
  const h = huddleOn(board, b.huddleId ?? "");
  const s = huddleArchive(board, h.id).find((x) => x.id === b.sessionId) ?? huddleArchive(board, h.id)[0];
  if (!s) throw new HttpError(404, "that huddle hasn't met yet");
  const lines = transcriptText(s).split("\n");
  const excerpt = lines.slice(0, 40).join("\n") + (lines.length > 40 ? `\n… ${lines.length - 40} more lines on Foundation` : "");
  const text = `${b.summary ? `${b.summary.trim()}\n\n` : ""}\`\`\`${excerpt}\`\`\`\n<${boardLink(board, h.id)}|The full huddle archive on Foundation>`;
  return slackDo(() => postMessage(req.params.id, text, u, { board, huddle: h.id, session: s.id }));
});

// ---------- jobs ----------

r.get("/api/jobs", (req) => {
  const hidden = hiddenBoards(requireUser(req));
  return { jobs: listJobs().filter((j) => !(j.board_id && hidden.has(j.board_id))) };
});
r.get("/api/jobs/:id", (req) => {
  const u = requireUser(req);
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, "no such job");
  requireBoard(u, job.board_id);
  return { job };
});
r.post("/api/jobs/:id/run", (req) => {
  const u = requireUser(req);
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, "no such job");
  requireBoard(u, job.board_id);
  return { job: startJob(job.id, job.board_id ?? "company", u.name) };
});

// ---------- machines (Kiri or Docker, through the Engine API) ----------

r.get("/api/machines/engines", async (req) => {
  requireUser(req);
  return { engines: await engineStatus(req.query.get("fresh") === "1") };
});
r.get("/api/machines/images", async (req) => {
  requireUser(req);
  return engineImages(req.query.get("engine") ?? undefined);
});
// a card on screen asks: the server reads the engine and writes what's true to the board
r.get("/api/boards/:id/machines/:panel", async (req) => {
  requireBoard(requireUser(req), req.params.id);
  return reconcileMachine(req.params.id, req.params.panel);
});
// everything that runs, stops or removes needs a person at a browser (gateWrites has already refused viewers)
r.post("/api/boards/:id/machines/:panel/start", async (req) => {
  const u = requirePerson(req, "Starting a machine");
  requireBoard(u, req.params.id);
  const b = await readJson<{ image?: string; engine?: string; ports?: number[] }>(req);
  return { machine: await startMachine(req.params.id, req.params.panel, u.name, b) };
});
r.post("/api/boards/:id/machines/:panel/stop", async (req) => {
  const u = requirePerson(req, "Stopping a machine");
  requireBoard(u, req.params.id);
  return { machine: await stopMachine(req.params.id, req.params.panel, u.name) };
});
r.post("/api/boards/:id/machines/:panel/restart", async (req) => {
  const u = requirePerson(req, "Restarting a machine");
  requireBoard(u, req.params.id);
  return { machine: await restartMachine(req.params.id, req.params.panel, u.name) };
});
r.post("/api/boards/:id/machines/:panel/remove", async (req) => {
  const u = requirePerson(req, "Removing a machine");
  requireBoard(u, req.params.id);
  const b = await readJson<{ confirm?: boolean }>(req);
  return { machine: await removeMachine(req.params.id, req.params.panel, u.name, b.confirm === true) };
});
// an agent's command waiting on a machine's card: only a person at a browser, who can edit the board, answers it
r.post("/api/boards/:id/machines/:panel/asks/:ask/:verdict", async (req) => {
  const verdict = req.params.verdict;
  if (verdict !== "run" && verdict !== "decline") throw new HttpError(404, "run or decline");
  const u = requirePerson(req, verdict === "run" ? "Running an agent's command" : "Declining an agent's command");
  requireBoard(u, req.params.id);
  return { ask: answerAsk(req.params.id, req.params.panel, req.params.ask, u, verdict) };
});
r.post("/api/boards/:id/machines/load", async (req) => {
  const u = requirePerson(req, "Loading an image into an engine");
  requireBoard(u, req.params.id);
  const b = await readJson<{ fileId?: string; engine?: string }>(req);
  if (!b.fileId) throw new HttpError(400, "name the file to load");
  return loadImage(req.params.id, b.fileId, u.name, b.engine);
});

// ---------- agent ----------

r.get("/api/agent/runtimes", (req) => {
  requireUser(req);
  return runtimes();
});
r.get("/api/agent/sessions", (req) => {
  const user = requireUser(req);
  return { sessions: listSessions(req.query.get("board") || "company", user.id) };
});
r.get("/api/agent/sessions/:id", (req) => {
  const user = requireUser(req);
  return { turns: sessionTurns(req.params.id, user.id) };
});

// ---------- Vision Code (T3) sessions, read-only ----------

r.get("/api/t3/threads", async (req) => {
  requireUser(req);
  return t3Threads();
});
r.get("/api/t3/threads/:id", async (req) => {
  requireUser(req);
  const t = await t3Thread(req.params.id);
  if (!t) throw new HttpError(404, "no such Vision Code thread");
  return t;
});

r.post("/api/agent", async (req, res) => {
  const user = requireUser(req);
  const body = await readJson<{ board?: string; prompt?: string; runtime?: string; session?: string }>(req);
  if (!body.prompt?.trim()) throw new HttpError(400, "say something");
  requireBoard(user, body.board || "company");
  const send = sse(res);
  const session = body.session && /^ses_[a-z0-9]{6,24}$/.test(body.session) ? body.session : undefined;
  // the run lives on the server: closing this stream detaches, it doesn't stop it
  const r = startRun({ boardId: body.board || "company", user, prompt: body.prompt, runtime: body.runtime, session });
  await new Promise<void>((done) => {
    const detach = followRun(r.id, user.id, send, done);
    res.on("close", () => (detach?.(), done()));
  });
  res.end();
});
r.get("/api/agent/runs/:id/events", async (req, res) => {
  const user = requireUser(req);
  const send = sse(res);
  await new Promise<void>((done) => {
    const detach = followRun(req.params.id, user.id, send, done);
    if (!detach) return done(); // finished long ago (or not yours): the transcript has it
    res.on("close", () => (detach(), done()));
  });
  res.end();
});
r.post("/api/agent/runs/stop-all", async (req) => {
  const user = requireUser(req);
  const { board } = await readJson<{ board?: string }>(req);
  if (!board) throw new HttpError(400, "board required");
  return { stopped: stopAllRuns(board, user.id) };
});
r.post("/api/agent/runs/:id/stop", (req) => {
  const user = requireUser(req);
  return { stopped: stopRun(req.params.id, user.id) };
});

// ---------- view only ----------

/**
 * Viewers don't write. Any non-GET under /api is a write except these: the
 * agent (its tools check per call, so a viewer can still ask it things),
 * stopping your own run, an MCP token (its tools check too), board tools
 * (runTool checks), setting roles (admins only), and a socket ticket (a
 * viewer's sync socket is read-only either way). The board is the
 * route's :id, or ?board=, else the person's account role decides.
 */
const READ_POSTS = [/^\/api\/agent$/, /^\/api\/agent\/runs\/[^/]+\/stop$/, /^\/api\/agent\/token$/, /^\/api\/boards\/[^/]+\/tools\//, /^\/api\/boards\/[^/]+\/people$/, /^\/api\/apps\/probe$/, /^\/api\/ws-ticket$/, /^\/api\/flowform\//];
function gateWrites(req: Req, path: string) {
  if (req.method === "GET" || req.method === "OPTIONS" || !path.startsWith("/api/")) return;
  if (READ_POSTS.some((p) => p.test(path))) return;
  const user = userFromRequest(req);
  if (!user) return; // the route's own requireUser answers 401
  const board = /^\/api\/boards\/([^/]+)/.exec(path)?.[1] ?? req.query.get("board");
  requireWriter(user, board);
}

// ---------- server ----------

function corsAllowed(origin: string) {
  return origin === config.clientUrl || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) || origin === "tauri://localhost" || config.corsOrigins.includes(origin);
}

const server = createServer(async (rawReq, res: ServerResponse) => {
  const req = rawReq as Req;
  const url = new URL(req.url ?? "/", "http://local");
  req.query = url.searchParams;
  // the client on its own port (dev), the desktop app's page (http://localhost:31440, tauri://localhost) and
  // FOUNDATION_CORS_ORIGINS. The app on a hosted server sends a bearer (Authorization), so preflights are kept 10 minutes
  const origin = req.headers.origin;
  if (origin && corsAllowed(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", "content-type, authorization, range, mcp-session-id, mcp-protocol-version");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-max-age", "600");
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (url.pathname === "/mcp") {
      const user = userFromRequest(req);
      if (!user) throw new HttpError(401, "MCP needs a bearer token (POST /api/agent/token)");
      requireBoard(user, req.query.get("board") || "company");
      return await handleMcp(req, res, user);
    }
    const m = r.match(req.method ?? "GET", url.pathname);
    if (!m) throw new HttpError(404, "not found");
    req.params = m.params;
    gateWrites(req, url.pathname);
    const out = await m.handler(req, res);
    if (!res.headersSent && out !== undefined) json(res, out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, { error: (e as Error).message }, status);
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
// every socket (sync, huddles, a machine's terminal) and how it proves who opens it: sockets.ts
server.on("upgrade", (req, socket, head) => handleUpgrade(wss, req, socket, head));

reindexFilesIfNeeded();
watchFactoryForm();
// the Vision loop: bring back what hand-off threads export, and ask the reviewers once they have
setInterval(() => {
  void pollHandoffs((h, reviewer) => {
    const section = h.section_id ? boardMaps(getBoard(h.board_id).doc).sections.get(h.section_id)?.name : undefined;
    createAsk({ boardId: h.board_id, actor: "Vision Code", userId: h.created_by }, { assignee: reviewer, prompt: `Review what Vision made for “${h.title}”`, kind: "review", section });
  });
}, 4000).unref();
seedCompanyBoard();
migrateAllBoards();
settleOrphanRuns();
startHermes();
startDigest();

// Started by the desktop app (src-tauri/src/server.rs), the server lives exactly as long as the app:
// the app holds the other end of stdin, and however the app ends (quit, crash, Task Manager) that
// pipe closes. Stop the agents' child processes, then go.
if (process.env.FOUNDATION_EXIT_WITH_PARENT === "1") {
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    try {
      stopEveryRun();
    } catch {
      /* going anyway */
    }
    server.close();
    setTimeout(() => process.exit(0), 150).unref();
  };
  process.stdin.on("end", leave).on("close", leave).on("error", leave);
  process.stdin.resume();
}

server.on("error", (e: NodeJS.ErrnoException) => {
  // one plain line: the desktop app shows it to the person and keeps it in its log
  const taken = e.code === "EADDRINUSE" || e.code === "EACCES";
  console.error(taken ? `Foundation's server can't listen on ${config.host}:${config.port} (${e.code}): another program holds that port, or Windows has reserved it.` : `Foundation's server stopped: ${e.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const rt = runtimes();
  console.log(`\n  Foundation server  ${config.publicUrl}`);
  console.log(`  data               ${config.dataDir}`);
  console.log(`  sign-in            ${config.google.clientId ? "Google" : ""}${config.google.clientId && config.devLogin ? " + " : ""}${config.devLogin ? "dev login" : ""}`);
  console.log(`  agent              ${rt.subscription ? "Claude Code (subscription)" : rt.subscriptionNote ? `— (${rt.subscriptionNote.split("\n")[0]})` : "—"}${rt.api ? ` · API (${rt.model})` : ""}`);
  console.log(`  MCP                ${config.publicUrl}/mcp?board=company\n`);
});
