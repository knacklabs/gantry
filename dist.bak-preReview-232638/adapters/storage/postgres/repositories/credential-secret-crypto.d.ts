import type { RuntimeSecretProvider } from '../../../../domain/ports/runtime-secret-provider.js';
export declare const SECRET_ENCRYPTION_KEY_ENV = "SECRET_ENCRYPTION_KEY";
export declare const SECRET_ENCRYPTION_KEYRING_ENV = "SECRET_ENCRYPTION_KEYRING_JSON";
export type CredentialSecretAadContext = {
    appId: string;
    subjectKind: 'capability_secret' | 'model_credential';
    subjectId: string;
    authMode?: string;
    schemaVersion: number;
};
export declare class CredentialSecretCryptoError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class CredentialSecretCryptoConfigurationError extends CredentialSecretCryptoError {
}
export declare class CredentialSecretCryptoIntegrityError extends CredentialSecretCryptoError {
}
export declare function isCredentialSecretCryptoError(error: unknown): error is CredentialSecretCryptoError;
export declare function encryptCredentialSecretValue(value: string, aadContext: CredentialSecretAadContext, runtimeSecrets?: RuntimeSecretProvider): string;
export declare function decryptCredentialSecretValue(stored: string, aadContext: CredentialSecretAadContext, runtimeSecrets?: RuntimeSecretProvider): string;
