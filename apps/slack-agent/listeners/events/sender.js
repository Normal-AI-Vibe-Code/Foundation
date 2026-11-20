/**
 * Why Casey should not run for this event, or null when it may.
 *
 * Bots are refused (Casey's own issue submissions are let through by the
 * message handler before this is asked), and so are people whose workspace
 * is not the one Casey is installed in, as Slack Connect channels deliver.
 * @param {any} event
 * @param {{ teamId?: string, isEnterpriseInstall?: boolean }} context
 * @returns {'bot' | 'outside_workspace' | null}
 */
export function refusal(event, context) {
  if (event.bot_id || event.bot_profile || event.subtype === 'bot_message') return 'bot';
  const team = event.user_team ?? event.team;
  if (team && context.teamId && team !== context.teamId && !context.isEnterpriseInstall) return 'outside_workspace';
  return null;
}

/**
 * The issue submission Casey itself posted for a person, or null. Metadata on
 * anyone else's message (another app's, or a person's posted through the
 * API) is not trusted to say who is asking.
 * @param {any} event
 * @param {{ botId?: string }} context
 * @returns {{ event_type: 'issue_submission', event_payload: { user_id: string } } | null}
 */
export function ownIssueSubmission(event, context) {
  const metadata = event.metadata;
  if (metadata?.event_type !== 'issue_submission') return null;
  if (!context.botId || event.bot_id !== context.botId) return null;
  if (typeof metadata.event_payload?.user_id !== 'string') return null;
  return metadata;
}
