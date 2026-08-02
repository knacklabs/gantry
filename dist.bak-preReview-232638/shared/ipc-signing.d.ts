export type IpcAuthPurpose = 'unbounded-interaction' | 'cancellation-retention';
export declare function buildPermissionResponseSignaturePayload(raw: object): Record<string, unknown>;
export declare function signIpcRequestPayload(requestSigningKey: string | undefined, payload: Record<string, unknown>): string | undefined;
export declare function createSignedIpcRequestEnvelope(requestSigningKey: string | undefined, payload: Record<string, unknown>, options?: {
    separateAuthExpiry?: boolean;
    authLifetimeMs?: number;
    authPurpose?: IpcAuthPurpose;
}): Record<string, unknown>;
export declare function verifyIpcResponsePayload(publicKeyPem: string | undefined, payload: Record<string, unknown>, signature: string | undefined): boolean;
export declare function hasValidIpcResponseSignature(publicKeyPem: string | undefined, raw: Record<string, unknown>): boolean;
