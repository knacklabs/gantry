import { describe, expect, it } from 'vitest';

import {
  createIpcResponseSigningKeyPair,
  signIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import {
  buildPermissionResponseSignaturePayload,
  hasValidIpcResponseSignature,
} from '@core/shared/ipc-signing.js';

function signedPermissionResponse(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const keys = createIpcResponseSigningKeyPair();
  return {
    publicKeyPem: keys.publicKeyPem,
    ...payload,
    signature: signIpcResponsePayload(keys.privateKeyPem, payload),
  };
}

describe('permission IPC response signing', () => {
  it('builds the complete signed field set in canonical order', () => {
    const payload = buildPermissionResponseSignaturePayload({
      signature: 'not-covered',
      ignored: 'not-covered',
      requestId: 'perm-1',
      responseNonce: 'nonce-1',
      approved: false,
      mode: 'cancel',
      decidedBy: 'human',
      reason: 'denied',
      risk_level: 'critical',
      risk_category: 'destructive',
      updatedPermissions: [],
      decisionClassification: 'user_reject',
    });

    expect(payload).toEqual({
      requestId: 'perm-1',
      responseNonce: 'nonce-1',
      approved: false,
      mode: 'cancel',
      decidedBy: 'human',
      reason: 'denied',
      risk_level: 'critical',
      risk_category: 'destructive',
      updatedPermissions: [],
      decisionClassification: 'user_reject',
    });
    expect(Object.keys(payload)).toEqual([
      'requestId',
      'responseNonce',
      'approved',
      'mode',
      'decidedBy',
      'reason',
      'risk_level',
      'risk_category',
      'updatedPermissions',
      'decisionClassification',
    ]);
  });

  it('verifies responses with and without optional risk fields', () => {
    const withoutRisk = signedPermissionResponse({
      requestId: 'perm-without-risk',
      responseNonce: 'nonce-without-risk',
      approved: true,
      mode: 'allow_once',
    });
    const withRisk = signedPermissionResponse({
      requestId: 'perm-with-risk',
      responseNonce: 'nonce-with-risk',
      approved: false,
      mode: 'cancel',
      risk_level: 'high',
      risk_category: 'network',
    });

    expect(
      hasValidIpcResponseSignature(
        withoutRisk.publicKeyPem as string,
        withoutRisk,
      ),
    ).toBe(true);
    expect(
      hasValidIpcResponseSignature(withRisk.publicKeyPem as string, withRisk),
    ).toBe(true);
  });

  it('rejects tampered risk fields and replayed nonces', () => {
    const signed = signedPermissionResponse({
      requestId: 'perm-tamper',
      responseNonce: 'nonce-original',
      approved: false,
      mode: 'cancel',
      risk_level: 'critical',
      risk_category: 'destructive',
    });
    const publicKeyPem = signed.publicKeyPem as string;

    expect(
      hasValidIpcResponseSignature(publicKeyPem, {
        ...signed,
        risk_level: 'low',
      }),
    ).toBe(false);
    expect(
      hasValidIpcResponseSignature(publicKeyPem, {
        ...signed,
        responseNonce: 'nonce-replayed',
      }),
    ).toBe(false);
  });
});
