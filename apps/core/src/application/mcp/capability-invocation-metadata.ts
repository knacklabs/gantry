import { createHash } from 'node:crypto';

/** MCP `params._meta` key and version a capability provider uses to bind a call to its Gantry job and run. */
export const CAPABILITY_INVOCATION_METADATA_KEY = 'gantry.invocation';
export const CAPABILITY_INVOCATION_METADATA_VERSION = 'gantry.capability_invocation@1';

export interface CapabilityInvocationIdentity {
  appId: string;
  jobId: string;
  runId: string;
  capabilityId: string;
  operation: string;
  idempotencyKey: string;
  arguments: Record<string, unknown>;
}

/**
 * Host-built envelope proving which job, run and reviewed operation sent these exact arguments. Providers recompute
 * `argumentsSha256` over the arguments they received, so it uses their canonical JSON (keys in code-unit order).
 */
export function capabilityInvocationMetadata(identity: CapabilityInvocationIdentity): Record<string, unknown> {
  return {
    [CAPABILITY_INVOCATION_METADATA_KEY]: {
      version: CAPABILITY_INVOCATION_METADATA_VERSION,
      appId: identity.appId,
      jobId: identity.jobId,
      runId: identity.runId,
      capabilityId: identity.capabilityId,
      operation: identity.operation,
      invocationId: invocationId(identity.idempotencyKey),
      argumentsSha256: `sha256:${createHash('sha256').update(providerCanonicalJson(identity.arguments)).digest('hex')}`,
    },
  };
}

// Providers accept invocation ids up to 256 characters; a longer idempotency key is represented by its digest.
function invocationId(idempotencyKey: string): string {
  const id = `invocation:${idempotencyKey}`;
  return id.length <= 256 ? id : `invocation:sha256:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

// Sorted with Array#sort (UTF-16 code units), not localeCompare: it must equal the provider's serialization.
function providerCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(providerCanonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${providerCanonicalJson(object[key])}`)
    .join(',')}}`;
}
