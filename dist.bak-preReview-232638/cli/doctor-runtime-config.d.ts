import { hasRuntimeCredentialConfigured } from './runtime-credential-check.js';
type RuntimeConfigSettings = NonNullable<Parameters<typeof hasRuntimeCredentialConfigured>[0]['settings']> & {
    providers: Record<string, {
        enabled?: boolean;
    } | undefined>;
};
export declare function hasConfiguredChannelProvider(settings: RuntimeConfigSettings): boolean;
export declare function hasProcessableGroupForConfiguredChannelSettings(input: {
    runtimeHome: string;
    settings: RuntimeConfigSettings;
    env: Record<string, string>;
    openRuntimeGroupDb: (runtimeHome: string) => Promise<{
        countConversationRoutesByJidPrefix: (prefix: string) => Promise<number>;
        close: () => Promise<void>;
    }>;
}): Promise<boolean>;
export {};
