import {
  TIMEZONE,
  getDefaultModelConfig,
  getRuntimeSettingsForConfig,
  getSelectedAgentHarness,
} from '../../config/index.js';
import { resolveAgentLockStatus } from '../../config/profiles.js';
import {
  getConfiguredModelProvidersForApp,
  getRuntimeRepositories,
  getRuntimeSkillArtifactStore,
  getRuntimeStorage,
  resolveRuntimePersonIdentity,
} from '../../adapters/storage/postgres/runtime-store.js';
import { HumanDecisionMemoryService } from '../../application/permissions/human-decision-memory-service.js';
import { createUsedByJobReader } from '../../application/permissions/permission-memory-listing.js';
import { createGroupProcessor } from '../../runtime/group-processing.js';
import type { GroupProcessingDeps } from '../../runtime/group-processing-types.js';

type RuntimeGroupProcessorInput = Pick<
  GroupProcessingDeps,
  | 'channelRuntime'
  | 'getConversationRoutes'
  | 'getGroup'
  | 'clearSession'
  | 'getCursor'
  | 'setCursor'
  | 'saveState'
  | 'setGroupModelOverride'
  | 'setGroupThinkingOverride'
  | 'setGroupPermissionModeOverride'
  | 'getAvailableGroups'
  | 'getRegisteredJids'
  | 'queue'
  | 'runAgent'
  | 'getCredentialBroker'
  | 'getMcpHostnameLookup'
  | 'getMcpDnsValidationCache'
  | 'normalizeProviderId'
  | 'publishRuntimeEvent'
  | 'executionAdapter'
  | 'executionAdapters'
  | 'runnerSandboxProvider'
> & {
  getRuntimeRepository: NonNullable<
    GroupProcessingDeps['getRuntimeRepository']
  >;
  getConversationHistoryCoverageRepository: NonNullable<
    GroupProcessingDeps['getConversationHistoryCoverageRepository']
  >;
  getHistoryCoverageDistrustEpoch: NonNullable<
    GroupProcessingDeps['getHistoryCoverageDistrustEpoch']
  >;
  skillArtifactStore?: GroupProcessingDeps['getSkillArtifactStore'];
  collectSessionMemory?: GroupProcessingDeps['collectSessionMemory'];
};

export function createRuntimeGroupProcessor(input: RuntimeGroupProcessorInput) {
  const storage = getRuntimeStorage();
  return createGroupProcessor({
    ...input,
    getToolRepository: () => storage.repositories.tools,
    getAsyncTaskRepository: () => storage.repositories.asyncTasks,
    getPatternCandidateRepository: () => storage.repositories.patternCandidates,
    getProactiveSurfacingRepository: () =>
      storage.repositories.proactiveSurfacing,
    getAgentLockStatus: resolveAgentLockStatus,
    getSkillRepository: () => storage.repositories.skills,
    getMcpServerRepository: () => storage.repositories.mcpServers,
    getCapabilitySecretRepository: () => storage.repositories.capabilitySecrets,
    getSkillArtifactStore:
      input.skillArtifactStore ?? getRuntimeSkillArtifactStore,
    collectSessionMemory: input.collectSessionMemory,
    resolvePersonIdentity: resolveRuntimePersonIdentity,
    getConfiguredModelProviders: getConfiguredModelProvidersForApp,
    getModelFamilyOrder: () => getRuntimeSettingsForConfig().modelFamilies,
    getDefaultInteractiveModel: (agentFolder) =>
      getDefaultModelConfig('interactive', agentFolder).model,
    getSelectedAgentHarness,
    remembered: {
      service: new HumanDecisionMemoryService({
        repository: storage.repositories.permissionDecisionMemory,
      }),
      usedBy: (appId) =>
        createUsedByJobReader({
          appId,
          permissions: storage.repositories.permissions,
          listJobs: async (jobIds) =>
            (
              await Promise.all(
                jobIds.map((jobId) =>
                  getRuntimeRepositories().getJobById(jobId),
                ),
              )
            ).flatMap((job) => (job ? [job] : [])),
        }),
      timezone: TIMEZONE,
    },
  });
}
