import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import { defaultModelStatusSelection, } from '../session/session-model-status.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';
import { executionProviderIdForCandidate, resolveTurnFailoverCandidates, } from './failover-candidate-loop.js';
const DEFAULT_MODEL_ALIAS = 'opus';
export async function resolveInitialGroupExecutionProviderId(input) {
    const requestedModel = input.group.agentConfig?.model ?? input.defaultModel;
    const initialModelSelection = defaultModelStatusSelection(requestedModel ?? DEFAULT_MODEL_ALIAS);
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
    const fallbackExecutionProviderId = () => resolveRuntimeExecutionProviderId(input.executionAdapter);
    return {
        initialModelSelection,
        failoverCandidates,
        ...(firstModel ? { firstModel } : {}),
        executionProviderId: firstModel
            ? executionProviderIdForCandidate(firstModel, undefined, input.agentHarness)
            : liveTurnRoute?.ok
                ? liveTurnRoute.value.executionProviderId
                : fallbackExecutionProviderId(),
    };
}
export async function resolveGroupRouteExecutionProviderId(input) {
    return (await resolveInitialGroupExecutionProviderId(input))
        .executionProviderId;
}
export function resolveGroupRouteExecutionProviderIdForDeps(input) {
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
