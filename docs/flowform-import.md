# Flowform → Foundation

How people sign in with their Flowform accounts, and how production Flowform (rooms, cards, media, members) is imported. Decided by Josh on 2026-11-02. Code: `apps/server/src/flowform.ts` (sign-in), `apps/server/src/flowform-import.ts` + `import-flowform-cli.ts` (import), `apps/server/src/members.ts` (board access). Tests: `test/flowform.test.ts`, `test/flowform-import.test.ts`. Evidence: `docs/evidence/2026-11-02_flowform-import/`.

## 1. Sign in with a Flowform account

Foundation doesn't have a Google client of its own here. It hands the person to Flowform's own native sign-in, the one the Flowform desktop client uses:

1. **Foundation sends the person to Flowform.** `GET /auth/flowform/start` redirects to `https://server.formresearch.ai/auth/google/start?cb=http://localhost:<port>/auth/flowform/done/<nonce>`.
2. **Flowform runs the sign-in.** It uses its own Google client, PKCE, JWKS check and signup allowlist. Then it returns `303` to the loopback address with `?session_token=…`.
3. **Foundation checks who signed in.** It calls `GET /auth/me` on Flowform with that bearer token, which answers with `user_id`, `email`, `email_verified` and `role`.
4. **Foundation keeps Flowform's session for downloads.** Encrypted (AES-256-GCM, `data/secret.key`), used only to download the person's Flowform files (`apps/server/src/flowformfiles.ts`). Until 2026-11-11 it was revoked here ("Foundation never keeps another service's bearer token"); Josh chose to keep it so Flowform's files can come in. A refused sign-in's session is still revoked, and Disconnect or Stop (Settings → Services) revokes it.
5. **Foundation creates its own session.** The token is stored hashed, sent in a cookie, and never put in a URL.

Rules:
- The browser that started the sign-in must be the one that finishes it, checked with an attempt cookie.
- The desktop app opens the system browser and polls with a secret that only the window holds.
- Flowform admins become Foundation admins.
- Flowform viewers are refused unless `FLOWFORM_ADMIT_VIEWERS=1`.
- A person is matched by **Flowform user id** first, then by email. Someone the importer already linked keeps their board memberships even if their email address changed.
- Dev login stays available for local work. Turn it off in shared deployments with `FOUNDATION_DEV_LOGIN=0`.

**Status (2026-11-02):** works against production Flowform when Foundation runs on the person's machine. The redirect chain up to Google's account chooser was checked live (`signin.txt`). Only the person can complete Google's own page. **Josh has nothing to set up for local use.** A *hosted* Foundation, one not on loopback, needs Flowform to accept its origin as a sign-in callback. That is a Flowform-side change, written up with Flowform (private).

## 2. What the importer reads

It reads Flowform's own daily data backup (`current.tar.gz`) and never touches the live server:

| Backup path | What it is |
|---|---|
| `data/flowform.db` | `VACUUM INTO` snapshot: `users`, `rooms`, `room_members`, `files` / `file_revisions` / `file_variants`, `room_files`, `primitive_files`, `media_refs`, `foundation_board_actions` |
| `data/rooms/<room>/snapshot.ydoc` | The room's Y.Doc, `encode_state_as_update_v2` |
| `data/rooms/<room>/updates.log` | Later v2 updates, each behind a little-endian u32 length |

**Media is not in the backup.** It lives in Flowform's media bucket, addressed by each rendition's object key (`file_variants.s3_key`; older cards carry the key on the card). The importer takes each file's **`source`** rendition, which is the original upload.

**How the room document is rebuilt:**
1. Apply the snapshot.
2. Apply the log records, in order.
3. Apply every `foundation_board_actions.doc_update` for the room. Flowform replays these on load; one already in the document changes nothing.

Torn or undecodable records are skipped and counted, as Flowform does.

## 3. Mapping

