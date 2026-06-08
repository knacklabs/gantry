import { describe, expect, it } from 'vitest';

import {
  getModelProviderByGatewayPath,
  getModelProviderDefinition,
  listExecutableModelProviders,
  listModelRouteProviders,
  normalizeModelCredentialPayload,
  resolveModelCredentialMode,
  type ModelProviderDefinition,
} from '@core/shared/model-provider-registry.js';
import { listModelCatalogEntries } from '@core/shared/model-catalog.js';

describe('model provider registry', () => {
  it('indexes provider definitions for route lookup', () => {
    const routeProviders = listModelRouteProviders();

    expect(listModelRouteProviders()).toBe(routeProviders);
    expect(getModelProviderDefinition(' ANTHROPIC ')).toBe(
      routeProviders.find((provider) => provider.id === 'anthropic'),
    );
    expect(getModelProviderByGatewayPath(' openrouter ')).toBe(
      routeProviders.find((provider) => provider.id === 'openrouter'),
    );
  });

  it('keeps every executable catalog route backed by registry execution support', () => {
    const executableProviderIds = new Set(
      listExecutableModelProviders().map((provider) => provider.id),
    );

    for (const entry of listModelCatalogEntries()) {
      const provider = getModelProviderDefinition(entry.modelRoute.id);
      expect(provider, entry.id).toBeDefined();
      expect(executableProviderIds.has(entry.modelRoute.id), entry.id).toBe(
        true,
      );
      expect(provider?.modelRoute, entry.id).toBe(true);
      expect(provider?.executionProviderIds, entry.id).toContain(
        entry.executionProviderId,
      );
    }
  });

  it('declares provider-side cache support without a shared cache assumption', () => {
    expect(getModelProviderDefinition('anthropic')?.cacheSupport).toMatchObject(
      {
        prompt: {
          mode: 'anthropic_cache_control',
          automatic: false,
          requestControl: 'cache_control_blocks',
        },
        response: { mode: 'none', enabledByDefault: false },
      },
    );
    expect(
      getModelProviderDefinition('openrouter')?.cacheSupport,
    ).toMatchObject({
      prompt: {
        mode: 'openrouter_anthropic_cache_control',
        automatic: false,
        requestControl: 'cache_control_blocks',
      },
      response: {
        mode: 'openrouter_response_cache',
        enabledByDefault: false,
        requestControl: 'request_header',
        usageBehavior: 'zero_usage_on_hit',
      },
    });
    expect(getModelProviderDefinition('openai')?.cacheSupport).toMatchObject({
      prompt: {
        mode: 'openai_automatic_prefix',
        automatic: true,
        requestControl: 'provider_automatic_prefix',
        usageFields: {
          readTokens: 'prompt_tokens_details.cached_tokens',
        },
      },
      response: { mode: 'none', enabledByDefault: false },
    });
  });

  it('keeps current providers on direct credential modes with friendly field labels', () => {
    for (const provider of listExecutableModelProviders()) {
      expect(provider.credentialModes.map((mode) => mode.id)).toContain(
        'api_key',
      );
      for (const mode of provider.credentialModes) {
        for (const field of mode.fields) {
          expect(field.label).not.toMatch(/^[A-Z0-9_]+$/);
          expect(field.label).not.toContain('_');
        }
      }
    }
    expect(
      getModelProviderDefinition('anthropic')?.credentialModes.map(
        (mode) => mode.id,
      ),
    ).toEqual(['api_key', 'claude_code_oauth']);
    expect(
      getModelProviderDefinition('openrouter')?.credentialModes.map(
        (mode) => mode.id,
      ),
    ).toEqual(['api_key']);
    expect(
      getModelProviderDefinition('openai')?.credentialModes.map(
        (mode) => mode.id,
      ),
    ).toEqual(['api_key']);
  });

  it('validates payloads through the selected credential mode', () => {
    expect(
      normalizeModelCredentialPayload({
        providerId: 'anthropic',
        authMode: 'api_key',
        payload: { apiKey: '  sk-ant-test  ' },
      }),
    ).toEqual({ apiKey: 'sk-ant-test' });
    expect(
      normalizeModelCredentialPayload({
        providerId: 'anthropic',
        authMode: 'claude_code_oauth',
        payload: { oauthToken: '  sk-ant-oat-test  ' },
      }),
    ).toEqual({ oauthToken: 'sk-ant-oat-test' });
    expect(() =>
      normalizeModelCredentialPayload({
        providerId: 'anthropic',
        authMode: 'api_key',
        payload: { bogus: 'value' },
      }),
    ).toThrow('Credential field bogus is not supported for anthropic api_key.');
  });

  it('represents future multi-field and external-identity auth modes', () => {
    const synthetic = {
      id: 'synthetic-azure',
      label: 'Synthetic Azure',
      executable: true,
      modelRoute: true,
      embeddingProvider: false,
      responseFamily: 'openai',
      supportedWorkloads: ['chat'],
      credentialModes: [
        {
          id: 'api_key',
          label: 'API key',
          helpText: 'Use an Azure API key.',
          version: 1,
          fields: [
            {
              name: 'endpoint',
              label: 'Azure endpoint',
              secret: false,
              required: true,
            },
            {
              name: 'deployment',
              label: 'Deployment name',
              secret: false,
              required: true,
            },
            {
              name: 'apiKey',
              label: 'Azure key',
              secret: true,
              required: true,
            },
          ],
          gatewayAuth: { strategy: 'azure_api_key', field: 'apiKey' },
        },
        {
          id: 'entra_default',
          label: 'Microsoft Entra',
          helpText: 'Use local Azure identity.',
          version: 1,
          fields: [
            {
              name: 'endpoint',
              label: 'Azure endpoint',
              secret: false,
              required: true,
            },
            {
              name: 'deployment',
              label: 'Deployment name',
              secret: false,
              required: true,
            },
          ],
          gatewayAuth: { strategy: 'azure_entra_default_credential' },
        },
        {
          id: 'aws_default_chain',
          label: 'AWS default chain',
          helpText: 'Use local AWS identity.',
          version: 1,
          fields: [
            {
              name: 'region',
              label: 'AWS region',
              secret: false,
              required: true,
            },
          ],
          gatewayAuth: { strategy: 'aws_sdk_default_chain' },
        },
      ],
      gateway: {
        pathSegment: 'synthetic-azure',
        upstreamOrigin: 'https://example.invalid',
        upstreamPathPrefix: '',
        stripRequestHeaders: [],
        sdkProjection: {
          baseUrlEnv: 'SYNTHETIC_BASE_URL',
          tokenEnv: 'SYNTHETIC_TOKEN',
          credentialProviderEnvKey: 'SYNTHETIC_TOKEN',
          credentialProvider: 'synthetic',
        },
      },
      cacheSupport: {
        prompt: {
          mode: 'none',
          automatic: false,
          requestControl: 'none',
          ttlOptions: [],
          minimumTokenThresholds: [],
          usageFields: {},
        },
        response: {
          mode: 'none',
          enabledByDefault: false,
          requestControl: 'none',
          requestHeaders: [],
          responseHeaders: [],
          usageBehavior: 'normal_usage',
        },
      },
      executionProviderIds: [],
    } satisfies ModelProviderDefinition;

    expect(
      resolveModelCredentialMode(synthetic, 'api_key').fields,
    ).toHaveLength(3);
    expect(
      resolveModelCredentialMode(synthetic, 'entra_default').gatewayAuth
        .strategy,
    ).toBe('azure_entra_default_credential');
    expect(
      resolveModelCredentialMode(synthetic, 'aws_default_chain').gatewayAuth
        .strategy,
    ).toBe('aws_sdk_default_chain');
  });
});
