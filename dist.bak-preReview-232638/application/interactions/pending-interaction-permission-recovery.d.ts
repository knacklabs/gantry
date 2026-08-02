import type { CapabilitySecretRepository, McpServerRepository, PermissionRepository, SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../../domain/types.js';
import type { JobManagementServiceDeps } from '../jobs/job-management-types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { PausedJobCapabilityRecheckResult } from '../jobs/job-permission-recovery.js';
export interface PermissionPersistenceBackend {
    opsRepository: RuntimeJobRepository;
    getToolRepository?: () => ToolCatalogRepository | undefined;
    getPermissionRepository?: () => PermissionRepository | undefined;
    mirrorAgentToolRulesToSettings?: (sourceAgentFolder: string, rules: string[], options?: {
        appId?: string;
        mode?: 'add' | 'remove';
    }) => Promise<void> | void;
    onSchedulerChanged?: (jobId?: string) => void;
    getSkillRepository?: () => SkillCatalogRepository | undefined;
    getMcpServerRepository?: () => McpServerRepository | undefined;
    getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
    getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
    getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
}
export declare function applyRecoveredPersistentPermissionGrant(input: {
    persistence: PermissionPersistenceBackend;
    request: PermissionApprovalRequest;
    sourceAgentFolder: string;
    decision: PermissionApprovalDecision;
    ipcDir?: string;
    onApplied?: (recovery: PausedJobCapabilityRecheckResult) => Promise<void> | void;
}): Promise<boolean>;
