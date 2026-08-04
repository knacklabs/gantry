import { logger } from '../../infrastructure/logging/logger.js';

export function slackReactionName(emoji: string): string {
  if (emoji === 'seen') return 'eyes';
  if (emoji === 'running') return 'hourglass_flowing_sand';
  return emoji.replace(/^:+|:+$/g, '');
}

export function isSlackAlreadyReactedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'data' in err &&
    typeof (err as { data?: { error?: unknown } }).data?.error === 'string' &&
    (err as { data: { error: string } }).data.error === 'already_reacted'
  );
}

export function isSlackReactionAlreadyAbsentError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'data' in err &&
    typeof (err as { data?: { error?: unknown } }).data?.error === 'string' &&
    ['no_reaction', 'already_reacted'].includes(
      (err as { data: { error: string } }).data.error,
    )
  );
}

export async function addSlackReaction(input: {
  app: { client: { reactions: { add(args: unknown): Promise<unknown> } } };
  jid: string;
  channelId: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
}): Promise<void> {
  if (!input.messageRef.trim()) return;
  const name = slackReactionName(input.emoji);
  const key = `${input.jid}:${input.messageRef}:${name}`;
  if (input.reactionKeys.has(key)) return;
  try {
    await input.app.client.reactions.add({
      channel: input.channelId,
      timestamp: input.messageRef,
      name,
    });
    input.reactionKeys.add(key);
  } catch (err) {
    if (isSlackAlreadyReactedError(err)) {
      input.reactionKeys.add(key);
      return;
    }
    logger.debug(
      { jid: input.jid, messageRef: input.messageRef, err },
      'Slack reaction update failed',
    );
  }
}

export async function removeSlackReaction(input: {
  app: { client: { reactions: { remove(args: unknown): Promise<unknown> } } };
  jid: string;
  channelId: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
}): Promise<void> {
  if (!input.messageRef.trim()) return;
  const name = slackReactionName(input.emoji);
  const key = `${input.jid}:${input.messageRef}:${name}`;
  try {
    await input.app.client.reactions.remove({
      channel: input.channelId,
      timestamp: input.messageRef,
      name,
    });
    input.reactionKeys.delete(key);
  } catch (err) {
    if (isSlackReactionAlreadyAbsentError(err)) {
      input.reactionKeys.delete(key);
      return;
    }
    logger.debug(
      { jid: input.jid, messageRef: input.messageRef, err },
      'Slack reaction removal failed',
    );
  }
}
