import type { NewMessage } from '../../domain/types.js';
import type {
  InboundConnectionScope,
  StagedInboundEventRepository,
} from '../../domain/ports/inbound-events.js';
import {
  INBOUND_EVENT_ATTEMPT_MS,
  INBOUND_EVENT_RETRY_GAPS_MS,
} from '../../domain/ports/inbound-events.js';
import { stableSha256Json } from '../../shared/stable-hash.js';

/** Bind durable ingress to trusted configured accounts, never provider payloads. */
export function createDurableChannelInbound(
  input: Parameters<typeof createDurableInboundMessages>[0] & {
    appId: string;
    accounts: () => Record<
      string,
      { provider: string; runtimeSecretRefs?: Record<string, string> }
    >;
    providerForJid: (jid: string) => { durableInbound?: boolean } | undefined;
  },
) {
  const inbox = createDurableInboundMessages(input);
  const scopes = new Map<string, InboundConnectionScope>();
  const scopeFor = (providerAccountId: string): InboundConnectionScope => {
    const account = input.accounts()[providerAccountId];
    if (!account)
      throw new Error(
        'The account is not configured. Check its provider settings.',
      );
    return {
      appId: input.appId,
      providerId: account.provider,
      connectionId: stableSha256Json([
        account.provider,
        account.runtimeSecretRefs,
      ]),
    };
  };
  return {
    onMessage: async (chatJid: string, message: NewMessage) => {
      if (!input.providerForJid(chatJid)?.durableInbound)
        return input.processMessage(chatJid, message);
      if (!message.providerAccountId)
        throw new Error(
          'The message has no account. Reconnect the bot and try again.',
        );
      return inbox.save(scopeFor(message.providerAccountId), chatJid, message);
    },
    track: (providerAccountId: string) => {
      const scope = scopeFor(providerAccountId);
      scopes.set(scope.connectionId, scope);
    },
    clear: () => scopes.clear(),
    recover: async () => {
      for (const scope of scopes.values()) await inbox.recover(scope);
    },
  };
}

/** Save normalized Gantry data; the existing admission poll resumes it. */
export function createDurableInboundMessages(input: {
  repository: () => StagedInboundEventRepository;
  processMessage: (
    chatJid: string,
    message: NewMessage,
  ) => Promise<'stored' | 'dropped'>;
  warn: (context: Record<string, unknown>, message: string) => void;
}) {
  const active = new Map<string, Promise<void>>();
  const recover = (scope: InboundConnectionScope): Promise<void> => {
    const key = JSON.stringify(scope);
    const previous = active.get(key);
    if (previous) return previous;
    const work = (async () => {
      const repository = input.repository();
      if (
        !repository.claimHeads ||
        !repository.settle ||
        !repository.retryLater
      )
        throw new Error(
          'Durable inbound recovery is unavailable. Restart Gantry after updating it.',
        );
      const events = await repository.claimHeads({ scope, limit: 4 });
      await Promise.all(
        events.map(async (event) => {
          const guard = {
            appId: scope.appId,
            eventId: event.id,
            claimToken: event.claimToken,
            deadlineAt: event.deadlineAt,
          };
          const payload = event.payload as {
            chatJid: string;
            message: NewMessage;
          };
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            // Canonical message/admission identity makes a late storage completion
            // safe to retry; one slow connection must not stall the admission poll.
            await Promise.race([
              input.processMessage(payload.chatJid, payload.message),
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () => reject(new Error('Inbound admission timed out')),
                  INBOUND_EVENT_ATTEMPT_MS,
                );
              }),
            ]);
            const result = await repository.settle!(guard);
            if (result.outcome !== 'applied')
              input.warn(
                { eventId: event.id },
                'Inbound completion lost its claim',
              );
          } catch {
            await repository.retryLater!({
              ...guard,
              nextAttemptAt: new Date(
                Date.now() +
                  (INBOUND_EVENT_RETRY_GAPS_MS[event.attempts - 1] ?? 40_000),
              ).toISOString(),
              failedOperation: 'message_admission',
            });
            input.warn(
              { eventId: event.id },
              'Inbound message will be retried',
            );
          } finally {
            clearTimeout(timeout);
          }
        }),
      );
    })().finally(() => {
      active.delete(key);
    });
    active.set(key, work);
    return work;
  };
  return {
    async save(
      scope: InboundConnectionScope,
      chatJid: string,
      message: NewMessage,
    ): Promise<'stored'> {
      const result = await input.repository().save({
        ...scope,
        kind: 'message',
        eventKey: JSON.stringify([
          message.providerAccountId,
          chatJid,
          message.thread_id ?? null,
          message.id,
        ]),
        rawChannelId: chatJid,
        rawThreadId: message.thread_id ?? null,
        rawMessageId: message.id,
        // Optional canonical fields can be undefined in memory; the inbox only
        // accepts the JSON representation that Postgres will actually retain.
        payload: JSON.parse(JSON.stringify({ chatJid, message })) as unknown,
        control: null,
      });
      if (result.outcome !== 'saved' && result.outcome !== 'duplicate')
        throw new Error(
          'Gantry could not save this message. Please send it again.',
        );
      return 'stored';
    },
    recover,
  };
}
