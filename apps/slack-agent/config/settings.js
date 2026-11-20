import { LogLevel } from '@slack/bolt';

export const STATE_SECRET_NAME = 'SLACK_STATE_SECRET';
export const LOG_LEVEL_NAME = 'SLACK_LOG_LEVEL';

/**
 * Why the OAuth state secret can't be used, as a sentence, or null when it can.
 * @param {string | undefined} value
 * @returns {string | null}
 */
export function stateSecretProblem(value) {
  if (!value) {
    return `Casey's OAuth server won't start: set ${STATE_SECRET_NAME} in .env to a random value of at least 32 characters.`;
  }
  if (value.length < 32) {
    return `Casey's OAuth server won't start: ${STATE_SECRET_NAME} is ${value.length} characters long and needs at least 32.`;
  }
  return null;
}

/**
 * Bolt's log level: INFO unless the environment asks for another one.
 * DEBUG logs whole Slack payloads, message text included.
 * @param {string | undefined} value
 * @returns {LogLevel}
 */
export function logLevelFrom(value) {
  const levels = /** @type {Record<string, LogLevel>} */ ({
    debug: LogLevel.DEBUG,
    info: LogLevel.INFO,
    warn: LogLevel.WARN,
    error: LogLevel.ERROR,
  });
  return levels[(value ?? '').trim().toLowerCase()] ?? LogLevel.INFO;
}
