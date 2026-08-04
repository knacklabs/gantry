export class CredentialBrokerPolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CredentialBrokerPolicyError';
    }
}
export class CredentialBrokerConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CredentialBrokerConfigError';
    }
}
export function isCredentialBrokerBoundaryError(err) {
    return (err instanceof CredentialBrokerPolicyError ||
        err instanceof CredentialBrokerConfigError ||
        (err instanceof Error &&
            (err.name === 'CredentialBrokerPolicyError' ||
                err.name === 'CredentialBrokerConfigError')));
}
