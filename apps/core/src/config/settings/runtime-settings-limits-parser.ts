import type { RuntimeLimitSettings } from './runtime-settings-types.js';
import { listExecutableModelProviders } from '../../shared/model-provider-registry.js';
import {
  DEFAULT_PROVIDER_SESSION_MAX_INPUT_TOKENS,
  MAX_PROVIDER_SESSION_MAX_INPUT_TOKENS,
  MIN_PROVIDER_SESSION_MAX_INPUT_TOKENS,
} from './runtime-settings-defaults.js';

// Strict parser for the optional `limits` block. Shape:
//   limits:
//     provider_session_max_input_tokens: <integer from 20,000 to 900,000>
//     <providerId>:
//       requests_per_minute: <positive integer>
// Provider ids are validated against the executable model provider registry;
// unknown providers and non-positive / non-integer caps fail loudly. Absent ->
// no caps. This is restart-owned config with no DB projection (mirrors the
// permissions/egress parser pattern).

function knownProviderIds(): Set<string> {
  return new Set(listExecutableModelProviders().map((provider) => provider.id));
}

function parsePositiveInt(raw: unknown, pathPrefix: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return raw;
}

export function parseLimitsSettings(raw: unknown): RuntimeLimitSettings {
  const defaults: RuntimeLimitSettings = {
    providerSessionMaxInputTokens: DEFAULT_PROVIDER_SESSION_MAX_INPUT_TOKENS,
    providers: {},
  };
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('limits must be a mapping');
  }
  const providerIds = knownProviderIds();
  const providers: RuntimeLimitSettings['providers'] = {};
  const limitsMap = raw as Record<string, unknown>;
  for (const [providerId, providerRaw] of Object.entries(limitsMap)) {
    if (providerId === 'provider_session_max_input_tokens') continue;
    if (!providerIds.has(providerId)) {
      throw new Error(
        `limits.${providerId} is not a supported model provider. Supported providers: ${[
          ...providerIds,
        ]
          .sort()
          .join(', ')}.`,
      );
    }
    if (
      typeof providerRaw !== 'object' ||
      providerRaw === null ||
      Array.isArray(providerRaw)
    ) {
      throw new Error(`limits.${providerId} must be a mapping`);
    }
    const providerMap = providerRaw as Record<string, unknown>;
    for (const key of Object.keys(providerMap)) {
      if (key !== 'requests_per_minute') {
        throw new Error(
          `limits.${providerId}.${key} is not supported. Configure requests_per_minute.`,
        );
      }
    }
    providers[providerId] = {
      requestsPerMinute: parsePositiveInt(
        providerMap.requests_per_minute,
        `limits.${providerId}.requests_per_minute`,
      ),
    };
  }
  const providerSessionMaxInputTokens = Object.hasOwn(
    limitsMap,
    'provider_session_max_input_tokens',
  )
    ? limitsMap.provider_session_max_input_tokens
    : DEFAULT_PROVIDER_SESSION_MAX_INPUT_TOKENS;
  if (
    typeof providerSessionMaxInputTokens !== 'number' ||
    !Number.isInteger(providerSessionMaxInputTokens) ||
    providerSessionMaxInputTokens < MIN_PROVIDER_SESSION_MAX_INPUT_TOKENS ||
    providerSessionMaxInputTokens > MAX_PROVIDER_SESSION_MAX_INPUT_TOKENS
  ) {
    throw new Error(
      `limits.provider_session_max_input_tokens must be an integer between ${MIN_PROVIDER_SESSION_MAX_INPUT_TOKENS} and ${MAX_PROVIDER_SESSION_MAX_INPUT_TOKENS}`,
    );
  }
  return { providerSessionMaxInputTokens, providers };
}
