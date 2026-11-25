import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const skipped = new Set(['node_modules', 'tests', '.git', 'data']);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name) || entry.name.startsWith('.env')) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

it('nothing in the Slack agent bypasses permissions', () => {
  const word = ['bypass', 'Permissions'].join('');
  const found = files(appRoot).filter((path) => readFileSync(path, 'latin1').includes(word));
  assert.deepEqual(found, []);
});
