import type { HostCredentialMode } from '../config/credentials/mode.js';
import { inspectModelCredentialReadiness } from './model-credential-readiness.js';
export interface CredentialSetupDraft {
    credentialMode: HostCredentialMode;
    postgresSetupKind?: 'local' | 'hosted' | 'existing';
    postgresDatabaseUrl?: string;
    postgresSchema?: string;
    selectedModel?: string;
    credentialLiveSkipProviderIds?: string[];
    memoryEnabled?: boolean;
    embeddingsEnabled?: boolean;
    dreamingEnabled?: boolean;
}
export type CredentialStepAction = {
    type: 'next';
} | {
    type: 'back';
} | {
    type: 'goto';
    step: 'storage';
} | {
    type: 'resume';
} | {
    type: 'cancel';
};
export declare function verifyModelAccess(runtimeHome?: string, settings?: Parameters<typeof inspectModelCredentialReadiness>[1], options?: {
    skipLiveProviderIds?: readonly string[];
}): Promise<{
    ok: boolean;
    message: string;
    nextAction?: string;
}>;
export declare function runCredentialsStep(draft: CredentialSetupDraft, runtimeHome: string): Promise<CredentialStepAction>;
export declare function requiredModelCredentialProvidersForSetupDraft(draft: CredentialSetupDraft): string[];
export interface RequiredModelCredentialProviderReason {
    providerId: string;
    reasons: string[];
}
export declare function requiredModelCredentialProviderReasonsForSetupDraft(draft: CredentialSetupDraft): RequiredModelCredentialProviderReason[];
