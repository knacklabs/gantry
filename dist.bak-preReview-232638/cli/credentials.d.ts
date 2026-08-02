import { type ModelCredentialPayload } from '../shared/model-provider-registry.js';
import { type RuntimeSettings } from '../config/settings/runtime-settings.js';
export declare function runCredentialsCommand(runtimeHome: string, args: string[]): Promise<number>;
export declare function storeModelCredentialInput(input: {
    runtimeHome: string;
    providerId: string;
    authMode: string;
    payload: ModelCredentialPayload;
}): Promise<void>;
export type ModelCredentialVerificationPromptResult = {
    type: 'verified';
} | {
    type: 'skip';
    reason: string;
} | {
    type: 'reenter';
} | {
    type: 'back';
} | {
    type: 'resume';
} | {
    type: 'cancel';
};
export declare function verifyModelCredentialInputWithPrompt(input: {
    providerId: string;
    authMode: string;
    payload: ModelCredentialPayload;
    allowBackResume?: boolean;
}): Promise<ModelCredentialVerificationPromptResult>;
export declare function listReadyModelCredentialProviders(runtimeHome: string): Promise<Set<string>>;
export declare function storeRuntimeSecretInput(input: {
    runtimeHome: string;
    name: string;
    value: string;
    actor?: string;
    runtimeSettings?: RuntimeSettings;
}): Promise<void>;
export declare function promptModelCredentialPayload(providerId: string, options?: {
    authMode?: string;
    partial?: boolean;
}): Promise<{
    authMode: string;
    payload: ModelCredentialPayload;
} | undefined>;
