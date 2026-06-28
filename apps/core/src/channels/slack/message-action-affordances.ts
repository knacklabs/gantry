import type { MessageActionAffordance } from '../../domain/types.js';

const SLACK_ACTION_VALUE_MAX_BYTES = 2000;
const SCHEDULER_ACTION_KINDS = new Set<MessageActionAffordance['kind']>([
  'scheduler_run_now',
  'scheduler_pause_job',
  'scheduler_open',
]);

function truncateSlackButtonLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= 75) return trimmed;
  return `${trimmed.slice(0, 72)}...`;
}

function slackActionValue(action: MessageActionAffordance): string | undefined {
  const value =
    action.kind === 'live_turn_stop'
      ? JSON.stringify({ kind: action.kind, actionToken: action.actionToken })
      : SCHEDULER_ACTION_KINDS.has(action.kind)
        ? JSON.stringify({
            kind: action.kind,
            jobId: action.jobId,
            runId: action.runId ?? null,
          })
        : undefined;
  if (!value) return undefined;
  return Buffer.byteLength(value, 'utf8') <= SLACK_ACTION_VALUE_MAX_BYTES
    ? value
    : undefined;
}

export function slackMessageActionBlocks(
  text: string,
  actions?: MessageActionAffordance[],
  options: { actionOnly?: boolean } = {},
): Array<Record<string, unknown>> | undefined {
  const elements = (actions ?? [])
    .map((action) => {
      const value = slackActionValue(action);
      if (!value) return null;
      return {
        type: 'button',
        action_id: 'gantry_message_action',
        text: {
          type: 'plain_text',
          text: truncateSlackButtonLabel(action.label),
        },
        ...(action.kind === 'scheduler_pause_job' ||
        action.kind === 'live_turn_stop'
          ? { style: 'danger' as const }
          : {}),
        value,
      };
    })
    .filter((action) => action !== null) as Array<Record<string, unknown>>;
  if (elements.length === 0) return undefined;
  const actionBlock = {
    type: 'actions',
    elements,
  };
  return options.actionOnly
    ? [actionBlock]
    : [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
        actionBlock,
      ];
}
