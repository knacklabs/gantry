import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import type { CredentialBrokerProfile } from '../../domain/models/credentials.js';
interface GatewayProviderRateLimits {
    providers: Record<string, {
        requestsPerMinute: number;
    }>;
}
export interface AgentCredentialBrokerFactoryOptions {
    mode: CredentialBrokerProfile;
    broker?: AgentCredentialBroker;
    modelCredentials?: ModelCredentialRepository;
    gatewayBindHost?: string;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
    limits?: () => GatewayProviderRateLimits;
}
export declare function createAgentCredentialBroker(options: AgentCredentialBrokerFactoryOptions): Promise<AgentCredentialBroker | undefined>;
export declare function ensureModelCredentialBinding(input: {
    mode: CredentialBrokerProfile;
    broker?: AgentCredentialBroker;
    modelCredentials?: ModelCredentialRepository;
    gatewayBindHost?: string;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
}): Promise<{
    created?: boolean;
} | undefined>;
export declare function ensureAgentCredentialBinding(input: {
    mode: CredentialBrokerProfile;
    broker?: AgentCredentialBroker;
    modelCredentials?: ModelCredentialRepository;
    gatewayBindHost?: string;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
    name: string;
    identifier: string;
}): Promise<{
    created?: boolean;
} | undefined>;
export {};
