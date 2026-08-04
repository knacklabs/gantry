import type { EgressNetworkAttribution } from './egress-gateway.js';
export interface EgressAccessPolicyState {
    connectHostMappings?: Map<string, string>;
}
export declare function networkAttributionMap(attribution: readonly EgressNetworkAttribution[] | undefined): Map<string, EgressNetworkAttribution>;
export declare function mappedEgressTarget(state: EgressAccessPolicyState, target: {
    host: string;
    port: number;
    authority: string;
}): {
    host: string;
    port: number;
    authority: string;
    connectHost?: string;
} | undefined;
