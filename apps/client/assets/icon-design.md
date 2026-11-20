# Foundation app icon

**Two leaves, one over the other**: a low leaf over one twice its height, each rounded at its top left and bottom right, as Josh drew it (2026-11-19). It replaced the four panels on a grid (2026-11-10), which read small in a taskbar.

- `foundation-mark.svg` is the drawing itself, traced from Josh's image: 1240×1240, white. The low leaf is 396 tall, the tall one 792, 52 between them; every round corner is a quarter circle of radius 396 (the low leaf's whole height). Use it as it is on a solid fill or dark ground.
- `foundation-icon.svg` is the app icon, drawn the way the company's other apps' are (a white mark filling a solid tile): the white mark 704 wide, centred on a **full-bleed tile** (the whole 1024 canvas, corners 230) in night navy (`#111a2c`). Nothing see-through: the glass squircle before it stopped at 896 of the canvas with a 560 mark, and went grey on a light taskbar.
- `public/foundation.svg` is the browser tab's icon: the same file.
- In the app it is `src/brand/Mark.tsx`, drawn in `currentColor`: `tone="pulse"` on paper and glass, `tone="on-fill"` (white) on a solid fill.

Regenerate the desktop icons from `apps/client`:

```bash
npm run tauri -- icon assets/foundation-icon.svg --output src-tauri/icons
```

Then delete the `android/`, `ios/` and `64x64.png` the CLI also writes (the desktop bundle doesn't use them) and copy the SVG to `public/foundation.svg`. Rebuild the executable to embed the new icon; if Cargo keeps a cached Windows icon resource, touch `src-tauri/build.rs` first.
