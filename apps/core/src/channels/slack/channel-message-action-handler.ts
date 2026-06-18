import type { MessageActionAffordanceKind } from '../../domain/types.js';

const SCHEDULER_MESSAGE_ACTION_KINDS = new Set<MessageActionAffordanceKind>([
  'scheduler_run_now',
  'scheduler_pause_job',
  'scheduler_open',
]);

type SlackAppLike = {
  action: (name: string, handler: (args: any) => Promise<void>) => void;
  client: {
    chat: {
      postEphemeral: (input: any) => Promise<unknown>;
    };
  };
};

export function registerSlackMessageActionHandler(app: SlackAppLike): void {
  app.action('gantry_message_action', async (args: any) => {
    await args.ack();
    const action = args.action as { value?: string };
    const body = args.body as {
      channel?: { id?: string };
      user?: { id?: string };
    };
    let payload:
      | {
          kind?: unknown;
          jobId?: unknown;
        }
      | undefined;
    try {
      payload = action.value ? JSON.parse(action.value) : undefined;
    } catch {
      return;
    }
    if (
      !payload ||
      typeof payload.kind !== 'string' ||
      !SCHEDULER_MESSAGE_ACTION_KINDS.has(
        payload.kind as MessageActionAffordanceKind,
      ) ||
      typeof payload.jobId !== 'string' ||
      payload.jobId.trim().length === 0 ||
      !body.channel?.id ||
      !body.user?.id
    ) {
      return;
    }
    try {
      await app.client.chat.postEphemeral({
        channel: body.channel.id,
        user: body.user.id,
        text: 'Scheduler action buttons are visible hints only in this channel. Open the scheduler surface or use scheduler tools to run this action.',
      });
    } catch {
      // ignore callback feedback failures
    }
  });
}
