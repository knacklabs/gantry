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
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import type { JobManagementServiceDeps } from '../jobs/job-management-types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { recheckSetupPausedJobsAfterCapabilityUpdate } from '../jobs/job-permission-recovery.js';
import type { PausedJobCapabilityRecheckResult } from '../jobs/job-permission-recovery.js';
import { PermissionManagementService } from '../permissions/permission-management-service.js';

export interface PermissionPersistenceBackend {
  opsRepository: RuntimeJobRepository;
  beforePersistentGrant?: (
    request: PermissionApprovalRequest,
    effectiveUpdates: readonly PermissionApprovalUpdate[],
  ) => Promise<boolean>;
  afterPersistentGrant?: (
    request: PermissionApprovalRequest,
    effectiveUpdates: readonly PermissionApprovalUpdate[],
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
    !(await input.persistence.beforePersistentGrant(input.request, updates))
  ) {
    return false;
  }
  const scopedRequest = persistentPermissionScopeRequest(input.request);
  // A grant approved for a scheduled job is private to that job's person (the
  // creator's memory identity, persisted at creation). A group job's person is
  // genuinely null -> a shared grant, as before. But an UNRESOLVABLE job (a
  // transient repository error or stale id) must FAIL CLOSED: never fall back
  // to a shared grant, which would widen one job's approval to everyone.
  // Deliberate (decision 0118): a turn with NO memory person (group, or a DM
  // the identity model deems ineligible) writes a SHARED grant. There is no
  // eligibility gate and no downgrade-to-allow-once path — that machinery was
  // built and intentionally removed. null = shared is the model, not a gap.
  let actingPersonId: string | null = input.request.personId ?? null;
  if (input.request.jobId) {
    const job = await input.persistence.opsRepository
      .getJobById(input.request.jobId)
      .catch(() => undefined);
    if (!job) return false;
    // A resolved job with no person (null or unset) is a group/legacy job ->
    // shared, as before. Only an UNRESOLVABLE job (missing / repository error,
    // handled above) fails closed, so a transient failure can't widen a
    // person's approval to a shared grant.
    actingPersonId = job.execution_context?.personId ?? null;
  }
  const permissionService = new PermissionManagementService();
  await permissionService.applyPersistentToolRuleGrant({
    appId: input.request.appId as never,
    agentId: (input.request.agentId ??
      `agent:${input.sourceAgentFolder}`) as never,
    sourceAgentFolder: input.sourceAgentFolder,
    personId: actingPersonId,
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
  // The durable grant above has already committed. Appending the job's honesty
  // requirement is best-effort from here: whether it loses its CAS race, finds
  // the setup state moved on (false), or hits a transient repository error
  // (throw), we log the gap but MUST still run the recheck and settle the
  // interaction — the grant is live, and reporting failure would strand a paused
  // job and re-show a stale approval for a permission that is already applied.
  //
  // ponytail: grant (permission store) and requirement append (job store) are
  // deliberately NOT atomic — a true cross-store transaction is a separate
  // protocol (deferred follow-up). This is safe because the grant is a
  // human-authorized, agent-scoped binding valid regardless of which job it came
  // from, and the recheck below re-reads fresh job state, so a job that
  // transitioned concurrently is never wrongly resumed. The only residual is a
  // benign missing honesty requirement (grant-without-requirement), strictly
  // milder than a phantom requirement: the agent already has the tool, so the
  // resumed job runs without re-denial, and the gap self-heals — if the grant is
  // later revoked, the next denial re-enters this same pause→append flow.
  if (input.persistence.afterPersistentGrant) {
    try {
      const appended = await input.persistence.afterPersistentGrant(
        input.request,
        updates,
      );
      if (!appended) {
        logger.warn(
          { requestId: input.request.requestId, jobId: input.request.jobId },
          'setup-pause requirement append skipped after grant already committed; settling on the durable grant',
        );
      }
    } catch (err) {
      logger.warn(
        { requestId: input.request.requestId, jobId: input.request.jobId, err },
        'setup-pause requirement append failed after grant already committed; settling on the durable grant',
      );
    }
  }
  const recovery = await recheckSetupPausedJobsAfterCapabilityUpdate({
    appId: input.request.appId,
    sourceAgentFolder: input.sourceAgentFolder,
    conversationJid: input.request.targetJid,
    jobId: input.request.jobId,
    recoveringPermissionPrompt:
      input.request.jobId && input.request.setupFingerprint
        ? {
            jobId: input.request.jobId,
            setupFingerprint: input.request.setupFingerprint,
          }
        : undefined,
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
