import { getProviderRuntimeSecret } from '../channels/provider-runtime-secrets.js';
type RuntimeSettings = NonNullable<Parameters<typeof getProviderRuntimeSecret>[0]['settings']>;
export declare function resolveTelegramTokenForDoctor(input: {
    settings: RuntimeSettings;
    env: Record<string, string>;
}): Promise<{
    token: string;
    unresolvedStoredRef: boolean;
}>;
export {};
