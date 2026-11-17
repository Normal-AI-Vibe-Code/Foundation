# Character studio: the sheet, the expressions stage, the flow as nodes (2026-11-17)

Josh's three asks, verbatim:

- (a) "The character sheets should be better organized and structured typographically, the text box should be larger and easier to edit, more WYSIWYG and part of the card; draw lines to separate the sections."
- (b) "Run another pass on the Characters for the animals, Mochi is a great example, but I want it when the character sheets are generated to produce robust character sheets with multiple emotions and poses before sending it into mesh avatar studio."
- (c) "I also want to see this flow recreated in the middle of the character studio board as new sections in between the inputs and outputs, it should be showing the flow of generation as nodes, and give the ability for us to output them to the section, that adds and automatically arranges things when we click on a generate button."

SPEC.md, DESIGN.md and docs/plan.json were not edited from this worktree (another session has them). What to put in them is below, word for word.

## What is and isn't done

| | State |
|---|---|
| (a) The card as a sheet: stage, name as an editable title, quiet tags, then *Who it is*, *Stages*, *Pictures*, *Drawn from* under eyebrows with a hairline between, the approval row, the foot | **done**, checked in a browser day and night, at 260 / 400 / 460 / 560 on `#/design` |
| (a) *Who it is* as formatted text on the card (the Text box's editing surface and toolbar), saved on leaving it and on ⌘/Ctrl+Enter with a tick; markdown kept, plain words to the prompts | **done**, checked in a browser and in the server's tests |
| (b) The `expressions` stage for both forms, priced, in the lineage, a reference for the views, optional on older characters | **done against the stand-in Meshy** (server tests and a browser). **Not verified against the real Meshy API**: no real request was sent, so the prompt's results, and whether Meshy takes `aspect_ratio: "4:3"` on `image-to-image`, are unknown |
| (b) The animals' expression sheets | **not generated.** Nothing was spent. One press is 9 credits (one `nano-banana-pro` image); the six animal mesh avatars would be 54. `scripts/characters-expressions.mjs` presses them for a person; it was run only against the stand-in |
| (b) mesh-avatar-studio using the sheet's BLINK and TALKING panels as drawn variants | **not built.** `docs/characters.md` says how it is meant to work and what has to be found out first |
| (c) A node card per stage, joined by the grid's own wires; tiles; Generate; ＋ New; auto-placement into `Characters · <Set>` | **done**, checked in a browser against the stand-in |
| (c) `upgradeStudio` bringing an existing studio (the one flow card) to the nodes | **done in the server's tests** (nothing lost, tracks only grow, once). **Not seen in a browser on an upgraded studio**, and not run on the owner's live studio (his server on :4410 runs older code and was not touched) |
| A viewer on the nodes (no Generate, no ＋ New) | written, **not checked in a browser** (the card's viewer state is on `#/design`) |
| The studio grid's frame rate with 27 more cards and 27 wires | **not measured** (`e2e -- frames` and the perf trace were not run on it) |

## How it was checked

- `npm test` (client 153, extension 9, server 261, slack-agent 48: all pass) and `npm run typecheck`.
- `apps/server/test/characters.test.ts` (15): the six stages of a 3D character with the expressions sheet's request (one reference, 4:3, the eight labels, full body), the views naming it as their second reference by hash, the card moved to *Characters* when the clips land and not before; a mesh avatar from before expressions (not held back; *Add expressions* is one image and leaves the portrait, the `.mavatar` and `ready` alone; the sheet again clears it); a finished mesh avatar moved, one kept in a person's own section left; `plainWords`; the starter set without an expressions role.
- `apps/server/test/studio-pipeline.test.ts` (4): a new studio's nine nodes and nine links per set, left to right, none overlapping, the band one block; a studio from before the pipeline; **a studio of 2026-11-16 with its one flow card, a card in the making, a finished card and a note: every one of them still there and unchanged after the upgrade, the flow card now the first node, a narrower column grown and a wider one left, and a second upgrade (and one after a person removes a node) changing nothing.**
- `apps/client/e2e/character-studio.spec.ts` (9) and the rewritten `e2e/council.spec.ts` (8), run together on ports above 15000 (`E2E_SERVER_PORT=16131 E2E_CLIENT_PORT=16151 E2E_SLACK_PORT=16141 E2E_MESHY_PORT=16145 E2E_T3_PORT=16195 npm run e2e -w @foundation/client -- council.spec character-studio`): 17 pass. `one-interface` and `card-chrome` (12) still pass.
- The pictures here were looked at, day and night.

One thing seen while checking: with both specs on one server, `council.spec.ts`'s "the card plays it live" failed twice in about ten runs (the 3D stage stayed a still for 15 s) and could not be made to fail again with the state being printed. The spec now puts the pointer on the card's stage first (the sheet is longer than its card, and the last press is at its foot). Whether that was the cause is **not established**; if it shows again, the frame budget (`characters/stageBudget.ts`) is where to look.

## The pictures

| | |
|---|---|
| `01_flow-empty-night.png` | a set's pipeline: nine node cards and the grid's wires between them |
| `02_new-character-form-night.png` | ＋ New on the Sheet node: a name, a line, the inspiration to draw from |
| `03_card-writing-night.png` | *Who it is* while writing: bold and a list as formatted text, the toolbar, "not saved yet" |
| `04_tile-at-expressions-night.png` | after Generate on the Sheet node: the tile at Expressions, the card docked under the band |
| `05_card-expressions-night.png` | the expressions sheet large on the card (the stand-in's eight panels) |
| `06_tile-at-output-night.png` | the `.mavatar` brought in from the Mesh avatar node: the tile at Output, waiting for approval |
| `07_placed-in-characters-night.png` | three finished cards placed in `Characters · Abstract`, side by side |
| `08_add-expressions-night.png` | a character from before expression sheets: *Add expressions · 9* |
| `09_flow-day.png`, `10_card-day.png` | the flow and the card by day |
| `11_design-card-{260,400,460,560}-{day,night}.png` | the card on `#/design` at each width |
| `12_design-flow-{day,night}.png` | the flow on `#/design` |

The figures in them are the stand-in's (a head and a block). No real character is shown.

## Decisions the owner might want differently

1. **Real cards and real wires**, not one wide card. Tried first, and it works: a `pipeline` panel carries ports, and nine `LinkDoc`s per set are drawn by the grid's wire layer. The cost: 27 more cards and 27 wires on the studio; the nodes can be dragged and a wire deleted like any other (the server doesn't put them back).
2. **The studio's columns grow from 1,560 to 2,060 px and the pipeline row from 1,040 to 1,490 px** (new studios; an upgrade only ever grows a track, and leaves a section a person stretched across several). Eight columns of 200 px nodes don't fit 1,560 at full size; the alternative was the whole band drawn at 79 %. Inspiration and Characters get wider with it.
3. **The band is two lanes**: Mesh avatar over Meshy model → Skeleton → Moods, with the first four nodes and Output as tall as both, so nothing docked fits beside a short node and cards in the making start under the band (the section's flow would otherwise put a third card over the first).
4. **The expressions sheet never clears later stages** (every other stage does). So *Add expressions* on a finished character is safe, and *Again* on a new one doesn't throw away views already paid for; the price is that views drawn before a redrawn expressions sheet aren't redrawn to match unless a person presses them.
5. **The server lets `views` run without `expressions`** (it uses whatever references there are); the card and the nodes are what put expressions first for a new character. Stricter would break nothing but the old path.
6. **A finished card moves only out of a `Pipeline · …` section.** One made by right-click in a section of your own stays there.
7. **A new character's card is 460 × 720** (was 620): the sheet is longer. Existing cards keep their size. The card scrolls; it doesn't try to fit.
8. **The identity's limit is 1,600 characters** (was 1,200): markdown marks count toward it.
9. *Who it is* keeps its draft on the card and saves on leaving / ⌘↵; it is not live-shared keystroke by keystroke as a Text box is (the character's state is the server's map, which people can't write).
10. `add_character` (an agent) and the section menu still put a new card where they did (an agent's goes to `Characters · <Set>`); only ＋ New on the Sheet node starts one in the Pipeline section.
11. The mesh form's expressions sheet is drawn on the portrait's mid-grey; the 3D form's on off-white, like its sheet.
12. On `#/design` the pictures are plain grey stand-in figures (there is no archive on that page).

## DESIGN.md: the two rows, replaced

**Character card** (replace the whole row):

> | **Character card** | One avatar's sheet (☺ in the card's header; 460 × 720 when made, and it scrolls: the sheet is as long as it needs to be. 2026-11-17, Josh: "better organized and structured typographically … draw lines to separate the sections"). A container: it answers to its own width (checked at 260, 400, 560). **The head**: a 250 px stage on `--color-abyss` with a hairline (180 under 300 wide, 300 over 500), the character as it stands (its sheet until it's ready, then live. **Every card draws itself**: the cards on screen play, as many as the frames allow (six to start; a grid that can't hold 30 fps sheds one every two seconds down to one, and takes one back when it has held 50), the card under the pointer always; a card without a place holds its picture, **with its flat ground cut away** (`characters/cutout.ts`). Never an empty frame, never a broken image); under it **the name as a title**, 22/600 with −0.02em (18 under 300), a field with no box: a hairline under the pointer, the pulse tint and a 1 px pulse line while writing; Enter or leaving saves, Esc puts it back; then **quiet tags** on one line in mist 12/500, a dim · between: the set, *3D character* or *mesh avatar*, and *on the council* in violet once ready and approved, *waiting for approval* in warn, *archived* or *next: views* in dim. Ready, a row of mood pills (the one playing on the agent wash) and *chest up / head to toe*. **Then the parts, each under a hairline (`--color-line`) and an eyebrow** (moss 11/600, tracked, uppercase) with a dim aside at its right: **Who it is**: formatted text on the card's own paper, the Text box's surface and toolbar (`panels/CharacterWords.tsx`): no box at rest, 14/1.5, six lines at least and as tall as its words, a hairline under the pointer, the pulse tint and line while writing, the toolbar in the card's flow under it; a plain click writes; leaving it or ⌘/Ctrl+Enter saves, and the eyebrow's aside says *not saved yet*, *saving…*, then **✓ saved** in `--color-ok` for 2.6 s. Kept as markdown; the prompts get the plain words. **Stages** (*2 of 4 done*): rows with an 18 px ring (✓ on `--color-ok` when done, … in violet while running with a 2 px violet progress rule, ! in `--color-bad` when failed with the reason in its place, ＋ on a dashed ring for an optional one), the stage's name 13/600 and what it makes in mist 11; the next stage's button is the primary pill and says its price (*Draw the expressions · 9*); a finished one offers *Again · n* as a plain pill; a character from before expression sheets is offered *Add expressions · 9*; later stages wait at 55 %; under 300 wide a stage's button sits under its words. **Pictures** (*3 kept in the archive*): the expressions sheet first, the card's whole width at 4:3 and never cropped, captioned with its eight panels; then the sheet, back, side and portrait in a grid of 3:4 pictures at least 84 wide, hairline, captioned in dim 11. **Drawn from** (*2 of the animals inspiration*): the set's inspiration as 44 × 56 picks at 60 %, the chosen ones full and ringed violet. Then **a person's word on it**: a row on the panel well (pulse-dim while pending): *Finished. Approve it and agents can wear it.* with **Approve** (the accent pill) and **Archive**; approved, a line and **Archive**; archived, the stage dims to 50 % and the row offers **Restore**. Foot, under a hairline, dim 11: Meshy's balance and the image model, or that Meshy isn't connected. A viewer sees all of it and no buttons. Its ✕ asks first (see Card); removed, the character leaves every council with its card, and what it drew stays in the archive. `panels/CharacterView.tsx`, `#/design` → The council |

**Pipeline card** (replace the whole row):

> | **Pipeline node** (`panel: "pipeline"` with a `node`; the Character studio's middle row, 2026-11-17, Josh: "showing the flow of generation as nodes … that adds and automatically arranges things when we click on a generate button") | Between a set's Inspiration and its Characters, a section *Pipeline · <Set>* holding the flow as **nine node cards joined by the grid's own wires** (links between the cards' ports: see Wires), in a band across its top: *Inspiration* → *Sheet* → *Expressions* → *Views* → *Mesh avatar* → *Output*, and under Mesh avatar the 3D lane *Meshy model* → *Skeleton* → *Moods*, which rejoins at Output. A node is a card 200 wide (290 tall in a lane; the first four and Output 620, both lanes), 56 between columns for a wire to turn, 40 between lanes. In it: a moss eyebrow 11/600 for what does it and what a press costs (*Image model · 9 credits*, *9 or 18 credits*, *By hand · no credits*), its name 16/600, **Takes** and **Makes** as two quiet lines (labels dim 11/600, words mist 11) over a hairline, then **the characters of this set that are at it** as tiles: a 32 × 42 picture (✦ before anything is drawn), the name 12/600 and a dim line (*mesh avatar*, *3D*; *working · 40%* in violet with a breathing violet bead and a 2 px progress rule; the reason in `--color-bad` when it failed; *waiting for approval* in warn at Output), and **Generate · n**, the primary pill across the tile, with the price on it (*Try again · n* after a failure, *Bring in .mavatar* on the Mesh avatar node). A person's press, the same as the card's button. When the stage lands the tile is at the next node; pressing a tile opens the character's card. At the foot, 12/600 tabular: *2 here · 1 working* (violet while one runs), *none here* in dim, Output *3 approved · 1 waiting*; on the Sheet node **＋ New**, which turns the node into a short form (a name, a line of who it is, *Mesh avatar* or *3D*, the set's inspiration as 30 × 38 picks, **Add at Sheet** as the accent pill). The Inspiration node shows up to twelve of the set's pictures and how many there are. Cards in the making sit docked under the band; a finished one is put into *Characters · <Set>* by the server, where the section's flow places it. A viewer sees the nodes and no buttons. A studio's one flow card of 2026-11-16 draws the same nodes in one frame, with its wires as a 9 px road and a 2 px `--color-wire` line, until the server has upgraded it. `panels/PipelineView.tsx`, `#/design` → The council |

## SPEC.md

**§0, a new 0.7** (or appended to 0.6):

> ### 0.7 The character sheet, expression sheets, the pipeline as nodes (Josh, 2026-11-17)
>
> **The ask.** The character card better organised and typographically structured, lines between its sections, its text box larger, easier to edit, more WYSIWYG and part of the card. Character sheets that are robust, with several emotions and poses, before a character goes to mesh-avatar-studio; another pass on the animals. The flow recreated in the middle of the studio as nodes between the inputs and the outputs, with a Generate button that adds to the section and arranges it.
>
> **What was built, and what was not.** Built: the card as a sheet (a title you can write in, quiet tags, *Who it is* as formatted text on the card that saves with a tick, parts under eyebrows and hairlines); an `expressions` stage after the sheet for both forms (one 4:3 picture of eight labelled panels drawn from the sheet, 9 credits, in the lineage, then a reference for the views; optional on characters made before it, and it never clears a later stage); a set's pipeline as nine node cards joined by the grid's wires, each with the characters at it as tiles and **Generate** with its price, **＋ New** on the Sheet node, and a finished character's card put into `Characters · <Set>` by the server; `upgradeStudio` for a studio with the one flow card. **Not done** (said here rather than implied): no expression sheet has been generated for any existing character, the animals included (9 credits each; `scripts/characters-expressions.mjs` presses them for a person); the stage has only run against the stand-in Meshy, so its prompt's real results are unseen; mesh-avatar-studio does not yet use the sheet's closed-eye and open-mouth panels as drawn variants (`docs/characters.md` describes the intended step); the upgrade has not been run on the live studio.
>
> **What shows it's right.** `apps/server/test/characters.test.ts` (15), `studio-pipeline.test.ts` (4), `apps/client/e2e/character-studio.spec.ts` (9), `e2e/council.spec.ts` (8). Evidence: `docs/evidence/2026-11-17_character-studio/`.

**§3 Feature status** (the Character studio's lines; adjust to the table's wording):

> - Character card as a sheet; identity as formatted text saved on the card: **done** (browser, day and night, 260 / 400 / 460 / 560).
> - Character pipeline: `expressions` stage (both forms): **partial**: built and tested against the stand-in; not run on the real Meshy; no existing character has one.
> - Character studio: the pipeline as node cards with Generate, ＋ New and auto-placement: **done** against the stand-in; the upgrade of an existing studio is tested on the server and **not verified** on the live one.
> - Mesh avatars: drawn variants (closed eye, open mouth) from the expressions sheet: **not started**.

**§7 Known issues** (new lines):

> - **The animals' expression sheets were not generated** (nor anyone else's). The stage exists; each is one press, 9 credits. `node scripts/characters-expressions.mjs --set animals` lists them and the cost; `--press` with `FOUNDATION_SESSION` spends them.
> - **The expressions prompt has never met the real image model.** The eight-panel grid, the labels, the mesh form's "same place in every panel" and `aspect_ratio: "4:3"` on Meshy's `image-to-image` are all unverified. The first real press should be looked at before the rest are spent.
> - **Mesh avatars still have no drawn variants.** The expressions sheet is drawn to be their source (BLINK, TALKING), but nothing cuts or registers them, and mesh-avatar-studio's rig format hasn't been checked for taking them.
> - **The live studio hasn't been upgraded.** It happens the next time someone opens the studio (⌘K) on a server running this code: the flow card becomes the Inspiration node, eight more nodes and nine wires per set are added, each set's column grows to 2,060 px and the pipeline row to 1,490 px. Tested on the server; not watched in a browser on a studio with twenty-two characters.
> - **A redrawn expressions sheet doesn't redraw the views.** By design (it clears nothing); a portrait drawn before it won't match it until *Views* is pressed again.
> - **The studio grid has 27 more cards and 27 wires.** Its frame rate wasn't measured.
> - **Two cards of the same picture in an Inspiration section show as two picks that toggle together** on a character card (they are one file). Seen while testing; there before this work.
> - **`council.spec.ts` "the card plays it live" failed twice in about ten runs** when run after `character-studio.spec.ts` on one server (the stage stayed a still). The spec now points at the stage first; the cause wasn't established.

## docs/characters.md: what changed

- The intro says the expressions stage and the nodes have only run against a stand-in.
- *On the board*: step 3 says *Who it is* is formatted text kept as markdown and that prompts get the plain words; the stage table has an **Expressions** row; a 3D character is about 95 credits (was 86), a mesh avatar 27; a finished card is moved to *Characters* and approved there.
- New **The pipeline row**: the nodes, tiles, Generate, ＋ New, auto-placement, what the nodes are in the document, what the upgrade does.
- New **The expressions sheet**: the eight panels and their order, what each form's looks like and why, that the views are drawn from the sheet and it, that it replaces nothing and is optional on older characters, **that no existing character has one**, the script, what to look for before going on.
- New **How mesh-avatar-studio is meant to use it (not done yet)**: BLINK as the closed-eye variant, TALKING as the open-mouth one, the others as references; what has to be found out first.
- *A mesh avatar, by hand*: step 1 and the "no drawn variants" note point at the sheet.
- *The starter set*: the `expressions` role is optional in the manifest.
- *Where things are*: the new file role, protocol, client files, scripts, checks and evidence.

## Plan cards

- **Done / Review**: "Character card as a sheet: typographic structure, lines, identity as formatted text" · "Expressions stage in the character pipeline (stand-in verified)" · "Character studio: the pipeline as nodes with Generate and auto-placement".
- **Needs you** (it spends credits): "Press the expressions sheet for one animal (Mochi, 9 credits) on a server running this code, look at it, then the other five (45)".
- **Next**: "mesh-avatar-studio: drawn closed-eye and open-mouth variants from the expressions sheet's BLINK and TALKING panels (try on one character, write down what happened)" · "Open the live studio on the new code and look at the upgraded layout with all twenty-two characters; measure its frames" · "Viewer check for the pipeline nodes in e2e".