| Flowform | Foundation | Notes |
|---|---|---|
| room | board `ff-<room_id>` (`meta.flowformRoom`) | Flowform's default room ("flowform") is everyone's, so it is imported as an **open** board |
| `room_members` (owner / editor / viewer) | `board_members`, same roles | A board with members is **members-only**: list, sync, tools, MCP, files, search and asks. Admins and the service token pass. **Viewer writes are not dropped yet** (SPEC §8 phase 1) |
| users | users, linked by `flowform_user_id` (then email) | Deleted tombstones and system accounts are skipped. No sessions are created |
| canvas (`board_id` + `canvas` on each card) | one section per canvas, one column each, named by the canvas node's title | Cards keep their Flowform positions: centre → top-left, `float: true`, 160 px in from the section edge |
| `text` (plus sticky notes) | note | Blocks become markdown-ish text: lists, quotes, code, links. Bold, italic, colours and sticky colour are dropped |
| `todo` | note | `- [x] item (due 2026-11-09)`. The assignee is dropped |
| `table` (schema 2) / retired `grid` | table + cells | Column labels become a header row. **Formulas come over as their shown text**: Flowform references are row/column ids |
| `image`, `video`, `video_note` | media + file | Crop, rotation and flip are dropped. Transcripts and thumbnails are not imported |
| `file_reference`, `model_3d`, `model_3d_v2` | file panel + file | The exact `revision_id` the card points at |
| `iframe` / `link_card` | app panel / link panel | |
| files shared with a room but not on its canvas | the board's files (`/api/files?board=`) | **Removed in Flowform → archived here** |
| media whose bytes can't be fetched | a note saying which file and key, e.g. "**drawing.pdf** hasn't arrived from flowform yet (key)" | A re-run swaps in the file if nobody has edited the note |

**Not carried.** Each of these is counted per room in the report:
- `groups`
- `board_connectors` (arrows between cards). Foundation's wires join app ports, not cards.
- `dataflow_connections`
- `directive`, `floor_plan`, `camera_feed`, `map`, `canvas_grid` frames, `board_jump`
- unplaceable cards: no kind, or missing x/y/w/h. Flowform skips these too.

**Re-runs.** The ledger is `flowform_imports`. It records what each Flowform thing became here, plus a hash of its source and a hash of what was written. On a re-run the importer:
- creates what's new;
- updates what changed in Flowform, but only if it is untouched in Foundation;
- leaves alone anything edited here (`kept`) and anything removed here (`removed-here`);
- **never deletes**: cards gone from Flowform stay on the board and are counted as `goneUpstream`.

A re-run with nothing new makes no board writes. File ids are deterministic per (room, key), and Flowform's ready renditions never change, so serving them as immutable is safe.

## 4. Running it against production

**What's needed** (none of it is on a developer machine, and none of it is stored by Foundation):
1. **The backup archive**, `current.tar.gz`: read access to where Flowform keeps its daily backup, including permission to decrypt it. **It holds everyone's data**: keep it off shared disks and delete it after the import. The importer deletes its own extraction.
2. **The media**: read access to Flowform's media bucket. The dry run's JSON report lists exactly the object keys the import needs, so only those need copying.
   - *Fallback without cloud access:* `--media-flowform` with `FLOWFORM_IMPORT_TOKEN` set to a Flowform session for the run. Flowform serves media only to members of a room (admins included), so this covers that person's rooms only.

The exact locations, permissions and commands are kept with Flowform (private), not in this public repo. The shape:

```bash
# 0. stop Foundation's server: it holds boards in memory and would compact over the import
# 1. fetch current.tar.gz (private runbook)
# 2. rehearse: a copy of Foundation's database, nothing kept; the JSON lists every media key needed
npm run import:flowform -w @foundation/server -- ./current.tar.gz --dry-run --json ./plan.json
# 3. copy those keys from the media bucket into ./flowform-media/<key> (private runbook)
jq -r '.boards[].missingMedia[]' plan.json | grep -v '^file '
# 4. import, then read the report (members, sections, cards, files, missing media, not carried)
npm run import:flowform -w @foundation/server -- ./current.tar.gz --media-dir ./flowform-media --json ./report.json
# 5. start Foundation; delete current.tar.gz and flowform-media when satisfied
```

Re-run steps 1–4 at any time to pull later Flowform changes. `--room <id>` limits a run to one room. `--default-room <id>` matches a Flowform server whose default room isn't "flowform".

A read-only export on Flowform's side would let Foundation pull without anyone holding cloud credentials; it is proposed with Flowform (private).
