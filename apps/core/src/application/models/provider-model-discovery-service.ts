import type { AppId } from '../../domain/app/app.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import type {
  DiscoveredProviderModel,
  ProviderModelDiscoveryPort,
} from '../../domain/ports/provider-model-discovery.js';
import type { ModelCatalogEntry } from '../../shared/model-catalog.js';
import {
  getModelProviderDefinition,
  type ModelCredentialPayload,
  type ModelProviderDefinition,
} from '../../shared/model-provider-registry.js';

const DISCOVERY_CACHE_MS = 15 * 60_000;
const REFRESH_RETRY_INTERVAL_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;

export type ProviderModelAvailability =
  | 'ready'
  | 'available_to_register'
  | 'configured_not_advertised'
  | 'availability_unknown';

export interface ProviderModelListing {
  providerId: string;
  providerLabel: string;
  discoverySource: 'live' | 'cache' | 'none';
  refreshedAt: string | null;
  refreshError: string | null;
  models: Array<{
    providerModelId: string;
    displayName: string;
    aliases: string[];
    registered: boolean;
    availability: ProviderModelAvailability;
    source: 'registered' | 'live' | 'registered_and_live';
    deprecated: boolean;
  }>;
}

type DiscoveryCacheEntry = {
  models: DiscoveredProviderModel[];
  refreshedAt: string;
  expiresAtMs: number;
};

export class ProviderModelDiscoveryService {
  private readonly cache = new Map<string, DiscoveryCacheEntry>();
  private readonly inFlight = new Map<
    string,
    { promise: Promise<DiscoveryCacheEntry>; controller: AbortController }
  >();
  private readonly lastForcedRefresh = new Map<string, number>();
  private readonly lastFailedRefresh = new Map<string, number>();
  private readonly lastRefreshError = new Map<string, string>();
  private readonly keys = new Set<string>();

  constructor(
    private readonly credentials: Pick<
      ModelCredentialRepository,
      'getModelCredential'
    >,
    private readonly discovery: ProviderModelDiscoveryPort,
    private readonly registeredModels: (
      appId: AppId,
    ) => Promise<readonly ModelCatalogEntry[]>,
    private readonly now: () => number = Date.now,
  ) {}

  async list(input: {
    appId: AppId;
    providerId: string;
    force?: boolean;
  }): Promise<ProviderModelListing> {
    return (await this.resolveListing(input)).listing;
  }

