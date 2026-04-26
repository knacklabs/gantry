import { isIP } from 'net';

export interface BrokerUrlValidationResult {
  ok: boolean;
  normalizedUrl?: string;
  error?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split('.')[0] === '127';
  if (ipVersion === 6) return normalized === '::1';
  return false;
}

export function validateBrokerUrl(
  rawUrl: string,
  label: string,
): BrokerUrlValidationResult {
  const input = rawUrl.trim();
  if (!input) {
    return { ok: false, error: `${label} is required.` };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: `${label} must be a valid URL.` };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: `${label} must not contain embedded credentials.`,
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      error: `${label} must not contain query parameters or fragments.`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `${label} must use http:// or https://.`,
    };
  }

  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    return {
      ok: false,
      error: `${label} must use HTTPS unless it points to loopback.`,
    };
  }

  return { ok: true, normalizedUrl: parsed.toString().replace(/\/$/, '') };
}

export function validateExternalBrokerUrl(
  rawUrl: string,
  label = 'ANTHROPIC_BASE_URL',
): BrokerUrlValidationResult {
  return validateBrokerUrl(rawUrl, label);
}

export function resolveExternalCredentialBaseUrl(rawBrokerUrl: string): string {
  const validation = validateExternalBrokerUrl(
    rawBrokerUrl,
    'credential_broker.external.base_url',
  );
  if (!validation.ok || !validation.normalizedUrl) {
    throw new Error(
      validation.error || 'credential_broker.external.base_url is invalid.',
    );
  }
  return validation.normalizedUrl;
}
