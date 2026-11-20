import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ownIssueSubmission, refusal } from '../../../listeners/events/sender.js';

const context = { teamId: 'T1', botId: 'B1' };

describe('who Casey answers', () => {
  it('answers a person in its own workspace', () => {
    assert.equal(refusal({ user: 'U1', team: 'T1' }, context), null);
    assert.equal(refusal({ user: 'U1' }, context), null);
  });

  it('refuses bots', () => {
    assert.equal(refusal({ bot_id: 'B2', user: 'U2' }, context), 'bot');
    assert.equal(refusal({ subtype: 'bot_message' }, context), 'bot');
    assert.equal(refusal({ bot_profile: { id: 'B2' } }, context), 'bot');
  });

  it('refuses people from another workspace', () => {
    assert.equal(refusal({ user: 'U9', user_team: 'T9', team: 'T1' }, context), 'outside_workspace');
    assert.equal(refusal({ user: 'U9', team: 'T9' }, context), 'outside_workspace');
  });

  it('trusts issue metadata only on its own bot messages', () => {
    const metadata = { event_type: 'issue_submission', event_payload: { user_id: 'U1' } };
    assert.deepEqual(ownIssueSubmission({ bot_id: 'B1', metadata }, context), metadata);
    assert.equal(ownIssueSubmission({ bot_id: 'B2', metadata }, context), null);
    assert.equal(ownIssueSubmission({ user: 'U3', metadata }, context), null);
    assert.equal(ownIssueSubmission({ bot_id: 'B1', metadata }, {}), null);
    assert.equal(ownIssueSubmission({ bot_id: 'B1' }, context), null);
  });
});
