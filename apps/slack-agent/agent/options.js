/**
 * What Casey's Claude Agent SDK session is allowed to do.
 *
 * Casey is started by Slack messages, so everything it reads is someone
 * else's text. It gets only the MCP tools this app hands it (its own helpdesk
 * tools and, when a user token is present, Slack's) and nothing from the
 * computer it runs on: no shell, no files, no web fetch, no settings, hooks,
 * skills, plugins or MCP servers from the user's or the repo's Claude Code
 * configuration, none of this process's secrets, and a working folder that is
 * empty and outside the checkout.
 *
 * Option names are the installed SDK's (`@anthropic-ai/claude-agent-sdk`
 * 0.3.x, `sdk.d.ts`, type `Options`).
 */

import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The SDK's built-in tools, by name. `tools: []` already removes them all;
 * this list is the second fence (`disallowedTools`), so a built-in that
 * comes back by default in a later SDK is still refused by name.
 */
export const BUILT_IN_TOOLS = Object.freeze([
  'Agent',
  'Task',
  'Bash',
  'BashOutput',
  'KillBash',
  'KillShell',
  'PowerShell',
  'Monitor',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'ExitPlanMode',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'Workflow',
  'SendMessage',
  'Artifact',
  'PushNotification',
]);

/**
 * The model credential Casey needs, and the only secret its SDK process gets.
 */
export const MODEL_CREDENTIAL = 'ANTHROPIC_API_KEY';

/**
 * Everything else the SDK's process may inherit: where programs, home,
 * app data and temp folders are, the locale, and the proxy. Matched without
 * regard to case (Windows spells it `Path`).
 */
export const ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * The SDK child's environment: the allowlist plus the model credential, read
 * from `source`. Nothing else (no Slack or Foundation tokens, no NODE_OPTIONS).
 * @param {Record<string, string | undefined>} [source]
 * @returns {Record<string, string>}
 */
export function caseyEnv(source = process.env) {
  const allowed = new Set([...ENV_ALLOWLIST, MODEL_CREDENTIAL]);
  /** @type {Record<string, string>} */
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string' && allowed.has(name.toUpperCase())) env[name] = value;
  }
  return env;
}

/** @type {string | null} */
let scratch = null;

/**
 * Casey's working folder: empty, under the OS temp folder (outside the repo),
 * readable only by this user, one per process.
 * @returns {string}
 */
export function scratchDir() {
  if (!scratch) {
    scratch = mkdtempSync(join(tmpdir(), 'casey-'));
    chmodSync(scratch, 0o700);
  }
  return scratch;
}

/**
 * The permission check: a tool runs only if it belongs to one of the MCP
 * servers this app configured. Everything else is refused.
 * @param {string[]} serverNames - keys of `mcpServers`
 * @returns {import('@anthropic-ai/claude-agent-sdk').CanUseTool}
 */
export function onlyConfiguredMcpTools(serverNames) {
  const prefixes = serverNames.map((name) => `mcp__${name}__`);
  const names = new Set(serverNames);
  return async (toolName, input, opts) => {
    const prefix = prefixes.find((p) => typeof toolName === 'string' && toolName.startsWith(p));
    const server = opts?.mcpServer;
    const serverOk = !server || names.has(server.name);
    if (prefix && toolName.length > prefix.length && serverOk) {
      return { behavior: 'allow', updatedInput: input };
    }
    return {
      behavior: 'deny',
      message: `Casey can't use ${String(toolName)}: only its helpdesk and Slack tools are allowed.`,
    };
  };
}

/**
 * The SDK options for one Casey run. Pure apart from what it is handed.
 * @param {{
 *   systemPrompt: string,
 *   mcpServers: Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>,
 *   cwd: string,
 *   env?: Record<string, string | undefined>,
 *   sessionId?: string,
 * }} params
 * @returns {import('@anthropic-ai/claude-agent-sdk').Options}
 */
export function buildCaseyOptions({ systemPrompt, mcpServers, cwd, env = process.env, sessionId }) {
  return {
    systemPrompt,
    mcpServers,
    tools: [],
    disallowedTools: [...BUILT_IN_TOOLS],
    permissionMode: 'default',
    canUseTool: onlyConfiguredMcpTools(Object.keys(mcpServers)),
    settingSources: [],
    strictMcpConfig: true,
    env: caseyEnv(env),
    cwd,
    ...(sessionId && { resume: sessionId }),
  };
}
