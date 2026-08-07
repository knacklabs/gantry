import type {
  CapabilitySecretRepository,
  McpServerRepository,
  PermissionRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import type { JobManagementServiceDeps } from '../jobs/job-management-types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { recheckSetupPausedJobsAfterCapabilityUpdate } from '../jobs/job-permission-recovery.js';
import type { PausedJobCapabilityRecheckResult } from '../jobs/job-permission-recovery.js';
import { PermissionManagementService } from '../permissions/permission-management-service.js';

export interface PermissionPersistenceBackend {
  opsRepository: RuntimeJobRepository;
  beforePersistentGrant?: (
    request: PermissionApprovalRequest,
  ) => Promise<boolean>;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  getPermissionRepository?: () => PermissionRepository | undefined;
  mirrorAgentToolRulesToSettings?: (
    sourceAgentFolder: string,
    rules: string[],
    options?: {
      appId?: string;
      mode?: 'add' | 'remove';
      expectedMcpBindings?: import('../../domain/mcp/mcp-servers.js').McpBindingAuthorityPrecondition[];
      mcpCapabilityGrantToken?: string;
    },
  ) => Promise<void> | void;
  onSchedulerChanged?: (jobId?: string) => void;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  sendQueuedReceipt?: (
    job: import('../../domain/types.js').Job,
    recoveryTransitionId: string,
  ) => Promise<unknown>;
  notifySetupRequired?: (input: {
    job: import('../../domain/types.js').Job;
    setupState: NonNullable<import('../../domain/types.js').Job['setup_state']>;
    previousFingerprint?: string;
  }) => Promise<boolean>;
}

function persistentPermissionScopeRequest(
  request: PermissionApprovalRequest,
): PermissionApprovalRequest {
  if (!request.threadId) return request;
  const { threadId: _routingThreadId, ...parentConversationRequest } = request;
  return parentConversationRequest;
}

export async function applyRecoveredPersistentPermissionGrant(input: {
  persistence: PermissionPersistenceBackend;
  request: PermissionApprovalRequest;
  sourceAgentFolder: string;
  decision: PermissionApprovalDecision;
  ipcDir?: string;
  onApplied?: (
    recovery: PausedJobCapabilityRecheckResult,
  ) => Promise<void> | void;
}): Promise<boolean> {
  const toolRepository = input.persistence.getToolRepository?.();
  const mirrorAgentToolRulesToSettings =
    input.persistence.mirrorAgentToolRulesToSettings;
  if (!toolRepository || !mirrorAgentToolRulesToSettings) return false;
  const updates = input.decision.updatedPermissions ?? [];
  if (updates.length === 0) return false;
  if (
    input.persistence.beforePersistentGrant &&
    !(await input.persistence.beforePersistentGrant(input.request))
  ) {
    return false;
  }
  const scopedRequest = persistentPermissionScopeRequest(input.request);
  const permissionService = new PermissionManagementService();
  await permissionService.applyPersistentToolRuleGrant({
    appId: input.request.appId as never,
    agentId: (input.request.agentId ??
      `agent:${input.sourceAgentFolder}`) as never,
    sourceAgentFolder: input.sourceAgentFolder,
    updates,
    toolRepository,
    mcpServerRepository: input.persistence.getMcpServerRepository?.(),
    mirrorAgentToolRulesToSettings,
    permissionRepository: input.persistence.getPermissionRepository?.(),
    semanticCapabilityDefinitions: input.request.semanticCapabilityDefinitions,
    ipcDir: input.ipcDir,
    runHandle: input.request.runHandle,
    requestId: input.request.requestId,
    actor: input.decision.decidedBy,
    conversationId: scopedRequest.targetJid,
    threadId: scopedRequest.threadId,
    runId: input.request.runId,
    jobId: input.request.jobId,
    reason: input.decision.reason,
  });
  const recovery = await recheckSetupPausedJobsAfterCapabilityUpdate({
    appId: input.request.appId,
    sourceAgentFolder: input.sourceAgentFolder,
    conversationJid: input.request.targetJid,
    jobId: input.request.jobId,
    recoveringPermissionRequestId: input.request.requestId,
    opsRepository: input.persistence.opsRepository,
    scheduler: {
      requestSchedulerSync: input.persistence.onSchedulerChanged ?? (() => {}),
    },
    toolRepository,
    skillRepository: input.persistence.getSkillRepository?.(),
    mcpServerRepository: input.persistence.getMcpServerRepository?.(),
    capabilitySecretRepository:
      input.persistence.getCapabilitySecretRepository?.(),
    credentialBroker: await input.persistence.getCredentialBroker?.(),
    getBrowserStatus: input.persistence.getBrowserStatus,
    publishRuntimeEvent: input.persistence.publishRuntimeEvent,
    sendQueuedReceipt: input.persistence.sendQueuedReceipt,
    notifySetupRequired: input.persistence.notifySetupRequired,
  });
  await input.onApplied?.(recovery);
  return true;
}