  private async resolveListing(input: {
    appId: AppId;
    providerId: string;
    force?: boolean;
  }): Promise<{
    listing: ProviderModelListing;
    live: readonly DiscoveredProviderModel[];
  }> {
    const provider = getModelProviderDefinition(input.providerId);
    if (!provider?.discovery) {
      throw new ProviderModelDiscoveryError(
        'MODEL_DISCOVERY_UNSUPPORTED',
        `Model discovery is not supported for provider ${input.providerId}.`,
      );
    }
    const [credential, appCatalog] = await Promise.all([
      this.credentials.getModelCredential({
        appId: input.appId,
        providerId: provider.id,
      }),
      this.registeredModels(input.appId),
    ]);
    const registered = appCatalog.filter(
      (entry) => entry.modelRoute.id === provider.id,
    );
    const prefix = `${input.appId}\0${provider.id}\0`;
    if (!credential || credential.status !== 'active') {
      this.removeSupersededCredentials(prefix);
      return {
        listing: mergeProviderModels({
          provider,
          registered,
          live: [],
          discoverySource: 'none',
          refreshedAt: null,
          refreshError: `No active ${provider.label} Model Access credential is configured.`,
        }),
        live: [],
      };
    }

    const key = `${prefix}${credential.fingerprint}`;
    this.removeSupersededCredentials(prefix, key);
    this.keys.add(key);
    this.pruneCache();
    const cached = this.cache.get(key);
    const now = this.now();
    const forcedRecently =
      input.force === true &&
      now - (this.lastForcedRefresh.get(key) ?? -Infinity) <
        REFRESH_RETRY_INTERVAL_MS;
    const failureBackoff =
      now - (this.lastFailedRefresh.get(key) ?? -Infinity) <
      REFRESH_RETRY_INTERVAL_MS;
    const refreshError = this.lastRefreshError.get(key) ?? null;
    if (
      ((forcedRecently || failureBackoff) && (cached || refreshError)) ||
      (cached && !input.force && cached.expiresAtMs > now)
    ) {
      const live = cached?.models ?? [];
      return {
        listing: mergeProviderModels({
          provider,
          registered,
          live,
          discoverySource: cached ? 'cache' : 'none',
          refreshedAt: cached?.refreshedAt ?? null,
          refreshError,
        }),
        live,
      };
    }
    if (input.force) this.lastForcedRefresh.set(key, now);

    try {
      const fresh = await this.refresh(key, provider, {
        authMode: credential.authMode,
        payload: credential.payload,
      });
      this.lastFailedRefresh.delete(key);
      this.lastRefreshError.delete(key);
      return {
        listing: mergeProviderModels({
          provider,
          registered,
          live: fresh.models,
          discoverySource: 'live',
          refreshedAt: fresh.refreshedAt,
          refreshError: null,
        }),
        live: fresh.models,
      };
    } catch (error) {
      const message = discoveryErrorMessage(provider, error);
      if (this.keys.has(key)) {
        this.lastFailedRefresh.set(key, now);
        this.lastRefreshError.set(key, message);
      }
      const live = cached?.models ?? [];
      return {
        listing: mergeProviderModels({
          provider,
          registered,
          live,
          discoverySource: cached ? 'cache' : 'none',
          refreshedAt: cached?.refreshedAt ?? null,
          refreshError: message,
        }),
        live,
      };
    }
  }

  async prepareRegistration(input: {
    appId: AppId;
    providerId: string;
    providerModelId: string;
    alias: string;
  }): Promise<{ alias: string; value: Record<string, unknown> }> {
    const { listing, live } = await this.resolveListing(input);
    const model = listing.models.find(
      (candidate) => candidate.providerModelId === input.providerModelId,
    );
    const discovered = live.find(
      (candidate) => candidate.providerModelId === input.providerModelId,
    );
    if (
      !model ||
      !discovered ||
      model.availability !== 'available_to_register'
    ) {
      throw new ProviderModelRegistrationError(
        'MODEL_NOT_DISCOVERED',
        `Model ${input.providerModelId} is not in the latest ${listing.providerLabel} discovery result.`,
      );
    }
    if (model.registered) {
      throw new ProviderModelRegistrationError(
        'MODEL_ALREADY_REGISTERED',
        `Model ${input.providerModelId} is already registered.`,
      );
    }
    const provider = getModelProviderDefinition(listing.providerId)!;
    const sourceUrl = new URL(provider.gateway.upstreamOrigin);
    sourceUrl.pathname = `${provider.gateway.upstreamPathPrefix.replace(/\/$/, '')}${provider.discovery!.path}`;
    return {
      alias: input.alias,
      value: {
        provider: provider.id,
        provider_model_id: model.providerModelId,
        display_name: model.displayName,
        aliases: [input.alias],
        recommended_alias: input.alias,
        supported_workloads: discovered.supportedWorkloads,
        source: {
          label: `${provider.label} live model discovery`,
          url: sourceUrl.toString(),
          verified_at: listing.refreshedAt ?? 'cached',
        },
      },
    };
  }

  private refresh(
    key: string,
    provider: ModelProviderDefinition,
    credential: { authMode: string; payload: ModelCredentialPayload },
  ): Promise<DiscoveryCacheEntry> {
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    let refresh: Promise<DiscoveryCacheEntry>;
    refresh = this.discovery
      .discover({
        providerId: provider.id,
        authMode: credential.authMode,
        credential: credential.payload,
        signal: controller.signal,
      })
      .then((models) => {
        if (models.length === 0) {
          throw new Error('provider returned an empty model listing');
        }
        const now = this.now();
        const entry = {
          models,
          refreshedAt: new Date(now).toISOString(),
          expiresAtMs: now + DISCOVERY_CACHE_MS,
        };
        if (this.keys.has(key)) this.cache.set(key, entry);
        return entry;
      })
      .finally(() => {
        if (this.inFlight.get(key)?.promise === refresh) {
          this.inFlight.delete(key);
        }
      });
    this.inFlight.set(key, { promise: refresh, controller });
    return refresh;
  }

