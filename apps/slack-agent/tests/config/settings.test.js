import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LogLevel } from '@slack/bolt';

import { logLevelFrom, stateSecretProblem } from '../../config/settings.js';

describe('OAuth state secret', () => {
  it('refuses when unset', () => {
    assert.match(/** @type {string} */ (stateSecretProblem(undefined)), /SLACK_STATE_SECRET/);
    assert.match(/** @type {string} */ (stateSecretProblem('')), /at least 32/);
  });

  it('refuses when shorter than 32 characters', () => {
    assert.match(/** @type {string} */ (stateSecretProblem('a'.repeat(31))), /31 characters/);
    assert.match(/** @type {string} */ (stateSecretProblem('bolt-js-support-agent')), /needs at least 32/);
  });

  it('accepts 32 characters or more', () => {
    assert.equal(stateSecretProblem('a'.repeat(32)), null);
    assert.equal(stateSecretProblem('f'.repeat(64)), null);
  });
});

describe('Bolt log level', () => {
  it('is INFO by default', () => {
    assert.equal(logLevelFrom(undefined), LogLevel.INFO);
    assert.equal(logLevelFrom(''), LogLevel.INFO);
    assert.equal(logLevelFrom('verbose'), LogLevel.INFO);
  });

  it('can be set from the environment', () => {
    assert.equal(logLevelFrom('debug'), LogLevel.DEBUG);
    assert.equal(logLevelFrom(' WARN '), LogLevel.WARN);
    assert.equal(logLevelFrom('error'), LogLevel.ERROR);
  });
});
