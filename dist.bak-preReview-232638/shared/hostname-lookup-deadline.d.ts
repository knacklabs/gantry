type HostnameLookup = (hostname: string, signal?: AbortSignal | null) => Promise<Array<{
    address: string;
    family: 4 | 6;
}>>;
export declare function lookupHostnameWithDeadline(input: {
    hostname: string;
    lookupHostname: HostnameLookup;
    timeoutMs: number;
    timeoutMessage: string;
    signal?: AbortSignal | null;
}): Promise<Array<{
    address: string;
    family: 4 | 6;
}>>;
export {};
