import type { Job, JobSetupState } from '../../domain/types.js';
import type { CapabilitySecretRepository, McpServerRepository, SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { Clock } from '../common/clock.js';
export declare const SETUP_REQUIRED_PAUSE_REASON = "Setup required";
export interface JobReadinessBrowserStatus {
    hasState?: boolean;
    authMarkers?: string[];
    error?: string;
}
export interface JobReadinessDeps {
    toolRepository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    mcpServerRepository?: McpServerRepository;
    capabilitySecretRepository?: CapabilitySecretRepository;
    credentialBroker?: AgentCredentialBroker;
    getBrowserStatus?: (profileName: string) => Promise<JobReadinessBrowserStatus | undefined>;
    workerImageInventory?: readonly string[];
    clock?: Clock;
}
export interface JobReadinessInput extends JobReadinessDeps {
    job: Pick<Job, 'id' | 'workspace_key' | 'access_requirements' | 'execution_context' | 'notification_routes' | 'setup_state'>;
    appId?: string;
    agentId?: string;
}
export interface JobReadinessResult {
    ready: boolean;
    setupState: JobSetupState;
    pauseReason: typeof SETUP_REQUIRED_PAUSE_REASON | null;
}
export declare function evaluateJobReadiness(input: JobReadinessInput): Promise<JobReadinessResult>;
export declare function setupStateForDeniedTool(input: {
    toolName: string;
    recoveryAction?: string | null;
    checkedAt?: string;
    previous?: JobSetupState;
}): JobSetupState;
export declare function setupStateForTransientPermission(input: {
    toolName: string;
    mode?: string | null;
    recoveryAction?: string | null;
    checkedAt?: string;
    previous?: JobSetupState;
}): JobSetupState;
export declare function setupStateForBrowserPrelaunchFailure(input: {
    checkedAt?: string;
    previous?: JobSetupState;
}): JobSetupState;
