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
import { HttpError, json, parseCookies, readJson, Router, sse, type Req } from "./http.ts";
import { AGENT_TOKEN_DAYS, clearSession, createSession, devSignInRefusal, GOOGLE_STATE_COOKIE, googleCallback, googleStart, isAllowed, requireUser, setSessionCookie, signIn, upsertUser, userFromRequest } from "./auth.ts";
import { SPACE_KINDS, boardEpoch, cleanFolder, cleanPageUrl, createBoardRow, editBoard, ensureBoardRow, getBoard, listBoards, presence, setBoardParent, updateBoardRow, type SpaceKind } from "./boards.ts";
import { archiveFile, listFiles, reindexFilesIfNeeded, requireFileVisible, serveFile, uploadFile } from "./files.ts";
import { integrationStatus, searchAll } from "./search.ts";
import { listApps, probeApp, saveApp } from "./apps.ts";
import { checkRepo, repoCommits, repoInfo, repoReadme } from "./github.ts";
import { companySnapshot, connectorEvents, readConnector, watchFactoryForm } from "./connectors.ts";
import { createAsk, listAsks, resolveAsk, startHermes } from "./hermes.ts";
import { getJob, jobShown, listJobs, startJob } from "./jobs.ts";
import { followRun, listSessions, pickRuntime, runtimes, sessionTurns, settleOrphanRuns, startRun, stopAllRuns, stopEveryRun, stopRun } from "./agent.ts";
import { t3Thread, t3Threads } from "./t3.ts";
import { hostTerminals, requestHostTerminal } from "./hostterm.ts";
import { changelog } from "./changelog.ts";
import { addT3Agent, enableT3Agent, localModels, removeT3Agent, startT3, stopT3, T3_PRESETS, t3Host, t3HostRunning, t3OpenLink, type AddAgentInput } from "./t3host.ts";
import { askT3, stopT3Thread, t3Bindings } from "./t3threads.ts";
import { pollHandoffs } from "./vision.ts";
import { boardPeople, boardRole, canWrite, requireWriter, setBoardRole } from "./roles.ts";
import { handleUpgrade, issueTicket } from "./sockets.ts";
import { SERVER_VERSION, minClient, requireCurrentClient } from "./clientversion.ts";
import { httpToolCtx, runTool, TOOLS } from "./tools.ts";
import { handleMcp } from "./mcp.ts";
import { seedCompanyBoard } from "./seed.ts";
import { addLine, attachRecording, huddleArchive, huddleForInvite, transcriptText, type NewHuddle } from "./huddles.ts";
import { boardLink, channelHistory, channelInfo, inviteText, listChannels, postMessage, shareText, SlackError, slackStatus } from "./slack.ts";
import { appendSection, boardMaps, huddleStateOf } from "@foundation/protocol";
import { migrateAllBoards } from "./migrate.ts";
import { saveCompanyGoal, saveGoal, setProfile, todayFor, type CompanyGoalInput, type GoalInput } from "./today.ts";
import * as flowform from "./flowform.ts";
import { approvePlace, bringFromPlace, listPlace, listPlaces, removePlace } from "./places.ts";
import { beginLink, finishLink, flowformCall, flowformTools, landingPage, linkStatus, unlink } from "./flowformlink.ts";
import { boardRole as memberRole, canSeeBoard, hiddenBoards, requireBoard } from "./members.ts";
import { boardIdFor } from "./flowform-import.ts";
import { bringFlowformFile, listRooms as listFlowformRooms, liveRooms, pullRoom, roomFiles, startFlowformSync } from "./flowform-live.ts";
import { beginGrant, downloadsStatus, dropSession, fileThumb } from "./flowformfiles.ts";
import { isPerson, requirePerson } from "./auth.ts";
import { isSystemGridKey, openSystemGrid } from "./systemgrids.ts";
import { availableAgents, postAgent, unpostAgent } from "./posted.ts";
import { startGridLog } from "./gridlog.ts";
import { answerAsk, startMachineAsks } from "./machineasks.ts";
import { answerAppToolAsk } from "./apptools.ts";
import { createPlanCard, movePlanCard, readPlan, syncPlan, type NewCard } from "./plan.ts";
import { startDigest } from "./digest.ts";
import { boardHasChannel, buildSlackBoard, fromBridge, joinFor, setAgents, setCurator, slackLiveStatus, startSlackLive, syncChannel, type BridgeMessage } from "./slacklive.ts";
import { addInspiration, attachMavatar, characterFile, characterTasks, costs as characterCosts, createCharacter, editCharacter, bringInStarter, openStudio, resumeCharacters, roster, setAvatar, startStage, type NewCharacter, setApproval } from "./characters.ts";
import { CHARACTER_STAGES, type CharacterStageKey } from "@foundation/protocol";
import { readBody } from "./http.ts";
import { engineImages, engineStatus, loadImage, machineSeen, removeMachine, restartMachine, startMachine, stopMachine } from "./machines.ts";
import { addDesktop, setAgentsMay, stopDesktopInstall } from "./machinedesktop.ts";
import { startMachineIo, tryOut } from "./machineio.ts";
import { prefsOf, setPref } from "./prefs.ts";
import { cookieOriginRefusal, hostRefusal, originAllowed } from "./origins.ts";
import { gridOutline } from "./subgrids.ts";
import { audit, callScope, readAudit, verifyAudit } from "./audit.ts";
import { egressState, routeScope, serviceKind, setAllowance } from "./egress.ts";

// people's grid edits go in the activity log, from the first board loaded
startGridLog();
startFlowformSync();
startMachineAsks();
startMachineIo();
// the Slack board: read in turn while the Slack app is quiet; its agents are ordinary crew runs
startSlackLive();
setCurator((o) => startRun(o));

const r = new Router();

r.get("/api/health", () => ({ ok: true, name: "foundation", at: Date.now() }));

// ---------- auth ----------

