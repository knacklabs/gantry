import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { ConversationRoute } from '../domain/types.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import {
  defaultModelStatusSelection,
  type ModelStatusSelectionUpdate,
} from '../session/session-model-status.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';
import {
  executionProviderIdForCandidate,
  resolveTurnFailoverCandidates,
} from './failover-candidate-loop.js';
import type { GroupProcessingDeps } from './group-processing-types.js';

const DEFAULT_MODEL_ALIAS = 'opus';

export async function resolveInitialGroupExecutionProviderId(input: {
  group: Pick<ConversationRoute, 'agentConfig' | 'folder'>;
  appId: string;
  defaultModel?: string;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
  agentHarness: AgentHarness;
  listConfiguredProviders?: GroupProcessingDeps['getConfiguredModelProviders'];
  familyOrder?: ReturnType<
    NonNullable<GroupProcessingDeps['getModelFamilyOrder']>
  >;
}): Promise<{
  executionProviderId: ExecutionProviderId;
  firstModel?: string;
  failoverCandidates: string[];
  initialModelSelection: ModelStatusSelectionUpdate;
}> {
  const requestedModel = input.group.agentConfig?.model ?? input.defaultModel;
  const initialModelSelection = defaultModelStatusSelection(
    requestedModel ?? DEFAULT_MODEL_ALIAS,
  );
  const failoverCandidates = await resolveTurnFailoverCandidates({
    requestedModel,
    appId: input.appId,
    listConfiguredProviders: input.listConfiguredProviders,
    familyOrder: input.familyOrder,
  });
  const firstModel = failoverCandidates[0];
  const liveTurnRoute = initialModelSelection.model
    ? resolveExecutionRoute({
        entry: initialModelSelection.model,
        agentHarness: input.agentHarness,
      })
    : undefined;
  const fallbackExecutionProviderId = (): ExecutionProviderId =>
    resolveRuntimeExecutionProviderId(
      input.executionAdapter,
    ) as ExecutionProviderId;
  return {
    initialModelSelection,
    failoverCandidates,
    ...(firstModel ? { firstModel } : {}),
    executionProviderId: firstModel
      ? executionProviderIdForCandidate(
          firstModel,
          undefined,
          input.agentHarness,
        )
      : liveTurnRoute?.ok
        ? (liveTurnRoute.value.executionProviderId as ExecutionProviderId)
        : fallbackExecutionProviderId(),
  };
}

export async function resolveGroupRouteExecutionProviderId(input: {
  group: Pick<ConversationRoute, 'agentConfig' | 'folder'>;
  appId: string;
  defaultModel?: string;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
  agentHarness: AgentHarness;
  listConfiguredProviders?: GroupProcessingDeps['getConfiguredModelProviders'];
  familyOrder?: ReturnType<
    NonNullable<GroupProcessingDeps['getModelFamilyOrder']>
  >;
}): Promise<ExecutionProviderId> {
  return (await resolveInitialGroupExecutionProviderId(input))
    .executionProviderId;
}

export function resolveGroupRouteExecutionProviderIdForDeps(input: {
  group: Pick<ConversationRoute, 'agentConfig' | 'folder'>;
  appId: string;
  defaultModel?: string;
  deps: Pick<
    GroupProcessingDeps,
    | 'executionAdapter'
    | 'getConfiguredModelProviders'
    | 'getModelFamilyOrder'
    | 'getSelectedAgentHarness'
  >;
}): Promise<ExecutionProviderId> {
  return resolveGroupRouteExecutionProviderId({
    group: input.group,
    appId: input.appId,
    defaultModel: input.defaultModel,
    executionAdapter: input.deps.executionAdapter,
    agentHarness: input.deps.getSelectedAgentHarness(input.group.folder),
    listConfiguredProviders: input.deps.getConfiguredModelProviders,
    familyOrder: input.deps.getModelFamilyOrder?.(),
  });
}
