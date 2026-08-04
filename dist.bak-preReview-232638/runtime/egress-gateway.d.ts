import { type EgressSettings } from '../shared/egress-policy.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
export interface EgressGatewayPrincipal {
    appId: string;
    agentId?: string;
    conversationId?: string;
    threadId?: string;
    runId?: string;
    jobId?: string;
}
export interface EgressGatewayUpstreamProxy {
    url: string;
    provider: string;
}
/** Run-scoped attribution of a declared outbound host to its reviewed capability. */
export interface EgressNetworkAttribution {
    host: string;
    capabilityId: string;
    capabilityLabel: string;
}
export interface EgressGatewayHandle {
    key: string;
    proxyUrl: string;
    port: number;
}
export interface EgressGatewayPrivateHostMapping {
    authority: string;
    connectHost: string;
}
export declare function closeEgressGatewaysForTest(): Promise<void>;
export declare function closeEgressGateway(handleOrKey: EgressGatewayHandle | string | undefined): Promise<void>;
export declare function ensureEgressGateway(input: {
    key: string;
    settings: EgressSettings;
    principal: EgressGatewayPrincipal;
    networkAttribution?: readonly EgressNetworkAttribution[];
    privateNetworkHostMappings?: readonly EgressGatewayPrivateHostMapping[];
    upstreamProxy?: EgressGatewayUpstreamProxy;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
}): Promise<EgressGatewayHandle>;
