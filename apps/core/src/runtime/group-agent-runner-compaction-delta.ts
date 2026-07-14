import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { ConversationRoute, NewMessage } from '../domain/types.js';
import { formatMessages } from '../messaging/router.js';
import type { GroupProcessingRepository } from './group-processing-types.js';

const COMPACTION_DELTA_REPLAY_MAX_MESSAGES = 50;
const COMPACTION_DELTA_REPLAY_MAX_AGE_MS = 30 * 60_000;

type TurnContext =
  | Awaited<
      ReturnType<NonNullable<GroupProcessingRepository['getAgentTurnContext']>>
    >
  | undefined;

function stale(lockedAt?: string): boolean {
  if (!lockedAt) return false;
  const timestamp = Date.parse(lockedAt);
  return (
    Number.isFinite(timestamp) &&
    Date.now() - timestamp > COMPACTION_DELTA_REPLAY_MAX_AGE_MS
  );
}

function deltaBlock(messages: readonly NewMessage[]): string {
  if (messages.length === 0) return '';
  return [
    '<gantry_compaction_delta>',
    'Messages persisted after the compaction base cursor. Use this delta before continuing the compacted provider session.',
    formatMessages([...messages], 'UTC'),
    '</gantry_compaction_delta>',
  ].join('\n');
}

export async function prepareCompactionDeltaReplay(input: {
  turnContext: TurnContext;
  loadTurnContext: (
    promoteReadyProviderSession: boolean,
  ) => Promise<TurnContext>;
  repository: GroupProcessingRepository;
  executionProviderId: ExecutionProviderId;
  group: ConversationRoute;
  chatJid: string;
  threadId: string | null;
  maintenanceProviderSession?: unknown;
}): Promise<{
  turnContext: TurnContext;
  block: string;
  markApplied?: (repository: GroupProcessingRepository) => Promise<void>;
}> {
  const pending = input.turnContext?.compactionDeltaReplay;
  if (input.maintenanceProviderSession) {
    return { turnContext: input.turnContext, block: '' };
  }
  if (
    !input.turnContext?.latestProviderSessionReady ||
    pending?.status !== 'pending'
  ) {
    return {
      turnContext: await input.loadTurnContext(true),
      block: '',
    };
  }

  const baseCursor = pending.baseCursor;
  const tooStale = stale(pending.lockedAt);
  const getDeltaMessages =
    input.repository.getContextMessagesSince ??
    input.repository.getMessagesSince;
  const messages =
    !tooStale && baseCursor
      ? await getDeltaMessages.call(
          input.repository,
          input.chatJid,
          baseCursor,
          COMPACTION_DELTA_REPLAY_MAX_MESSAGES + 1,
          {
            threadId: input.threadId,
            providerAccountId: input.group.providerAccountId,
          },
        )
      : [];

  const providerSessionId = input.turnContext.readyProviderSessionId;
  const externalSessionId = input.turnContext.readyExternalSessionId;
  if (tooStale || messages.length > COMPACTION_DELTA_REPLAY_MAX_MESSAGES) {
    if (providerSessionId && externalSessionId) {
      await input.repository.markProviderSessionDeltaReplay?.({
        providerSessionId,
        agentSessionId: input.turnContext.agentSessionId,
        provider: input.executionProviderId,
        externalSessionId,
        status: 'degraded',
        reason: tooStale ? 'stale' : 'too_large',
      });
      await input.repository.expireProviderSession?.({
        providerSessionId,
        agentSessionId: input.turnContext.agentSessionId,
        provider: input.executionProviderId,
        externalSessionId,
      });
      return { turnContext: await input.loadTurnContext(false), block: '' };
    }
  }

  const replayTurnContext = {
    ...input.turnContext,
    providerSessionId,
    externalSessionId,
  };
  return {
    turnContext: replayTurnContext,
    block: deltaBlock(messages),
    markApplied: async (repository) => {
      const promoted = await input.loadTurnContext(true);
      if (
        !promoted?.providerSessionId ||
        !promoted.externalSessionId ||
        !promoted.agentSessionId
      )
        return;
      await repository.markProviderSessionDeltaReplay?.({
        providerSessionId: promoted.providerSessionId,
        agentSessionId: promoted.agentSessionId,
        provider: input.executionProviderId,
        externalSessionId: promoted.externalSessionId,
        status: 'applied',
        ...(baseCursor ? { compactionBaseCursor: baseCursor } : {}),
      });
    },
  };
}
