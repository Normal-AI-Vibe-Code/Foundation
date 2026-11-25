/**
 * The Slack user token (SLACK_USER_TOKEN) is one person's Slack: it searches their DMs and private channels.
 * So it is used only for that person's own asks: their browser, their app, or an agent acting for them
 * (an agent run they asked, or an agent token they made). For anyone else, and for the service token, Slack
 * is searched with only what the bot token can see, or not at all, and the answer says why.
 *
 * Whose token it is comes from Slack itself, once: auth.test names the account, users.info gives its email
 * (asked with the bot token, which has users:read.email for Hermes, else with the user token). The email is
 * matched to a Foundation account's. If Slack doesn't say, nobody's asks use the user token.
 * SLACK_API_BASE points this at a stand-in (tests).
 */

import { one } from "./db.ts";
import { egressBlocked } from "./egressguard.ts";

const RETRY_MS = 5 * 60_000;

const base = () => (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");

/** what to tell someone whose search didn't use the user token */
export const SLACK_SEARCH_NOT_YOURS =
  "Slack messages weren't searched for you: Slack search runs on a person's own Slack connection, and the one this server holds is someone else's.";

async function slackGet<T>(method: string, params: Record<string, string>, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${base()}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const body = (await res.json()) as { ok: boolean } & T;
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

let known: { token: string; email: string | null; at: number } | null = null;

/** the email of the Slack account the user token belongs to (lower case), or null when Slack doesn't say */
export async function userTokenOwner(): Promise<string | null> {
  const token = process.env.SLACK_USER_TOKEN ?? "";
  if (!token) return null;
  if (known && known.token === token && (known.email || Date.now() - known.at < RETRY_MS)) return known.email;
  let email: string | null = null;
  const me = await slackGet<{ user_id?: string }>("auth.test", {}, token);
  if (me?.user_id) {
    for (const t of [process.env.SLACK_BOT_TOKEN ?? "", token]) {
      if (!t) continue;
      const info = await slackGet<{ user?: { profile?: { email?: string } } }>("users.info", { user: me.user_id }, t);
      email = info?.user?.profile?.email?.trim().toLowerCase() || null;
      if (email) break;
    }
  }
  known = { token, email, at: Date.now() };
  return email;
}

/** forget whose token it is (tests; a changed token is noticed on its own) */
export function forgetUserTokenOwner() {
  known = null;
}

/**
 * The user token, when this ask is its owner's: `userId` is the Foundation account the search is for (a
 * person, or the person an agent acts for). Null for anyone else, for the service token, and for no one.
 */
export async function slackUserTokenFor(userId: string | undefined): Promise<string | null> {
  // asking Slack whose token this is is itself a call to Slack: an agent's call makes it only where a person allowed Slack (egress.ts)
  if (egressBlocked("Slack")) return null;
  const token = process.env.SLACK_USER_TOKEN ?? "";
  if (!token || !userId || userId === "agent") return null;
  const owner = await userTokenOwner();
  if (!owner) return null;
  const me = one<{ email: string }>("select email from users where id = ?", userId);
  return me && me.email.trim().toLowerCase() === owner ? token : null;
}
