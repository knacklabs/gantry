import { describe, expect, it, vi } from 'vitest';

import { LiveProviderModelDiscoveryAdapter } from '@core/adapters/llm/provider-model-discovery-adapter.js';
import { normalizeProviderModelError } from '@core/adapters/llm/provider-model-error.js';
import { ProviderModelDiscoveryService } from '@core/application/models/provider-model-discovery-service.js';
import type { AppId } from '@core/domain/app/app.js';
import type { ProviderModelDiscoveryPort } from '@core/domain/ports/provider-model-discovery.js';
import {
  listModelCatalogEntries,
  type ModelCatalogEntry,
} from '@core/shared/model-catalog.js';
import { getModelProviderDefinition } from '@core/shared/model-provider-registry.js';

const appId = 'default' as AppId;
const CHAT_WORKLOADS = ['chat'] as const;
const registeredModels = async () => listModelCatalogEntries();

function credential(providerId: string) {
  return {
    id: `credential:${providerId}`,
    appId,
    providerId,
    authMode: 'api_key',
    status: 'active',
    schemaVersion: 1,
    payload: { apiKey: 'secret-provider-key' },
    fingerprint: `fingerprint:${providerId}`,
    fieldFingerprints: [],
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  } as never;
}

describe('live provider model discovery', () => {
  it.each([
    ['anthropic', 'https://api.anthropic.com/v1/models', 'x-api-key'],
    ['openrouter', 'https://openrouter.ai/api/v1/models', 'authorization'],
    ['groq', 'https://api.groq.com/openai/v1/models', 'authorization'],
    ['perplexity', 'https://api.perplexity.ai/v1/models', 'authorization'],
  ])(
    'uses the fixed adapter-owned endpoint and auth for %s',
    async (providerId, endpoint, authHeader) => {
      const request = vi.fn(async () =>
        Response.json({
          data: [{ id: `${providerId}-new`, name: 'New model' }],
        }),
      );
      const adapter = new LiveProviderModelDiscoveryAdapter(request as never);

      await expect(
        adapter.discover({
          providerId,
          authMode: 'api_key',
          credential: { apiKey: 'secret-provider-key' },
        }),
      ).resolves.toEqual([
        {
          providerModelId: `${providerId}-new`,
          displayName: 'New model',
          deprecated: false,
          supportedWorkloads:
            getModelProviderDefinition(providerId)!.supportedWorkloads,
        },
      ]);
      const [url, init] = request.mock.calls[0]!;
      expect(String(url)).toBe(`${endpoint}?limit=100`);
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).has(authHeader)).toBe(true);
    },
  );

  it('stops provider pagination after ten outbound requests', async () => {
    const request = vi.fn(async () =>
      Response.json({ data: [{ id: 'still-more' }], has_more: true }),
    );
    const adapter = new LiveProviderModelDiscoveryAdapter(request as never);

    await expect(
      adapter.discover({
        providerId: 'anthropic',
        authMode: 'api_key',
        credential: { apiKey: 'secret-provider-key' },
      }),
    ).rejects.toThrow('more than 10 pages');
    expect(request).toHaveBeenCalledTimes(10);
  });

  it('rejects invalid UTF-8 provider payloads', async () => {
    const request = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff]), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = new LiveProviderModelDiscoveryAdapter(request as never);

    await expect(
      adapter.discover({
        providerId: 'anthropic',
        authMode: 'api_key',
        credential: { apiKey: 'secret-provider-key' },
      }),
    ).rejects.toThrow('malformed JSON');
  });

  it('filters non-generative provider models before registration', async () => {
    const request = vi.fn(async () =>
      Response.json({
        data: [
          { id: 'gpt-6-mini', name: 'GPT 6 Mini' },
          { id: 'text-embedding-4-large', name: 'Embedding' },
          { id: 'gpt-image-2', name: 'Image' },
          { id: 'gpt-6-realtime-preview', name: 'Realtime' },
          { id: 'whisper-2', name: 'Transcription' },
          { id: 'omni-moderation-2', name: 'Moderation' },
        ],
      }),
    );
    const adapter = new LiveProviderModelDiscoveryAdapter(request as never);

    await expect(
      adapter.discover({
        providerId: 'openai',
        authMode: 'api_key',
        credential: { apiKey: 'secret-provider-key' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerModelId: 'gpt-6-mini',
        supportedWorkloads:
          getModelProviderDefinition('openai')!.supportedWorkloads,
      }),
    ]);
  });

  it('honors provider-declared text output capability', async () => {
    const request = vi.fn(async () =>
      Response.json({
        data: [
          {
            id: 'vendor/text-model',
            architecture: { output_modalities: ['text'] },
          },
          {
            id: 'vendor/image-model',
            architecture: { output_modalities: ['image'] },
          },
        ],
      }),
    );
    const adapter = new LiveProviderModelDiscoveryAdapter(request as never);

    await expect(
      adapter.discover({
        providerId: 'openrouter',
        authMode: 'api_key',
        credential: { apiKey: 'secret-provider-key' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ providerModelId: 'vendor/text-model' }),
    ]);
  });
});

