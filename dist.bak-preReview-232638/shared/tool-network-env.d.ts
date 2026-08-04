export interface ToolNetworkEnvInput {
    proxyUrl: string;
    caBundlePath?: string;
    noProxy?: {
        NO_PROXY?: string;
        no_proxy?: string;
    };
}
export declare function buildToolNetworkEnv(input: ToolNetworkEnvInput): Record<string, string>;
