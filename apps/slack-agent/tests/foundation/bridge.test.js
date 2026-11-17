import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import { connectFoundation, FORWARDED, isLoopback, slim } from '../../foundation/bridge.js';

/** @type {Array<{ auth: string | undefined, body: any }>} */
const heard = [];
/** @type {import('node:http').Server} */
let foundation;
let url = '';

before(async () => {
  foundation = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      heard.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.end(JSON.stringify({ ok: true, boards: 1 }));
    });
  });
  await new Promise((r) => foundation.listen(0, '127.0.0.1', () => r(undefined)));
  url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (foundation.address()).port}`;
});
after(() => foundation.close());

/** a Bolt app, as far as the bridge uses one */
function fakeApp() {
  /** @type {Array<(args: any) => Promise<void>>} */
  const middleware = [];
  /** @type {string[]} */
  const log = [];
  return {
    middleware,
    log,
    use: (/** @type {(args: any) => Promise<void>} */ fn) => middleware.push(fn),
    logger: { info: (/** @type {string} */ m) => log.push(m), warn: (/** @type {string} */ m) => log.push(m) },
  };
}
const TOKEN = 'a'.repeat(40);
const settle = () => new Promise((r) => setTimeout(r, 200));

test('only the kind and the channel of an event leave this process', () => {
  const sent = slim({
    type: 'message',
    subtype: 'file_share',
    channel: 'C1',
    text: 'the secret plan',
    user: 'U1',
    files: [{ id: 'F1' }],
  });
  assert.deepEqual(sent, { type: 'message', subtype: 'file_share', channel: 'C1' });
  assert.deepEqual(slim({ type: 'channel_created', channel: { id: 'C2', name: 'launch' } }), {
    type: 'channel_created',
    channel: 'C2',
  });
});

test('it checks in, forwards what Foundation follows, and lets the app’s own listeners run', async () => {
  heard.length = 0;
  const app = fakeApp();
  const line = connectFoundation(/** @type {any} */ (app), {
    url,
    token: TOKEN,
    botToken: 'xoxb-test-token',
    checkInMs: 30,
  });
  assert.ok(line);
  await settle();
  assert.equal(heard[0].body.type, 'hello');
  assert.equal(heard[0].auth, `Bearer ${TOKEN}`);
  assert.equal(heard[0].body.bot_token, 'xoxb-test-token', 'Foundation on this computer is lent the bot token');
  assert.ok(
    heard.some((h) => h.body.type === 'heartbeat'),
    'and it keeps checking in',
  );

  heard.length = 0;
  let ran = 0;
  const next = async () => {
    ran++;
  };
  await app.middleware[0]({ body: { event: { type: 'message', channel: 'C1', text: 'hello there' } }, next });
  await app.middleware[0]({ body: { event: { type: 'reaction_added', item: { channel: 'C1' } } }, next });
  await app.middleware[0]({ body: { type: 'block_actions' }, next });
  line.stop();
  await settle();
  assert.equal(ran, 3, 'every event still reaches the app');
  const events = heard.filter((h) => h.body.type === 'event').map((h) => h.body.event);
  assert.deepEqual(events, [{ type: 'message', channel: 'C1' }]);
  assert.ok(!JSON.stringify(heard).includes('hello there'), 'no message text is forwarded');
  assert.ok(FORWARDED.has('channel_rename') && !FORWARDED.has('reaction_added'));
});

test('the bot token never goes to another host', async () => {
  assert.equal(isLoopback('http://127.0.0.1:4410'), true);
  assert.equal(isLoopback('http://localhost:4410'), true);
  assert.equal(isLoopback('https://foundation.example.com'), false);
  /** @type {any[]} */
  const bodies = [];
  const app = fakeApp();
  const line = connectFoundation(/** @type {any} */ (app), {
    url: 'https://foundation.example.com',
    token: TOKEN,
    botToken: 'xoxb-test-token',
    fetch: /** @type {any} */ (
      async (/** @type {string} */ _u, /** @type {any} */ init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true };
      }
    ),
  });
  await settle();
  line?.stop();
  assert.equal(bodies[0].type, 'hello');
  assert.equal(bodies[0].bot_token, undefined);
});

test('without a service token it says so and forwards nothing', () => {
  const app = fakeApp();
  assert.equal(connectFoundation(/** @type {any} */ (app), { url, token: '' }), null);
  assert.equal(app.middleware.length, 0);
  assert.match(app.log[0], /FOUNDATION_SERVICE_TOKEN/);
});

test('Foundation being down is said once, and doesn’t stop the app', async () => {
  const app = fakeApp();
  const line = connectFoundation(/** @type {any} */ (app), { url: 'http://127.0.0.1:9', token: TOKEN, checkInMs: 20 });
  await new Promise((r) => setTimeout(r, 200));
  line?.stop();
  assert.equal(app.log.filter((m) => /can’t reach/.test(m)).length, 1);
});