describe('provider model catalog merge', () => {
  it('keeps registered aliases and caches a successful merged listing', async () => {
    const registered = listModelCatalogEntries().filter(
      (entry) => entry.modelRoute.id === 'anthropic',
    );
    const matching = registered[0]!;
    const discover = vi.fn(async () => [
      {
        providerModelId: matching.modelRoute.providerModelId,
        displayName: matching.displayName,
        deprecated: false,
        supportedWorkloads: CHAT_WORKLOADS,
      },
      {
        providerModelId: 'claude-discovered-only',
        displayName: 'Claude Discovered Only',
        deprecated: false,
        supportedWorkloads: CHAT_WORKLOADS,
      },
    ]);
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      { discover },
      registeredModels,
      () => Date.parse('2026-08-03T00:00:00.000Z'),
    );

    const live = await service.list({ appId, providerId: 'anthropic' });
    const cached = await service.list({ appId, providerId: 'anthropic' });

    expect(discover).toHaveBeenCalledTimes(1);
    expect(cached.discoverySource).toBe('cache');
    expect(live.models.filter((model) => model.registered)).toHaveLength(
      registered.length,
    );
    expect(live.models).toContainEqual(
      expect.objectContaining({
        providerModelId: matching.modelRoute.providerModelId,
        source: 'registered_and_live',
        availability: 'ready',
      }),
    );
    expect(live.models).toContainEqual(
      expect.objectContaining({
        providerModelId: 'claude-discovered-only',
        availability: 'available_to_register',
        registered: false,
      }),
    );
  });

  it('retains stale discovery and every saved alias when refresh fails', async () => {
    let now = 0;
    const discover = vi
      .fn<ProviderModelDiscoveryPort['discover']>()
      .mockResolvedValueOnce([
        {
          providerModelId: 'claude-stale',
          displayName: 'Claude Stale',
          deprecated: false,
          supportedWorkloads: CHAT_WORKLOADS,
        },
      ])
      .mockRejectedValueOnce(new Error('provider offline'));
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      { discover },
      registeredModels,
      () => now,
    );
    await service.list({ appId, providerId: 'anthropic' });
    now = 15 * 60_000 + 1;

    const listing = await service.list({ appId, providerId: 'anthropic' });

    expect(listing.discoverySource).toBe('cache');
    expect(listing.refreshError).toContain('Saved aliases were retained');
    expect(listing.models).toContainEqual(
      expect.objectContaining({
        providerModelId: 'claude-stale',
        availability: 'availability_unknown',
      }),
    );
    expect(listing.models.filter((model) => model.registered)).toHaveLength(
      listModelCatalogEntries().filter(
        (entry) => entry.modelRoute.id === 'anthropic',
      ).length,
    );
  });

  it('merges only the requested app catalog', async () => {
    const otherAppId = 'other-app' as AppId;
    const base = listModelCatalogEntries().find(
      (entry) => entry.modelRoute.id === 'anthropic',
    )!;
    const scopedEntry: ModelCatalogEntry = {
      ...base,
      id: 'settings:scoped-model',
      modelRoute: {
        ...base.modelRoute,
        providerModelId: 'claude-scoped-model',
      },
      displayName: 'Scoped Model',
      runnerModel: 'claude-scoped-model',
      aliases: ['scoped-model'],
      recommendedAlias: 'scoped-model',
    };
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      {
        discover: async () => [
          {
            providerModelId: 'claude-scoped-model',
            displayName: 'Scoped Model',
            deprecated: false,
            supportedWorkloads: CHAT_WORKLOADS,
          },
        ],
      },
      async (requestedAppId) => (requestedAppId === appId ? [scopedEntry] : []),
    );

    const appListing = await service.list({
      appId,
      providerId: 'anthropic',
    });
    const otherListing = await service.list({
      appId: otherAppId,
      providerId: 'anthropic',
    });

    expect(appListing.models[0]).toMatchObject({ registered: true });
    expect(otherListing.models[0]).toMatchObject({ registered: false });
  });

  it('retains the last good listing when refresh is empty', async () => {
    let now = 0;
    const discover = vi
      .fn<ProviderModelDiscoveryPort['discover']>()
      .mockResolvedValueOnce([
        {
          providerModelId: 'claude-last-good',
          displayName: 'Claude Last Good',
          deprecated: false,
          supportedWorkloads: CHAT_WORKLOADS,
        },
      ])
      .mockResolvedValueOnce([]);
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      { discover },
      registeredModels,
      () => now,
    );
    await service.list({ appId, providerId: 'anthropic' });
    now = 15 * 60_000 + 1;

    const listing = await service.list({ appId, providerId: 'anthropic' });

    expect(listing.discoverySource).toBe('cache');
    expect(listing.refreshError).toContain('empty model listing');
    expect(listing.models).toContainEqual(
      expect.objectContaining({ providerModelId: 'claude-last-good' }),
    );
  });

  it('forces one refresh per thirty seconds', async () => {
    let now = 0;
    const discover = vi.fn(async () => [
      {
        providerModelId: `claude-refresh-${now}`,
        displayName: 'Claude Refresh',
        deprecated: false,
        supportedWorkloads: CHAT_WORKLOADS,
      },
    ]);
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      { discover },
      registeredModels,
      () => now,
    );
    await service.list({ appId, providerId: 'anthropic' });
    now = 1;
    await service.list({ appId, providerId: 'anthropic', force: true });
    now = 2;
    await service.list({ appId, providerId: 'anthropic', force: true });

    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed forced-refresh warning while the retry is throttled', async () => {
    let now = 0;
    const discover = vi
      .fn<ProviderModelDiscoveryPort['discover']>()
      .mockResolvedValueOnce([
        {
          providerModelId: 'claude-last-good',
          displayName: 'Claude Last Good',
          deprecated: false,
          supportedWorkloads: CHAT_WORKLOADS,
        },
      ])
      .mockRejectedValueOnce(new Error('provider offline'));
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      { discover },
      registeredModels,
      () => now,
    );
    await service.list({ appId, providerId: 'anthropic' });
    now = 1;
    await service.list({ appId, providerId: 'anthropic', force: true });
    now = 2;

    const throttled = await service.list({
      appId,
      providerId: 'anthropic',
      force: true,
    });

    expect(discover).toHaveBeenCalledTimes(2);
    expect(throttled.refreshError).toContain('provider offline');
    expect(throttled.models).toContainEqual(
      expect.objectContaining({ availability: 'availability_unknown' }),
    );
  });

  it('throttles repeated forced refreshes after an initial outage', async () => {
    let now = 0;
    const discover = vi.fn(async () => {
      throw new Error('provider offline');
    });
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      { discover },
      registeredModels,
      () => now,
    );
    await service.list({ appId, providerId: 'anthropic', force: true });
    now = 1;

    const throttled = await service.list({
      appId,
      providerId: 'anthropic',
      force: true,
    });

    expect(discover).toHaveBeenCalledTimes(1);
    expect(throttled.discoverySource).toBe('none');
    expect(throttled.refreshError).toContain('provider offline');
  });

  it('backs off ordinary discovery reads during a provider outage', async () => {
    let now = 0;
    const discover = vi.fn(async () => {
      throw new Error('provider offline');
    });
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('anthropic') },
      { discover },
      registeredModels,
      () => now,
    );
    await service.list({ appId, providerId: 'anthropic' });
    now = 1;

    const backedOff = await service.list({
      appId,
      providerId: 'anthropic',
    });

    expect(discover).toHaveBeenCalledTimes(1);
    expect(backedOff.refreshError).toContain('provider offline');
  });

  it('evicts cached models when the provider credential becomes inactive', async () => {
    let active = true;
    const discover = vi.fn(async () => [
      {
        providerModelId: 'claude-live',
        displayName: 'Claude Live',
        deprecated: false,
        supportedWorkloads: CHAT_WORKLOADS,
      },
    ]);
    const service = new ProviderModelDiscoveryService(
      {
        getModelCredential: async () =>
          active ? credential('anthropic') : undefined,
      },
      { discover },
      registeredModels,
    );
    await service.list({ appId, providerId: 'anthropic' });
    active = false;
    await service.list({ appId, providerId: 'anthropic' });
    active = true;

    await service.list({ appId, providerId: 'anthropic' });

    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('aborts an in-flight refresh when the credential rotates', async () => {
    let fingerprint = 'fingerprint:old';
    let oldRequestAborted = false;
    let oldCalls = 0;
    let resolveOld!: (
      models: Awaited<ReturnType<ProviderModelDiscoveryPort['discover']>>,
    ) => void;
    const discover = vi.fn<ProviderModelDiscoveryPort['discover']>(
      ({ signal }) => {
        if (fingerprint !== 'fingerprint:old') {
          return Promise.resolve([
            {
              providerModelId: 'claude-current',
              displayName: 'Claude Current',
              deprecated: false,
              supportedWorkloads: CHAT_WORKLOADS,
            },
          ]);
        }
        oldCalls += 1;
        if (oldCalls > 1) {
          return Promise.resolve([
            {
              providerModelId: 'claude-reloaded',
              displayName: 'Claude Reloaded',
              deprecated: false,
              supportedWorkloads: CHAT_WORKLOADS,
            },
          ]);
        }
        return new Promise((resolve) => {
          resolveOld = resolve;
          signal?.addEventListener(
            'abort',
            () => void (oldRequestAborted = true),
            { once: true },
          );
        });
      },
    );
    const service = new ProviderModelDiscoveryService(
      {
        getModelCredential: async () => ({
          ...credential('anthropic'),
          fingerprint,
        }),
      },
      { discover },
      registeredModels,
    );
    const staleRequest = service.list({ appId, providerId: 'anthropic' });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
    fingerprint = 'fingerprint:new';

    const current = await service.list({ appId, providerId: 'anthropic' });
    resolveOld([
      {
        providerModelId: 'claude-stale',
        displayName: 'Claude Stale',
        deprecated: false,
        supportedWorkloads: CHAT_WORKLOADS,
      },
    ]);
    await staleRequest;
    fingerprint = 'fingerprint:old';
    const restored = await service.list({ appId, providerId: 'anthropic' });

    expect(oldRequestAborted).toBe(true);
    expect(discover).toHaveBeenCalledTimes(3);
    expect(current.models).toContainEqual(
      expect.objectContaining({ providerModelId: 'claude-current' }),
    );
    expect(restored.models).toContainEqual(
      expect.objectContaining({ providerModelId: 'claude-reloaded' }),
    );
  });

  it('prepares only an explicitly discovered, unregistered alias', async () => {
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('openrouter') },
      {
        discover: async () => [
          {
            providerModelId: 'vendor/new-model',
            displayName: 'New Model',
            deprecated: false,
            supportedWorkloads: CHAT_WORKLOADS,
          },
        ],
      },
      registeredModels,
    );

    await expect(
      service.prepareRegistration({
        appId,
        providerId: 'openrouter',
        providerModelId: 'vendor/new-model',
        alias: 'new-model',
      }),
    ).resolves.toMatchObject({
      alias: 'new-model',
      value: {
        provider: 'openrouter',
        provider_model_id: 'vendor/new-model',
        aliases: ['new-model'],
        recommended_alias: 'new-model',
        supported_workloads: CHAT_WORKLOADS,
      },
    });
    await expect(
      service.prepareRegistration({
        appId,
        providerId: 'openrouter',
        providerModelId: 'raw-provider-id-never-listed',
        alias: 'raw-id',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_DISCOVERED' });
  });

  it('does not register a model from a failed stale discovery result', async () => {
    let now = 0;
    const discover = vi
      .fn()
      .mockResolvedValueOnce([
        {
          providerModelId: 'vendor/stale-model',
          displayName: 'Stale Model',
          deprecated: false,
          supportedWorkloads: CHAT_WORKLOADS,
        },
      ])
      .mockRejectedValueOnce(new Error('provider offline'));
    const service = new ProviderModelDiscoveryService(
      { getModelCredential: async () => credential('openrouter') },
      { discover },
      registeredModels,
      () => now,
    );
    await service.list({ appId, providerId: 'openrouter' });
    now = 15 * 60_000 + 1;

    await expect(
      service.prepareRegistration({
        appId,
        providerId: 'openrouter',
        providerModelId: 'vendor/stale-model',
        alias: 'stale-model',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_DISCOVERED' });
  });
});

describe('provider model execution errors', () => {
  it('maps provider invalid-model errors to a stable terminal code', () => {
    const entry = listModelCatalogEntries()[0] as ModelCatalogEntry;
    expect(
      normalizeProviderModelError({
        error: `model_not_found: "${entry.modelRoute.providerModelId}" does not exist`,
        modelEntry: entry,
      }),
    ).toContain('MODEL_NOT_AVAILABLE');
    const anthropicEntry = listModelCatalogEntries().find(
      (candidate) => candidate.modelRoute.id === 'anthropic',
    )!;
    expect(
      normalizeProviderModelError({
        error: 'not_found_error: resource not found',
        modelEntry: anthropicEntry,
      }),
    ).toContain('MODEL_NOT_AVAILABLE');
    expect(
      normalizeProviderModelError({
        error: 'invalid model response from upstream parser',
        modelEntry: entry,
      }),
    ).toBe('invalid model response from upstream parser');
    expect(
      normalizeProviderModelError({
        error: `tools are not supported for model ${entry.modelRoute.providerModelId}`,
        modelEntry: entry,
      }),
    ).toBe(
      `tools are not supported for model ${entry.modelRoute.providerModelId}`,
    );
    expect(
      normalizeProviderModelError({
        error: `model_not_found: "${entry.modelRoute.providerModelId}o"`,
        modelEntry: entry,
      }),
    ).toBe(`model_not_found: "${entry.modelRoute.providerModelId}o"`);
    expect(
      normalizeProviderModelError({
        error: '429 rate limit exceeded',
        modelEntry: entry,
      }),
    ).toBe('429 rate limit exceeded');
  });
});
