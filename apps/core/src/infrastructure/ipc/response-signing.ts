import {
  generateKeyPairSync,
  sign as cryptoSign,
  createHmac,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'crypto';

export interface IpcResponseSigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function createIpcResponseSigningKeyPair(): IpcResponseSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
}

export function canonicalIpcResponsePayload(
  payload: Record<string, unknown>,
): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

export function signIpcResponsePayload(
  privateKeyPem: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  const key = privateKeyPem?.trim();
  if (!key) return undefined;
  return cryptoSign(null, canonicalIpcResponsePayload(payload), key).toString(
    'base64',
  );
}

export function signIpcResponseAuthPayload(
  responseSigningKey: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  const key = responseSigningKey?.trim();
  if (!key) return undefined;
  return createHmac('sha256', key)
    .update(canonicalIpcResponsePayload(payload))
    .digest('hex');
}

export function verifyIpcResponseAuthPayload(
  responseSigningKey: string | undefined,
  payload: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  const key = responseSigningKey?.trim();
  const sig = signature?.trim();
  if (!key || !sig) return false;
  const expected = signIpcResponseAuthPayload(key, payload);
  if (!expected || sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function verifyIpcResponsePayload(
  publicKeyPem: string | undefined,
  payload: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  const key = publicKeyPem?.trim();
  const sig = signature?.trim();
  if (!key || !sig) return false;
  try {
    return cryptoVerify(
      null,
      canonicalIpcResponsePayload(payload),
      key,
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
}
