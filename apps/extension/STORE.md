# Foundation for Chrome: the Chrome Web Store listing

What to paste into the Chrome Web Store Developer Dashboard, field by field. Values in **release.json** that are still placeholders (the address, the support email, the privacy URL) are marked ⟨placeholder⟩ here too.

## Package

- **File:** `apps/extension/dist/foundation-today-<version>.zip` from `npm run release -w @foundation/extension`
- **Visibility:** Private, for everyone in the company's Google Workspace domain (Distribution → Visibility → *Private* → *Everyone at formindustries.com* ⟨placeholder⟩). Not listed publicly.
- **Regions:** all

## Store listing

- **Name** (from the manifest): Foundation — Today
- **Summary** (the manifest's description, 132 characters at most): Form Industries' first stop: each new tab opens Today — the Shiba, what wants you, your goals, and every company app.
- **Category:** Workflow & Planning
- **Language:** English
- **Description:**

  > Foundation is Form Industries' shared workspace. With this extension, every new tab opens your Today page:
  >
  > • The Shiba, Foundation's agent: ask it about your day, your goals and what to do next, by typing or by voice.
  > • What wants you: things your teammates asked of you, notes that tag you, design stages you own, new files and changes on your boards, and work that matches your job, each linking to its place.
  > • Your goals, with progress, that you and the Shiba keep up to date.
  > • Every company app (BomForm, FactoryForm, HyperForm, Vision, the Data Room and more), one click away.
  >
  > The toolbar button shows the same at a glance. You sign in to Foundation with your work Google account as usual; the extension keeps nothing but Foundation's address.
  >
  > For people at Form Industries. Questions: foundation@formindustries.com ⟨placeholder⟩

- **Icon:** `dist/store/icon-128.png` (made by the release build)
- **Screenshots** (1280×800): `store/screenshot-1-today.png`, `store/screenshot-2-popup.png`
- **Small promo tile** (440×280): `store/promo-small.png`
- **Marquee** (1400×560, optional): `store/promo-marquee.png`
- **Official URL:** none (needs a verified domain in Search Console; optional)
- **Homepage URL:** https://foundation.formindustries.com ⟨placeholder⟩
- **Support URL:** mailto:foundation@formindustries.com ⟨placeholder⟩

The store images are made by `STORE_ASSETS=1 npm run e2e -w @foundation/client -- e2e/extension.spec.ts`: Today and the popup as the extension really shows them, on a seeded test board.

## Privacy practices

- **Single purpose:** Opens the company's Foundation workspace (the person's Today page) on every new tab, and shows a summary of it from the toolbar.
- **Permission justifications:**
  - `storage`: keeps one setting, the address of the company's Foundation (and reads the address an administrator sets by policy).
  - **Host permissions** (Foundation's address and the company's domains): the toolbar summary reads the person's Today from the company's Foundation with their existing sign-in. Nothing else is requested from those hosts.
  - **Optional host permissions** (`https://*/*`): asked for only when a person sets a Foundation address outside the company's domains in the options, and only for that one address.
  - **New tab override:** the extension's purpose: the new tab opens Foundation's Today.
- **Remote code:** No. Every script is in the package; the pages allow only `script-src 'self'`.
- **Data usage** (what to tick):
  - *Personally identifiable information:* yes, the person's name and work email, as shown by Foundation (read from the company's own server to show them; not collected by the extension).
  - *Website content:* yes, the person's Today (tasks, goals) from the company's Foundation, shown in the popup.
  - Everything else (health, financial, authentication, personal communications, location, web history, user activity): no.
  - Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.
- **Privacy policy URL:** https://foundation.formindustries.com/#/privacy ⟨placeholder⟩. The reviewers must be able to open it from the internet; if Foundation isn't public, publish the same text (Foundation's `#/privacy`) on a public page.

## Test instructions for the reviewers

The extension needs a Form Industries account, so reviewers can't sign in. Say so, and give them what they can check without one:

> This is an internal tool for Form Industries employees, distributed privately to our Google Workspace domain. Opening a new tab goes to our Foundation workspace (https://foundation.formindustries.com ⟨placeholder⟩), which asks for a company Google sign-in. Without one, the new tab shows the sign-in page and the toolbar popup says "You're signed out of Foundation" with the company's apps listed. ⟨If the reviewers need a test account, create a viewer account on Foundation and give it here.⟩
