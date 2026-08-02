import { hostnameForNetwork, isPrivateNetworkAddress } from '../../domain/network/public-address-policy.js';
export declare const isPrivateAddress: typeof isPrivateNetworkAddress;
export { hostnameForNetwork };
export type ResolvedWebhookTarget = {
    url: URL;
    address: string;
    family: 4 | 6;
};
export declare function validateWebhookTarget(targetUrl: string): Promise<ResolvedWebhookTarget>;
