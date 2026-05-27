import crypto from 'node:crypto';

// Verifies an Interakt webhook signature against the raw request body.
//
// Per Interakt docs the header is `Interakt-Signature: sha256=<hex>` where
// `<hex>` is HMAC-SHA256(rawBody, secret_key) hex-encoded. The verification
// MUST happen against the raw bytes (not parsed JSON) to remain stable
// across whitespace/encoding changes Interakt's serialiser might make.

const SIGNATURE_PREFIX = 'sha256=';

export function verifyInteraktSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!header || typeof header !== 'string') return false;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith(SIGNATURE_PREFIX)) return false;
  const providedHex = trimmed.slice(SIGNATURE_PREFIX.length).toLowerCase();
  if (!/^[0-9a-f]+$/.test(providedHex)) return false;
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  if (providedHex.length !== expectedHex.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(providedHex, 'hex'),
    Buffer.from(expectedHex, 'hex'),
  );
}
