import {
  requestSlackLiveUx,
  slackReactionName,
  SlackLiveUxResponseError,
} from './live-ux.js';

export function isSlackAlreadyReactedError(err: unknown): boolean {
  if (err instanceof SlackLiveUxResponseError) {
    return err.code === 'already_reacted';
  }
  return (
    typeof err === 'object' &&
    err !== null &&
    'data' in err &&
    typeof (err as { data?: { error?: unknown } }).data?.error === 'string' &&
    (err as { data: { error: string } }).data.error === 'already_reacted'
  );
}

export function isSlackReactionAlreadyAbsentError(err: unknown): boolean {
  if (err instanceof SlackLiveUxResponseError) {
    return ['no_reaction', 'already_reacted'].includes(err.code);
  }
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
  botToken: string;
  jid: string;
  channelId: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
  signal?: AbortSignal;
  reconcile?: boolean;
}): Promise<void> {
  if (!input.messageRef.trim()) return;
  const name = slackReactionName(input.emoji);
  const key = `${input.jid}:${input.messageRef}:${name}`;
  if (!input.reconcile && input.reactionKeys.has(key)) return;
  const invalidate = () => input.reactionKeys.delete(key);
  input.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    await requestSlackLiveUx({
      method: 'reactions.add',
      botToken: input.botToken,
      channelId: input.channelId,
      messageRef: input.messageRef,
      name,
      signal: input.signal,
    });
    if (!input.signal?.aborted) input.reactionKeys.add(key);
  } catch (err) {
    if (isSlackAlreadyReactedError(err)) {
      if (!input.signal?.aborted) input.reactionKeys.add(key);
      return;
    }
    throw err;
  } finally {
    input.signal?.removeEventListener('abort', invalidate);
  }
}

export async function removeSlackReaction(input: {
  botToken: string;
  jid: string;
  channelId: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
  signal?: AbortSignal;
  reconcile?: boolean;
}): Promise<void> {
  if (!input.messageRef.trim()) return;
  const name = slackReactionName(input.emoji);
  const key = `${input.jid}:${input.messageRef}:${name}`;
  const invalidate = () => input.reactionKeys.delete(key);
  input.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    await requestSlackLiveUx({
      method: 'reactions.remove',
      botToken: input.botToken,
      channelId: input.channelId,
      messageRef: input.messageRef,
      name,
      signal: input.signal,
    });
    if (!input.signal?.aborted) input.reactionKeys.delete(key);
  } catch (err) {
    if (isSlackReactionAlreadyAbsentError(err)) {
      if (!input.signal?.aborted) input.reactionKeys.delete(key);
      return;
    }
    throw err;
  } finally {
    input.signal?.removeEventListener('abort', invalidate);
  }
}
