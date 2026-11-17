# Foundation for Chrome

Every new tab opens **Today** at the company's Foundation: the Shiba, what wants you, your goals, every company app. The toolbar button shows the same at a glance. It keeps nothing but Foundation's address; your Foundation sign-in does the rest.

```
src/                 the extension (MV3): newtab, popup, options, managed_schema.json (the admin's setting)
build.mjs            builds it (dev or release), draws the icons, writes the admin's policies
release.json         what the official build needs to know; `placeholder: true` = not confirmed yet
STORE.md             the Chrome Web Store listing, field by field (text, privacy answers, reviewer notes)
store/               the listing's images (1280×800 screenshots, 440×280 tile, 1400×560 marquee)
test/                the package and release checks (npm test -w @foundation/extension)
```

The real-browser check is `apps/client/e2e/extension.spec.ts`. It loads the built extension into Chromium, then:
- opens a new tab and checks that Today appears, signed in;
- checks that the popup reads Today with the Foundation sign-in from the extension's own origin;
- checks the signed-out popup;
- checks that `#/privacy` opens without a sign-in.

`STORE_ASSETS=1` also remakes `store/`.

## Try it yourself (two minutes)

```bash
npm run build -w @foundation/extension
```

Then in Chrome:
1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose `apps/extension/dist/unpacked`.

With `npm run dev` running, a new tab opens http://localhost:1430's Today. Building with `FOUNDATION_URL=https://…` points it at another Foundation.

## Make it the company's default page

**Recommended route:** a private Chrome Web Store item, force-installed from the Google Admin console. Chrome then updates it by itself, no one has to install anything, and the admin console sets the address for everyone.

### 1. Fill in release.json

Every entry marked `placeholder: true` still needs a confirmed value:

| Key | What |
|---|---|
| `foundationUrl` | The hosted Foundation, for example `https://foundation.formindustries.com`. It needs a hosted Foundation first (SPEC §8 *Ship*). |
| `companyDomains` | Domains the popup may read Foundation from without asking. The admin can move Foundation within them. |
| `supportEmail` | Shown on the listing and on `#/privacy`. Keep `apps/client/src/privacy/Privacy.tsx` `SUPPORT_EMAIL` the same; a test checks it. |
| `privacyUrl` | Foundation's `#/privacy`, if the Web Store's reviewers can reach it from the internet. Otherwise use a public page with the same text. |
| `extensionId` | Known after the first upload (step 3). |

### 2. Build the package

```bash
npm run release -w @foundation/extension
```

This writes:
- `dist/foundation-today-<version>.zip`, the upload;
- `dist/store/icon-128.png`;
- `dist/policy/`, the admin's policies.

It lists every placeholder still open, and it builds anyway, so it can be tried first. The version is `apps/extension/package.json`'s: bump it for every upload.

### 3. Publish it privately (a person: it needs a Google account, and the developer registration has a one-time fee)

1. Sign in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) with a company Google Workspace account. Use a group publisher, so the item isn't tied to one person.
2. Click **New item** and upload the zip.
3. Fill in the listing and privacy tabs from [STORE.md](STORE.md), and upload the images from `store/` and `dist/store/icon-128.png`.
4. Under **Distribution → Visibility**, choose **Private** and the company's Workspace domain.
5. Submit for review. Private items are usually reviewed within days.
6. Copy the item's ID into `release.json` (`extensionId`) and run `npm run release` again. That gives the policies the real ID.

### 4. Install it for everyone (a Workspace admin)

In the [Google Admin console](https://admin.google.com):

1. Go to **Devices → Chrome → Apps & extensions → Users & browsers**.
2. Choose the organisational unit (the top one is everyone).
3. Click **+ → Add Chrome app or extension by ID**, paste the ID and choose **From the Chrome Web Store**.
4. Set **Installation policy: Force install** (or **Force install + pin to browser toolbar**).
5. In **Policy for extensions**, paste `dist/policy/admin-console-policy.json`:

   ```json
   { "foundationUrl": { "Value": "https://foundation.formindustries.com" } }
   ```

   This sets Foundation's address for everyone, and the options page shows it as set by the administrator. Change it here, without rebuilding, if Foundation moves.
6. **Optional:** also open Today when Chrome starts and as the home page. In **Devices → Chrome → Settings → Users & browsers**:
   - set **Home page** to `<foundation>/#/today` and **Show home button** on;
   - set **Pages to load on startup** to `<foundation>/#/today`.

Chrome picks the policy up within hours, or right away on `chrome://policy` → **Reload policies**. Check there that `ExtensionInstallForcelist` lists the ID.

### Machines outside Workspace (managed Chrome via MDM or GPO)

The same policies are in `dist/policy/`:

| Platform | Files |
|---|---|
| Windows | `windows.reg` (HKLM policies: force-install, the address, and optionally home and startup) |
| macOS | `com.google.Chrome.plist` (force-install, home and startup) and `com.google.Chrome.extensions.<id>.plist` (the address), delivered as managed-preferences payloads by your MDM |

### Updating

1. Bump `version` in `apps/extension/package.json`.
2. Run `npm run release -w @foundation/extension`.
3. Upload the new zip on the item's **Package** tab and submit.

Chrome updates installed copies by itself after review.

## Notes

- **The new tab hands off to Foundation's own page.** The omnibox shows Foundation's address and the page has the keyboard. That's because sign-in, WebGL and the Shiba's voice belong to Foundation's origin, not the extension's.
- **Chrome may ask once** whether to keep the extension's new tab on a person's own install. It isn't expected to ask for a force-installed one. Check on the first rollout.
- **No network calls except to Foundation**, and only from the popup. Nothing is remote code: the pages allow only `script-src 'self'`.
