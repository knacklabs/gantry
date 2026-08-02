export type ResolvedPublicAddress = {
    address: string;
    family: 4 | 6;
};
export type HostnameLookup = (hostname: string) => Promise<ResolvedPublicAddress[]>;
export declare function hostnameForNetwork(input: string): string;
export declare function isIpAddress(address: string): boolean;
export declare function isLoopbackAddress(address: string): boolean;
export declare function isPrivateNetworkAddress(address: string): boolean;
