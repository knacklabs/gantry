import type {
  DiscoveredProviderModel,
  ProviderModelDiscoveryPort,
} from '../../domain/ports/provider-model-discovery.js';
import {
  getModelProviderDefinition,
  type ModelCredentialPayload,
  type ModelProviderDefinition,
} from '../../shared/model-provider-registry.js';
import {
  injectProviderAuth,
  resolveGatewayUpstream,
} from './anthropic-claude-agent/gantry-model-gateway-routing.js';

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_MODELS = 5_000;

export class LiveProviderModelDiscoveryAdapter implements ProviderModelDiscoveryPort {
  constructor(private readonly fetchProvider: typeof fetch = fetch) {}

  async discover(input: {
    providerId: string;
    authMode: string;
    credential: ModelCredentialPayload;
    signal?: AbortSignal;
  }): Promise<DiscoveredProviderModel[]> {
    const provider = getModelProviderDefinition(input.providerId);
    if (!provider?.discovery) {
      throw new Error(
        `provider ${input.providerId} does not support discovery`,
      );
    }
    const discovered = new Map<string, DiscoveredProviderModel>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = discoveryUrl(
        provider,
        input.authMode,
        input.credential,
        cursor,
      );
      const headers: Record<string, string> = { accept: 'application/json' };
      if (provider.discovery.cursorParameter === 'after_id') {
        headers['anthropic-version'] = '2023-06-01';
      }
      await injectProviderAuth({
        headers,
        provider,
        authMode: input.authMode,
        payload: input.credential,
        method: 'GET',
        upstreamUrl: url,
        body: Buffer.alloc(0),
      });
      const response = await this.fetchProvider(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)])
          : AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`provider returned HTTP ${response.status}`);
      }
      const parsed = parseDiscoveryPage(
        provider,
        await readBoundedJson(response),
      );
      for (const model of parsed.models) {
        if (!discovered.has(model.providerModelId)) {
          discovered.set(model.providerModelId, model);
        }
        if (discovered.size > MAX_MODELS) {
          throw new Error(`provider returned more than ${MAX_MODELS} models`);
        }
      }
      if (!parsed.hasMore) return [...discovered.values()];
      cursor = parsed.lastId;
      if (!cursor) throw new Error('provider pagination cursor is missing');
    }
    throw new Error(`provider returned more than ${MAX_PAGES} pages`);
  }
}

function discoveryUrl(
  provider: ModelProviderDefinition,
  authMode: string,
  credential: ModelCredentialPayload,
  cursor?: string,
): URL {
  const upstream = resolveGatewayUpstream(provider, authMode, credential);
  const url = new URL(upstream.origin);
  url.pathname = `${upstream.pathPrefix.replace(/\/$/, '')}${provider.discovery!.path}`;
  url.searchParams.set('limit', '100');
  if (cursor) {
    url.searchParams.set(
      provider.discovery!.cursorParameter ?? 'after',
      cursor,
    );
  }
  return url;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    throw new Error('provider response exceeds the 4 MiB limit');
  }
  if (!response.body) throw new Error('provider response body is missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new Error('provider response exceeds the 4 MiB limit');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(joined),
    ) as unknown;
  } catch {
    throw new Error('provider returned malformed JSON');
  }
}

function parseDiscoveryPage(
  provider: ModelProviderDefinition,
  payload: unknown,
): { models: DiscoveredProviderModel[]; hasMore: boolean; lastId?: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('provider returned a malformed model listing');
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.data)) {
    throw new Error('provider returned a malformed model listing');
  }
  const models = record.data.map(parseDiscoveredModel);
  const hasMore = record.has_more === true || record.hasMore === true;
  const lastId = stringValue(record.last_id) ?? models.at(-1)?.providerModelId;
  if (
    provider.discovery?.cursorParameter === 'after_id' &&
    record.has_more !== undefined &&
    typeof record.has_more !== 'boolean'
  ) {
    throw new Error('provider returned malformed pagination metadata');
  }
  return { models, hasMore, ...(lastId ? { lastId } : {}) };
}

function parseDiscoveredModel(item: unknown): DiscoveredProviderModel {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('provider returned a malformed model entry');
  }
  const record = item as Record<string, unknown>;
  const id = stringValue(record.id);
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error('provider returned a malformed model id');
  }
  const displayName =
    stringValue(record.display_name) ?? stringValue(record.name) ?? id;
  if (displayName.length > 512) {
    throw new Error('provider returned a malformed model display name');
  }
  return {
    providerModelId: id,
    displayName,
    deprecated:
      record.deprecated === true ||
      record.status === 'deprecated' ||
      record.lifecycle_status === 'deprecated',
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
