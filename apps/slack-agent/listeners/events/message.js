import { runCaseyAgent } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';
import { errorMessage, FAILURE_TEXT, NOT_OWNER_TEXT } from './replies.js';
import { ownIssueSubmission, refusal } from './sender.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
}

/**
 * @param {{ runAgent?: typeof runCaseyAgent, store?: import('../../thread-context/store.js').SessionStore }} [deps]
 * @returns {(args: import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>) => Promise<void>}
 */
export function makeMessageHandler({ runAgent = runCaseyAgent, store = sessionStore } = {}) {
  return async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
    if (!isGenericMessageEvent(event)) return;

    const issueMetadata = ownIssueSubmission(event, context);

    const refused = issueMetadata ? null : refusal(event, context);
    if (refused) {
      logger.info(`Casey: not answering a message (${refused})`);
      return;
    }

    const isDm = event.channel_type === 'im';
    if (!isDm && !event.thread_ts) return;
    if (!isDm && context.botUserId && (event.text ?? '').includes(`<@${context.botUserId}>`)) return;

    const userId = issueMetadata ? issueMetadata.event_payload.user_id : context.userId;
    if (!userId) return;

    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;
    const decision = store.decide(channelId, threadTs, userId, {
      startIfNew: isDm && !store.isEngaged(channelId, threadTs),
    });

    if (decision.kind === 'not_engaged') return;
    if (decision.kind === 'not_owner') {
      logger.info('Casey: a reply in a thread someone else started was not run');
      if (store.firstRefusal(channelId, threadTs, userId)) {
        await say({ text: NOT_OWNER_TEXT, thread_ts: threadTs });
      }
      return;
    }

    try {
      const existingSessionId = decision.kind === 'resume' ? decision.sessionId : undefined;

      if (isDm && !existingSessionId) {
        await client.reactions.add({
          channel: channelId,
          timestamp: event.ts,
          name: 'eyes',
        });
      }

      await setStatus({
        status: 'Thinking…',
        loading_messages: [
          'Teaching the hamsters to type faster…',
          'Untangling the internet cables…',
          'Consulting the office goldfish…',
          'Polishing up the response just for you…',
          'Convincing the AI to stop overthinking…',
        ],
      });

      const userToken = issueMetadata ? undefined : context.userToken;
      const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken };
      const { responseText, sessionId: newSessionId } = await runAgent(event.text || '', existingSessionId, deps);

      const streamer = sayStream();
      await streamer.append({ markdown_text: responseText });
      await streamer.stop({ blocks: buildFeedbackBlocks() });

      if (newSessionId) {
        store.setSession(channelId, threadTs, newSessionId, userId);
      }
    } catch (e) {
      logger.error(`Failed to handle message: ${errorMessage(e)}`);
      await say({ text: FAILURE_TEXT, thread_ts: threadTs });
    }
  };
}

/**
 * Handle messages sent to Casey via DM, or replies in threads where the
 * sender already has a session with Casey.
 */
export const handleMessage = makeMessageHandler();
