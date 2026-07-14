import { createHash } from 'node:crypto';

import type { RuntimeCredentialBrokerSettings } from '../../../config/settings/runtime-settings-types.js';
import type { LlmPassthroughEndpoint } from './llm-request-validator.js';

type PromptCacheSettings = RuntimeCredentialBrokerSettings['promptCache'];

export type DirectLlmPromptCacheDiagnostics = {
  readonly enabled: boolean;
  readonly mode:
    | 'anthropic_explicit'
    | 'provider_automatic_prefix'
    | 'disabled'
    | 'unsupported';
  readonly ttl: '5m' | '1h' | null;
  readonly prefixHash: string | null;
  readonly prefixChars: number;
  readonly breakpointCount: 0 | 1;
};

export function applyDirectLlmPromptCache(
  endpoint: LlmPassthroughEndpoint,
  body: Record<string, unknown>,
  settings: PromptCacheSettings,
  options: { readonly providerAutomatic?: boolean } = {},
): DirectLlmPromptCacheDiagnostics {
  const prefix = readSystemPrefix(endpoint, body);
  if (endpoint === 'chat_completions') {
    return diagnostics({
      enabled: options.providerAutomatic === true,
      mode:
        options.providerAutomatic === true
          ? 'provider_automatic_prefix'
          : 'unsupported',
      prefix,
    });
  }
  const ttl =
    readSystemPromptCacheTtl(body.system) ?? settings.anthropic.defaultTtl;
  stripCacheControl(body);
  if (!settings.enabled) {
    return diagnostics({ enabled: false, mode: 'disabled', prefix });
  }

  const cacheControl = {
    type: 'ephemeral',
    ttl,
  } as const;
  if (typeof body.system === 'string' && body.system.length > 0) {
    body.system = [
      {
        type: 'text',
        text: body.system,
        cache_control: cacheControl,
      },
    ];
    return diagnostics({
      enabled: true,
      mode: 'anthropic_explicit',
      ttl,
      prefix,
      breakpointCount: 1,
    });
  }
  if (!Array.isArray(body.system)) {
    return diagnostics({ enabled: false, mode: 'unsupported', prefix });
  }
  for (let index = body.system.length - 1; index >= 0; index -= 1) {
    const block = body.system[index];
    if (
      isRecord(block) &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.length > 0
    ) {
      block.cache_control = cacheControl;
      return diagnostics({
        enabled: true,
        mode: 'anthropic_explicit',
        ttl,
        prefix,
        breakpointCount: 1,
      });
    }
  }
  return diagnostics({ enabled: false, mode: 'unsupported', prefix });
}

function diagnostics(input: {
  readonly enabled: boolean;
  readonly mode: DirectLlmPromptCacheDiagnostics['mode'];
  readonly ttl?: '5m' | '1h';
  readonly prefix: string;
  readonly breakpointCount?: 0 | 1;
}): DirectLlmPromptCacheDiagnostics {
  return {
    enabled: input.enabled,
    mode: input.mode,
    ttl: input.ttl ?? null,
    prefixHash: input.prefix
      ? createHash('sha256').update(input.prefix).digest('hex')
      : null,
    prefixChars: input.prefix.length,
    breakpointCount: input.breakpointCount ?? 0,
  };
}

function readSystemPrefix(
  endpoint: LlmPassthroughEndpoint,
  body: Record<string, unknown>,
): string {
  if (endpoint === 'messages' || endpoint === 'count_tokens') {
    return collectText(body.system);
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemMessages = messages.filter(
    (message): message is Record<string, unknown> =>
      isRecord(message) && message.role === 'system',
  );
  return systemMessages
    .map((message) => collectText(message.content))
    .join('\n');
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(collectText).filter(Boolean).join('\n');
  }
  if (!isRecord(value)) return '';
  if (value.type === 'text' && typeof value.text === 'string')
    return value.text;
  return '';
}

function readSystemPromptCacheTtl(value: unknown): '5m' | '1h' | null {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const ttl = readSystemPromptCacheTtl(value[index]);
      if (ttl) return ttl;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const cacheControl = isRecord(value.cache_control)
    ? value.cache_control
    : null;
  if (cacheControl?.ttl === '5m' || cacheControl?.ttl === '1h') {
    return cacheControl.ttl;
  }
  return null;
}

function stripCacheControl(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) stripCacheControl(entry);
    return;
  }
  if (!isRecord(value)) return;
  delete value.cache_control;
  for (const entry of Object.values(value)) stripCacheControl(entry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
