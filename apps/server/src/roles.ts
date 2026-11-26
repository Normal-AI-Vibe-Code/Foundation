/**
 * Who may change a board. Everyone signed in can read; a viewer can't write.
 *
 * A person's role on a board is the one an admin set for that board, or else
 * their account's role: admin, member, or viewer (a flowform viewer let in
 * with FLOWFORM_ADMIT_VIEWERS). Admins can always write, and only admins set
 * roles.
 *
 * The server enforces it everywhere a write can come from: the board's sync
 * socket drops a viewer's updates (attachConnection), runTool refuses every
 * tool but the read-only ones (HTTP tools, MCP, the agent), and the HTTP gate
 * refuses a viewer's other writes. The client's view-only mode is a courtesy
 * on top.
 */

import type { UserInfo } from "@foundation/protocol";
import { all, one, run } from "./db.ts";
import { HttpError } from "./http.ts";
import { dropConnections } from "./boards.ts";
import { audit } from "./audit.ts";

export type BoardRole = "admin" | "member" | "viewer";

/** tools that only look (or, run_code, only call tools that are checked again), which a viewer may use */
export const READ_TOOLS = new Set([
  "read_board",
  "read_card",
  "read_collection",
  "machines",
  "search",
  "company",
  "read_file",
  "read_repo",
  "find_repo",
  "app_tools",
  "places", // approved folders on this computer; reads only
  "flowform", // the person's own Flowform, through a read-only token; writes nothing here
  "pipeline_status",
  "huddle_transcript",
  "replay_timeline", // a recorded session's timeline; reads only
  "read_timeline", // a grid's timeline (timeline.ts); reads only
  "slack_read",
  "set_plan", // shows the session's plan; writes nothing to the board
  "find_images",
  "bring_view", // moves the asker's own view; changes nothing on the board
  "crew_work", // what this ask's crew has made so far; reads only
  // Today: the person's own page. Goals and a profile are theirs, not a board's, so a viewer keeps them too
  "today",
  "set_goal",
  "set_profile",
  "point_today",
  // ChatForm: no board; chattools.ts enforces chat's own rule (the person's channels; posting where they're a member)
  "chat_channels",
  "chat_read",
  "chat_search",
  "chat_post",
  "chat_react",
  // code mode (codemode.ts): finding tools reads only; a script's every call goes through runTool again,
  // so a viewer's script reads and each write inside it is refused here like any other
  "search_tools",
  "run_code",
]);

function accountRole(userId: string): BoardRole {
  if (userId === "agent") return "member"; // the service token
  const u = one<{ role: string }>("select role from users where id = ?", userId);
  return u?.role === "admin" ? "admin" : u?.role === "member" ? "member" : "viewer";
}

export function boardRole(userId: string, boardId: string): BoardRole {
  const account = accountRole(userId);
  if (account === "admin") return "admin";
  const set = one<{ role: string }>("select role from board_roles where board_id = ? and user_id = ?", boardId, userId);
  return set?.role === "member" || set?.role === "viewer" ? set.role : account;
}

export const canWrite = (userId: string, boardId: string) => boardRole(userId, boardId) !== "viewer";

export function requireWriter(user: UserInfo, boardId?: string | null) {
  const role = boardId ? boardRole(user.id, boardId) : accountRole(user.id);
  if (role === "viewer") throw new HttpError(403, boardId ? `View only: you can read “${boardId}” but not change it. An admin can make you a member.` : "View only: your account can read but not change boards.");
}

/** set (or with null, clear) someone's role on one board — admins only, in person (the route asks requirePerson) */
export function setBoardRole(by: UserInfo, boardId: string, userId: string, role: "member" | "viewer" | null) {
  const rec = (decision: "allowed" | "refused", reason?: string) =>
    audit({ actor_kind: by.id === "agent" ? "service" : "person", actor_id: by.id, actor_name: by.name, board_id: boardId, door: "route", action: "board_role.set", target: `${userId}:${role ?? "default"}`, decision, reason: reason ?? null, approved_by: decision === "allowed" ? by.id : null, result: decision === "allowed" ? "ok" : null });
  if (by.role !== "admin" || by.id === "agent") {
    rec("refused", "not an admin");
    throw new HttpError(403, "Only an admin can change who may edit a board");
  }
  if (!one("select id from users where id = ?", userId)) throw new HttpError(404, "no such person");
  if (role === null) run("delete from board_roles where board_id = ? and user_id = ?", boardId, userId);
  else
    run(
      "insert into board_roles (board_id, user_id, role, set_by, set_at) values (?, ?, ?, ?, ?) on conflict(board_id, user_id) do update set role = excluded.role, set_by = excluded.set_by, set_at = excluded.set_at",
      boardId, userId, role, by.id, Date.now(),
    );
  rec("allowed");
  dropConnections(boardId, userId); // they reconnect under the new role
}

/** everyone who can sign in, with their role on this board and whether it was set for the board */
export function boardPeople(boardId: string) {
  const set = new Map(all<{ user_id: string; role: string }>("select user_id, role from board_roles where board_id = ?", boardId).map((r) => [r.user_id, r.role]));
  return all<{ id: string; name: string; email: string; color: string }>("select id, name, email, color from users order by name").map((u) => ({
    ...u,
    role: boardRole(u.id, boardId),
    account: accountRole(u.id),
    onBoard: set.has(u.id),
  }));
}
