import { AsyncCommandTaskService } from './async-command-task-service.js';
import { resolveDelegatedAgentTarget } from './ipc-agent-delegation-target.js';
import type { TaskContext } from './ipc-types.js';
type ResolvedDelegationTarget = Extract<Awaited<ReturnType<typeof resolveDelegatedAgentTarget>>, {
    ok: true;
}>;
interface DelegatedTaskOwner {
    appId: string;
    agentId: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
}
export declare function executeResolvedDelegation(input: {
    context: TaskContext;
    service: AsyncCommandTaskService;
    owner: DelegatedTaskOwner;
    target: ResolvedDelegationTarget;
    trustedProviderAccountId?: string | null;
    trustedJobId?: string;
    trustedParentRunId?: string;
    payload: Record<string, unknown>;
    objective: string;
    requestedTargetAgentId?: string;
}): Promise<import("../application/core-tools/task-lifecycle.js").CoreTaskLifecycleResult>;
export {};
