import { DEEPAGENTS_ENGINE } from '../../../shared/agent-engine.js';
import {
  resolveModelCredentialMode,
  type ModelCredentialPayload,
  type ModelGatewayResolvedUpstream,
  type ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';
import { getAwsDefaultChainCredentials } from './gantry-model-gateway-auth-aws-default.js';
import { signAwsSigV4Request } from './gantry-model-gateway-auth-sigv4.js';
import {
  getVertexAdcBearerToken,
  getVertexServiceAccountBearerToken,
} from './gantry-model-gateway-auth-vertex.js';
import { GatewayBadRequestError } from './gantry-model-gateway-http.js';
import { resolveModelCredentialSecretRef } from './gantry-model-gateway-secret-ref.js';

export function resolveGatewayUpstream(
  provider: ModelProviderDefinition,
  authMode: string,
  payload: ModelCredentialPayload,
): ModelGatewayResolvedUpstream {
  try {
    return (
      provider.gateway.upstreamResolver?.({ authMode, payload }) ?? {
        origin: provider.gateway.upstreamOrigin,
        pathPrefix: provider.gateway.upstreamPathPrefix,
      }
    );
  } catch (error) {
    throw new GatewayBadRequestError(
      error instanceof Error
        ? error.message
        : 'Model gateway upstream could not be resolved.',
    );
  }
}

export function assertProviderPathAllowed(
  provider: ModelProviderDefinition,
  upstreamPathname: string,
  method = 'POST',
  upstreamPathPrefix = provider.gateway.upstreamPathPrefix,
): void {
  const providerPath = stripUpstreamPathPrefix(
    upstreamPathname,
    upstreamPathPrefix,
  );
  const allowed =
    method === 'GET'
      ? isAllowedGatewayReadPath(provider, providerPath)
      : method === 'POST' &&
        allowedGatewayPostPaths(provider).has(providerPath);
  if (!allowed) {
    throw new GatewayBadRequestError(
      `Model gateway path is not allowed for ${provider.id}.`,
    );
  }
}

export function isGatewayMethodAllowed(
  method: string,
  gatewayPathname: string,
): boolean {
  if (method === 'POST') return true;
  if (method !== 'GET') return false;
  return (
    /^\/openai\/v1\/(?:batches|files)(?:\/|$)/.test(gatewayPathname) ||
    /^\/anthropic\/v1\/messages\/batches(?:\/|$)/.test(gatewayPathname)
  );
}

export function isProviderBatchPath(
  provider: ModelProviderDefinition,
  providerPath: string,
): boolean {
  if (provider.id === 'openai') {
    return /^\/v1\/(?:batches|files)(?:\/|$)/.test(providerPath);
  }
  return (
    provider.id === 'anthropic' &&
    /^\/v1\/messages\/batches(?:\/|$)/.test(providerPath)
  );
}

export function isProviderBatchSubmissionPath(
  provider: ModelProviderDefinition,
  providerPath: string,
  method: string,
): boolean {
  if (method !== 'POST') return false;
  return provider.id === 'openai'
    ? providerPath === '/v1/batches'
    : provider.id === 'anthropic' && providerPath === '/v1/messages/batches';
}

export function isProviderBatchResultPath(
  provider: ModelProviderDefinition,
  providerPath: string,
): boolean {
  if (provider.id === 'openai') {
    return /^\/v1\/files\/[^/]+\/content$/.test(providerPath);
  }
  return (
    provider.id === 'anthropic' &&
    /^\/v1\/messages\/batches\/[^/]+\/results$/.test(providerPath)
  );
}

export function openAiBatchIdFromPath(
  providerPath: string,
): string | undefined {
  return exactDecodedPathId(providerPath, /^\/v1\/batches\/([^/]+)$/);
}

export function openAiFileContentIdFromPath(
  providerPath: string,
): string | undefined {
  return exactDecodedPathId(providerPath, /^\/v1\/files\/([^/]+)\/content$/);
}

export async function injectProviderAuth(input: {
  headers: Record<string, string>;
  provider: ModelProviderDefinition;
  authMode: string;
  payload: ModelCredentialPayload;
  method: string;
  upstreamUrl: URL;
  body: Buffer;
}): Promise<void> {
  const { headers, provider, authMode, payload } = input;
  const auth = resolveModelCredentialMode(provider, authMode).gatewayAuth;
  if (
    auth.strategy !== 'bearer' &&
    auth.strategy !== 'header' &&
    auth.strategy !== 'claude_code_oauth' &&
    auth.strategy !== 'aws_bedrock_api_key' &&
    auth.strategy !== 'aws_bedrock_api_key_ref' &&
    auth.strategy !== 'aws_sigv4' &&
    auth.strategy !== 'aws_sdk_default_chain' &&
    auth.strategy !== 'vertex_service_account' &&
    auth.strategy !== 'vertex_service_account_ref' &&
    auth.strategy !== 'google_adc'
  ) {
    throw new Error(
      `Model gateway auth strategy ${auth.strategy} is not implemented for ${provider.id} ${authMode}.`,
    );
  }
  if (auth.strategy === 'aws_sdk_default_chain') {
    signAwsSigV4Request({
      method: input.method,
      url: input.upstreamUrl,
      headers,
      body: input.body,
      region: requirePayloadField(payload, provider.id, 'region'),
      service: 'bedrock',
      credentials: await getAwsDefaultChainCredentials({
        profile: payload.profile,
      }),
    });
    return;
  }
  if (auth.strategy === 'aws_sigv4') {
    signAwsSigV4Request({
      method: input.method,
      url: input.upstreamUrl,
      headers,
      body: input.body,
      region: requirePayloadField(payload, provider.id, 'region'),
      service: 'bedrock',
      credentials: {
        accessKeyId: requirePayloadField(payload, provider.id, 'accessKeyId'),
        secretAccessKey: requirePayloadField(
          payload,
          provider.id,
          'secretAccessKey',
        ),
        ...(payload.sessionToken ? { sessionToken: payload.sessionToken } : {}),
      },
    });
    return;
  }
  if (auth.strategy === 'google_adc') {
    headers.authorization = `Bearer ${await getVertexAdcBearerToken()}`;
    return;
  }
  if (auth.strategy === 'vertex_service_account') {
    if (!auth.field) {
      throw new Error(
        `Model gateway auth strategy ${auth.strategy} for ${provider.id} ${authMode} is missing a credential field.`,
      );
    }
    const token = await getVertexServiceAccountBearerToken({
      serviceAccountJson: requirePayloadField(payload, provider.id, auth.field),
      expectedProjectId: requirePayloadField(payload, provider.id, 'projectId'),
    });
    headers.authorization = `Bearer ${token}`;
    return;
  }
  if (auth.strategy === 'vertex_service_account_ref') {
    if (!auth.field) {
      throw new Error(
        `Model gateway auth strategy ${auth.strategy} for ${provider.id} ${authMode} is missing a credential field.`,
      );
    }
    const serviceAccountJson = await resolveModelCredentialSecretRef(
      requirePayloadField(payload, provider.id, auth.field),
    );
    const token = await getVertexServiceAccountBearerToken({
      serviceAccountJson,
      expectedProjectId: requirePayloadField(payload, provider.id, 'projectId'),
    });
    headers.authorization = `Bearer ${token}`;
    return;
  }
  if (!auth.field) {
    throw new Error(
      `Model gateway auth strategy ${auth.strategy} for ${provider.id} ${authMode} is missing a credential field.`,
    );
  }
  const value = requirePayloadField(payload, provider.id, auth.field);
  if (
    auth.strategy === 'bearer' ||
    auth.strategy === 'claude_code_oauth' ||
    auth.strategy === 'aws_bedrock_api_key'
  ) {
    headers.authorization = `Bearer ${value}`;
    return;
  }
  if (auth.strategy === 'aws_bedrock_api_key_ref') {
    headers.authorization = `Bearer ${await resolveModelCredentialSecretRef(
      value,
    )}`;
    return;
  }
  headers[auth.headerName ?? auth.field] = value;
}

function allowedGatewayPostPaths(
  provider: ModelProviderDefinition,
): Set<string> {
  if (provider.id === 'openai') {
    return new Set([
      '/v1/embeddings',
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/files',
      '/v1/batches',
    ]);
  }
  if (provider.executionRoute.engine === DEEPAGENTS_ENGINE) {
    return new Set(['/chat/completions', '/v1/chat/completions']);
  }
  const paths = new Set(['/v1/messages', '/v1/messages/count_tokens']);
  if (provider.id === 'anthropic') paths.add('/v1/messages/batches');
  return paths;
}

function isAllowedGatewayReadPath(
  provider: ModelProviderDefinition,
  providerPath: string,
): boolean {
  if (provider.id === 'openai') {
    return (
      /^\/v1\/batches(?:\/[^/]+)?$/.test(providerPath) ||
      /^\/v1\/files\/[^/]+\/content$/.test(providerPath)
    );
  }
  if (provider.id === 'anthropic') {
    return /^\/v1\/messages\/batches(?:\/[^/]+(?:\/results)?)?$/.test(
      providerPath,
    );
  }
  return false;
}

function stripUpstreamPathPrefix(pathname: string, prefix: string): string {
  const normalizedPrefix = prefix.trim().replace(/\/+$/, '');
  if (!normalizedPrefix) return pathname;
  if (pathname === normalizedPrefix) return '/';
  if (pathname.startsWith(`${normalizedPrefix}/`)) {
    return pathname.slice(normalizedPrefix.length);
  }
  return pathname;
}

function exactDecodedPathId(
  providerPath: string,
  pattern: RegExp,
): string | undefined {
  const encoded = pattern.exec(providerPath)?.[1];
  if (!encoded) return undefined;
  /* eslint-disable no-catch-all/no-catch-all -- malformed encoded ids are rejected */
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded && !decoded.includes('/') ? decoded : undefined;
  } catch {
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function requirePayloadField(
  payload: ModelCredentialPayload,
  providerId: string,
  field: string,
): string {
  const value = payload[field];
  if (!value) {
    throw new Error(
      `Model credential payload for ${providerId} is missing ${field}.`,
    );
  }
  return value;
}
