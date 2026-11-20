import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import { makeAppMentionedHandler } from '../../../listeners/events/app-mentioned.js';
import { makeMessageHandler } from '../../../listeners/events/message.js';
import { FAILURE_TEXT, NOT_OWNER_TEXT } from '../../../listeners/events/replies.js';
import { SessionStore } from '../../../thread-context/store.js';

const CHANNEL = 'C1';
const ROOT = '100.000';
const TOKENS = { UA: 'xoxp-alice', UB: 'xoxp-bob' };

/** @type {SessionStore} */
let store;
/** @type {any} */
let runAgent;
/** @type {any} */
let onMention;
/** @type {any} */
let onMessage;
let next = 0;

/**
 * @param {'UA' | 'UB'} user
 * @param {Record<string, unknown>} event
 * @returns {any}
 */
function args(user, event) {
  return {
    client: { reactions: { add: mock.fn(async () => ({ ok: true })) } },
    context: { userId: user, botUserId: 'UBOT', botId: 'B1', teamId: 'T1', userToken: TOKENS[user] },
    event: { team: 'T1', user, ...event },
    logger: { info: mock.fn(), error: mock.fn() },
    say: mock.fn(async () => ({ ok: true })),
    sayStream: () => ({ append: mock.fn(async () => {}), stop: mock.fn(async () => {}) }),
    setStatus: mock.fn(async () => {}),
  };
}

/**
 * @param {'UA' | 'UB'} user
 * @param {string} ts
 * @param {string} [threadTs]
 */
const mention = (user, ts, threadTs) =>
  args(user, {
    type: 'app_mention',
    channel: CHANNEL,
    ts,
    text: '<@UBOT> my VPN is down',
    ...(threadTs && { thread_ts: threadTs }),
  });

/**
 * @param {'UA' | 'UB'} user
 * @param {string} ts
 */
const reply = (user, ts) =>
  args(user, { type: 'message', channel: CHANNEL, channel_type: 'channel', ts, thread_ts: ROOT, text: 'still broken' });

beforeEach(() => {
  store = new SessionStore();
  next = 0;
  runAgent = mock.fn(async () => ({ responseText: 'On it.', sessionId: `s-${++next}` }));
  onMention = makeAppMentionedHandler({ runAgent, store });
  onMessage = makeMessageHandler({ runAgent, store });
});

describe('a thread belongs to the person who started it', () => {
  it('the owner continues their own session with their own token', async () => {
    await onMention(mention('UA', ROOT));
    assert.equal(runAgent.mock.callCount(), 1);
    assert.equal(runAgent.mock.calls[0].arguments[1], undefined);
    assert.equal(store.getSession(CHANNEL, ROOT, 'UA'), 's-1');

    await onMessage(reply('UA', '101.000'));
    assert.equal(runAgent.mock.callCount(), 2);
    const [, sessionId, deps] = runAgent.mock.calls[1].arguments;
    assert.equal(sessionId, 's-1');
    assert.equal(deps.userId, 'UA');
    assert.equal(deps.userToken, 'xoxp-alice');
  });

  it("another person's reply runs nothing and is told once", async () => {
    await onMention(mention('UA', ROOT));
    const first = reply('UB', '102.000');
    await onMessage(first);
    assert.equal(runAgent.mock.callCount(), 1, 'no agent run for the other person');
    assert.equal(first.say.mock.callCount(), 1);
    assert.deepEqual(first.say.mock.calls[0].arguments[0], { text: NOT_OWNER_TEXT, thread_ts: ROOT });

    const second = reply('UB', '103.000');
    await onMessage(second);
    assert.equal(runAgent.mock.callCount(), 1);
    assert.equal(second.say.mock.callCount(), 0, 'told only once');
    assert.equal(store.getSession(CHANNEL, ROOT, 'UB'), null);
    assert.equal(store.getSession(CHANNEL, ROOT, 'UA'), 's-1');
  });

  it("a session is never resumed with another person's token", async () => {
    await onMention(mention('UA', ROOT));
    await onMessage(reply('UB', '102.000'));
    await onMention(mention('UB', '104.000', ROOT));
    for (const call of runAgent.mock.calls) {
      const [, sessionId, deps] = call.arguments;
      if (sessionId === 's-1') assert.equal(deps.userToken, 'xoxp-alice');
    }
  });

  it("a new mention by the other person starts that person's own session", async () => {
    await onMention(mention('UA', ROOT));
    await onMention(mention('UB', '104.000', ROOT));
    assert.equal(runAgent.mock.callCount(), 2);
    const [, sessionId, deps] = runAgent.mock.calls[1].arguments;
    assert.equal(sessionId, undefined, 'not the first person’s session');
    assert.equal(deps.userId, 'UB');
    assert.equal(deps.userToken, 'xoxp-bob');
    assert.equal(store.getSession(CHANNEL, ROOT, 'UB'), 's-2');
    assert.equal(store.getSession(CHANNEL, ROOT, 'UA'), 's-1');

    await onMessage(reply('UB', '105.000'));
    assert.equal(runAgent.mock.calls[2].arguments[1], 's-2');
    await onMessage(reply('UA', '106.000'));
    assert.equal(runAgent.mock.calls[3].arguments[1], 's-1');
  });

  it('a mention in a thread is run once, by the mention handler', async () => {
    await onMention(mention('UA', ROOT));
    const asMessage = args('UA', {
      type: 'message',
      channel: CHANNEL,
      channel_type: 'channel',
      ts: '107.000',
      thread_ts: ROOT,
      text: '<@UBOT> and the printer',
    });
    await onMessage(asMessage);
    assert.equal(runAgent.mock.callCount(), 1);
    assert.equal(asMessage.say.mock.callCount(), 0);
  });

  it('a reply in a thread Casey is not in is ignored', async () => {
    const quiet = reply('UB', '108.000');
    await onMessage(quiet);
    assert.equal(runAgent.mock.callCount(), 0);
    assert.equal(quiet.say.mock.callCount(), 0);
  });

  it('a DM starts a session owned by the sender', async () => {
    const dm = args('UB', { type: 'message', channel: 'D1', channel_type: 'im', ts: '200.000', text: 'help' });
    await onMessage(dm);
    assert.equal(runAgent.mock.callCount(), 1);
    assert.equal(store.getSession('D1', '200.000', 'UB'), 's-1');
  });
});

describe('errors stay out of the thread', () => {
  it('posts a fixed sentence and logs only the message', async () => {
    runAgent = mock.fn(async () => {
      throw new Error('upstream refused');
    });
    onMention = makeAppMentionedHandler({ runAgent, store });
    onMessage = makeMessageHandler({ runAgent, store });

    const m = mention('UA', ROOT);
    await onMention(m);
    assert.deepEqual(m.say.mock.calls.at(-1).arguments[0], { text: FAILURE_TEXT, thread_ts: ROOT });
    const logged = m.logger.error.mock.calls[0].arguments[0];
    assert.match(logged, /upstream refused/);
    assert.doesNotMatch(logged, /VPN|xoxp|at .*\.js/);

    const dm = args('UA', {
      type: 'message',
      channel: 'D1',
      channel_type: 'im',
      ts: '300.000',
      text: 'my secret issue',
    });
    await onMessage(dm);
    assert.deepEqual(dm.say.mock.calls.at(-1).arguments[0], { text: FAILURE_TEXT, thread_ts: '300.000' });
    const loggedDm = dm.logger.error.mock.calls[0].arguments[0];
    assert.match(loggedDm, /upstream refused/);
    assert.doesNotMatch(loggedDm, /secret issue|xoxp|at .*\.js/);
  });
});
