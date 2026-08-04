import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import { type FamilyOrderOverrides } from '../shared/model-families.js';
import { type ConfiguredModelProvidersLookup } from './model-family-resolution.js';
export declare function resolveTurnFailoverCandidates(input: {
    requestedModel: string | undefined;
    appId: string;
    listConfiguredProviders: ConfiguredModelProvidersLookup | undefined;
    familyOrder: FamilyOrderOverrides | undefined;
}): Promise<string[]>;
export declare function executionProviderIdForCandidate(alias: string, fallback: ExecutionProviderId | undefined, agentHarness?: AgentHarness): ExecutionProviderId;
export declare function shouldFailoverToNextCandidate(input: {
    status: 'success' | 'error' | string;
    error: string | undefined;
    hasStreamedOutput: boolean;
    attempt: number;
    candidateCount: number;
}): boolean;
export declare function describeFailover(input: {
    fromProviderId: string;
    toProviderId: string;
    fromModel: string;
    toModel: string;
    reason: string | undefined;
}): string;
export interface FailoverAttemptOutput {
    status: 'success' | 'error' | string;
    error?: string;
}
export interface FailoverAdvanceDetails {
    toProviderId: ExecutionProviderId;
    fromModel: string;
    toModel: string;
    reason: string | undefined;
}
export declare function publishRunFailoverEvent(input: {
    publish: ((event: RuntimeEventPublishInput) => Promise<unknown> | void) | undefined;
    appId: string | undefined;
    agentId?: string;
    runId?: string;
    conversationId: string;
    threadId?: string | null;
    fromProvider: string;
    family: string | null;
    details: FailoverAdvanceDetails;
}): void;
export declare function runFamilyFailoverLoop<O extends FailoverAttemptOutput>(input: {
    candidates: readonly string[];
    initialOutput: O;
    fallbackProviderId: ExecutionProviderId;
    agentHarness?: AgentHarness;
    hasStreamedOutput: () => boolean;
    invoke: (model: string) => Promise<O>;
    onFailover: (toProviderId: ExecutionProviderId, details: FailoverAdvanceDetails) => ExecutionProviderId;
    log: (message: string) => void;
}): Promise<O>;
