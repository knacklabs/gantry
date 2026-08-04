import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type { CapabilitySecretRepository, McpServerRepository, SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { SchedulerCoordinationPort } from './scheduler-coordination-port.js';
import { type JobReadinessBrowserStatus } from './job-readiness-service.js';
export interface RecheckPausedJobsAfterCapabilityUpdateInput {
    appId?: string;
    sourceAgentFolder: string;
    conversationJid?: string;
    jobId?: string;
    opsRepository: RuntimeJobRepository;
    scheduler: SchedulerCoordinationPort;
    toolRepository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    mcpServerRepository?: McpServerRepository;
    capabilitySecretRepository?: CapabilitySecretRepository;
    credentialBroker?: AgentCredentialBroker;
    getBrowserStatus?: (profileName: string) => Promise<JobReadinessBrowserStatus | undefined>;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
    clock?: {
        now(): string;
    };
}
export interface RecheckedSetupJob {
    jobId: string;
    name: string;
    state: 'queued' | 'still_blocked';
    nextAction?: string;
}
export interface PausedJobCapabilityRecheckResult {
    checked: number;
    queued: RecheckedSetupJob[];
    stillBlocked: RecheckedSetupJob[];
}
export declare function recheckSetupPausedJobsAfterCapabilityUpdate(input: RecheckPausedJobsAfterCapabilityUpdateInput): Promise<PausedJobCapabilityRecheckResult>;
