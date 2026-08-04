export declare const IPC_REQUEST_MAX_AGE_MS: number;
export declare function signIpcRequestPayload(requestSigningKey: string | undefined, payload: Record<string, unknown>): string | undefined;
export declare function verifyIpcRequestPayload(requestSigningKey: string | undefined, payload: Record<string, unknown>, signature: string | undefined): boolean;
export declare function validateIpcRequestFreshness(payload: Record<string, unknown>, nowMs?: number, maxAgeMs?: number): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
