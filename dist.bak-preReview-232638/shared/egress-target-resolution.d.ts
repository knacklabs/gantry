import { type EgressPolicyMatch } from './egress-policy.js';
export type PublicEgressAddressResolution = {
    ok: true;
    host: string;
    address: string;
    family: 4 | 6;
} | {
    ok: false;
    host: string;
    deny?: EgressPolicyMatch;
};
export declare function normalizeEgressAuthorityHost(authority: string): string | undefined;
export declare function resolvePublicEgressAddress(rawHost: string): Promise<PublicEgressAddressResolution>;
