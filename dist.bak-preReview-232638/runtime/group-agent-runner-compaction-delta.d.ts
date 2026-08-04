import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { ConversationRoute } from '../domain/types.js';
import type { GroupProcessingRepository } from './group-processing-types.js';
type TurnContext = Awaited<ReturnType<NonNullable<GroupProcessingRepository['getAgentTurnContext']>>> | undefined;
export declare function prepareCompactionDeltaReplay(input: {
    turnContext: TurnContext;
    loadTurnContext: (promoteReadyProviderSession: boolean) => Promise<TurnContext>;
    repository: GroupProcessingRepository;
    executionProviderId: ExecutionProviderId;
    group: ConversationRoute;
    chatJid: string;
    threadId: string | null;
    maintenanceProviderSession?: unknown;
}): Promise<{
    turnContext: TurnContext;
    block: string;
    markApplied?: (repository: GroupProcessingRepository) => Promise<void>;
}>;
export {};
