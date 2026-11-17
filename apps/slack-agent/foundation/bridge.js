/**
 * The live line from Slack to Foundation.
 *
 * Foundation's Slack board keeps a section for every channel. This process is
 * the one Slack talks to (Socket Mode), so it tells Foundation two things:
 *
 *   - that it's here: a check-in every 10 seconds. While they keep coming,
 *     each section's Slack mark reads Live; when they stop, Foundation falls
 *     back to reading channels in turn and the mark says Polling.
 *   - what happened: for each message or channel event Slack sends, only its
 *     type, subtype and channel. No message text leaves this process;
 *     Foundation reads the channel itself.
 *
 * Both go to POST {FOUNDATION_URL}/api/slack/events with Foundation's service
 * token. When Foundation is on this computer (a loopback address), the
 * check-in also carries the bot token the Slack CLI gave this process, so
 * Foundation can read channels and fetch images without the token being
 * copied into its .env by hand. It is never sent to any other host.
 *
 * Settings (this app's .env, or Foundation's .env two folders up):
 *   FOUNDATION_URL            default http://127.0.0.1:4410
 *   FOUNDATION_SERVICE_TOKEN  required: at least 32 characters, the same value Foundation has
 */

import { readFileSync } from 'node:fs';

const CHECK_IN_MS = 10_000;

/** what Foundation follows: messages, and the channel list changing */
export const FORWARDED = new Set([
  'message',
  'channel_created',
  'channel_rename',
  'channel_archive',
  'channel_unarchive',
  'channel_deleted',
  'channel_left',
  'group_rename',
  'group_archive',
  'group_unarchive',
  'group_left',
  'member_joined_channel',
  'member_left_channel',
]);

/**
 * Only what Foundation needs to know which section to read again.
 * @param {Record<string, any>} event
 * @returns {{ type: string, subtype?: string, channel?: string }}
 */
export function slim(event) {
  const channel = typeof event.channel === 'string' ? event.channel : event.channel?.id;
  return { type: event.type, ...(event.subtype ? { subtype: event.subtype } : {}), ...(channel ? { channel } : {}) };
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * A setting from this process's environment, else from Foundation's own .env
 * (this app lives in Foundation's repo, at apps/slack-agent).
 * @param {string} name
 * @param {string} [envFile]
 * @returns {string}
 */
export function setting(
  name,
  envFile = new URL('../../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
) {
  if (process.env[name]) return /** @type {string} */ (process.env[name]);
  try {
    const line = readFileSync(decodeURIComponent(envFile), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    return line
      ? line
          .slice(name.length + 1)
          .trim()
          .replace(/^["']|["']$/g, '')
      : '';
  } catch {
    return '';
  }
}

/**
 * Forward Slack's events to Foundation and keep checking in.
 * @param {import('@slack/bolt').App} app
 * @param {{ url?: string, token?: string, botToken?: string, checkInMs?: number, fetch?: typeof fetch }} [opts]
 * @returns {{ stop: () => void, send: (body: Record<string, unknown>) => Promise<boolean> } | null}
 */
export function connectFoundation(app, opts = {}) {
  const url = (opts.url ?? (setting('FOUNDATION_URL') || 'http://127.0.0.1:4410')).replace(/\/$/, '');
  const token = opts.token ?? setting('FOUNDATION_SERVICE_TOKEN');
  const post = opts.fetch ?? fetch;
  if (token.length < 32) {
    app.logger.warn(
      'Foundation: not connected. Set FOUNDATION_SERVICE_TOKEN (32+ characters, the same value in Foundation’s .env) so channel events reach the Slack board.',
    );
    return null;
  }
  const botToken = isLoopback(url) ? (opts.botToken ?? process.env.SLACK_BOT_TOKEN) : undefined;
  let reached = true;

  /** @param {Record<string, unknown>} body */
  const send = async (body) => {
    try {
      const res = await post(`${url}/api/slack/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Foundation answered ${res.status}`);
      if (!reached) app.logger.info(`Foundation: reached again at ${url}`);
      reached = true;
      return true;
    } catch (e) {
      if (reached)
        app.logger.warn(`Foundation: can’t reach ${url} (${/** @type {Error} */ (e).message}). Still trying.`);
      reached = false;
      return false;
    }
  };

  app.use(async ({ body, next }) => {
    const event = /** @type {any} */ (body)?.event;
    if (event && FORWARDED.has(event.type)) void send({ type: 'event', event: slim(event) });
    await next();
  });

  const checkIn = (/** @type {'hello' | 'heartbeat'} */ type) =>
    send({ type, ...(botToken ? { bot_token: botToken } : {}) });
  void checkIn('hello').then(
    (ok) => ok && app.logger.info(`Foundation: connected at ${url}. Sections on the Slack board read Live.`),
  );
  const timer = setInterval(() => void checkIn('heartbeat'), opts.checkInMs ?? CHECK_IN_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), send };
}
