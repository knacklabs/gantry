import { parseRuntimeSecretRefString } from '../../domain/ports/runtime-secret-provider.js';
import { parseStringValue } from './runtime-settings-parse-primitives.js';
import type {
  RuntimeAuthenticationSettings,
  RuntimeOidcSettings,
} from './runtime-settings-types.js';

function parseOidcSettings(raw: unknown, path: string): RuntimeOidcSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${path} must be a mapping`);
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (
      ![
        'issuer',
        'client_id',
        'client_secret_ref',
        'company_domain',
        'provider_label',
      ].includes(key)
    )
      throw new Error(`${path}.${key} is not supported`);
  const issuerValue = parseStringValue(value.issuer, `${path}.issuer`);
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuerValue);
  } catch (error) {
    throw new Error(`${path}.issuer must be an https URL`, { cause: error });
  }
  if (
    issuerUrl.protocol !== 'https:' ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash
  )
    throw new Error(`${path}.issuer must be an https URL`);
  const clientSecretPath = `${path}.client_secret_ref`;
  const clientSecret = parseRuntimeSecretRefString(
    parseStringValue(value.client_secret_ref, clientSecretPath),
    clientSecretPath,
  );
  return {
    issuer: issuerUrl.toString().replace(/\/$/, ''),
    clientId: parseStringValue(value.client_id, `${path}.client_id`),
    clientSecretRef: `${clientSecret.source}:${clientSecret.name}`,
    companyDomain: parseStringValue(
      value.company_domain,
      `${path}.company_domain`,
    ).toLowerCase(),
    providerLabel: parseStringValue(
      value.provider_label,
      `${path}.provider_label`,
    ),
  };
}

export function parseAuthenticationSettings(
  raw: unknown,
): RuntimeAuthenticationSettings {
  const defaults: RuntimeAuthenticationSettings = {
    mode: 'local',
    canonicalOrigin: 'http://127.0.0.1:3939',
  };
  if (raw === undefined) return defaults;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('authentication must be a mapping');
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (
      !['mode', 'canonical_origin', 'active_oidc', 'candidate_oidc'].includes(
        key,
      )
    )
      throw new Error(`authentication.${key} is not supported`);
  const mode =
    value.mode === undefined
      ? defaults.mode
      : parseStringValue(value.mode, 'authentication.mode');
  if (mode !== 'local' && mode !== 'hosted')
    throw new Error('authentication.mode must be local or hosted');
  const canonicalOriginValue =
    value.canonical_origin === undefined
      ? defaults.canonicalOrigin
      : parseStringValue(
          value.canonical_origin,
          'authentication.canonical_origin',
        );
  let canonicalOriginUrl: URL;
  try {
    canonicalOriginUrl = new URL(canonicalOriginValue);
  } catch (error) {
    throw new Error('authentication.canonical_origin must be an origin URL', {
      cause: error,
    });
  }
  if (
    !['http:', 'https:'].includes(canonicalOriginUrl.protocol) ||
    canonicalOriginUrl.username ||
    canonicalOriginUrl.password ||
    canonicalOriginUrl.pathname !== '/' ||
    canonicalOriginUrl.search ||
    canonicalOriginUrl.hash
  )
    throw new Error('authentication.canonical_origin must be an origin URL');
  if (mode === 'hosted' && canonicalOriginUrl.protocol !== 'https:')
    throw new Error(
      'authentication.canonical_origin must use https in hosted mode',
    );
  if (
    mode === 'local' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(canonicalOriginUrl.hostname)
  )
    throw new Error(
      'authentication.canonical_origin must use a loopback host in local mode',
    );
  const activeOidc =
    value.active_oidc === undefined
      ? undefined
      : parseOidcSettings(value.active_oidc, 'authentication.active_oidc');
  const candidateOidc =
    value.candidate_oidc === undefined
      ? undefined
      : parseOidcSettings(
          value.candidate_oidc,
          'authentication.candidate_oidc',
        );
  if (mode === 'hosted' && !activeOidc)
    throw new Error(
      'authentication.active_oidc is required when authentication.mode is hosted',
    );
  return {
    mode,
    canonicalOrigin: canonicalOriginUrl.origin,
    activeOidc,
    candidateOidc,
  };
}
