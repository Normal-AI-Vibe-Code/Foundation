import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUILT_IN_TOOLS,
  buildCaseyOptions,
  caseyEnv,
  MODEL_CREDENTIAL,
  onlyConfiguredMcpTools,
  scratchDir,
} from '../../agent/options.js';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = resolve(appRoot, '../..');

const ambient = {
  PATH: '/usr/bin',
  Path: 'C:\\Windows',
  HOME: '/home/casey',
  USERPROFILE: 'C:\\Users\\casey',
  APPDATA: 'C:\\Users\\casey\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\casey\\AppData\\Local',
  TEMP: '/tmp',
  LANG: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy:8080',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SLACK_BOT_TOKEN: 'xoxb-1',
  SLACK_APP_TOKEN: 'xapp-1',
  SLACK_USER_TOKEN: 'xoxp-1',
  SLACK_SIGNING_SECRET: 's',
  SLACK_CLIENT_SECRET: 's',
  SLACK_CLIENT_ID: '1.2',
  FOUNDATION_SERVICE_TOKEN: 'f'.repeat(40),
  FOUNDATION_URL: 'http://127.0.0.1:4410',
  GITHUB_TOKEN: 'ghp',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  AWS_SECRET_ACCESS_KEY: 'aws',
  DB_PASSWORD: 'pw',
  OPENAI_API_KEY: 'sk-other',
  NODE_OPTIONS: '--require ./evil.js',
};

const servers = {
  'casey-tools': { type: 'sdk', name: 'casey-tools', instance: {} },
  'slack-mcp': { type: 'http', url: 'https://mcp.slack.com/mcp', headers: { Authorization: 'Bearer xoxp-1' } },
};

function options() {
  return buildCaseyOptions({
    systemPrompt: 'You are Casey.',
    mcpServers: /** @type {any} */ (servers),
    cwd: scratchDir(),
    env: ambient,
  });
}

/**
 * @param {string} name
 * @param {any} [opts]
 * @returns {Promise<any>}
 */
async function decide(name, opts = {}) {
  const canUseTool = /** @type {any} */ (options().canUseTool);
  return canUseTool(name, { x: 1 }, { signal: new AbortController().signal, ...opts });
}

describe('Casey SDK options', () => {
  it('never bypasses permissions', () => {
    const o = options();
    assert.equal(o.permissionMode, 'default');
    assert.notEqual(o.allowDangerouslySkipPermissions, true);
    assert.equal(o.allowedTools, undefined);
  });

  it('has no built-in tools, and refuses them by name too', () => {
    const o = options();
    assert.deepEqual(o.tools, []);
    for (const name of [
      'Bash',
      'PowerShell',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'Agent',
      'Skill',
    ]) {
      assert.ok(o.disallowedTools?.includes(name), `${name} is disallowed`);
    }
    assert.deepEqual(o.disallowedTools, [...BUILT_IN_TOOLS]);
  });

  for (const name of [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'WebFetch',
    'PowerShell',
    'Skill',
    'NotAToolAtAll',
    'mcp__',
    'mcp__casey-tools__',
  ]) {
    it(`canUseTool denies ${name}`, async () => {
      const result = await decide(name);
      assert.equal(result.behavior, 'deny');
      assert.ok(result.behavior === 'deny' && result.message.length > 0);
    });
  }

  it('canUseTool denies an MCP tool from a server that is not configured', async () => {
    assert.equal((await decide('mcp__filesystem__read_file')).behavior, 'deny');
    assert.equal((await decide('mcp__casey-tools-evil__run')).behavior, 'deny');
    assert.equal((await decide('mcp__foundation__write')).behavior, 'deny');
  });

  it('canUseTool denies a configured name served by a server that is not configured', async () => {
    const result = await decide('mcp__casey-tools__search_knowledge_base', {
      mcpServer: { name: 'impostor', source: 'project' },
    });
    assert.equal(result.behavior, 'deny');
  });

  it('canUseTool allows the configured MCP tools', async () => {
    const own = await decide('mcp__casey-tools__search_knowledge_base', {
      mcpServer: { name: 'casey-tools', source: 'sdk' },
    });
    assert.equal(own.behavior, 'allow');
    assert.deepEqual(own.behavior === 'allow' && own.updatedInput, { x: 1 });
    assert.equal((await decide('mcp__slack-mcp__slack_search_public')).behavior, 'allow');
  });

  it('a Slack tool is denied when no Slack server is configured', async () => {
    const canUseTool = /** @type {any} */ (onlyConfiguredMcpTools(['casey-tools']));
    const result = await canUseTool('mcp__slack-mcp__slack_send_message', {}, { signal: new AbortController().signal });
    assert.equal(result.behavior, 'deny');
  });

  it('loads no Claude Code settings and no MCP servers but its own', () => {
    const o = options();
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(Object.keys(o.mcpServers ?? {}), ['casey-tools', 'slack-mcp']);
    assert.equal(o.plugins, undefined);
    assert.equal(o.hooks, undefined);
  });

  it('gives the SDK no secret but the model credential', () => {
    const env = /** @type {Record<string, string>} */ (options().env);
    const names = Object.keys(env);
    assert.deepEqual(
      names.filter((n) => /TOKEN|SECRET|PASSWORD/i.test(n)),
      [],
    );
    const credentials = names.filter((n) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(n));
    assert.deepEqual(credentials, [MODEL_CREDENTIAL]);
    for (const name of ['SLACK_CLIENT_ID', 'FOUNDATION_URL', 'NODE_OPTIONS', 'OPENAI_API_KEY']) {
      assert.ok(!names.includes(name), `${name} is not passed`);
    }
    for (const value of Object.values(env)) {
      assert.ok(!/^(xox|xapp)/.test(value), 'no Slack token value');
      assert.notEqual(value, ambient.FOUNDATION_SERVICE_TOKEN);
    }
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.Path, 'C:\\Windows');
    assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
  });

  it('defaults to the process environment, filtered', () => {
    const env = caseyEnv();
    for (const name of Object.keys(env)) assert.ok(!/TOKEN|SECRET|PASSWORD/i.test(name), name);
  });

  it('works in an empty, private folder outside the repo', () => {
    const cwd = /** @type {string} */ (options().cwd);
    assert.ok(isAbsolute(cwd));
    const fromRepo = relative(repoRoot, cwd);
    assert.ok(fromRepo.startsWith('..') || isAbsolute(fromRepo), `${cwd} is outside ${repoRoot}`);
    assert.ok(statSync(cwd).isDirectory());
    if (process.platform !== 'win32') assert.equal(statSync(cwd).mode & 0o777, 0o700);
    assert.equal(scratchDir(), cwd);
  });

  it('resumes a session only when given one', () => {
    assert.equal(options().resume, undefined);
    const o = buildCaseyOptions({ systemPrompt: '', mcpServers: {}, cwd: scratchDir(), env: {}, sessionId: 's-1' });
    assert.equal(o.resume, 's-1');
  });
});
