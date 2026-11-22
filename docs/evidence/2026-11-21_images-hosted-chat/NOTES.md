# Verification Evidence — Progressive Cached Images & Hosted ChatForm (`2026-11-21`)

End-to-end verification in real Chromium browsers (`@playwright/test` 1.64.1, `1440×900` @ `1x` DPR, Day & Night themes) covering:
1. **Progressive Cached Images & Server LODs** (`apps/client/e2e/progressive-images.spec.ts`)
2. **Hosted Foundation, ChatForm, Bearer Image Cache, Local-Feature Boundaries & Admin People** (`apps/client/e2e/hosted-chat.spec.ts` — plan card `hosted-chat-check`, issue #230)

---

## 1. Exact Commands & Pass / Fail Summary

```powershell
# Suite 1: Progressive Cached Images & #/design Day/Night Verification
$env:E2E_SERVER_PORT='15430'; $env:E2E_CLIENT_PORT='15450'; $env:E2E_SLACK_PORT='15440'; $env:E2E_MESHY_PORT='15445'; $env:E2E_T3_PORT='15495'
npm run e2e -w @foundation/client -- progressive-images.spec.ts

# Suite 2: Self-Contained Hosted Server + Cookie & Desktop Bearer ChatForm + Boundaries + Admin People
$env:E2E_SERVER_PORT='15430'; $env:E2E_CLIENT_PORT='15450'; $env:E2E_SLACK_PORT='15440'; $env:E2E_MESHY_PORT='15445'; $env:E2E_T3_PORT='15495'
npm run e2e -w @foundation/client -- hosted-chat.spec.ts

# Typecheck & Security Gate
npm run typecheck -w @foundation/client
npm run check:security -- --diff origin/main --tree-if-no-ref
```

| Suite / Check | Result | Pass / Total | Duration |
| --- | --- | --- | --- |
| `apps/client/e2e/progressive-images.spec.ts` | **PASS** | **4 / 4** (0 failed) | `53.2 s` |
| `apps/client/e2e/hosted-chat.spec.ts` | **PASS** | **4 / 4** (0 failed) | `60.0 s` |
| `npm run typecheck -w @foundation/client` | **PASS** | `0 errors` | `~4 s` |
| `npm run check:security -- --diff origin/main --tree-if-no-ref` | **PASS** | `0 findings` | `~2 s` |

---

## 2. Measured Progressive Image & Cache Numbers (`progressive-images.spec.ts`)

### Test 1 — Server LOD Byte Savings & Cold Grid Load
Uploaded two high-resolution images to a fresh grid at normal card dimensions (`360×270` and `300×300`) and opened the grid in a brand-new cold browser context:

| Asset | Natural Dimensions | Original Size | Cold Grid Tier Requests | Transferred Bytes | `X-Image-Alpha` |
| --- | --- | --- | --- | --- | --- |
| `stator-2048x1536.jpg` | `2048 × 1536` | `2,001,223 B` (`1,954.3 KB`) | `?w=64` (`1,159 B`) + `?w=256` (`7,349 B`) | `8,508 B` (`8.3 KB`) | `"0"` |
| `rotor-alpha-1024.png` | `1024 × 1024` | `714,842 B` (`698.1 KB`) | `?w=64` (`2,078 B`) + `?w=256` (`33,505 B`) | `35,583 B` (`34.7 KB`) | `"1"` |
| **Combined Total** | — | **`2,716,065 B` (`2,652.4 KB`)** | **4 tier responses (`0` original fetches)** | **`44,091 B` (`43.1 KB`)** | — |

- **Measured Byte Reduction**: **`98.4%`** (`2,652.4 KB` → `43.1 KB`, well above the `> 75%` target).
- **Headers Verified**: Numeric `X-Image-Level` (`"64"`, `"256"`), `X-Image-Natural-Width` (`"2048"`, `"1024"`), `X-Image-Natural-Height` (`"1536"`, `"1024"`), and `X-Image-Alpha` (`"0"` opaque JPEG, `"1"` transparent PNG -> `.media-card.is-clear`).
- **L2 Cache Population**: `caches.open("foundation-image-cache-v2")` stored all **4** tier entries immediately on cold load.

### Test 2 — L1 Instant Remount, L2 Reload Persistence & Logout Wipe
- **L1 Synchronous Remount**: Unmounted both `MediaView` cards (`0` cards in DOM, `refs` dropped to `0`) and mounted two new cards referencing the same `/files/<id>` URLs → rendered synchronously with `blob:` URLs on frame 1 and **`0` network requests**.
- **L2 Persistent Cache Across `page.reload()`**: Reloaded the browser tab and waited for board sync + sharp image decode → **`0` network requests** to `/files/` (100% served from `foundation-image-cache-v2`).
- **Sign-out Cache Wipe**: Clicked **Sign out** in `#/settings/general` (`logout()` → `clearImageCache()` + `POST /auth/logout`) → verified `await caches.has("foundation-image-cache-v2") === false`.

### Test 3 — ChatForm Image Attachment (`w`/`h`), `?w=512` Inline & Lightbox Upgrade
- Uploaded a `1600×1200` JPEG to `board=chat` and posted in `#general`:
  - `GET /api/chat/channels/<general>/messages` returned `files[0].w === 1600` and `files[0].h === 1200`.
  - `.chat-picture` rendered with `style="aspect-ratio: 1600 / 1200;"` so layout space was reserved before decode.
  - Inline `<ProgressiveImage>` resolved to `data-prog-phase="sharp"` at `data-prog-tier="512"` (`img.naturalWidth === 512`, `img.naturalHeight === 384`), never downloading the `1600×1200` original while inline.
  - Clicking `.chat-picture` opened `.chat-lightbox` immediately in `data-prog-phase="sharp"` (zero blank `"well"` flash, reusing cached `512` L1 tier) and upgraded seamlessly in the background to `data-prog-tier="orig"` (`1600×1200`).

### Test 4 — `#/design` Day & Night Interactive Specimens
- Verified **"Progressive cached images"** interactive buttons (`Shed off-screen VRAM` → `shed -> 64w`, `Simulate L1 hit` → `L1 hit · 0 ms`, `Replay cold load` → `well` → `64w · 1.4 KB` → `512w · 42 KB`) in Day and Night themes via `NightOrb`.
- Verified **"People on a hosted server"** (`PeopleSectionDemo`) last-admin demotion lock on Ada, role promotion for Kai (`member` → `admin`), and Day/Night theme rendering.

---

## 3. Hosted Foundation & ChatForm Checks (`hosted-chat.spec.ts`)

Spun up a self-contained hosted environment with zero `/etc/hosts` changes:
- **Stand-in Google OAuth**: loopback account chooser, `/token`, and `/userinfo`.
- **Hosted Foundation Server**: `FOUNDATION_PUBLIC_URL=http://foundation.localhost:<port>`, `FOUNDATION_CLIENT_DIR=apps/client/dist`, `FOUNDATION_ALLOWLIST=@formindustries.co`, `FOUNDATION_ADMIN_EMAILS=ada@formindustries.co`, `FOUNDATION_DEV_LOGIN=0`.
- **Simulated Tauri Desktop App Origin**: `http://localhost:<appPort>` pointed at `http://foundation.localhost:<port>` (`BEARER === true`).

| Check | Measured Outcome |
| --- | --- |
| **Ada browser Google sign-in** | Arrived as `admin` (`ada@formindustries.co`); `foundation_session` cookie set (`HttpOnly`, `SameSite=Lax`); email dev-login hidden |
| **Outsider allowlist gate** | `someone@gmail.com` received `"Sign-in didn't finish"` (`not on Foundation's allowlist`) and `0` session cookies |
| **Kai desktop device-code sign-in** | Window & browser showed matching `XXXX-XXXX` code; `0` bearer before `"This is me"`; after press, arrived as `member` with `Authorization: Bearer` (`0` cookies, token never in any URL) |
| **Live `#general`, mentions & unread badge** | Ada's `@kai.moreno` post incremented Kai's `[data-chat-badge]` to `"1"` on `#/today`, highlighted `.chat-mention.is-me`, and cleared to `0` when read |
| **Threads, reactions & DMs** | Live thread reply (`1 reply` summary), live `👍` reaction pill, and private DM creation with unread badge (`1`) & bidirectional live replies |
| **Hosted ChatForm progressive images & bearer L2 cache** | `1600×1200` JPEG displayed at `data-prog-tier="512"` (`?w=512`, `0` original fetches) in both cookie browser and cross-origin bearer desktop window; desktop window stored **2** entries in `foundation-image-cache-v2` and survived `kai.reload()` with **`0` network image requests** |
| **Offline drop & live reconnect** | Dropped Kai's network (`setOffline(true)`), Ada posted in `#general`, restored network (`setOffline(false)`) → message arrived automatically with zero reload |
| **Hosted local-feature boundaries** | `GET /api/capabilities` reported `hosted: true` and `local.{terminal,browser,machines,vms,t3,vision,places,localDev} === false`; `POST /api/host-terminal` and `POST /api/host-browser` returned **`403`** even for admin Ada; opening Terminal UI rendered `[data-hosted-terminal]` with **`0`** auto-POSTs |
| **Admin People management (`#/settings/general`)** | Admin Ada saw Ada (`admin`, demotion locked while sole admin) and Kai (`member`), promoted Kai to `admin`, verified persistence across `ada.reload()` and Kai's bearer `GET /api/me` (`role: "admin"`) |

---

## 4. Screenshot Inventory (`1440×900`)

1. `01_design-images-day.png` — `#/design` **"Progressive cached images"** specimen & interactive cache controls (Day)
2. `02_design-images-night.png` — `#/design` **"Progressive cached images"** specimen & interactive cache controls (Night)
3. `03_design-people-day.png` — `#/design` **"People on a hosted server"** specimen after promoting Kai to Admin (Day)
4. `04_design-people-night.png` — `#/design` **"People on a hosted server"** specimen (Night)
5. `05_hosted-chat-browser.png` — Hosted ChatForm (`#general`) in browser cookie mode (Ada, Day) with live mention, thread summary, reaction, and `512w` progressive image
6. `06_hosted-chat-desktop-bearer.png` — Hosted ChatForm (`#general`) in simulated desktop bearer mode (Kai, Night) showing matching live state and bearer-cached `512w` image
7. `07_hosted-tools-boundary.png` — Hosted server Terminal tool pane showing honest `[data-hosted-terminal]` boundary notice alongside the live company grid
8. `08_hosted-people-settings.png` — Hosted server `Settings → General → People on this server` after promoting Kai Moreno to `Admin`
