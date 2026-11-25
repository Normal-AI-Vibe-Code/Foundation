import { runCaseyAgent } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';
import { errorMessage, FAILURE_TEXT } from './replies.js';
import { refusal } from './sender.js';

/**
 * @param {{ runAgent?: typeof runCaseyAgent, store?: import('../../thread-context/store.js').SessionStore }} [deps]
 * @returns {(args: import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>) => Promise<void>}
 */
export function makeAppMentionedHandler({ runAgent = runCaseyAgent, store = sessionStore } = {}) {
  return async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
    const refused = refusal(event, context);
    if (refused) {
      logger.info(`Casey: not answering a mention (${refused})`);
      return;
    }
    const userId = context.userId ?? event.user;
    if (!userId) return;

    const channelId = event.channel;
    const threadTs = event.thread_ts || event.ts;
    try {
      const cleanedText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!cleanedText) {
        await say({
          text: "Hey there! How can I help you? Describe your IT issue and I'll do my best to assist.",
          thread_ts: threadTs,
        });
        return;
      }

      if (!event.thread_ts) {
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

      const decision = store.decide(channelId, threadTs, userId, { startIfNew: true });
      const existingSessionId = decision.kind === 'resume' ? decision.sessionId : undefined;

      const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken };
      const { responseText, sessionId: newSessionId } = await runAgent(cleanedText, existingSessionId, deps);

      const streamer = sayStream();
      await streamer.append({ markdown_text: responseText });
      await streamer.stop({ blocks: buildFeedbackBlocks() });

      if (newSessionId) {
        store.setSession(channelId, threadTs, newSessionId, userId);
      }
    } catch (e) {
      logger.error(`Failed to handle app mention: ${errorMessage(e)}`);
      await say({ text: FAILURE_TEXT, thread_ts: threadTs });
    }
  };
}

/**
 * Handle app_mention events and run the Casey agent. A mention resumes only
 * the sender's own session in that thread; anyone else's mention starts theirs.
 */
export const handleAppMentioned = makeAppMentionedHandler();
