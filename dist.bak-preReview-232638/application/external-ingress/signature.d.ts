export interface ExternalIngressSignaturePort {
    sha256(input: string): string;
    hmacSha256(secret: string, payload: string): string;
    constantTimeEqual(left: string, right: string): boolean;
}
export interface ExternalIngressSignaturePayloadInput {
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    rawBody: string;
    bodyHash: string;
}
export declare function buildExternalIngressSignaturePayload(input: ExternalIngressSignaturePayloadInput): string;
export declare function isExternalIngressTimestampFresh(input: {
    timestamp: string;
    toleranceMs?: number;
    nowMs?: number;
}): boolean;
export declare function signExternalIngressRequest(input: {
    crypto: ExternalIngressSignaturePort;
    secret: string;
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    rawBody: string;
}): {
    signature: string;
    bodyHash: string;
    payload: string;
};
export declare function verifyExternalIngressRequestSignature(input: {
    crypto: ExternalIngressSignaturePort;
    secret: string;
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    rawBody: string;
    signature: string;
    toleranceMs?: number;
    nowMs?: number;
}): boolean;
