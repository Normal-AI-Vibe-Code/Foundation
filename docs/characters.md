# Characters: how the council's avatars are made

The council (☺) seats each agent at work as a character. Characters are made on the **Character studio** board (⌘K → *Open the Character studio*), a stage at a time. This is how, what each stage sends, and what was learned making the first eleven on 2026-11-14 and the animal set again, as mesh avatars, on 2026-11-15.

The pipeline is WildChild's (`C:\Dev\WildChild\tools\meshy_hunter_v8_pipeline.mjs`) with the Vision Archive's rules about lineage; the mesh avatars are [mesh-avatar-studio](https://github.com/shinshin86/mesh-avatar-studio)'s.

## On the board

1. **Inspiration.** Drop pictures into a set's *Inspiration* section (`Inspiration · Anime`, `· Animals`, `· Abstract`, or a section you name `Inspiration · <Set>`). They set the style, mood and palette; a character is never a copy of one.
2. **Add a character.** Right-click a section → *Character: 3D* or *Character: mesh avatar* (or ⌘K → *Add a character to this section*; an agent can with `add_character`). In a `Characters · <Set>` section it joins that set.
3. **Say who it is**, in a line or two: what it is, its colours, what it wears, its proportions. Pick up to five inspiration pictures on the card.
4. **Press the stages**, looking at what comes back before paying for the next. Each button says its cost.

| Stage | 3D character | Mesh avatar | Credits |
|---|---|---|---|
| Sheet | the front view, in an A-pose | the front view, standing | 9 |
| Views | the back and one side, turned from the sheet | a head-and-shoulders portrait on a flat grey ground | 18 / 9 |
| Model | a textured model from the views (`multi-image-to-3d`, Meshy 7.1, 30k triangles, 2K texture) | | 30 |
| Skeleton | Meshy's rig (24 joints), at the height on the card | | 5 |
| Moods | one file with a clip per mood | | 24 |
| Mesh avatar | | a `.mavatar` built with mesh-avatar-studio, brought in | 0 |

A 3D character is about 86 credits and five minutes of waiting (the clips take the longest). When its last stage lands it is **on the council**: try its moods on the card.

Images are drawn by `nano-banana-pro` through Meshy (`MESHY_IMAGE_MODEL` changes it). Every request is kept with its prompt, model, who pressed it and the hashes of its references: `GET /api/boards/:board/characters/:panel/tasks`.

## What makes a good sheet

- **Two legs, an A-pose, nothing in the hands.** Meshy's rigging only fits bipeds, face toward the camera. Animals and blobs are drawn standing upright with short arms and legs that are clearly separate from the body ("the body is the head; the arms and legs are clearly separate from it" got a flame creature rigged).
- **Say the proportions.** "Chunky vinyl-toy proportions, about two and a half heads tall" gives a figure that reads at 124 px.
- **Keep props off.** A backpack or a scarf end becomes part of the skinned mesh.
- **Look at the views before the model.** A side view that comes back three-quarter contradicts the front and makes a contradictory mesh: press *Views* again instead. All ten turnarounds on 2026-11-14 came back true.
- **No pose conversion.** The model request leaves `pose_mode` out: the sheet is already posed, and Meshy's conversion stretched stylised bodies into human proportions in WildChild.

## The moods

`packages/protocol/src/characters.ts` holds the mood machine and each mood's clip in Meshy's library (`GET /openapi/v1/animations/library`, 678 clips). The clips were chosen by measurement, not by name: sixteen were generated on Mochi's skeleton and each one's shoulder yaw sampled across the clip.

| Mood | Clip (action id) | Shoulders turn | Why |
|---|---|---|---|
| idle | Idle 3 (243) | −6°..5° | the library's plain "Idle" (0) swings −55°..100° |
| thinking | Confused Scratch (36) | −29°..19° | reads as thinking |
| working | Talk with Right Hand Open (314) | 9°..24° | "Checkout Gesture" (34) turns to 44° |
| talking | Talk with Hands Open (313) | 10°..19° | |
| happy | Victory Fist Pump (403) | 2°..4° | "Victory Cheer" (59) spins −70°..63° |
| sad | Head Hold in Pain (391) | −39°..51° | a beat; it turns away, which suits it |
| surprised | Shrug (317) | 6°..10° | "Look Around Dumbfounded" (333) turns its back |
| waving | Big Wave Hello (28) | −5°..10° | |

To try others: `rigging` task id + `action_ids` → one GLB; load it and sample `atan2` of LeftArm − RightArm over each clip. Changing a mood's clip means pressing *Moods* again on each character (24 credits).

The clips' GLB is what a seat plays: it carries the skinned, textured mesh. The hips' horizontal travel is taken out when it loads, so a clip stays on its spot.

## A mesh avatar, by hand

The mesh stage isn't a button yet (SPEC §7): the rig is coordinates read off grids, which needs an agent with vision. In a Claude Code session, with [mesh-avatar-studio](https://github.com/shinshin86/mesh-avatar-studio) cloned beside Foundation (`C:\Dev\mesh-avatar-studio`), Node 22.17+, Python with `uv`, and Playwright's Chromium (`npm run doctor` there says what's missing):

1. **The portrait.** Download the character's portrait from its card (the *portrait* picture) and cut its ground away: a flood fill of the ground's colour from the border, then from any enclosed patch of it (the gaps inside loops of hair), a 1 px erode and a slight blur on the alpha, cropped to what's left. The pipeline draws portraits on flat mid-grey for this. **Don't ask Meshy to remove the background**: `remove_background` took a white-haired character's hair and blouse with it.
2. **Calibrate.** `uv run tools/vision-check.py make work/vision-check`, read the twelve markers, `… score`. It must pass (median ≤ 4 px) before anything is traced.
3. **Project and survey.** `uv run tools/new-project.py <portrait.png> <name>`, then `uv run tools/grid.py projects/<name> --step 50 --out projects/<name>/work/grid-full.png`. **Read coordinates from the grid's labels, not from where things sit in the picture**: the grid image has margins and its own scale.
4. **Zoomed grids** for each eye (5 px), the mouth and anything hanging: `--region x0,y0,x1,y1 --step 5`.
5. **The rig draft** (`projects/<name>/rig.draft.json`; fields in `docs/rig-fields.md`): head and body ellipses and bands, the face ellipses, each eye's `opening` (the white and iris inside the lashes, about 18 points, clockwise from the image-left corner) and `roi` (10–20 px outside the lashes; keep bangs out), the mouth line, cheeks, hair strands root to tip, earrings as `accessories`, the fine mesh rectangle around the head.
6. **Check.** `npm run validate-rig -- projects/<name>/rig.draft.json`, then `uv run tools/overlay.py projects/<name> --rig rig.draft.json --out …/overlay.png` and `--part eyes --zoom`. Look at them.
7. **Build and review.** `uv run --with numpy --with pillow --with opencv-python-headless tools/build-layers.py projects/<name> --rig rig.draft.json`, then `npm run render-poses -- projects/<name>`: 64 images in `review/`. Closed eyes must close to one clean line; a ±30° turn must not tear; the mouth must open without pulling the chin.
8. **Pack and bring in.** `npm run pack-avatar -- projects/<name>` → `projects/<name>.mavatar`. On the card: *Bring in the .mavatar*.

All five of the anime set took one pass each (2026-11-14), about ten minutes apiece once the first was done. What came up:

- **Keep an eye's `roi` off anything that isn't the eye.** Sora's left lashes reach her hair's outline: with the outline inside the region, a blink smeared it; clamping the region to the skin side fixed it (the lash tips then stay still).
- **Glasses**: keep each `roi` inside its lens and the frames are untouched by a blink (Rin).
- **Only red earrings swing** (`accessories` isolates by redness); others ride with the head.
- Without drawn variants a closed eye keeps faint crease lines; that is the guide's documented "good enough".

The source pictures stay on this machine in mesh-avatar-studio's `projects/`, which it never commits.

### Animal faces (2026-11-15: Mochi, Kumo, Taro the shibas and Sage the snow monkey)

The animal set was first made as rigged 3D (Mochi, Sage) and remade as mesh avatars from the animal photos, two passes each at most. Say in the character's words that it faces the viewer **with both eyes open and the mouth closed**: the references all have their eyes shut, and a mesh avatar can't blink an eye that was never drawn open.

- **Eyes.** Trace `opening` to the inside edge of the dark rim, or for a rimless solid eye to its true outer edge. Never inset it into the dark: an inset leaves light specks at the seam when the eye is open. A round eye closes to its lower arc (a "U"), and the lid is filled smooth, which shows a little on textured fur. Keep `roi` off the brow spots and the cream muzzle, even if that leaves only 5–8 px of margin.
- **Mouth.** The engine paints the open mouth along one parabola and never moves the nose. For a shiba's "w" mouth, set a short line through its two low points (`halfLen` about half the drawn width, a small positive `bow`) so the mouth opens under the peak, which stays as the upper lip. Put `brow` on the eyebrow spots so expressions move them.
- **Ears** ride with the head (`strands` and `accessories` stay empty). A full-body figure (Taro) takes `body.hip`, so its feet stay planted when the body sways.
- **Flat shapes** (Dot, Quad, Tri, 2026-11-16). Head weight is only a y-band; the head ellipse is just the turn's bump, with no movement at its rim. Put that rim on the silhouette (Dot: the circle; Quad: the inscribed circle; Tri: an ellipse inside the triangle) with `shiftX` around 14–18, and the outline never moves or tears. Park the ear ellipses and unused shoulders as 6 px dots in a clear corner (ears slide up to 9 px in a turn and would dent the edge). A figure with no body takes a `weightBand` below the picture, `body.hip` to plant its base, and clear rows under the base.
- **Rimless eyes** (plain discs: the shapes, Ember, Scout). Trace the true outer edge from the pixels, as a polygon when the eye isn't an ellipse. The closed eye is made from the dark rim around it, and these have none: expect a bare lid with a faint arc, or nothing (Quad's eyes vanish when closed), until a closed-eye variant is drawn.
- **Small mouths.** A mouth under about 30 px wide needs `halfLen` of at least 20: the painted opening is a fixed 20 px tall and only 62 % of the line wide. Don't use `--holes` unless the figure really has enclosed gaps: it punches pinholes in grey highlights. A figure whose own shading is near the ground's grey (Yuki's dress) needs a chroma-aware cut, not a plain flood.
- **Cut-out and packing.** Pale or spiky fur on grey needs a flood tolerance of about 60, checked on a light background and not only a dark one (Sage's fur tips kept a grey fringe at 22). `pack-avatar` refuses to overwrite an existing `.mavatar`: delete the old one before repacking.

## The starter set

Every install starts with the characters there are (twenty-two as of 2026-11-16: four abstract in 3D and again as mesh avatars, three shape characters, five anime and six animal mesh avatars): `apps/server/starter/characters` holds a manifest and each one's pictures and playable file, and the server brings them onto the Character studio board the first time it's made (no key, nothing spent). To change the set, make or retire characters on this computer's studio board and run `node scripts/characters-export.mjs` (every ready character whose card is still on the grid; or name the ones to keep). A character whose card was removed is retired: its record and files stay, and it leaves the set. It re-encodes the pictures as JPEG when `uv` with Pillow is to hand. `FOUNDATION_STARTER_DIR` points the server at another folder; empty turns the set off (the checks run that way).

## Where things are

| | |
|---|---|
| The state | the board's `characters` map (panel id → `CharacterState`), written by the server alone; SQLite `characters`, `character_tasks`, `crew_avatars` |
| The files | the archive (`data/files/<sha256>`), on the studio board: `<Name> sheet.png`, `back`, `side`, `portrait`, `model.glb`, `clips.glb`, `<Name>.mavatar` |
| The server | `apps/server/src/characters.ts` (stages, prompts, the task loop), `meshy.ts` (the client) |
| The client | `apps/client/src/characters/` (the council, the 3D actor, the mesh face), `panels/CharacterView.tsx` (the card) |
| The checks | `apps/server/test/characters.test.ts`, `apps/client/e2e/council.spec.ts` with `e2e/meshy-standin.mjs` |
| The evidence | `docs/evidence/2026-11-14_council-characters/` |
