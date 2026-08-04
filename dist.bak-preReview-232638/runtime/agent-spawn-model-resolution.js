import { MODEL_RUNTIME_CREDENTIAL_IDENTIFIER } from '../domain/models/credentials.js';
import { LlmProfileResolutionService, } from '../application/model-resolution/llm-profile-resolution-service.js';
import { DEFAULT_SETUP_MODEL_ALIAS } from '../shared/model-catalog.js';
import { nowIso } from '../shared/time/datetime.js';
import { rewriteModelFamilyAliasForApp, } from './model-family-resolution.js';
export async function resolveSpawnModel(input) {
    const modelWorkload = input.agentInput.isScheduledJob
        ? input.agentInput.jobModelUseKind === 'oneTimeJob'
            ? 'one_time_job'
            : 'recurring_job'
        : 'chat';
    const requestedModel = input.agentInput.model || input.modelConfig.model;
    const familyResolvedModel = await rewriteModelFamilyAliasForApp({
        alias: requestedModel || input.modelConfig.model || DEFAULT_SETUP_MODEL_ALIAS,
        appId: input.appId,
        listConfiguredProviders: input.listConfiguredProviders,
        familyOrder: input.modelFamilyOrder,
    });
    const profileTimestamp = nowIso();
    const runtimeLlmProfile = {
        id: `transient-runtime-profile:${input.group.folder}:${modelWorkload}`,
        appId: input.appId,
        purpose: input.agentInput.isScheduledJob ? 'coding' : 'chat',
        modelAlias: familyResolvedModel,
        credentialProfileRef: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
        createdAt: profileTimestamp,
        updatedAt: profileTimestamp,
    };
    const resolvedModel = new LlmProfileResolutionService().resolve({
        profile: runtimeLlmProfile,
        workload: modelWorkload,
        agentHarness: input.agentHarness,
    });
    return { modelWorkload, resolvedModel };
}
