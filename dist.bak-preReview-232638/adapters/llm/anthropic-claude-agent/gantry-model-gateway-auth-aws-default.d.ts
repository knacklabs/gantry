import type { AwsSigV4Credentials } from './gantry-model-gateway-auth-sigv4.js';
export declare function getAwsDefaultChainCredentials(input: {
    profile?: string;
}): Promise<AwsSigV4Credentials>;
export declare function clearAwsDefaultCredentialProviderCacheForTest(): void;
