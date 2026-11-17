# The viewer role (2026-11-03)

Isolated copy (client :1440, server :4420 with `FOUNDATION_ADMIN_EMAILS=boss@normal.dev`, a `.backup` of `data/foundation.db`). The admin "Boss Test" is signed in on `localhost:1440`, a member "Kai Test" on `kai.localhost:1440`. Both used the dev login with test addresses.

**Setting a role.** The admin's side pane lists **People on this board** (00). Admins show as Admin; everyone else has a picker: "Member (account)" (the account's role), "Can edit", or "View only". Choosing View only for Kai closed Kai's sync socket; Kai's tab reconnected, read its role again and showed **View only** in the board tab, with no reload (01). Setting Can edit back reversed it the same way.

**Kai as a viewer, trying to write** (all from Kai's tab):

| Attempt | Result |
|---|---|
| Rename the Foundation section (a local edit) | Snapped back at once, with the notice "View only — you can look around…" (02). The admin's board never changed |
| `POST /api/boards/company/tools/add_note` | 403, "View only: this person can read the board…" |
| `POST /api/files?board=company` (upload) | 403, "View only: you can read “company” but not change it…" |
| `POST /api/boards/company/tools/read_board` | 200 (reading is fine) |

Back on Can edit, Kai renamed the section and the admin saw it.

The viewer's sync socket drops updates on the server. `roles.test.ts` covers that, along with refused tools, roles and admin-only setting.

**What a viewer sees.** View-only pill on the board tab (03 night, 04 day). Controls that change the board are hidden: add buttons, section tools, card actions, resize, gutters, ports, New board, new session. Notes don't open for writing. A viewer can still open agent sessions; the agent is told they're view-only and every write tool refuses.