// public: also what this server is, and the oldest client it still works with (clientversion.ts)
r.get("/auth/config", () => ({ google: Boolean(config.google.clientId), devLogin: config.devLogin, flowform: { url: flowform.flowformUrl() }, version: SERVER_VERSION, minClient: minClient() || null }));
r.get("/api/me", (req) => ({ user: userFromRequest(req) }));
/** what on this computer has a shell now, if anything: dev sign-in waits until it stops (auth.ts devSignInRefusal) */
function shellRunning(): string | false {
  if (t3HostRunning()) return "T3";
  if (hostTerminals() > 0) return "the built-in terminal";
  if (one("select 1 from jobs where status = 'running' and kind = 'rea' limit 1")) return "a REA job (it can run Claude Code)";
  return false;
}
r.post("/auth/dev", async (req, res) => {
  // off unless FOUNDATION_DEV_LOGIN=1; then only from this computer, with an allowlist, while nothing here has a shell (ADR-001 G0)
  const refused = devSignInRefusal(req, shellRunning());
  if (refused) throw new HttpError(403, refused);
  // a page elsewhere can't sign this browser in as someone (login CSRF): a browser always says which page a POST comes from
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(String(origin))) throw new HttpError(403, `A page at ${String(origin).slice(0, 80)} can't sign anyone in to Foundation. Open Foundation itself.`);
  const { email, name, bearer } = await readJson<{ email?: string; name?: string; bearer?: boolean }>(req);
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "enter an email");
  if (!isAllowed(email)) throw new HttpError(403, `${email} is not on Foundation's allowlist`);
  const user = upsertUser(email, name ?? "");
  audit({ actor_kind: "person", actor_id: user.id, actor_name: user.name, door: "route", action: "sign_in.dev", target: bearer === true ? "app session" : "browser session", decision: "allowed", result: "ok" });
  return { user, ...signIn(res, user.id, bearer === true) };
});
r.get("/auth/google/start", (_req, res) => {
  // the sign-in is bound to this browser: the callback must bring back the state this cookie holds
  const { url, cookie } = googleStart();
  res.writeHead(302, { location: url, "set-cookie": cookie });
  res.end();
});
r.get("/auth/google/callback", async (req, res) => {
  const user = await googleCallback(req.query.get("code") ?? "", req.query.get("state") ?? "", parseCookies(req.headers.cookie)[GOOGLE_STATE_COOKIE] ?? "");
  setSessionCookie(res, createSession(user.id));
  res.writeHead(302, { location: config.clientUrl });
  res.end();
});
// Google through flowform-server — the flowform client's sign-in (flowform.ts)
r.get("/auth/flowform/start", (req, res) => flowform.startWeb(req, res));
r.post("/auth/flowform/begin", (req) => flowform.beginDesktop(req));
r.get("/auth/flowform/done/:nonce", (req, res) => flowform.done(req, res));
r.post("/auth/flowform/poll", (req, res) => flowform.poll(req, res));
// the person's press on the page /done shows a desktop sign-in: only then does the poll above get a session
r.post("/auth/flowform/confirm/yes", (req, res) => flowform.confirm(req, res, "yes"));
r.post("/auth/flowform/confirm/no", (req, res) => flowform.confirm(req, res, "no"));
// a person's link to Flowform's boards and files, read-only, through its MCP endpoint (flowformlink.ts)
r.get("/api/flowform/link", (req) => {
  const u = requireUser(req);
  return { ...linkStatus(u.id), ...downloadsStatus(u.id) };
});
r.post("/api/flowform/link", (req) => beginLink(requirePerson(req, "Connecting Flowform").id));
r.post("/api/flowform/unlink", async (req) => {
  const u = requirePerson(req, "Disconnecting Flowform");
  await unlink(u.id);
  await dropSession(u.id); // the downloads session goes with it
  return { ok: true };
});
// Flowform file downloads: the person's own Flowform session, kept encrypted for this alone (flowformfiles.ts)
r.post("/api/flowform/files/allow", (req) => beginGrant(requirePerson(req, "Allowing Flowform file downloads").id, flowform.loopbackOrigin(req)));
r.post("/api/flowform/files/stop", async (req) => {
  await dropSession(requirePerson(req, "Stopping Flowform file downloads").id);
  return { ok: true };
});
r.post("/api/flowform/files/:file/bring", async (req) => {
  // copies a Flowform file into this board's archive: a write, so gateWrites has checked ?board= (not in READ_POSTS)
  const u = requireUser(req);
  const board = req.query.get("board");
  requireBoard(u, board);
  const { revision, name } = await readJson<{ revision?: string; name?: string }>(req);
  if (!revision) throw new HttpError(400, "which revision?");
  // files found by search aren't a room's: they share one scope ("me"), and the bytes are stored once whatever the scope
  const file = await bringFlowformFile(u.id, board, "me", { file_id: req.params.file, revision_id: revision, name });
  if (!file) throw new HttpError(404, "Flowform didn't give that file (gone, not yours to read, or over 512 MB)");
  return { file: { ...file, url: `/files/${file.id}` } };
});
// Flowform's own small picture of one of the person's files, fetched as them (never another person's: flowformfiles.ts)
const THUMB_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
r.get("/files/flowform/:file/:rev/thumb", async (req, res) => {
  const u = requireUser(req);
  const pic = await fileThumb(u.id, req.params.file, req.params.rev);
  if (!pic || !THUMB_TYPES.has(pic.mime)) throw new HttpError(404, "Flowform has no picture of that file");
  res.writeHead(200, { "content-type": pic.mime, "content-length": pic.body.length, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
  res.end(req.method === "HEAD" ? undefined : pic.body);
});
// the files on one of the person's Flowform rooms, to browse and drag out without bringing the room in
r.get("/api/flowform/rooms/:id/files", async (req) => ({ files: await roomFiles(requireUser(req).id, req.params.id) }));
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
// Flowform rooms brought in live through the link, and kept up to date (flowform-live.ts)
r.get("/api/flowform/rooms", async (req) => {
  const u = requireUser(req);
  const live = new Map(liveRooms().map((l) => [l.room_id, l]));
  return { rooms: (await listFlowformRooms(u.id)).map((x) => ({ ...x, live: live.get(x.room_id) ?? null })) };
});
r.post("/api/flowform/rooms/:id/pull", async (req) => {
  // a write to the room's board: not in READ_POSTS, so gateWrites has already checked ?board=
  const u = requirePerson(req, "Bringing in a Flowform room");
  const board = boardIdFor(req.params.id);
  requireWriter(u, board);
  if (memberRole(board, u.id) === "viewer") throw new HttpError(403, "View only: you can read this room's board here but not bring it up to date");
  return pullRoom(u.id, req.params.id);
});
r.get("/api/flowform/tools", async (req) => ({ tools: await flowformTools(requireUser(req).id) }));
r.post("/api/flowform/tools/:name", async (req) => flowformCall(requireUser(req).id, req.params.name, await readJson(req)));
r.post("/auth/logout", (req, res) => {
  clearSession(req, res);
  return { ok: true };
});
/** a one-time, 30-second ticket for one socket, for a client that can't send its session on a WebSocket (sockets.ts) */
r.post("/api/ws-ticket", async (req) => {
  const { path, client } = await readJson<{ path?: string; client?: string }>(req);
  // a client older than this server's minimum gets no socket (426), and says so on its update card
  requireCurrentClient(client, req.headers.origin);
  return issueTicket(req, path);
});
/** a bearer for an external agent (Claude Code, Codex, Vision) acting as you: a person makes it (an agent's token can't mint itself a longer one), and it lasts a week (ADR-001 G9) */
r.post("/api/agent/token", (req) => {
  const u = requirePerson(req, "Making an agent token");
  audit({ actor_kind: "person", actor_id: u.id, actor_name: u.name, door: "route", action: "agent_token.mint", target: `${AGENT_TOKEN_DAYS} days`, decision: "allowed", approved_by: u.id, result: "ok" });
  return { token: createSession(u.id, AGENT_TOKEN_DAYS * 864e5, "agent"), mcp: `${config.publicUrl}/mcp?board=company` };
});

// ---------- boards ----------

// a members-only board is listed, and answers, only to its members (members.ts): to anyone else it isn't there
r.get("/api/boards", (req) => {
  const u = requireUser(req);
  const hidden = hiddenBoards(u);
  return { boards: listBoards().filter((b) => !hidden.has(b.id)).map((b) => ({ ...b, role: boardRole(u.id, b.id) })) };
});
r.get("/api/boards/:id/epoch", (req) => {
  requireBoard(requireUser(req), req.params.id);
  return { epoch: boardEpoch(req.params.id) };
});
r.get("/api/boards/:id/people", (req) => {
  requireBoard(requireUser(req), req.params.id);
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

// who may edit a board: an admin, in person (an admin's agent token can't change roles)
r.post("/api/boards/:id/people", async (req) => {
  const u = requirePerson(req, "Changing who may edit a board");
  requireBoard(u, req.params.id);
  const { userId, role } = await readJson<{ userId?: string; role?: "member" | "viewer" | null }>(req);
  if (!userId || (role !== null && role !== "member" && role !== "viewer")) throw new HttpError(400, "userId and role (member, viewer or null) required");
  setBoardRole(u, req.params.id, userId, role);
  return { people: boardPeople(req.params.id) };
});
r.post("/api/boards", async (req) => {
  requireWriter(requireUser(req));
  const body = await readJson<{ name?: string; kind?: string; folder?: string | null; url?: string; parent?: string | null }>(req);
  const kind: SpaceKind = SPACE_KINDS.includes(body.kind as SpaceKind) ? (body.kind as SpaceKind) : "grid";
  const url = kind === "page" ? cleanPageUrl(body.url) : null;
  if (kind === "page" && !url) throw new HttpError(400, "A web page needs an address (http or https)");
  let name = (body.name ?? "").trim().slice(0, 80);
  if (!name) {
    // an unnamed space takes a name nothing else has: "Untitled grid", then "Untitled grid 2"…
    const base = kind === "page" ? new URL(url!).hostname : kind === "deck" ? "Untitled presentation" : "Untitled grid";
    const taken = new Set(listBoards().map((b) => b.name));
    name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  }
  const id = createBoardRow(name, { kind, folder: cleanFolder(body.folder), url });
  // the server lays the first sections, so two people opening a new space at once don't both seed it
  // (a deck's sections are its slides; a page space keeps a board for its people and activity, with nothing on it)
  if (kind !== "page") {
    const doc = getBoard(id).doc;
    if (boardMaps(doc).sections.size === 0) {
      editBoard(id, "system", (d) => {
        if (kind === "deck") for (const s of ["Title", "Slide 2", "Slide 3"]) appendSection(d, s);
        else appendSection(d, "Section 1");
      });
    }
  }
  if (body.parent) {
    requireBoard(requireUser(req), String(body.parent));
    requireWriter(requireUser(req), String(body.parent));
    const out = setBoardParent(id, String(body.parent));
    if ("error" in out) throw new HttpError(400, out.error);
  }
  return { id };
});
// rename a space, move it between project folders, or re-point a page space: anyone who can write it
r.post("/api/boards/:id", async (req) => {
  const u = requireUser(req);
  const id = req.params.id;
  requireBoard(u, id);
  if (!listBoards().some((b) => b.id === id)) throw new HttpError(404, "No such grid");
  requireWriter(u, id);
  const body = await readJson<{ name?: string; folder?: string | null; url?: string; parent?: string | null }>(req);
  const patch: { name?: string; folder?: string | null; url?: string } = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 80);
    if (!name) throw new HttpError(400, "A grid needs a name");
    patch.name = name;
  }
  if (body.folder !== undefined) patch.folder = cleanFolder(body.folder);
  if (body.url !== undefined) {
    const url = cleanPageUrl(body.url);
    if (!url) throw new HttpError(400, "A web address (http or https) required");
    patch.url = url;
  }
  updateBoardRow(id, patch);
  // a grid of grids: put it inside another (which must be one this person can write too), or back at the top
  if (body.parent !== undefined) {
    const parent = body.parent === null || body.parent === "" ? null : String(body.parent);
    if (parent) {
      requireBoard(u, parent);
      requireWriter(u, parent);
    }
    const out = setBoardParent(id, parent);
    if ("error" in out) throw new HttpError(400, out.error);
  }
  return { board: listBoards().find((b) => b.id === id) };
});
/** what a grid holds, for the card that stands for it on another grid: its tracks, its sections at their places, their cards as blocks */
r.get("/api/boards/:id/outline", (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  return gridOutline(req.params.id, u);
});
/**
 * "Open as its own grid": the section becomes a grid inside this one, its cards move into it, and the
 * section keeps a card that previews it (subgrids.ts). The board tool `extract_section` by its other door:
 * a viewer is refused, and the same request_id answers with what was done the first time.
 */
r.post("/api/boards/:id/sections/:section/extract", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  if (!listBoards().some((b) => b.id === req.params.id)) throw new HttpError(404, "No such grid");
  const body = await readJson<{ request_id?: string }>(req);
  const out = await runTool(httpToolCtx(req.params.id, u, isPerson(req)), "extract_section", { section: req.params.section, ...(typeof body.request_id === "string" ? { request_id: body.request_id } : {}) });
  return { result: out, board: listBoards().find((b) => b.id === (out as { board: string }).board) };
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
  // a board named here is one the caller can see (its allowances decide what an agent's search may send)
  requireBoard(u, req.query.get("board"));
  const q = (req.query.get("q") ?? "").trim();
  if (!q) return { hits: [], sources: {} };
  return searchAll(q, { boardId: req.query.get("board") ?? undefined, remote: req.query.get("remote") !== "0", hidden: hiddenBoards(u), userId: u.id });
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
// saving an app and probing an address: a person (the server fetches whatever address is given; ADR-001 G10).
// Probe isn't in READ_POSTS, so a viewer is refused by the write gate as well
r.post("/api/apps", async (req) => {
  const u = requirePerson(req, "Saving an app");
  const body = await readJson<{ name: string; url?: string; repo?: string; mcp?: string; description?: string }>(req);
  if (!body.name) throw new HttpError(400, "name required");
  return { app: saveApp(body, u.id) };
});
r.post("/api/apps/probe", async (req) => {
  requirePerson(req, "Probing an app's address");
  const { url } = await readJson<{ url?: string }>(req);
  if (!url || !/^https?:\/\//.test(url)) throw new HttpError(400, "an http(s) URL");
  return probeApp(url);
});
r.get("/api/repo", async (req) => {
  requireUser(req);
  let repo: string;
  try {
    repo = checkRepo(req.query.get("repo") ?? "");
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
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
// an ask DMs the assignee on Slack as "Foundation · <name> asks": a person's (agents ask with the ask_person tool)
r.post("/api/asks", async (req) => {
  const u = requirePerson(req, "Asking someone on Slack as you");
  const b = await readJson<{ board: string; assignee: string; prompt: string; kind?: string; section?: string }>(req);
  requireBoard(u, b.board);
  return createAsk({ boardId: b.board, actor: u.name, userId: u.id }, { assignee: b.assignee, prompt: b.prompt, kind: b.kind ?? "cad_upload", section: b.section });
});
r.post("/api/asks/:id/resolve", async (req) => {
  const u = requireUser(req);
  const { fileId } = await readJson<{ fileId?: string }>(req);
  requireBoard(u, one<{ board_id: string }>("select board_id from asks where id = ?", req.params.id)?.board_id);
  if (fileId) requireFileVisible(u.id, fileId);
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
  requireFileVisible(u.id, b.fileId);
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
// a channel is read for a board that has it (a Slack card, or the Slack board's section): not any channel the bot sees
r.get("/api/slack/channels/:id", (req) => {
  const u = requireUser(req);
  const board = req.query.get("board") ?? "";
  if (!board) throw new HttpError(400, "which board is this channel on? (?board=)");
  requireBoard(u, board);
  if (!listBoards().some((b) => b.id === board) || !boardHasChannel(board, req.params.id)) throw new HttpError(404, "That Slack channel isn't on this board. Put it on the board (a Slack card) to read it here.");
  return slackDo(async () => ({ channel: await channelInfo(req.params.id), messages: await channelHistory(req.params.id, 40, req.query.get("fresh") === "1") }));
});
// posting, sharing, inviting and handing over huddle notes go out under the person's name ("<name> via
// Foundation"): a person's press, never an agent's bearer or the service token
r.post("/api/slack/channels/:id/messages", async (req) => {
  const u = requirePerson(req, "Posting to Slack as you");
  const b = await readJson<{ text?: string }>(req);
  return slackDo(() => postMessage(req.params.id, b.text ?? "", u));
});
/** send the channel a link to a place on the board */
r.post("/api/slack/channels/:id/share", async (req) => {
  const u = requirePerson(req, "Sharing to Slack as you");
  const b = await readJson<{ board?: string; objectId?: string; title?: string; note?: string }>(req);
  const board = b.board ?? "company";
  requireBoard(u, board);
  const text = shareText({ by: u.name, board, objectId: b.objectId, title: b.title || "A place", note: b.note });
  return slackDo(async () => ({ ...(await postMessage(req.params.id, text, u, { board, objectId: b.objectId ?? null })), url: boardLink(board, b.objectId) }));
});
/** invite the channel into a huddle on the board */
r.post("/api/slack/channels/:id/invite", async (req) => {
  const u = requirePerson(req, "Inviting a Slack channel as you");
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
  const u = requirePerson(req, "Sending huddle notes to Slack as you");
  const b = await readJson<{ board?: string; huddleId?: string; sessionId?: string; summary?: string }>(req);
  const board = b.board ?? "company";
  // a members-only board's huddle transcript is its members' to share
  requireBoard(u, board);
  const h = huddleOn(board, b.huddleId ?? "");
  const s = huddleArchive(board, h.id).find((x) => x.id === b.sessionId) ?? huddleArchive(board, h.id)[0];
  if (!s) throw new HttpError(404, "that huddle hasn't met yet");
  const lines = transcriptText(s).split("\n");
  const excerpt = lines.slice(0, 40).join("\n") + (lines.length > 40 ? `\n… ${lines.length - 40} more lines on Foundation` : "");
  const text = `${b.summary ? `${b.summary.trim()}\n\n` : ""}\`\`\`${excerpt}\`\`\`\n<${boardLink(board, h.id)}|The full huddle archive on Foundation>`;
  return slackDo(() => postMessage(req.params.id, text, u, { board, huddle: h.id, session: s.id }));
});

// ---------- the Slack board: a section per channel, kept live (slacklive.ts) ----------

r.get("/api/slack/live", async (req) => {
  requireUser(req);
  return slackLiveStatus();
});
/**
 * make the Slack board (or bring the one there is up to date) and say where it is. It reads every channel
 * the app is in, and a read can start an agent turn: a person's press, like a single channel's read below
 */
r.post("/api/slack/board", async (req) => {
  const u = requirePerson(req, "Building or re-reading the Slack board");
  requireWriter(u);
  return slackDo(() => buildSlackBoard(u));
});
/** read one channel into its section now */
// a read can end in an agent turn (slacklive.ts wantCurate, once a person turned agents on): a person's press
r.post("/api/slack/board/sync", async (req) => {
  const u = requirePerson(req, "Reading a Slack channel into the board");
  const board = req.query.get("board") ?? "";
  requireBoard(u, board);
  const { channel } = await readJson<{ channel?: string }>(req);
  if (!channel) throw new HttpError(400, "which channel?");
  await slackDo(() => syncChannel(board, channel));
  return { ok: true };
});
/** the Slack app joins a public channel so its section can be read: the channel sees it join, so a person presses this */
r.post("/api/slack/board/join", async (req) => {
  const u = requirePerson(req, "Having the Slack app join a channel");
  const board = req.query.get("board") ?? "";
  requireBoard(u, board);
  const { channel } = await readJson<{ channel?: string }>(req);
  if (!channel) throw new HttpError(400, "which channel?");
  await slackDo(() => joinFor(board, channel, u));
  return { ok: true };
});
/** agents write and keep each section's summary: every one is an agent turn, so a person turns it on (and off) */
r.post("/api/slack/board/agents", async (req) => {
  const u = requirePerson(req, "Turning agents on for the Slack board");
  const board = req.query.get("board") ?? "";
  requireBoard(u, board);
  const { on } = await readJson<{ on?: boolean }>(req);
  if (on && !pickRuntime()) throw new HttpError(503, "No agent runtime: sign in to Claude Code (`claude`) to use your subscription, or set ANTHROPIC_API_KEY");
  return slackDo(async () => setAgents(board, u, on === true));
});
/**
 * What Slack sends, forwarded by the Slack app's own process (apps/slack-agent):
 * that it's there, and each event as it happens. The service token only.
 */
r.post("/api/slack/events", async (req) => {
  const u = requireUser(req);
  if (u.id !== "agent") throw new HttpError(403, "Only the Slack app's process (the service token) reports Slack events");
  const addr = req.socket.remoteAddress ?? "";
  const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  return fromBridge(await readJson<BridgeMessage>(req), { loopback });
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
  // what the card and its confirmation show: the whole target and goal from the job itself, and the hash a Run names
  return { job, ...jobShown(job) };
});
// a job runs third-party code or spends on a model: only a person presses Run (jobs.ts; ADR-001 G1)
r.post("/api/jobs/:id/run", async (req) => {
  const u = requirePerson(req, "Running a job");
  const job = getJob(req.params.id);
  if (!job) throw new HttpError(404, "no such job");
  requireBoard(u, job.board_id);
  // seeing the job's board isn't enough: a viewer of it can't start what runs on it
  requireWriter(u, job.board_id);
  // it runs only what the card showed: the press names the hash of the target and goal it showed (jobs.ts)
  const { shown } = await readJson<{ shown?: string }>(req);
  return { job: startJob(job.id, job.board_id ?? "company", u.name, typeof shown === "string" ? shown : "", u.id) };
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
  return machineSeen(req.params.id, req.params.panel);
});
// everything that runs, stops or removes needs a person at a browser (gateWrites has already refused viewers)
r.post("/api/boards/:id/machines/:panel/start", async (req) => {
  const u = requirePerson(req, "Starting a machine");
  requireBoard(u, req.params.id);
  const b = await readJson<{ image?: string; engine?: string; ports?: number[]; desktop?: boolean }>(req);
  return { machine: await startMachine(req.params.id, req.params.panel, u.name, b) };
});
// Ins & outs: the machine writes a test line to /foundation/out (it runs a command in it: a person, who can write here)
r.post("/api/boards/:id/machines/:panel/io/try", async (req) => {
  const u = requirePerson(req, "Writing to a machine");
  requireWriter(u, req.params.id);
  return { io: await tryOut(req.params.id, req.params.panel) };
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
// a graphical desktop inside a running machine: installing it runs third-party code, so a person does it (machinedesktop.ts)
r.post("/api/boards/:id/machines/:panel/desktop", async (req) => {
  const u = requirePerson(req, "Adding a desktop to a machine");
  requireBoard(u, req.params.id);
  // { stop: true }: a person ends an install that is going (or one the card still shows from before a restart)
  const b = await readJson<{ stop?: boolean }>(req).catch(() => ({}) as { stop?: boolean });
  if (b.stop === true) return { machine: await stopDesktopInstall(req.params.id, req.params.panel, u) };
  return { machine: addDesktop(req.params.id, req.params.panel, u).machine };
});
// whether agents may use that desktop: a person's leave on this machine, given and taken back from their browser
r.post("/api/boards/:id/machines/:panel/agents", async (req) => {
  const u = requirePerson(req, "Letting agents use a desktop");
  requireBoard(u, req.params.id);
  const b = await readJson<{ allow?: boolean }>(req);
  return { machine: setAgentsMay(req.params.id, req.params.panel, u, b.allow === true) };
});
// an agent's command waiting on a machine's card: only a person at a browser, who can edit the board, answers it
r.post("/api/boards/:id/machines/:panel/asks/:ask/:verdict", async (req) => {
  const verdict = req.params.verdict;
  if (verdict !== "run" && verdict !== "decline") throw new HttpError(404, "run or decline");
  const u = requirePerson(req, verdict === "run" ? "Running an agent's command" : "Declining an agent's command");
  requireBoard(u, req.params.id);
  return { ask: answerAsk(req.params.id, req.params.panel, req.params.ask, u, verdict) };
});
// an agent's ask to use an app's tool, on the app's card: the same gate (a person at their browser who can edit the board).
// Allow lets agents call that tool of that saved app until its definition changes; it calls nothing itself (apptools.ts)
r.post("/api/boards/:id/apps/:panel/asks/:ask/:verdict", async (req) => {
  const verdict = req.params.verdict;
  if (verdict !== "allow" && verdict !== "decline") throw new HttpError(404, "allow or decline");
  const u = requirePerson(req, verdict === "allow" ? "Allowing an app's tool" : "Declining an agent's ask");
  requireBoard(u, req.params.id);
  return { ask: answerAppToolAsk(req.params.id, req.params.panel, req.params.ask, u, verdict) };
});
r.post("/api/boards/:id/machines/load", async (req) => {
  const u = requirePerson(req, "Loading an image into an engine");
  requireBoard(u, req.params.id);
  const b = await readJson<{ fileId?: string; engine?: string }>(req);
  if (!b.fileId) throw new HttpError(400, "name the file to load");
  requireFileVisible(u.id, b.fileId);
  return loadImage(req.params.id, b.fileId, u.name, b.engine);
});

// ---------- a person's own preferences (prefs.ts) ----------

r.get("/api/prefs", (req) => ({ prefs: prefsOf(requireUser(req).id) }));
// theirs to change, from their own browser: an agent's token reads them and can't set them
r.post("/api/prefs", async (req) => {
  const u = requirePerson(req, "Changing your preferences");
  const b = await readJson<{ key?: string; value?: unknown }>(req);
  return { prefs: setPref(u.id, b.key ?? "", b.value) };
});

// ---------- characters: the council's avatars and the pipeline that makes them (characters.ts) ----------

/** every character, and who wears which: any signed-in person, on any board */
r.get("/api/characters", (req) => {
  requireUser(req);
  return roster();
});
r.get("/api/characters/costs", async (req) => {
  requireUser(req);
  return characterCosts();
});
/** a character's file by role (thumb, clips, mavatar, front …): characters are the company's, so this doesn't ask which board */
r.get("/api/characters/:id/files/:role", (req, res) => {
  requireUser(req);
  serveFile(req, res, characterFile(req.params.id, req.params.role));
});
// ---------- agents assigned to a section or a grid: who is on its council (posted.ts) ----------

r.get("/api/agents/available", (req) => {
  requireUser(req);
  return availableAgents();
});
r.post("/api/boards/:id/agents", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  requireWriter(u, req.params.id);
  const { place, agent } = await readJson<{ place?: string; agent?: string }>(req);
  if (!place || !agent) throw new HttpError(400, "place (a section id, or * for the grid) and agent required");
  return postAgent(req.params.id, place, agent, u);
});
r.post("/api/boards/:id/agents/remove", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  requireWriter(u, req.params.id);
  const { place, agent } = await readJson<{ place?: string; agent?: string }>(req);
  if (!place || !agent) throw new HttpError(400, "place and agent required");
  return { agents: unpostAgent(req.params.id, place, agent, u) };
});

// ---------- Foundation's own grids (the plan, the design language) and a person's settings ----------

r.post("/api/system-grids/:key", (req) => {
  requireUser(req);
  if (!isSystemGridKey(req.params.key)) throw new HttpError(404, "No such grid");
  return openSystemGrid(req.params.key);
});

/** make the Character studio board (or say where the one there is) */
r.post("/api/characters/studio", (req) => {
  const u = requireUser(req);
  requireWriter(u);
  return openStudio(u);
});
/** choose the character an agent name wears */
r.post("/api/characters/avatars", async (req) => {
  const u = requireUser(req);
  requireWriter(u);
  const b = await readJson<{ name?: string; character?: string | null }>(req);
  return { avatars: setAvatar(u, b.name ?? "", b.character ?? null) };
});
// adding and describing a character spends nothing (gateWrites has refused viewers)
r.post("/api/boards/:id/characters", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  return { character: createCharacter(req.params.id, { name: u.name, id: u.id, human: isPerson(req) }, await readJson<NewCharacter>(req)) };
});
/** an image into a set's Inspiration section (the request's body is the image) */
r.post("/api/boards/:id/characters/inspiration", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  const mime = (req.headers["content-type"] || "").split(";")[0];
  return addInspiration(req.params.id, req.query.get("set") ?? "Abstract", await readBody(req, 20 * 1024 * 1024), { name: (req.query.get("name") || "inspiration").slice(0, 240), mime }, u);
});
r.post("/api/boards/:id/characters/:panel/edit", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  return { character: editCharacter(req.params.id, req.params.panel, await readJson<NewCharacter>(req)) };
});
// a person's word on a character: approve it for the council, archive it, or put it back in the pipeline
r.post("/api/boards/:id/characters/:panel/approval", async (req) => {
  const u = requirePerson(req, "Approving a character");
  requireWriter(u, req.params.id);
  const { approval } = await readJson<{ approval?: string }>(req);
  if (approval !== "approved" && approval !== "archived" && approval !== "pending") throw new HttpError(400, "approval is approved, archived or pending");
  return { character: setApproval(req.params.id, req.params.panel, approval, u) };
});
r.get("/api/boards/:id/characters/:panel/tasks", (req) => {
  requireBoard(requireUser(req), req.params.id);
  return { tasks: characterTasks(req.params.id, req.params.panel) };
});
/** a .mavatar built with mesh-avatar-studio, as the request's body */
r.post("/api/boards/:id/characters/:panel/mavatar", async (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  return { character: await attachMavatar(req.params.id, req.params.panel, await readBody(req, 130 * 1024 * 1024), u) };
});
// every stage spends credits: a person at a browser presses it (an agent's bearer is refused)
r.post("/api/boards/:id/characters/:panel/stages/:stage", async (req) => {
  const u = requirePerson(req, "Spending credits on a character");
  requireBoard(u, req.params.id);
  const stage = req.params.stage as CharacterStageKey;
  if (!CHARACTER_STAGES.model.includes(stage) && !CHARACTER_STAGES.mesh.includes(stage)) throw new HttpError(404, "no such stage");
  const b = await readJson<{ confirm?: boolean }>(req);
  return { character: await startStage(req.params.id, req.params.panel, stage, u, { confirm: b.confirm === true }) };
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

// ---------- Today: the person's own page ----------

r.get("/api/today", (req) => todayFor(requireUser(req)));
r.post("/api/today/goals", async (req) => {
  const u = requireUser(req);
  const g = await readJson<GoalInput>(req);
  try {
    return { goal: saveGoal(u.id, g) };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
// the company's goals: Today's other door is open to viewers (their own goals), so this one checks itself
const companyGoalRequests = new Map<string, unknown>();
r.post("/api/today/company-goals", async (req) => {
  const u = requireUser(req);
  requireWriter(u, "company");
  const g = await readJson<CompanyGoalInput & { request_id?: string }>(req);
  const key = g.request_id ? `${u.id}:${g.request_id}` : null;
  if (key && companyGoalRequests.has(key)) return companyGoalRequests.get(key);
  const out = { goal: saveCompanyGoal(u, g) };
  if (key) {
    companyGoalRequests.set(key, out);
    if (companyGoalRequests.size > 500) companyGoalRequests.delete(companyGoalRequests.keys().next().value!);
  }
  return out;
});
r.post("/api/today/profile", async (req) => {
  const u = requireUser(req);
  return { profile: setProfile(u.id, await readJson(req)) };
});

// ---------- Vision Code (T3) sessions, read-only ----------

// whole coding transcripts, on no board: an admin, in person
function requireT3Reader(req: Req) {
  const u = requirePerson(req, "Reading Vision Code's threads");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin can read Vision Code's threads.");
  return u;
}
r.get("/api/t3/threads", async (req) => {
  requireT3Reader(req);
  return t3Threads();
});
r.get("/api/t3/threads/:id", async (req) => {
  requireT3Reader(req);
  const t = await t3Thread(req.params.id);
  if (!t) throw new HttpError(404, "no such Vision Code thread");
  return t;
});

// ---------- the built-in terminal (hostterm.ts): a shell on this computer, for an admin, in person ----------
r.post("/api/host-terminal", (req) => requestHostTerminal(req));
// what changed in Foundation's own code (changelog.ts): read-only, for anyone signed in
r.get("/api/changelog", async (req) => {
  requireUser(req);
  return changelog(Number(req.query.get("n") ?? 60));
});

// ---------- Foundation's own T3 instance: the agents this computer has (t3host.ts) ----------

r.get("/api/t3host", (req) => {
  requireUser(req);
  return t3Host();
});
// starting it runs a third-party program on this computer: a person's press, and not a viewer's
r.post("/api/t3host/start", async (req) => {
  const u = requirePerson(req, "Starting T3");
  if (u.role === "viewer") throw new HttpError(403, "Viewers can't start T3.");
  return startT3(u.name);
});
r.post("/api/t3host/stop", (req) => {
  const u = requirePerson(req, "Stopping T3");
  if (u.role === "viewer") throw new HttpError(403, "Viewers can't stop T3.");
  return stopT3();
});

// a thread runs a model on someone's plan or key: a person's press, by someone who can write the board
r.post("/api/t3host/threads", async (req) => {
  const u = requirePerson(req, "Asking an agent");
  const body = await readJson<{ board?: string; section?: string; agent?: string; model?: string; text?: string; as?: string }>(req);
  if (!body.board || !body.section || !body.agent) throw new HttpError(400, "board, section and agent required");
  requireWriter(u, body.board);
  return askT3(u, { board: body.board, section: body.section, agent: body.agent, model: body.model, text: body.text ?? "", as: body.as });
});
r.post("/api/t3host/threads/:id/stop", (req) => {
  const u = requirePerson(req, "Stopping an agent");
  if (u.role === "viewer") throw new HttpError(403, "Viewers can't stop agents.");
  return stopT3Thread(u, req.params.id);
});
r.get("/api/t3host/bindings", (req) => {
  requireUser(req);
  return t3Bindings(req.query.get("board") ?? "");
});
// T3's own page, for a supervised thread's approvals and its transcript: a one-time link, per press
r.post("/api/t3host/open", async (req) => {
  const u = requirePerson(req, "Opening T3");
  if (u.role === "viewer") throw new HttpError(403, "Viewers can't open T3.");
  const { thread } = await readJson<{ thread?: string }>(req);
  return { url: await t3OpenLink(thread).catch((e) => { throw new HttpError(502, (e as Error).message); }) };
});
// adding an agent gives this computer something new to run, and may carry a key: an admin, in person.
// The key goes straight to T3 (which keeps it); Foundation doesn't store it, log it or send it back
r.post("/api/t3host/agents", async (req) => {
  const u = requirePerson(req, "Adding an agent");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin can add an agent.");
  const body = await readJson<AddAgentInput>(req);
  return { agents: await addT3Agent(body).catch((e) => { throw new HttpError(400, (e as Error).message); }) };
});
// turning on one of T3's own agents (Antigravity, Cursor…) lets this computer run its program: an admin, in person
r.post("/api/t3host/agents/:id/enable", async (req) => {
  const u = requirePerson(req, "Turning on an agent");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin can turn on an agent.");
  return { agents: await enableT3Agent(req.params.id).catch((e) => { throw new HttpError(400, (e as Error).message); }) };
});
r.delete("/api/t3host/agents/:id", async (req) => {
  const u = requirePerson(req, "Removing an agent");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin can remove an agent.");
  return { agents: await removeT3Agent(req.params.id).catch((e) => { throw new HttpError(400, (e as Error).message); }) };
});
// the server asks an address on this computer for its models: a person's form, not an agent's port scan
r.get("/api/t3host/local", async (req) => {
  requirePerson(req, "Asking this computer's model server");
  return localModels(req.query.get("base") || undefined).catch((e) => { throw new HttpError(400, (e as Error).message); });
});
r.get("/api/t3host/presets", (req) => {
  requireUser(req);
  return T3_PRESETS;
});

// a new run spends on a model: a person asks (ADR-001 G2). Crew helpers and the Slack curator start theirs
// in-process (agent.ts startRun), not through this route. Still in READ_POSTS: a viewer who is a person may ask
r.post("/api/agent", async (req, res) => {
  const user = requirePerson(req, "Asking the agent");
  const body = await readJson<{ board?: string; prompt?: string; runtime?: string; session?: string; persona?: string; as?: string }>(req);
  if (!body.prompt?.trim()) throw new HttpError(400, "say something");
  requireBoard(user, body.board || "company");
  const send = sse(res);
  const session = body.session && /^ses_[a-z0-9]{6,24}$/.test(body.session) ? body.session : undefined;
  // the run lives on the server: closing this stream detaches, it doesn't stop it
  const r = startRun({ boardId: body.board || "company", user, prompt: body.prompt, runtime: body.runtime, session, persona: body.persona === "shiba" ? "shiba" : undefined, as: body.as });
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

// ---------- the audit log, and what agents may send outside (audit.ts, egress.ts) ----------

// who did what: an admin, in person, reads it (audit.ts). Rows hold no argument values, results or message text
r.get("/api/audit", (req) => {
  const u = requirePerson(req, "Reading the audit log");
  if (u.role !== "admin") throw new HttpError(403, "Only an admin can read the audit log.");
  const board = req.query.get("board");
  const after = Number(req.query.get("after") ?? 0);
  const limit = Number(req.query.get("limit") ?? 100);
  return { rows: readAudit({ board, after, limit }), chain: verifyAudit() };
});

// what agents on a board may send to outside services (egress.ts): anyone who can see the board reads it;
// a person who can edit it (on a members-only board, its owner or an admin) sets it, from their own browser or app
r.get("/api/boards/:id/egress", (req) => {
  const u = requireUser(req);
  requireBoard(u, req.params.id);
  return egressState(req.params.id, u);
});
const changeEgress = (on: boolean) => async (req: Req) => {
  const u = requirePerson(req, on ? "Letting agents send outside" : "Taking back what agents may send outside");
  requireBoard(u, req.params.id);
  const b = await readJson<{ service?: string; kind?: string }>(req);
  const sk = serviceKind(String(b.service ?? ""), String(b.kind ?? ""));
  if (!sk) throw new HttpError(400, "Name a service and a kind of send it takes (GET this board's egress lists them)");
  setAllowance(req.params.id, u, sk.service, sk.kind, on);
  return egressState(req.params.id, u);
};
r.post("/api/boards/:id/egress", changeEgress(true));
r.delete("/api/boards/:id/egress", changeEgress(false));

/** an agent's request to a read route that reaches an outside service runs under the board's allowances (egress.ts routeScope) */
function agentRouteScope(req: Req, path: string) {
  const user = userFromRequest(req);
  if (!user || isPerson(req)) return null;
  const service = user.id === "agent";
  // a board's allowance is lent only to a caller who can see that board: naming another one borrows nothing
  const named = req.query.get("board");
  const board = named && canSeeBoard(user, named) ? named : null;
  return routeScope(req.method ?? "GET", path, board, { kind: service ? "service" : "agent", id: service ? "agent" : `agent:${user.id}`, name: user.name, for: service ? null : user.id });
}

// ---------- view only ----------

/**
 * Viewers don't write. Any non-GET under /api is a write except these: the
 * agent (its tools check per call, so a viewer can still ask it things),
 * stopping your own run, an MCP token (its tools check too), board tools
 * (runTool checks), setting roles (admins only), a socket ticket (a
 * viewer's sync socket is read-only either way), and a person's own Today
 * and preferences (their goals, profile and settings are theirs, not a board's). The board is the
 * route's :id, or ?board=, else the person's account role decides.
 */
const READ_POSTS = [/^\/api\/agent$/, /^\/api\/agent\/runs\/[^/]+\/stop$/, /^\/api\/agent\/token$/, /^\/api\/boards\/[^/]+\/tools\//, /^\/api\/boards\/[^/]+\/people$/, /^\/api\/ws-ticket$/, /^\/api\/today\//, /^\/api\/prefs$/, /^\/api\/flowform\/(?!rooms\/[^/]+\/pull$|files\/[^/]+\/bring$)/];
function gateWrites(req: Req, path: string) {
  if (req.method === "GET" || req.method === "OPTIONS" || !path.startsWith("/api/")) return;
  if (READ_POSTS.some((p) => p.test(path))) return;
  const user = userFromRequest(req);
  if (!user) return; // the route's own requireUser answers 401
  const board = /^\/api\/boards\/([^/]+)/.exec(path)?.[1] ?? req.query.get("board");
  requireWriter(user, board);
}

// ---------- server ----------

const server = createServer(async (rawReq, res: ServerResponse) => {
  const req = rawReq as Req;
  const url = new URL(req.url ?? "/", "http://local");
  req.query = url.searchParams;
  // a request must name this server (DNS rebinding: origins.ts), whatever it is for, /auth/dev included
  const misnamed = hostRefusal(req);
  if (misnamed) return json(res, { error: misnamed }, 421);
  // exactly the client (FOUNDATION_CLIENT_URL), the desktop app's window (http://localhost:31440, tauri://localhost)
  // and FOUNDATION_CORS_ORIGINS. The app on a hosted server sends a bearer (Authorization), so preflights are kept 10 minutes
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
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
    // a change signed in by the cookie comes from one of our own pages (cross-site request forgery: origins.ts)
    // (the desktop sign-in's press page posts from this server's own origin and uses no Foundation session: it checks its own origin and cookie)
    const forged = url.pathname.startsWith("/auth/flowform/confirm/") ? null : cookieOriginRefusal(req);
    if (forged) throw new HttpError(403, forged);
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
    const scope = agentRouteScope(req, url.pathname);
    const out = scope ? await callScope.run(scope, () => m.handler(req, res)) : await m.handler(req, res);
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
server.on("upgrade", (req, socket, head) => {
  // a socket must name this server too (DNS rebinding: origins.ts); whose page opens it is checked in handleUpgrade
  if (hostRefusal(req)) {
    socket.write("HTTP/1.1 421 Misdirected Request\r\n\r\n");
    socket.destroy();
    return;
  }
  handleUpgrade(wss, req, socket, head);
});

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
resumeCharacters();
// characters this build carries that this install hasn't had yet (a fresh install, or a studio made from an older set)
void bringInStarter()
  .then((n) => n && console.log(`  characters         brought in ${n} from the starter set`))
  .catch((e: Error) => console.error(`  characters         the starter set didn't load: ${e.message}`));

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
  const doors = [config.google.clientId ? "Google" : `Google through Flowform (${flowform.flowformUrl()})`, config.devLogin ? "dev login (this computer only)" : ""].filter(Boolean);
  console.log(`  sign-in            ${doors.join(" + ")}`);
  // never locked out without being told why: dev login is off unless asked for
  if (!config.devLogin && !config.google.clientId) console.log("  dev login          off. To sign in by email on this computer, add FOUNDATION_DEV_LOGIN=1 to .env and restart");
  console.log(`  agent              ${rt.subscription ? "Claude Code (subscription)" : rt.subscriptionNote ? `— (${rt.subscriptionNote.split("\n")[0]})` : "—"}${rt.api ? ` · API (${rt.model})` : ""}`);
  console.log(`  MCP                ${config.publicUrl}/mcp?board=company\n`);
});
