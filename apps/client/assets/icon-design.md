# Foundation app icon

**Four panels on a grid**: two full-width rows over a row split in two, as Josh drew it (2026-11-10). It is Foundation's own floor in miniature: sections laid on a grid, one of them split.

- `foundation-mark.svg` is the drawing itself: 451×418, white panels, corners 5, 23 between rows and 19 between the two bottom panels. Use it as it is on a solid fill or dark ground.
- `foundation-icon.svg` is the app icon: the white panels (560 wide, rows 154 tall, 28 between rows, 24 between the bottom pair, corners 6) centred on a **glass squircle**, a superellipse (n = 5) filling 896 of the 1024 canvas. A still icon can't blur what is behind it, so the glass is drawn: night navy (`#111a2c`) at 62 %, a white sheen fading from 20 % at the top, and a rim lit from above. The backing is there because a taskbar, dock or desktop can be light or dark and the white mark alone would vanish on a light one; it lets some of whatever is behind show through. No blue.
- `public/foundation.svg` is the browser tab's icon: the same file.
- In the app it is `src/brand/Mark.tsx`, drawn in `currentColor`: `tone="pulse"` on paper and glass, `tone="on-fill"` (white) on a solid fill.

Regenerate the desktop icons from `apps/client`:

```bash
npm run tauri -- icon assets/foundation-icon.svg --output src-tauri/icons
```

Then delete the `android/`, `ios/` and `64x64.png` the CLI also writes (the desktop bundle doesn't use them) and copy the SVG to `public/foundation.svg`. Rebuild the executable to embed the new icon; if Cargo keeps a cached Windows icon resource, touch `src-tauri/build.rs` first.
