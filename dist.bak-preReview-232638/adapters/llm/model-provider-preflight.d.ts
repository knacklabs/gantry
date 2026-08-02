import type { AppId } from '../../domain/app/app.js';
export interface ModelProviderPreflightResult {
    ok: boolean;
    status: 'pass' | 'fail' | 'skipped';
    message: string;
}
export interface ModelProviderPreflightSettings {
    credentialBroker: {
        mode: 'none' | 'gantry';
        gateway?: {
            bindHost: string;
        };
    };
}
export declare function preflightModelProvider(input: {
    runtimeHome: string;
    providerId: string;
    chatAlias?: string;
    settings: ModelProviderPreflightSettings;
    appId?: AppId;
}): Promise<ModelProviderPreflightResult>;
