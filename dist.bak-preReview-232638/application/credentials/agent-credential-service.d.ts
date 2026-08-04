import type { AgentCredentialPurpose, AgentCredentialInjection, CredentialBrokerProfile } from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentId } from '../../domain/agent/agent.js';
import type { ConversationId, ConversationThreadId } from '../../domain/conversation/conversation.js';
import type { AgentRunId } from '../../domain/events/events.js';
import type { JobId } from '../../domain/jobs/jobs.js';
import type { ModelCredentialProvider } from '../../domain/model-credentials/model-credentials.js';
import type { ModelRouteId } from '../../shared/model-catalog.js';
export type AgentCredentialInjectionInput = {
    mode: 'gantry';
    purpose?: AgentCredentialPurpose;
    appId?: AppId;
    agentId?: AgentId;
    runId?: AgentRunId;
    apiKeyId?: string;
    apiRequestId?: string;
    jobId?: JobId;
    conversationId?: ConversationId;
    threadId?: ConversationThreadId;
    modelCredentialProviderId?: ModelCredentialProvider;
    modelRouteId?: ModelRouteId;
    modelBatchRequestCount?: number;
    modelBatchId?: string;
    agentIdentifier?: string;
    broker: AgentCredentialBroker;
} | {
    mode: 'none';
    purpose?: AgentCredentialPurpose;
    agentIdentifier?: string;
};
export declare function getAgentCredentialInjection(input: AgentCredentialInjectionInput): Promise<AgentCredentialInjection>;
export declare function ensureModelCredentialBinding(input: {
    mode: CredentialBrokerProfile;
    broker?: AgentCredentialBroker;
}): Promise<{
    created?: boolean;
} | undefined>;
export declare function ensureAgentCredentialBinding(input: {
    mode: CredentialBrokerProfile;
    broker?: AgentCredentialBroker;
    name: string;
    identifier: string;
}): Promise<{
    created?: boolean;
} | undefined>;