  private removeSupersededCredentials(
    prefix: string,
    activeKey?: string,
  ): void {
    for (const key of this.keys) {
      if (key.startsWith(prefix) && key !== activeKey) this.deleteCacheKey(key);
    }
  }

  private pruneCache(): void {
    // ponytail: process-local cap; use a shared cache if control-plane scale requires it.
    while (this.keys.size > MAX_CACHE_ENTRIES) {
      const oldest = this.keys.values().next().value as string | undefined;
      if (!oldest) return;
      this.deleteCacheKey(oldest);
    }
  }

  private deleteCacheKey(key: string): void {
    this.cache.delete(key);
    this.keys.delete(key);
    this.lastForcedRefresh.delete(key);
    this.lastFailedRefresh.delete(key);
    this.lastRefreshError.delete(key);
    this.inFlight.get(key)?.controller.abort();
    this.inFlight.delete(key);
  }
}

export class ProviderModelDiscoveryError extends Error {
  constructor(
    readonly code: 'MODEL_DISCOVERY_UNSUPPORTED',
    message: string,
  ) {
    super(message);
  }
}

export class ProviderModelRegistrationError extends Error {
  constructor(
    readonly code: 'MODEL_NOT_DISCOVERED' | 'MODEL_ALREADY_REGISTERED',
    message: string,
  ) {
    super(message);
  }
}

function discoveryErrorMessage(
  provider: ModelProviderDefinition,
  error: unknown,
): string {
  const reason = error instanceof Error ? error.message : 'request failed';
  return `${provider.label} model discovery failed: ${reason}. Saved aliases were retained.`;
}

function mergeProviderModels(input: {
  provider: ModelProviderDefinition;
  registered: readonly ModelCatalogEntry[];
  live: readonly DiscoveredProviderModel[];
  discoverySource: ProviderModelListing['discoverySource'];
  refreshedAt: string | null;
  refreshError: string | null;
}): ProviderModelListing {
  const rows = new Map<string, ProviderModelListing['models'][number]>();
  const liveById = new Map(
    input.live.map((model) => [model.providerModelId, model]),
  );
  for (const entry of input.registered) {
    const id = entry.modelRoute.providerModelId;
    const live = liveById.get(id);
    const existing = rows.get(id);
    rows.set(id, {
      providerModelId: id,
      displayName: entry.displayName,
      aliases: [
        ...new Set([...(existing?.aliases ?? []), ...entry.aliases]),
      ].sort(),
      registered: true,
      availability: input.refreshError
        ? 'availability_unknown'
        : live
          ? 'ready'
          : 'configured_not_advertised',
      source: live ? 'registered_and_live' : 'registered',
      deprecated: live?.deprecated ?? false,
    });
  }
  for (const live of input.live) {
    if (rows.has(live.providerModelId)) continue;
    rows.set(live.providerModelId, {
      ...live,
      aliases: [],
      registered: false,
      availability: input.refreshError
        ? 'availability_unknown'
        : 'available_to_register',
      source: 'live',
    });
  }
  return {
    providerId: input.provider.id,
    providerLabel: input.provider.label,
    discoverySource: input.discoverySource,
    refreshedAt: input.refreshedAt,
    refreshError: input.refreshError,
    models: [...rows.values()].sort(
      (a, b) =>
        Number(b.registered) - Number(a.registered) ||
        a.displayName.localeCompare(b.displayName) ||
        a.providerModelId.localeCompare(b.providerModelId),
    ),
  };
}
