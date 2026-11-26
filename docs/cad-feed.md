# CAD cards fed by an app

Josh, 2026-11-25: an agent goes into the BOM app, takes the parts' STL files, and puts 3D CAD nodes beside it on the grid. Each node is wired to the app, so when the app's part changes the model does. Cut the wire and the card is an orphan that keeps its last model. Copy the card elsewhere to work on it on its own.

The code is in `apps/server/src/cadfeed.ts` and the tools `add_cad` and `refresh_cad` (in `tools.ts`). The client side is the file card's feed strip and the board's card copy and paste.

## How it works

1. **An app hands over a file.** An app's MCP tool can answer with an embedded resource that has bytes: `{ type: "resource", resource: { uri, mimeType, blob } }`. `call_app_tool` stores that file in the grid's files, the same way an upload is stored: archived, never deleted, at most 64 MB. The agent gets the file id back in the text: `[file f_…: hub.stl, model/stl, 120 KB — kept in this grid's files; add_cad shows it in 3D]`.
2. **`add_cad`** puts a CAD card on the grid. A CAD card is an ordinary `panel: "file"` card holding an STL, OBJ, GLB, STEP or IGES model, which the client draws in 3D. There are two ways to give it a model:
   - `file_id`: a model already in the grid's files. The card is a plain one, with no wire.
   - `from: { panel, tool, args }`: the app card and its tool. The card gets a `feed` (`CadFeed` in `packages/protocol`). A wire `LinkDoc` runs from the app card's `cad` port to the card's `model` port. By default the card goes in the app card's section; `section` puts it somewhere else.
3. **The card follows the app while it's wired.** `refresh_cad` asks the app again with the same tool and the same arguments. It runs in four cases:
   - a person presses Refresh on the card (`POST /api/boards/:id/cad/:panel/refresh`)
   - a wire into the card is made again
   - an agent calls it
   - every `FOUNDATION_CAD_REFRESH_MS` (10 minutes by default) while the board is open on the server

   If the app returns the same bytes, the card only records `checkedAt`. If it returns new bytes, they are stored as a new file and the card shows them (`changedAt`); the old file stays in the archive. If the app returns no model or an error, the card keeps its model and says why (`state: "error"`, `note`).
4. **Orphan.** Cut the wire (the wire's Disconnect, or Delete with the wire selected) and the card is no longer asked. It keeps `feed` so it can say where it came from, and shows "Unlinked: keeps its last model". ⌘Z puts the wire back, and the card is asked again at once.
5. **Copy and paste.** A pasted card is a new card with no wires, so a pasted CAD card is an orphan from the start.

## The rules that hold

- Every call to the app is `call_app_tool`'s: the saved app's address, never the card's (apptools.ts), and a person's Allow on that tool on that board. Until a person allows it, nothing is called. `add_cad` makes no card and the agent is told a person was asked. A refresh leaves the card `waiting`, with a note saying whose press it needs.
- A timed refresh runs through `runTool` under the name of the person who set the card up (`feed.by`). So the role check (a viewer's card is never refreshed), the audit row and the board's activity are the same as for any call. Nothing on a timer starts a run of anything, spends money, or reaches an address nobody saved.
- `feed` is written by the server alone.

## What the app has to offer (PartForm / "Airform BOM")

PartForm (`partform.apps.normallab.co`, the card named "Airform BOM") signs people in through OnShape, and its parts' geometry lives in OnShape. On 2026-11-25 it had no MCP endpoint and no public API. Its pages call its own server functions, and `/api/part-image`, `/api/documents/…` and `/api/part-references` sit behind its sign-in. So no agent can reach its STLs yet. What it needs, on the PartForm side:

1. An MCP endpoint (streamable HTTP, e.g. `/mcp`) that takes a bearer token Foundation holds.
2. A tool that lists parts, e.g. `list_parts { query? } → [{ id, number, name, revision }]`.
3. A tool that returns a part's model, e.g. `part_model { part } →` a `text` line naming the part and revision, plus one `resource` block: `{ uri: "partform://parts/<id>.stl", mimeType: "model/stl", blob: <base64> }`. Inside PartForm this is OnShape's STL export of the part (`GET /api/partstudios/d/{did}/{wvm}/{wvmid}/e/{eid}/stl?partIds=…`, units in millimetres), made with the signed-in account's OnShape token.
4. Then a person saves the app in Foundation's app registry with that MCP address, and the card's `mcp` is set to it.

From then on, "pull the CAD out of Airform BOM into the section on the right" goes like this: `app_tools`, then `call_app_tool list_parts`, then one `add_cad { from: { panel, tool: "part_model", args: { part } } }` per part. The first call asks a person to press Allow on the card.

The tests use a stand-in app with exactly that tool: `apps/server/test/cadfeed.test.ts`.
