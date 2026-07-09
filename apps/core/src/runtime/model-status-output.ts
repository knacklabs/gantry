import { findModelByRunnerModel } from '../shared/model-catalog.js';
import { estimateUsageCostUsd } from '../shared/model-usage.js';
import type { AgentOutput } from './agent-spawn-types.js';
import { updateRuntimeModelStatus } from './model-status-store.js';

interface RuntimeModelStatusGroup {
  folder: string;
  agentConfig?: { model?: string | null } | null;
}

export function recordRuntimeModelUsage(input: {
  group: RuntimeModelStatusGroup;
  threadId: string | null;
  usage: NonNullable<AgentOutput['usage']>;
  usageEventId?: string;
  getDefaultModel: () => string | undefined;
}): void {
  const sessionModel = input.group.agentConfig?.model;
  const selectedModel = sessionModel || input.getDefaultModel();
  const billedModel = findModelByRunnerModel(input.usage.model);
  const model = billedModel ?? findModelByRunnerModel(selectedModel);
  const canEstimateCost =
    input.usage.model !== 'mixed' && input.usage.cacheProvider !== 'mixed';
  const usage =
    typeof input.usage.estimatedCostUsd === 'number' &&
    input.usage.estimatedCostUsd > 0
      ? input.usage
      : {
          ...input.usage,
          estimatedCostUsd: canEstimateCost
            ? estimateUsageCostUsd(model, input.usage)
            : undefined,
        };
  updateRuntimeModelStatus({
    scopeKey: input.group.folder,
    threadId: input.threadId,
    selectionSource: sessionModel ? 'session override' : 'chat default',
    modelAlias: billedModel?.recommendedAlias ?? selectedModel,
    model,
    usage,
    usageKey: input.usageEventId,
  });
}
