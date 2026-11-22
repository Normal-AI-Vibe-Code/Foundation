/**
 * Settings → General → People on this server (issue #227).
 *
 * Shown to admins: everyone who has signed in to this Foundation server and
 * their server-wide role (Admin, Member, View only). The last admin on the
 * server cannot be demoted, so the server is never left without an admin.
 */

import { useEffect, useState } from "react";
import type { UserInfo } from "@foundation/protocol";
import { api } from "../lib/api";
import { initials } from "../shell/Presence";
import { toast } from "../state/ui";
import { Group, Seg } from "./SettingsSpace";

export type ServerRole = "admin" | "member" | "viewer";

export interface ServerUser {
  id: string;
  email: string;
  name: string;
  color: string;
  role: ServerRole;
  created_at?: number;
}

const ROLE_OPTIONS: Array<{ id: ServerRole; label: string }> = [
  { id: "admin", label: "Admin" },
  { id: "member", label: "Member" },
  { id: "viewer", label: "View only" },
];

function shortDate(ts?: number): string | null {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return null;
  }
}

export function PeopleSectionView({
  users,
  meId,
  busyId,
  error,
  onRole,
}: {
  users: ServerUser[] | null;
  meId?: string;
  busyId?: string | null;
  error?: string | null;
  onRole?: (userId: string, role: ServerRole) => void;
}) {
  const admins = (users ?? []).filter((u) => u.role === "admin").length;
  return (
    <Group
      title={
        <>
          People on this server {users && <span className="set-count">{users.length}</span>}
        </>
      }
      note="Everyone who has signed in here, and their server-wide role. Admins manage people, places and server tools; members create and edit grids and chat; viewers read grids and join chat where invited. At least one admin stays on the server."
    >
      {error && (
        <div className="set-row people-error" role="alert">
          <span className="set-row-detail">{error}</span>
        </div>
      )}
      {!users && !error && (
        <div className="set-row">
          <span className="set-row-detail">Asking the server…</span>
        </div>
      )}
      {users && users.length === 0 && (
        <div className="set-row">
          <span className="set-row-detail">No people found on this server yet.</span>
        </div>
      )}
      {(users ?? []).map((u) => {
        const lastAdmin = u.role === "admin" && admins <= 1;
        const busy = busyId === u.id;
        const joined = shortDate(u.created_at);
        return (
          <div key={u.id} className="set-row people-row" data-person-email={u.email} data-person-role={u.role}>
            <span className="me-avatar people-avatar" style={{ background: u.color }} aria-hidden>
              {initials(u.name)}
            </span>
            <div className="set-row-text">
              <span className="set-row-name people-name">
                {u.name}
                {u.id === meId && <span className="people-you">you</span>}
              </span>
              <span className="set-row-detail people-meta">
                {u.email}
                {joined ? ` · Joined ${joined}` : ""}
              </span>
            </div>
            <div
              className="set-row-act"
              data-tip={lastAdmin ? "At least one admin must stay on this server" : undefined}
              title={lastAdmin ? "At least one admin must stay on this server" : undefined}
            >
              <Seg
                label={`Role for ${u.name}`}
                value={u.role}
                options={ROLE_OPTIONS}
                disabled={busy || lastAdmin}
                onChange={(next) => onRole?.(u.id, next)}
              />
            </div>
          </div>
        );
      })}
    </Group>
  );
}

export function PeopleSection({ user }: { user: UserInfo }) {
  const [users, setUsers] = useState<ServerUser[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user.role !== "admin") return;
    api<{ users: ServerUser[] }>("/api/admin/users").then(
      (r) => {
        setUsers(r.users);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [user.role]);

  if (user.role !== "admin") return null;

  const changeRole = async (targetId: string, role: ServerRole) => {
    setBusyId(targetId);
    setError(null);
    try {
      const r = await api<{ users: ServerUser[] }>(`/api/admin/users/${encodeURIComponent(targetId)}/role`, {
        method: "POST",
        json: { role },
      });
      setUsers(r.users);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast(msg, "bad");
    } finally {
      setBusyId(null);
    }
  };

  return <PeopleSectionView users={users} meId={user.id} busyId={busyId} error={error} onRole={(id, r) => void changeRole(id, r)} />;
}
