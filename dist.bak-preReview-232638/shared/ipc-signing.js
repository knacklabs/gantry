import { createHmac, randomUUID, verify as cryptoVerify } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { nowMs, toIso } from './time/datetime.js';
const ORDINARY_IPC_AUTH_LIFETIME_MS = 5 * 60_000;
const PERMISSION_RESPONSE_FIELDS_AFTER_APPROVED = [
    'mode',
    'decidedBy',
    'reason',
    'risk_level',
    'risk_category',
    'updatedPermissions',
    'decisionClassification',
];
export function buildPermissionResponseSignaturePayload(raw) {
    const response = raw;
    const payload = {
        requestId: response.requestId,
    };
    if (response.responseNonce) {
        payload.responseNonce = response.responseNonce;
    }
    payload.approved = response.approved;
    for (const field of PERMISSION_RESPONSE_FIELDS_AFTER_APPROVED) {
        if (response[field]) {
            payload[field] = response[field];
        }
    }
    return payload;
}
export function signIpcRequestPayload(requestSigningKey, payload) {
    const key = requestSigningKey?.trim();
    if (!key)
        return undefined;
    return createHmac('sha256', key).update(canonicalJson(payload)).digest('hex');
}
export function createSignedIpcRequestEnvelope(requestSigningKey, payload, options) {
    const { authExpiresAt: _authExpiresAt, authIssuedAt: _authIssuedAt, authPurpose: _authPurpose, ...requestPayload } = payload;
    const issuedAtMs = nowMs();
    const authLifetimeMs = options?.authLifetimeMs ?? ORDINARY_IPC_AUTH_LIFETIME_MS;
    if (authLifetimeMs > ORDINARY_IPC_AUTH_LIFETIME_MS && !options?.authPurpose) {
        throw new Error('Extended IPC auth lifetime requires an explicit purpose');
    }
    const authExpiresAt = typeof payload.expiresAt === 'string' && payload.expiresAt.trim()
        ? payload.expiresAt
        : toIso(issuedAtMs + ORDINARY_IPC_AUTH_LIFETIME_MS);
    const signedPayload = {
        ...requestPayload,
        requestId: typeof payload.requestId === 'string' && payload.requestId.trim()
            ? payload.requestId
            : `ipc-${randomUUID()}`,
        nonce: randomUUID(),
        ...(options?.separateAuthExpiry
            ? {
                authIssuedAt: toIso(issuedAtMs),
                authExpiresAt: toIso(issuedAtMs + authLifetimeMs),
                ...(options.authPurpose ? { authPurpose: options.authPurpose } : {}),
            }
            : { expiresAt: authExpiresAt }),
    };
    const signature = signIpcRequestPayload(requestSigningKey, signedPayload);
    return signature ? { ...signedPayload, signature } : signedPayload;
}
export function verifyIpcResponsePayload(publicKeyPem, payload, signature) {
    const key = publicKeyPem?.trim();
    const sig = signature?.trim();
    if (!key || !sig)
        return false;
    try {
        return cryptoVerify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(sig, 'base64'));
    }
    catch {
        return false;
    }
}
export function hasValidIpcResponseSignature(publicKeyPem, raw) {
    const signature = typeof raw.signature === 'string' ? raw.signature.trim() : '';
    return verifyIpcResponsePayload(publicKeyPem, buildPermissionResponseSignaturePayload(raw), signature);
}
