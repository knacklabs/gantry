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
      expect(provider?.executionRoute, entry.id).toBeDefined();
    }
  });

  it('declares a single provider-derived execution route with credential mode constraints', () => {
    expect(getModelProviderDefinition('anthropic')?.executionRoute).toEqual({
      engine: 'anthropic_sdk',
      executionProviderId: 'anthropic:claude-agent-sdk',
      supportedCredentialModes: ['api_key', 'claude_code_oauth'],
    });
    // OpenRouter is now the DeepAgents lane (was anthropic_sdk) and projects the
    // OpenAI-family gateway env so ChatOpenRouter reads the loopback base-url +
    // gtw_ token.
    expect(getModelProviderDefinition('openrouter')?.executionRoute).toEqual({
      engine: 'deepagents',
      executionProviderId: 'deepagents:langchain',
      supportedCredentialModes: ['api_key'],
    });
    expect(
      getModelProviderDefinition('openrouter')?.gateway.sdkProjection,
    ).toMatchObject({
      baseUrlEnv: 'OPENAI_BASE_URL',
      tokenEnv: 'OPENAI_API_KEY',
      credentialProvider: 'openrouter',
    });
    expect(
      getModelProviderDefinition('openrouter')?.gateway.sdkProjection
        .additionalTokenEnv,
    ).toBeUndefined();
    expect(getModelProviderDefinition('openai')?.executionRoute).toEqual({
      engine: 'deepagents',
      executionProviderId: 'deepagents:langchain',
      supportedCredentialModes: ['api_key'],
    });
    expect(getModelProviderDefinition('bedrock')?.executionRoute).toEqual({
      engine: 'deepagents',
      executionProviderId: 'deepagents:langchain',
      supportedCredentialModes: ['bedrock_api_key'],
    });
    expect(getModelProviderDefinition('vertex')?.executionRoute).toEqual({
      engine: 'deepagents',
      executionProviderId: 'deepagents:langchain',
      supportedCredentialModes: ['service_account'],
    });
  });

  it('makes OpenAI an executable chat and memory model route', () => {
    const openai = getModelProviderDefinition('openai');
    expect(openai?.executable).toBe(true);
    expect(openai?.modelRoute).toBe(true);
    expect(openai?.supportedWorkloads).toEqual([
      'chat',
      'memory_extractor',
      'memory_dreaming',
      'memory_consolidation',
    ]);
    expect(openai?.gateway.sdkProjection).toMatchObject({
      baseUrlEnv: 'OPENAI_BASE_URL',
      tokenEnv: 'OPENAI_API_KEY',
    });
    expect(listModelRouteProviders().map((provider) => provider.id)).toContain(
      'openai',
    );
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
        // OpenRouter speaks chat/completions on the DeepAgents lane; Kimi caches
        // automatically on the prefix (OpenAI-shaped usage).
        mode: 'openrouter_automatic_prefix',
        automatic: true,
        requestControl: 'provider_automatic_prefix',
        usageFields: {
          readTokens: 'prompt_tokens_details.cached_tokens',
          writeTokens: 'prompt_tokens_details.cache_write_tokens',
        },
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
    expect(
      getModelProviderDefinition('bedrock')?.credentialModes.map(
        (mode) => mode.id,
      ),
    ).toEqual(['bedrock_api_key']);
    expect(
      getModelProviderDefinition('vertex')?.credentialModes.map(
        (mode) => mode.id,
      ),
    ).toEqual(['service_account']);
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
    expect(
      normalizeModelCredentialPayload({
        providerId: 'bedrock',
        authMode: 'bedrock_api_key',
        payload: { region: ' us-east-1 ', apiKey: ' bedrock-key ' },
      }),
    ).toEqual({ region: 'us-east-1', apiKey: 'bedrock-key' });
    expect(() =>
      normalizeModelCredentialPayload({
        providerId: 'bedrock',
        authMode: 'access_key',
        payload: { region: 'us-west-2', accessKeyId: 'AKIATEST' },
      }),
    ).toThrow('Credential auth mode access_key is not supported for bedrock.');
    expect(
      normalizeModelCredentialPayload({
        providerId: 'vertex',
        authMode: 'service_account',
        payload: {
          region: ' global ',
          projectId: 'gantry-test',
          serviceAccountJson: JSON.stringify({
            type: 'service_account',
            project_id: 'other-project',
            client_email: 'gantry@example.iam.gserviceaccount.com',
            private_key:
              '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
          }),
        },
      }),
    ).toMatchObject({
      region: 'global',
      projectId: 'gantry-test',
    });
    expect(() =>
      normalizeModelCredentialPayload({
        providerId: 'bedrock',
        authMode: 'bedrock_api_key',
        payload: { region: 'us-east-1.example.com', apiKey: 'key' },
      }),
    ).toThrow(
      'Credential field region is invalid for bedrock bedrock_api_key.',
    );
    expect(() =>
      normalizeModelCredentialPayload({
        providerId: 'vertex',
        authMode: 'service_account',
        payload: {
          region: 'eu',
          projectId: 'gantry-test',
          serviceAccountJson: '{}',
        },
      }),
    ).toThrow('Credential field region is invalid for vertex service_account.');
    expect(() =>
      normalizeModelCredentialPayload({
        providerId: 'vertex',
        authMode: 'service_account',
        payload: {
          region: 'us-central1',
          projectId: 'gantry-test',
          serviceAccountJson: '{}',
        },
      }),
    ).toThrow('Credential field region is invalid for vertex service_account.');
    expect(() =>
      normalizeModelCredentialPayload({
        providerId: 'vertex',
        authMode: 'service_account',
        payload: {
          region: 'global',
          projectId: 'gantry-test/evil',
          serviceAccountJson: '{}',
        },
      }),
    ).toThrow(
      'Credential field projectId is invalid for vertex service_account.',
    );
    expect(() =>
      normalizeModelCredentialPayload({
        providerId: 'vertex',
        authMode: 'service_account',
        payload: {
          region: 'global',
          projectId: 'gantry-test',
          serviceAccountJson: '{}',
        },
      }),
    ).toThrow(
      'Credential field serviceAccountJson is invalid for vertex service_account.',
    );
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
      executionRoute: {
        engine: 'deepagents',
        executionProviderId: 'deepagents:langchain',
        supportedCredentialModes: ['api_key'],
      },
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

  it.each([
    [
      'groq',
      'https://api.groq.com',
      '/openai/v1',
      'prompt_tokens_details.cached_tokens',
    ],
    ['deepseek', 'https://api.deepseek.com', '/v1', 'prompt_cache_hit_tokens'],
    ['xai', 'https://api.x.ai', '/v1', 'prompt_tokens_details.cached_tokens'],
    ['together', 'https://api.together.ai', '/v1', 'cached_tokens'],
    [
      'fireworks',
      'https://api.fireworks.ai',
      '/inference/v1',
      'prompt_tokens_details.cached_tokens',
    ],
    [
      'cerebras',
      'https://api.cerebras.ai',
      '/v1',
      'prompt_tokens_details.cached_tokens',
    ],
    [
      'gemini',
      'https://generativelanguage.googleapis.com',
      '/v1beta/openai',
      'prompt_tokens_details.cached_tokens',
    ],
  ])(
    'registers %s on the deepagents lane with the right gateway upstream and cache-read field',
    (id, upstreamOrigin, upstreamPathPrefix, readTokens) => {
      const provider = getModelProviderDefinition(id);
      expect(provider).toBeDefined();
      expect(provider!.responseFamily).toBe('openai');
      expect(provider!.executionRoute.engine).toBe('deepagents');
      expect(provider!.executionRoute.executionProviderId).toBe(
        'deepagents:langchain',
      );
      expect(provider!.executionRoute.supportedCredentialModes).toEqual([
        'api_key',
      ]);
      expect(provider!.gateway.pathSegment).toBe(id);
      expect(provider!.gateway.upstreamOrigin).toBe(upstreamOrigin);
      expect(provider!.gateway.upstreamPathPrefix).toBe(upstreamPathPrefix);
      expect(provider!.gateway.sdkProjection.baseUrlEnv).toBe(
        'OPENAI_BASE_URL',
      );
      expect(provider!.gateway.sdkProjection.tokenEnv).toBe('OPENAI_API_KEY');
      expect(provider!.credentialModes[0]!.id).toBe('api_key');
      expect(provider!.credentialModes[0]!.gatewayAuth).toMatchObject({
        strategy: 'bearer',
        field: 'apiKey',
      });
      expect(provider!.cacheSupport.prompt.usageFields.readTokens).toBe(
        readTokens,
      );
      // These are general instruct providers: they serve chat + jobs AND the
      // memory workloads, so a zero-Anthropic deployment can run memory on them.
      expect(provider!.supportedWorkloads).toEqual([
        'chat',
        'one_time_job',
        'recurring_job',
        'memory_extractor',
        'memory_dreaming',
        'memory_consolidation',
      ]);
    },
  );

  it('registers perplexity on the deepagents lane with a bare upstream prefix, no prompt cache, and no memory workloads', () => {
    const provider = getModelProviderDefinition('perplexity');
    expect(provider).toBeDefined();
    expect(provider!.executionRoute.engine).toBe('deepagents');
    expect(provider!.gateway.upstreamOrigin).toBe('https://api.perplexity.ai');
    expect(provider!.gateway.upstreamPathPrefix).toBe('');
    expect(provider!.cacheSupport.prompt.mode).toBe('none');
    expect(provider!.cacheSupport.prompt.automatic).toBe(false);
    expect(
      provider!.cacheSupport.prompt.usageFields.readTokens,
    ).toBeUndefined();
    // The search/answer provider is intentionally NOT a memory model: its
    // responses carry citations and are unsuitable for extraction/summarization.
    expect(provider!.supportedWorkloads).toEqual([
      'chat',
      'one_time_job',
      'recurring_job',
    ]);
  });

  it('registers region-aware Bedrock and global-only Vertex providers without prompt cache assumptions', () => {
    const bedrock = getModelProviderDefinition('bedrock');
    expect(bedrock).toBeDefined();
    expect(bedrock!.responseFamily).toBe('openai');
    expect(bedrock!.gateway.pathSegment).toBe('bedrock');
    expect(bedrock!.gateway.upstreamPathPrefix).toBe('/v1');
    expect(bedrock!.gateway.upstreamResolver).toBeDefined();
    expect(
      bedrock!.gateway.upstreamResolver!({
        authMode: 'bedrock_api_key',
        payload: {
          region: 'ap-south-1',
          apiKey: 'bedrock-key',
        },
      }),
    ).toEqual({
      origin: 'https://bedrock-runtime.ap-south-1.amazonaws.com',
      pathPrefix: '/v1',
    });
    expect(bedrock!.cacheSupport.prompt.mode).toBe('none');
    expect(bedrock!.supportedWorkloads).toEqual([
      'chat',
      'one_time_job',
      'recurring_job',
    ]);

    const vertex = getModelProviderDefinition('vertex');
    expect(vertex).toBeDefined();
    expect(vertex!.responseFamily).toBe('openai');
    expect(vertex!.gateway.pathSegment).toBe('vertex');
    expect(vertex!.gateway.upstreamOrigin).toBe(
      'https://aiplatform.googleapis.com',
    );
    expect(vertex!.gateway.upstreamPathPrefix).toBe(
      '/v1/projects/example-project/locations/global/endpoints/openapi',
    );
    expect(vertex!.gateway.upstreamResolver).toBeDefined();
    expect(
      vertex!.gateway.upstreamResolver!({
        authMode: 'service_account',
        payload: {
          region: 'global',
          projectId: 'gantry-test',
          serviceAccountJson: '{}',
        },
      }),
    ).toEqual({
      origin: 'https://aiplatform.googleapis.com',
      pathPrefix: '/v1/projects/gantry-test/locations/global/endpoints/openapi',
    });
    expect(() =>
      vertex!.gateway.upstreamResolver!({
        authMode: 'service_account',
        payload: {
          region: 'eu',
          projectId: 'gantry-test',
          serviceAccountJson: '{}',
        },
      }),
    ).toThrow('Google Cloud location is invalid.');
    expect(vertex!.cacheSupport.prompt.mode).toBe('none');
    expect(vertex!.supportedWorkloads).toEqual([
      'chat',
      'one_time_job',
      'recurring_job',
    ]);
  });
});
