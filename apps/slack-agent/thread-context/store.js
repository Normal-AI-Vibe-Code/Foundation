/**
 * @typedef {Object} StoreEntry
 * @property {string} sessionId
 * @property {string} threadKey
 * @property {string | undefined} userId
 * @property {number} timestamp
 */

/**
 * @typedef {{ kind: 'resume', sessionId: string } | { kind: 'start' } | { kind: 'not_owner' } | { kind: 'not_engaged' }} ThreadDecision
 */

/**
 * In-memory session ID store with TTL-based cleanup. A session belongs to the
 * person who started it: it is found again only with the same user ID.
 */
export class SessionStore {
  /**
   * @param {number} [ttlSeconds=86400]
   * @param {number} [maxEntries=1000]
   */
  constructor(ttlSeconds = 86400, maxEntries = 1000) {
    /** @type {Map<string, StoreEntry>} */
    this._store = new Map();
    /** @private @type {Map<string, number>} */
    this._told = new Map();
    /** @private @type {number} */
    this._ttlSeconds = ttlSeconds;
    /** @private @type {number} */
    this._maxEntries = maxEntries;
  }

  /**
   * @param {string} channelId
   * @param {string} threadTs
   * @param {string} [userId]
   * @returns {string | null}
   */
  getSession(channelId, threadTs, userId) {
    const key = entryKey(channelId, threadTs, userId);
    const entry = this._store.get(key);
    if (!entry) return null;
    if (this._expired(entry.timestamp)) {
      this._store.delete(key);
      return null;
    }
    return entry.sessionId;
  }

  /**
   * @param {string} channelId
   * @param {string} threadTs
   * @param {string} sessionId
   * @param {string} [userId] - the person who started the session
   * @returns {void}
   */
  setSession(channelId, threadTs, sessionId, userId) {
    this._store.set(entryKey(channelId, threadTs, userId), {
      sessionId,
      threadKey: threadKey(channelId, threadTs),
      userId,
      timestamp: Date.now(),
    });
    this._cleanup();
  }

  /**
   * Whether anyone has a live session in this thread.
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {boolean}
   */
  isEngaged(channelId, threadTs) {
    const thread = threadKey(channelId, threadTs);
    for (const entry of this._store.values()) {
      if (entry.threadKey === thread && !this._expired(entry.timestamp)) return true;
    }
    return false;
  }

  /**
   * What a message from `userId` in this thread may do.
   * @param {string} channelId
   * @param {string} threadTs
   * @param {string} userId
   * @param {{ startIfNew: boolean }} opts - whether a person with no session here starts one
   * @returns {ThreadDecision}
   */
  decide(channelId, threadTs, userId, { startIfNew }) {
    const sessionId = this.getSession(channelId, threadTs, userId);
    if (sessionId) return { kind: 'resume', sessionId };
    if (startIfNew) return { kind: 'start' };
    return this.isEngaged(channelId, threadTs) ? { kind: 'not_owner' } : { kind: 'not_engaged' };
  }

  /**
   * True the first time a person is told this thread is not theirs.
   * @param {string} channelId
   * @param {string} threadTs
   * @param {string} userId
   * @returns {boolean}
   */
  firstRefusal(channelId, threadTs, userId) {
    const key = entryKey(channelId, threadTs, userId);
    const at = this._told.get(key);
    if (at !== undefined && !this._expired(at)) return false;
    this._told.set(key, Date.now());
    this._cleanup();
    return true;
  }

  /**
   * @private
   * @param {number} timestamp
   * @returns {boolean}
   */
  _expired(timestamp) {
    return Date.now() - timestamp > this._ttlSeconds * 1000;
  }

  /**
   * @private
   * @returns {void}
   */
  _cleanup() {
    for (const [key, entry] of this._store) {
      if (this._expired(entry.timestamp)) {
        this._store.delete(key);
      }
    }
    for (const [key, at] of this._told) {
      if (this._expired(at)) this._told.delete(key);
    }
    if (this._store.size > this._maxEntries) {
      const sorted = [...this._store.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = sorted.slice(0, this._store.size - this._maxEntries);
      for (const [key] of toRemove) {
        this._store.delete(key);
      }
    }
    while (this._told.size > this._maxEntries) {
      const oldest = this._told.keys().next().value;
      if (oldest === undefined) break;
      this._told.delete(oldest);
    }
  }
}

/**
 * @param {string} channelId
 * @param {string} threadTs
 * @returns {string}
 */
function threadKey(channelId, threadTs) {
  return `${channelId}:${threadTs}`;
}

/**
 * @param {string} channelId
 * @param {string} threadTs
 * @param {string} [userId]
 * @returns {string}
 */
function entryKey(channelId, threadTs, userId) {
  return `${threadKey(channelId, threadTs)}:${userId ?? ''}`;
}
