import { MODEL_RUNTIME_CREDENTIAL_IDENTIFIER } from '../domain/models/credentials.js';
import type { ConversationRoute } from '../domain/types.js';
import {
  LlmProfileResolutionService,
  type LlmProfileResolution,
} from '../application/model-resolution/llm-profile-resolution-service.js';
import type { LlmProfile } from '../domain/agent/agent.js';
import { DEFAULT_SETUP_MODEL_ALIAS } from '../shared/model-catalog.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import type { FamilyOrderOverrides } from '../shared/model-families.js';
import { nowIso } from '../shared/time/datetime.js';
import {
  rewriteModelFamilyAliasForApp,
  type ConfiguredModelProvidersLookup,
} from './model-family-resolution.js';
import type { AgentInput } from './agent-spawn-types.js';

export type SpawnModelWorkload = 'chat' | 'one_time_job' | 'recurring_job';

export async function resolveSpawnModel(input: {
  group: ConversationRoute;
  agentInput: AgentInput;
  appId: string;
  modelConfig: { model?: string; source: string };
  agentHarness: AgentHarness;
  modelFamilyOrder?: FamilyOrderOverrides;
  listConfiguredProviders: ConfiguredModelProvidersLookup;
}): Promise<{
  modelWorkload: SpawnModelWorkload;
  resolvedModel: LlmProfileResolution;
}> {
  const modelWorkload: SpawnModelWorkload = input.agentInput.isScheduledJob
    ? input.agentInput.jobModelUseKind === 'oneTimeJob'
      ? 'one_time_job'
      : 'recurring_job'
    : 'chat';
  const requestedModel = input.agentInput.model || input.modelConfig.model;
  const familyResolvedModel = await rewriteModelFamilyAliasForApp({
    alias:
      requestedModel || input.modelConfig.model || DEFAULT_SETUP_MODEL_ALIAS,
    appId: input.appId,
    listConfiguredProviders: input.listConfiguredProviders,
    familyOrder: input.modelFamilyOrder,
  });
  const profileTimestamp = nowIso();
  const runtimeLlmProfile: LlmProfile = {
    id: `transient-runtime-profile:${input.group.folder}:${modelWorkload}` as never,
    appId: input.appId as never,
    purpose: input.agentInput.isScheduledJob ? 'coding' : 'chat',
    modelAlias: familyResolvedModel,
    credentialProfileRef: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
    createdAt: profileTimestamp as never,
    updatedAt: profileTimestamp as never,
  };
  const resolvedModel = new LlmProfileResolutionService().resolve({
    profile: runtimeLlmProfile,
    workload: modelWorkload,
    agentHarness: input.agentHarness,
  });
  return { modelWorkload, resolvedModel };
}
