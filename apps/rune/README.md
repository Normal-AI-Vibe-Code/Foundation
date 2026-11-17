# apps/rune — Foundation's board, drawn by Rune

A second renderer for the board, beside the web renderer and never instead of it.
[Rune](https://github.com/anomalyco/rune) is a Rust GPU UI framework with its own layout, text,
springs and renderer. This crate draws Foundation's grid with it, builds to wasm, and runs on a
canvas through WebGPU in the browser and in the desktop app's webview.

It is off by default. **Settings → Renderer** turns it on for this device and lists, row by row,
what Rune draws the same as the web renderer, what differs, and what isn't there yet
(`apps/client/src/rune/parity.ts`). SPEC §3 and §7 say where it stands.

## Build

```sh
npm run rune:build            # release -> apps/client/public/rune/ (not checked in)
npm run rune:build -- --dev   # quicker to build, about twice the size
```

Needs rustup (`rust-toolchain.toml` pins the toolchain Rune pins, with the wasm target) and the
wasm-bindgen CLI at the version in `Cargo.toml`:

```sh
cargo install wasm-bindgen-cli --version 0.2.129 --locked
```

The first build compiles Rune and wgpu (about three minutes here); after that an edit rebuilds
in about twenty seconds. `npm run build:desktop` runs it first (`--if-able`: without the toolchain
it says so and that build has no Rune). Without a build the app says so and stays on the web renderer.

## How it fits

```
store.ts (the board, its geometry) ──▶ rune/scene.ts ──JSON──▶ scene.rs ──▶ view.rs ──▶ WebGPU canvas
        ▲                                                                      │
        └──────────── rune/host.ts ◀──JSON── bridge.rs (press, move, text) ◀───┘
camera.ts (one camera, both engines) ──▶ setCamera ──▶ two Live values (no view re-run)
```

- **The store is the one writer.** Rune never changes the board: it reports what the person
  did (`bridge.rs`) and `apps/client/src/rune/host.ts` calls the store's own actions. Sync,
  viewers, undo and the server's invariants don't know Rune exists.
- **The store is the one source of geometry.** `scene.ts` hands over sections and cards already
  laid out by the functions the web renderer, the wires and the cursors read, and colours
  already resolved from `packages/ui/src/tokens.css`. If the two engines disagree about where
  something is, one of them has a bug. `SCENE_VERSION` (both sides) guards the shape.
- **One camera.** The grid's springs, wheel, pinch, throw, framing and keys are the same code
  for both engines (`GridViewport.tsx`); it asks `hitWorld` what's under the pointer where the
  web renderer asks the DOM.
- **Web layers stay web.** Wires, cursors and the chrome draw over the canvas.
- **The paper is Rune's.** Rune's web canvas can't be see-through, so `paper.rs` draws the web
  paper's own shader (`apps/client/src/gl/background.ts`, in WGSL) through Rune's compositor
  hook, and a section's dots with it. The page tells it where the pointer is, whether it's
  night, and the time twice a second (the grain); a frame is asked for by moving a live value
  a hair (`lib.rs` `redraw`), because Rune's own clock only runs while it draws.
- **The face is the app's.** `fonts/` holds Hanken Grotesk as TrueType (`scripts/rune-fonts.py`
  unpacks the web bundle's WOFF2); the build copies it beside the wasm and Rune fetches it after
  its first frame. Handed over before the first frame it would replace Rune's built-in faces,
  the code face among them.
- **A note's markdown is Rune's kit's** (`rune-kit`, `markdown`), one top-level block at a time,
  so the blocks can be spaced with the web note's margins instead of the kit's reading-page ones.
- **Web content stays web, as islands.** Apps, pages, machines, maps and video are the web
  renderer's own components, placed over the canvas in a shell of their section
  (`apps/client/src/rune/RuneIslands.tsx`). `isIsland` in `scene.ts` is the one rule: a card is
  drawn by exactly one engine, and Rune is never handed an island. A table is Rune's at rest
  and an island while it's the card in hand.

- **The client decides, Rune draws.** What a section's toolbar or a card's bar offers, and what
  each button does, is `apps/client/src/rune/tools.ts` (the web toolbar's own list). Rune is
  handed `{ id, icon, tone }`, draws the icon (`view.rs` `icon`) and reports the id.
- **Right-clicks are claimed.** Rune's web layer hands a right-click to the browser unless an
  element has `on_secondary_press`; the board's root has one, so the browser's menu never opens
  over it, and a section's reports the point for the client to open the menu at.

## Adding a part

1. Put what it needs in the scene (`scene.ts` and `scene.rs`, and bump `SCENE_VERSION` in both).
2. Draw it in `view.rs` with the web renderer's own values (name where each comes from).
3. Report any new interaction through `bridge.rs` and handle it in `host.ts` with a store action.
4. Check it beside the web renderer (`e2e/rune.spec.ts` takes both engines' pictures of one
   board), then move its row in `parity.ts`. A row turns to *Same* only after that.

## Rune itself

Pre-release: `Cargo.toml` pins a rev of Rune's `dev` branch, the same rev for its kit and for the
four crates Rune patches (bump all six together). Rune's docs are `crates/rune/README.md` and
`WEB.md` in its repo. Found here, 2026-11-12: a web canvas asked to be transparent came out
opaque (its web host never asks WebGPU for an alpha canvas, so Rune paints the paper), and the web
host sets no cursors. Found 2026-11-13: Rune's frame step re-runs the view on many frames of a
pan or a zoom though only live values moved (`e2e/rune-frames.spec.ts` counts them; SPEC §7). Rune takes issues, not
pull requests.
