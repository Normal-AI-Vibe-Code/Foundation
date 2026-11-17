/**
 * #/privacy: what Foundation for Chrome (and Foundation behind it) does with a
 * person's data, in plain words. Open without a sign-in, because the Chrome
 * Web Store's reviewers and anyone deciding whether to install it must be able
 * to read it. The listing links here (apps/extension/release.json privacyUrl).
 */
import { isNight, setNight } from "@foundation/ui";
import { NightOrb } from "../shell/NightOrb";
import "./privacy.css";

/** who to write to: the same address as apps/extension/release.json supportEmail (a test keeps them equal) */
export const SUPPORT_EMAIL = "foundation@formindustries.com";
export const PRIVACY_UPDATED = "2026-11-11";

export function Privacy() {
  return (
    <div className="privacy-page">
      <header className="design-head privacy-head">
        <div>
          <div className="f-eyebrow">Foundation for Chrome</div>
          <h1>Privacy</h1>
        </div>
        <div className="privacy-spacer" />
        <NightOrb onToggle={() => setNight(!isNight())} />
        <a className="f-pill" href="#/">
          Open Foundation
        </a>
      </header>
      <article className="privacy-body">
        <p className="privacy-lede">
          Foundation is Form Industries' own workspace, for the people who work here. The Chrome extension makes each new tab open your Today page in Foundation and shows a summary of it from the toolbar. It
          has no ads, no analytics and no tracking, and it doesn't sell or share anything.
        </p>

        <h2>What the extension keeps</h2>
        <p>
          One thing: the address of the company's Foundation, in Chrome's own storage for the extension (it follows your Chrome profile). Your company's administrator may set it for everyone instead. It keeps no
          passwords, tokens or browsing history, and it can't see the pages you visit.
        </p>

        <h2>What it reads, and where it goes</h2>
        <p>
          A new tab opens Foundation's Today page, as if you'd typed its address. When you open the toolbar summary, the extension asks the company's Foundation for your Today (your name, what's asked of you
          and where you're tagged, your goals, and the company's apps), using the Foundation sign-in your browser already has. That goes only between your browser and Foundation. The extension runs no code
          from anywhere else.
        </p>

        <h2>What Foundation itself keeps</h2>
        <ul>
          <li>Your name, work email and sign-in, the boards and files the company keeps in it, your goals, and what you tell the Shiba about your work. They're kept on the company's own Foundation server.</li>
          <li>
            When you ask the Shiba (or Foundation's agent) something, your question and the part of Foundation it needs to answer (your Today, or a board) are sent to Anthropic's Claude to write the answer,
            under the company's account.
          </li>
          <li>Speaking to the Shiba uses Chrome's speech recognition, which sends your voice to Google to turn it into text. Typing doesn't.</li>
        </ul>

        <h2>Removing it</h2>
        <p>
          Removing the extension deletes the address it kept. If the company installed it for everyone, your administrator decides whether it stays. To have your goals or what you told the Shiba removed from
          Foundation, write to us.
        </p>

        <h2>Questions</h2>
        <p>
          Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
        <p className="privacy-updated">Last updated {new Date(`${PRIVACY_UPDATED}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</p>
      </article>
    </div>
  );
}
