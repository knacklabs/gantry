export declare class CredentialBrokerPolicyError extends Error {
    constructor(message: string);
}
export declare class CredentialBrokerConfigError extends Error {
    constructor(message: string);
}
export declare function isCredentialBrokerBoundaryError(err: unknown): err is CredentialBrokerPolicyError | CredentialBrokerConfigError;
