# 2026-11-22 — Whole-app usability, legibility, spacing & motion pass (`jakubkrehel/skills`)

Evidence for SPEC §0.15 and `DESIGN.md` updates.

## Automated checks
- `npm run typecheck` (`@foundation/client`, `@foundation/server`): PASS
- `npm run build` (`@foundation/client` Vite production bundle): PASS
- `npm run check:security`: PASS (`clean (8 waived by the allowlist)`)
- `apps/client/test/design.test.ts`: PASS (4/4 — 0 raw colour literals added, 0 `background`/`color`/`all` transitions)
- `apps/client/test/usability.test.ts`: PASS (11/11 — WCAG 2.2 AA `>= 4.5:1` across all 4 surfaces in Day & Night, `--color-on-fill` across solid fills, 1:1 `packages/ui/src/index.ts` parity, `:focus-visible` + `forced-colors`, `.f-pill:not(:disabled):active`, pure-neutral `--color-media-outline`, and `Spring`/`Spring2D` reduced-motion settlement)
- `apps/client/e2e/usability.spec.ts` (real Chromium against isolated server): PASS (5/5)

## Quantitative deltas across `apps/client/src` & `packages/ui/src`
| Metric | Before | After |
|---|---:|---:|
| Day `--color-dim` worst contrast (`--color-panel`) | 3.12:1 (FAIL) | **4.56:1 (AA PASS)** |
| Night `--color-dim` worst contrast (`--color-raise`) | 3.27:1 (FAIL) | **4.52:1 (AA PASS)** |
| Day `--color-ok` / `--color-warn` / `--color-agent` on `--color-panel` | 4.26 / 4.17 / 4.34 (FAIL) | **4.57 / 4.57 / 4.53 (AA PASS)** |
| `:focus-visible` rules | 31 | **217** |
| `overscroll-behavior: contain` | 11 / 88 scrollers | **92 / 89 scrollers** |
| `scroll-padding-block` declarations | 0 | **61** |
| `text-wrap: balance / pretty` | 2 | **136** |
| `@media (hover: hover)` guards | 0 | **63** |
| `100vh` viewport leaks | 7 | **0** |
| `role="status"` / `role="alert"` / `aria-live` | 31 | **96** |
| `aria-modal` dialogs | 2 | **9** |
| `body` `user-select: none` | global block | **removed (scoped to `.grid-viewport` & drag handles)** |

## Captured screenshots (1440×900, Chromium)
- `01-design-usability-day.png` — `#/design` *Usability & contrast* live specimen in Day (every token measured `>= 4.5:1`)
- `02-design-usability-night.png` — `#/design` *Usability & contrast* live specimen in Night
- `03-grid-day.png` — Main company grid in Day
- `04-command-bar-day.png` — `⌘K` CommandBar (`role="dialog"`, `aria-modal="true"`, high-legibility frosted glass + gentle scrim)
- `05-grid-night.png` — Main company grid in Night (switched via real night orb; WebGL paper + DOM tokens unified)
- `06-today-room.png` — Today (`room` theme, single `<main>`, boosted 74% `--color-dim` legibility over Shiba background)
- `07-chatform-day.png` — ChatForm in Day
- `08-chatform-night.png` — ChatForm in Night
- `09-settings-day.png` — Settings in Day (32px section spacing, readable measure)
- `10-settings-night.png` — Settings in Night

## Not verified
- Physical touch hardware, OS `forced-colors` High Contrast mode, screen-reader voice output (NVDA/VoiceOver), and the packaged Tauri desktop window.
