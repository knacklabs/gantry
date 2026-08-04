import type { Logger } from '../../infrastructure/logging/logger.js';
import type { IpcDeps } from '../../runtime/ipc.js';
import type { RuntimeAgentSessionRepository, RuntimeMessageRepository } from '../../domain/repositories/ops-repo.js';
interface AsyncTaskRecoveryDeps extends Partial<Pick<IpcDeps, 'conversationRoutes' | 'executionAdapter' | 'executionAdapters' | 'getAsyncTaskRepository' | 'getCapabilitySecretRepository' | 'getCredentialBroker' | 'getEgressSettings' | 'getMcpDnsValidationCache' | 'getMcpServerRepository' | 'getSkillArtifactStore' | 'getSkillRepository' | 'getToolRepository' | 'mcpHostnameLookup' | 'publishRuntimeEvent' | 'runAgent' | 'runnerSandboxProvider'>> {
    logger: Pick<Logger, 'warn'>;
    opsRepository?: RuntimeAgentSessionRepository & Pick<RuntimeMessageRepository, 'storeMessageWithLiveAdmission'>;
}
export declare function recoverStaleAsyncCommandTasks(appId: string, deps: AsyncTaskRecoveryDeps): Promise<void>;
export declare function recoverStaleSessionCompactionTasks(appId: string, deps: AsyncTaskRecoveryDeps): Promise<number>;
export declare function startAsyncTaskRecoveryLoop(appId: string, deps: AsyncTaskRecoveryDeps): void;
export declare function stopAsyncTaskRecoveryLoop(): void;
export {};
