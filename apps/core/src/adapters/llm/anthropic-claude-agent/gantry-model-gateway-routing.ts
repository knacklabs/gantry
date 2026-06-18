import { DEEPAGENTS_ENGINE } from '../../../shared/agent-engine.js';
import {
  resolveModelCredentialMode,
  type ModelCredentialPayload,
  type ModelGatewayResolvedUpstream,
  type ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';
import { signAwsSigV4Request } from './gantry-model-gateway-auth-sigv4.js';
import { getVertexServiceAccountBearerToken } from './gantry-model-gateway-auth-vertex.js';
import { GatewayBadRequestError } from './gantry-model-gateway-http.js';

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
  upstreamPathPrefix = provider.gateway.upstreamPathPrefix,
): void {
  const providerPath = stripUpstreamPathPrefix(
    upstreamPathname,
    upstreamPathPrefix,
  );
  const allowed = allowedGatewayPaths(provider).has(providerPath);
  if (!allowed) {
    throw new GatewayBadRequestError(
      `Model gateway path is not allowed for ${provider.id}.`,
    );
  }
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
    auth.strategy !== 'aws_sigv4' &&
    auth.strategy !== 'vertex_service_account'
  ) {
    throw new Error(
      `Model gateway auth strategy ${auth.strategy} is not implemented for ${provider.id} ${authMode}.`,
    );
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
  headers[auth.headerName ?? auth.field] = value;
}

function allowedGatewayPaths(provider: ModelProviderDefinition): Set<string> {
  if (provider.id === 'openai') {
    return new Set(['/v1/embeddings', '/v1/chat/completions', '/v1/responses']);
  }
  if (provider.executionRoute.engine === DEEPAGENTS_ENGINE) {
    return new Set(['/chat/completions', '/v1/chat/completions']);
  }
  return new Set(['/v1/messages', '/v1/messages/count_tokens']);
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
