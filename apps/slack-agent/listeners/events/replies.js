export const NOT_OWNER_TEXT =
  'I only continue a thread with the person who started it. DM me or mention me in a new message and I’ll start one with you.';

export const FAILURE_TEXT = 'Sorry, something went wrong on my side. Please try again in a moment.';

/**
 * An error's message alone: no stack, no event, no payload.
 * @param {unknown} e
 * @returns {string}
 */
export function errorMessage(e) {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'unknown error';
}
