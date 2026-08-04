import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { EgressGatewayPrincipal, EgressGatewayUpstreamProxy, EgressNetworkAttribution } from './egress-gateway.js';
export interface EgressAuditState {
    principal: EgressGatewayPrincipal;
    networkAttribution: Map<string, EgressNetworkAttribution>;
    upstreamProxy?: EgressGatewayUpstreamProxy;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
    logger: {
        info: (context: Record<string, unknown>, message: string) => void;
        warn: (context: Record<string, unknown>, message: string) => void;
    };
}
export declare function auditConnect(state: EgressAuditState, decision: {
    host: string;
    port?: number;
    allowed: boolean;
    denied: boolean;
    reason: string;
    matchedPattern?: string;
}): Promise<void>;
