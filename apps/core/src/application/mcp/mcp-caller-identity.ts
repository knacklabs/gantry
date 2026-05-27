import type { MaterializedMcpCapability } from './mcp-server-materialization.js';
import { normalizeCapabilitySecretName } from '../../domain/capability-secrets/capability-secrets.js';
import { hmacSha256Hex } from '../../shared/hmac-sha256.js';
import { formatMissingGantrySecretsMessage } from '../../shared/user-visible-messages.js';

export interface CallerIdentity {
  phone: string;
  email?: string;
}

export const CALLER_IDENTITY_UNAVAILABLE_MESSAGE =
  'I can only check details linked to the phone number you are messaging from. The phone number, email, or order you asked about does not match that number.';

export type CallerIdentityProjectionResult =
  | { ok: true; capabilities: MaterializedMcpCapability[] }
  | { ok: false; error: string; internalError: string };

export function projectCallerIdentityHeaders(input: {
  capabilities: readonly MaterializedMcpCapability[];
  chatJid: string;
  credentialEnv: Record<string, string>;
}): CallerIdentityProjectionResult {
  const projected: MaterializedMcpCapability[] = [];
  for (const capability of input.capabilities) {
    const identityConfig = capability.callerIdentity;
    if (!identityConfig || identityConfig.mode === 'disabled') {
      projected.push(capability);
      continue;
    }
    if (capability.config.type !== 'http' && capability.config.type !== 'sse') {
      return callerIdentityProjectionFailure(
        `MCP caller identity requires ${capability.name} to use HTTP or SSE transport so Gantry can sign the caller identity header`,
      );
    }
    const identity = deriveCallerIdentityFromJid({
      jid: input.chatJid,
      jidPrefix: identityConfig.source.jidPrefix,
    });
    if (!identity) {
      return callerIdentityProjectionFailure(
        `MCP caller identity requires a ${identityConfig.source.jidPrefix} conversation identity before ${capability.name} can be exposed to an agent`,
      );
    }
    const secretName = normalizeCapabilitySecretName(identityConfig.signingRef);
    const secret = input.credentialEnv[secretName]?.trim() ?? '';
    if (!secret) {
      return callerIdentityProjectionFailure(
        `${formatMissingGantrySecretsMessage([secretName])} Required before ${capability.name} can be exposed to an agent with caller identity enabled.`,
      );
    }
    projected.push(
      injectIdentityHeaderIntoMcpCapability({
        cap: capability,
        identity,
        headerName: identityConfig.headerName,
        secret,
      }),
    );
  }
  return { ok: true, capabilities: projected };
}

function callerIdentityProjectionFailure(
  internalError: string,
): CallerIdentityProjectionResult {
  return {
    ok: false,
    error: CALLER_IDENTITY_UNAVAILABLE_MESSAGE,
    internalError,
  };
}

export function deriveCallerIdentityFromJid(input: {
  jid: string;
  jidPrefix: string;
}): CallerIdentity | null {
  if (!input.jid.startsWith(input.jidPrefix)) return null;
  const digits = input.jid.slice(input.jidPrefix.length);
  if (!/^\d{8,15}$/.test(digits)) return null;
  return { phone: `+${digits}` };
}

function computeIdentitySignature(
  input: { phone?: string; email?: string; ts: number },
  secret: string,
): string {
  const canonical = [
    `phone=${input.phone ?? ''}`,
    `email=${(input.email ?? '').toLowerCase()}`,
    `ts=${input.ts}`,
  ].join('|');
  return hmacSha256Hex(secret, canonical);
}

export function injectIdentityHeaderIntoMcpCapability(input: {
  cap: MaterializedMcpCapability;
  identity: CallerIdentity;
  headerName: string;
  secret: string;
}): MaterializedMcpCapability {
  const { cap, identity, headerName, secret } = input;
  if (cap.config.type !== 'http' && cap.config.type !== 'sse') return cap;
  const ts = Math.floor(Date.now() / 1000);
  const sig = computeIdentitySignature(
    {
      phone: identity.phone,
      ...(identity.email ? { email: identity.email } : {}),
      ts,
    },
    secret,
  );
  const headerValue =
    `phone:${identity.phone};` +
    (identity.email ? `email:${identity.email.toLowerCase()};` : '') +
    `ts:${ts};sig:${sig}`;
  return {
    ...cap,
    config: {
      ...cap.config,
      headers: {
        ...(cap.config.headers ?? {}),
        [headerName]: headerValue,
      },
    },
  };
}
