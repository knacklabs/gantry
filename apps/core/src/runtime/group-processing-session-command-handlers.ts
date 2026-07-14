import type { ConversationRoute } from '../domain/types.js';
import {
  createSessionArchiveHandlers,
  createSessionCompactionHandlers,
} from './group-session-command-state.js';
import { resolveGroupRouteExecutionProviderIdForDeps } from './group-initial-execution-provider.js';
import type {
  GroupProcessingDeps,
  GroupProcessingRepository,
} from './group-processing-types.js';

export function createGroupProcessingSessionCommandHandlers(input: {
  ops: () => GroupProcessingRepository;
  appId: string;
  defaultModel?: string;
  group: ConversationRoute;
  chatJid: string;
  threadId: string | null;
  defaultScope: 'user' | 'group';
  memoryUserId?: string;
  collectMemory?: GroupProcessingDeps['collectSessionMemory'];
  deps: Pick<
    GroupProcessingDeps,
    | 'executionAdapter'
    | 'executionAdapters'
    | 'getAsyncTaskRepository'
    | 'getConfiguredModelProviders'
    | 'getModelFamilyOrder'
    | 'getSelectedAgentHarness'
    | 'publishRuntimeEvent'
  >;
}) {
  const { deps, group, appId } = input;
  const stateInput = {
    ops: input.ops,
    appId,
    group,
    chatJid: input.chatJid,
    threadId: input.threadId,
    defaultScope: input.defaultScope,
    memoryUserId: input.memoryUserId,
    collectMemory: input.collectMemory,
    executionAdapter: deps.executionAdapter,
    executionAdapters: deps.executionAdapters,
    resolveExecutionProviderId: () =>
      resolveGroupRouteExecutionProviderIdForDeps({
        group,
        appId,
        defaultModel: input.defaultModel,
        deps,
      }),
    getAsyncTaskRepository: deps.getAsyncTaskRepository,
    publishRuntimeEvent: deps.publishRuntimeEvent,
  };
  return {
    ...createSessionArchiveHandlers(stateInput),
    ...createSessionCompactionHandlers(stateInput),
  };
}
