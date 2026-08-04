import { type ModelCredentialPayload } from '../shared/model-provider-registry.js';
import type { DoctorCheck } from './doctor.js';
export type ModelProviderCredentialLiveCheck = {
    ok: true;
} | {
    ok: false;
    message: string;
} | {
    skipped: true;
    reason: string;
};
type RuntimeSettingsForLiveCredentialCheck = {
    providers: Record<string, {
        enabled: boolean;
    } | undefined>;
    providerAccounts?: Record<string, {
        provider: string;
        status?: string;
        runtimeSecretRefs: Record<string, string | undefined>;
    } | undefined>;
};
export declare function verifyModelProviderCredentialLive(input: {
    providerId: string;
    authMode: string;
    payload: ModelCredentialPayload;
    timeoutMs?: number;
}): Promise<ModelProviderCredentialLiveCheck>;
export declare function inspectSlackTokenLiveCheck(input: {
    settings: RuntimeSettingsForLiveCredentialCheck;
    env: Record<string, string>;
    timeoutMs?: number;
}): Promise<DoctorCheck | null>;
export declare function inspectTelegramTokenLiveCheck(input: {
    settings: RuntimeSettingsForLiveCredentialCheck;
    env: Record<string, string>;
    timeoutMs?: number;
}): Promise<DoctorCheck | null>;
export {};
