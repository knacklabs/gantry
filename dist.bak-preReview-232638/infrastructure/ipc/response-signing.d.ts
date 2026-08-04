export interface IpcResponseSigningKeyPair {
    publicKeyPem: string;
    privateKeyPem: string;
}
export declare function createIpcResponseSigningKeyPair(): IpcResponseSigningKeyPair;
export declare function canonicalIpcResponsePayload(payload: Record<string, unknown>): Buffer;
export declare function signIpcResponsePayload(privateKeyPem: string | undefined, payload: Record<string, unknown>): string | undefined;
export declare function verifyIpcResponsePayload(publicKeyPem: string | undefined, payload: Record<string, unknown>, signature: string | undefined): boolean;
