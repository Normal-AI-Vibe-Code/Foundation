/**
 * Board membership (flowform's room_members, ported for imported rooms).
 *
 * A board with no member rows is open to every signed-in person — the company
 * board and anything made here before membership existed. A board with rows is
 * members-only: a person who isn't on it can't list it, sync it, run tools on
 * it, search it or fetch its files. Admins and the service token pass.
 *
 * Viewer write-dropping is §8 phase 1 (`attachConnection`); this gate is about
 * who can see a board at all.
 */

import type { UserInfo } from "@foundation/protocol";
import { all, one, run } from "./db.ts";
import { HttpError } from "./http.ts";

export type BoardRole = "owner" | "editor" | "viewer";

export function boardIsRestricted(boardId: string): boolean {
  return Boolean(one("select 1 from board_members where board_id = ? limit 1", boardId));
}

export function boardRole(boardId: string, userId: string): BoardRole | undefined {
  return one<{ role: BoardRole }>("select role from board_members where board_id = ? and user_id = ?", boardId, userId)?.role;
}

export function canSeeBoard(user: UserInfo, boardId: string): boolean {
  if (user.role === "admin" || user.id === "agent") return true;
  return !boardIsRestricted(boardId) || Boolean(boardRole(boardId, user.id));
}

export function requireBoard(user: UserInfo, boardId: string | null | undefined) {
  // a restricted board answers like a missing one: its name isn't confirmed to outsiders
  if (boardId && !canSeeBoard(user, boardId)) throw new HttpError(404, "no such board");
}

/** board ids this person can't see (to filter lists and search hits) */
export function hiddenBoards(user: UserInfo): Set<string> {
  if (user.role === "admin" || user.id === "agent") return new Set();
  const rows = all<{ board_id: string }>(
    `select distinct board_id from board_members
      where board_id not in (select board_id from board_members where user_id = ?)`,
    user.id,
  );
  return new Set(rows.map((r) => r.board_id));
}

export function setMember(boardId: string, userId: string, role: BoardRole, source = "foundation") {
  run(
    `insert into board_members (board_id, user_id, role, source, added_at) values (?, ?, ?, ?, ?)
       on conflict (board_id, user_id) do update set role = excluded.role, source = excluded.source`,
    boardId, userId, role, source, Date.now(),
  );
}

export function listMembers(boardId: string) {
  return all<{ user_id: string; email: string; name: string; role: BoardRole; source: string }>(
    "select m.user_id, u.email, u.name, m.role, m.source from board_members m join users u on u.id = m.user_id where m.board_id = ? order by m.role, u.name",
    boardId,
  );
}
