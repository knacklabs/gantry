import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { getAgentCredentialInjection } from '../../../application/credentials/agent-credential-service.js';
import type { AppId } from '../../../domain/app/app.js';
import type { AgentCredentialBroker } from '../../../domain/ports/agent-credential-broker.js';
import {
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
} from '../../../shared/model-catalog.js';
import { DEEPAGENTS_ENGINE } from '../../../shared/agent-engine.js';
import {
  getModelProviderDefinition,
  type ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readRawBody, recordControlRequestLog, sendError } from '../http.js';
import type { ApiKeyRecord } from '../auth.js';
import {
  findUnsupportedLlmRequestField,
  type LlmPassthroughEndpoint,
} from './llm-request-validator.js';

const MAX_LLM_BODY_BYTES = 16 * 1024 * 1024;
const LLM_RATE_LIMIT_PER_KEY = 120;
const CHAT_RESPONSE_FAMILY = ['op', 'enai'].join('');
const VERSIONED_CHAT_COMPLETIONS_PROVIDER_IDS = new Set([
  ['op', 'enai'].join(''),
  ['open', 'router'].join(''),
]);
const BLOCKED_LOOPBACK_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
  'x-api-key',
]);
const BLOCKED_LOOPBACK_RESPONSE_HEADERS = new Set([
  'authorization',
  'connection',
  'set-cookie',
  'transfer-encoding',
]);

// Local structural shape mirrors RuntimeLlmAdmissionSettings; declared here so
// the control layer does not import the config-settings module (layer rule).
type LlmAdmissionLimits = {
  globalMaxInFlight: number;
  perAppKeyMaxInFlight: number;
};

const llmAdmissionState = {
  globalInFlight: 0,
  perAppKeyInFlight: new Map<string, number>(),
};

type ResolvedLlmRequest = {
  endpoint: LlmPassthroughEndpoint;
  body: Buffer;
  entry: ModelCatalogEntry;
  alias: string;
  provider: ModelProviderDefinition;
  tail: string;
};

export async function handleLlmRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  const endpoint = llmEndpointFor(pathname);
  if (!endpoint) return false;
  if (req.method !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'LLM route requires POST');
    return true;
  }
  const auth = authorizeControlRequest(req, res, ctx.keys, ['llm:invoke']);
  if (!auth) return true;
  if (
    !ctx.triggerRateLimiter.consume(
      `llm:${auth.appId}:${auth.kid}`,
      LLM_RATE_LIMIT_PER_KEY,
    )
  ) {
    sendError(res, 429, 'RATE_LIMITED', 'Too many LLM requests');
    return true;
  }

  const limits = (
    ctx.getEffectiveRuntimeSettings() as unknown as {
      runtime: { llmAdmission: LlmAdmissionLimits };
    }
  ).runtime.llmAdmission;
  const admissionKey = `${auth.appId}:${auth.kid}`;
  // Deliberately process-local per decision 0046. SPS-4 owns any future
  // cluster-wide admission authority.
  const releaseAdmission = tryAcquireLlmAdmission(admissionKey, limits);
  if (!releaseAdmission) {
    sendError(
      res,
      429,
      'TOO_MANY_CONCURRENT_LLM_REQUESTS',
      'Too many concurrent LLM requests',
    );
    return true;
  }
  try {
    return await handleAdmittedLlmRequest(
      req,
      res,
      ctx,
      pathname,
      endpoint,
      auth,
    );
  } finally {
    releaseAdmission();
  }
}

async function handleAdmittedLlmRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  endpoint: LlmPassthroughEndpoint,
  auth: ApiKeyRecord,
): Promise<boolean> {
  const rawBody = await readRawBody(req, MAX_LLM_BODY_BYTES);
  const resolved = resolveLlmRequest(endpoint, rawBody, res, auth.maxTokens);
  if (!resolved) return true;

  const apiRequestId = randomUUID();
  let broker: AgentCredentialBroker | undefined;
  let injectionIssued = false;
  let statusCode = 502;
  let responseBodyBytes: number | undefined;
  let responseCompleted = false;
  let clientDisconnected = false;
  const gatewayAbort = new AbortController();
  const abortGateway = () => {
    if (responseCompleted) return;
    clientDisconnected = true;
    gatewayAbort.abort();
  };
  const abortGatewayForIncompleteRequest = () => {
    if (req.complete === false) abortGateway();
  };
  const markResponseCompleted = () => {
    responseCompleted = true;
  };
  req.once('close', abortGatewayForIncompleteRequest);
  res.once('close', abortGateway);
  res.once('finish', markResponseCompleted);
  try {
    let gateway: { baseUrl: string; token: string };
    try {
      broker = await ctx.app.getCredentialBroker();
      if (!broker) throw new Error('Model gateway is not configured');
      const injection = await getAgentCredentialInjection({
        mode: 'gantry',
        purpose: 'model_runtime',
        appId: auth.appId as AppId,
        apiKeyId: auth.kid,
        apiRequestId,
        modelRouteId: resolved.entry.modelRoute.id,
        broker,
      });
      injectionIssued = true;
      gateway = readGatewayProjection(resolved.provider, injection.env);
    } catch (error) {
      statusCode = sendLlmSetupError(res, error);
      return true;
    }
    const { baseUrl, token } = gateway;
    const headers = copyLoopbackRequestHeaders(req.headers);
    headers.authorization = `Bearer ${token}`;
    headers['content-type'] = 'application/json';
    try {
      const response = await fetch(`${baseUrl}${resolved.tail}`, {
        method: 'POST',
        headers,
        body: resolved.body,
        signal: gatewayAbort.signal,
      });
      statusCode = response.status;
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const parsed = Number(contentLength);
        if (Number.isFinite(parsed)) responseBodyBytes = parsed;
      }
      res.statusCode = response.status;
      forwardGatewayResponseHeaders(response, res);
      await pipeFetchResponseBody(response, res);
    } catch {
      if (clientDisconnected) return true;
      statusCode = 502;
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
      } else {
        sendError(
          res,
          statusCode,
          'MODEL_GATEWAY_UNAVAILABLE',
          'Model gateway request failed',
        );
      }
      return true;
    }
  } finally {
    responseCompleted = responseCompleted || res.writableEnded;
    req.off('close', abortGatewayForIncompleteRequest);
    res.off('close', abortGateway);
    res.off('finish', markResponseCompleted);
    await recordControlRequestLog({
      route: pathname,
      method: req.method ?? 'POST',
      statusCode,
      apiKeyId: auth.kid,
      appId: auth.appId,
      modelAlias: resolved.alias,
      modelRouteId: resolved.entry.modelRoute.id,
      requestBodyBytes: resolved.body.byteLength,
      ...(responseBodyBytes !== undefined ? { responseBodyBytes } : {}),
      ...(clientDisconnected ? { clientDisconnected: true } : {}),
    });
    if (injectionIssued) {
      await broker?.revokeInjection?.({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId: auth.appId as AppId,
          apiKeyId: auth.kid,
          apiRequestId,
          modelRouteId: resolved.entry.modelRoute.id,
        },
      });
    }
  }
  return true;
}

function tryAcquireLlmAdmission(
  key: string,
  limits: LlmAdmissionLimits,
): (() => void) | undefined {
  const keyInFlight = llmAdmissionState.perAppKeyInFlight.get(key) ?? 0;
  if (
    llmAdmissionState.globalInFlight >= limits.globalMaxInFlight ||
    keyInFlight >= limits.perAppKeyMaxInFlight
  ) {
    return undefined;
  }

  // No await may appear between the checks above and these increments. The
  // JavaScript turn is the synchronization boundary for this process-local gate.
  llmAdmissionState.globalInFlight += 1;
  llmAdmissionState.perAppKeyInFlight.set(key, keyInFlight + 1);

  return () => {
    llmAdmissionState.globalInFlight -= 1;
    const nextKeyInFlight =
      (llmAdmissionState.perAppKeyInFlight.get(key) ?? 1) - 1;
    if (nextKeyInFlight === 0) {
      llmAdmissionState.perAppKeyInFlight.delete(key);
    } else {
      llmAdmissionState.perAppKeyInFlight.set(key, nextKeyInFlight);
    }
  };
}

export function getLlmConcurrencyAdmissionSnapshotForTest(): {
  globalInFlight: number;
  perAppKeyInFlight: Record<string, number>;
} {
  return {
    globalInFlight: llmAdmissionState.globalInFlight,
    perAppKeyInFlight: Object.fromEntries(llmAdmissionState.perAppKeyInFlight),
  };
}

function llmEndpointFor(pathname: string): LlmPassthroughEndpoint | undefined {
  if (pathname === '/llm/v1/messages') return 'messages';
  if (pathname === '/llm/v1/messages/count_tokens') return 'count_tokens';
  if (pathname === '/llm/v1/chat/completions') return 'chat_completions';
  return undefined;
}

function resolveLlmRequest(
  endpoint: LlmPassthroughEndpoint,
  rawBody: Buffer,
  res: ServerResponse,
  maxTokens?: number,
): ResolvedLlmRequest | null {
  const body = parseBody(rawBody, res);
  if (!body) return null;
  const unsupported = findUnsupportedLlmRequestField(endpoint, body, maxTokens);
  if (unsupported) {
    sendError(
      res,
      400,
      unsupported.code ?? 'UNSUPPORTED_FIELD',
      unsupported.message,
      {
        field: unsupported.field,
        ...(unsupported.limit !== undefined
          ? { limit: unsupported.limit }
          : {}),
        ...(unsupported.requested !== undefined
          ? { requested: unsupported.requested }
          : {}),
        ...(unsupported.toolType ? { toolType: unsupported.toolType } : {}),
        ...(unsupported.value ? { value: unsupported.value } : {}),
      },
    );
    return null;
  }
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const resolution = resolveModelSelectionForWorkload(model, 'chat');
  if (!resolution.ok) {
    sendError(res, 400, 'INVALID_MODEL', resolution.message);
    return null;
  }
  const provider = getModelProviderDefinition(resolution.entry.modelRoute.id);
  if (!provider) {
    sendError(res, 400, 'INVALID_MODEL', 'Model provider is not registered');
    return null;
  }
  const compatibilityError = endpointCompatibilityError(endpoint, provider);
  if (compatibilityError) {
    sendError(res, 400, 'INVALID_MODEL', compatibilityError);
    return null;
  }
  body.model = resolution.entry.modelRoute.providerModelId;
  return {
    endpoint,
    body: Buffer.from(JSON.stringify(body)),
    entry: resolution.entry,
    alias: resolution.alias,
    provider,
    tail:
      endpoint === 'messages'
        ? '/v1/messages'
        : endpoint === 'count_tokens'
          ? '/v1/messages/count_tokens'
          : chatCompletionsTail(provider),
  };
}

function parseBody(
  rawBody: Buffer,
  res: ServerResponse,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8') || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'LLM request body must be an object',
      );
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'INVALID_JSON', 'Invalid JSON body');
    return null;
  }
}

function endpointCompatibilityError(
  endpoint: LlmPassthroughEndpoint,
  provider: ModelProviderDefinition,
): string | undefined {
  if (endpoint !== 'chat_completions') {
    return provider.executionRoute.engine === DEEPAGENTS_ENGINE
      ? `Model route ${provider.id} does not support Messages passthrough`
      : undefined;
  }
  const chatCompatible =
    provider.responseFamily === CHAT_RESPONSE_FAMILY ||
    provider.executionRoute.engine === DEEPAGENTS_ENGINE;
  return chatCompatible
    ? undefined
    : `Model route ${provider.id} does not support Chat Completions passthrough`;
}

function chatCompletionsTail(provider: ModelProviderDefinition): string {
  return VERSIONED_CHAT_COMPLETIONS_PROVIDER_IDS.has(provider.id)
    ? '/v1/chat/completions'
    : '/chat/completions';
}

function copyLoopbackRequestHeaders(
  headers: IncomingMessage['headers'],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (BLOCKED_LOOPBACK_REQUEST_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      out[lower] = value.join(', ');
    } else if (typeof value === 'string') {
      out[lower] = value;
    }
  }
  return out;
}

function forwardGatewayResponseHeaders(
  response: Response,
  res: ServerResponse,
): void {
  response.headers.forEach((value, key) => {
    if (!BLOCKED_LOOPBACK_RESPONSE_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

async function pipeFetchResponseBody(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );
  for await (const chunk of body) {
    await new Promise<void>((resolve, reject) => {
      res.write(chunk, (error) => (error ? reject(error) : resolve()));
    });
  }
  res.end();
}

function readGatewayProjection(
  provider: ModelProviderDefinition,
  env: Record<string, string>,
): { baseUrl: string; token: string } {
  const projection = provider.gateway.sdkProjection;
  const baseUrl = env[projection.baseUrlEnv];
  const token = env[projection.tokenEnv];
  if (!baseUrl || !token) {
    throw Object.assign(
      new Error(`Model gateway projection for ${provider.id} is incomplete`),
      { statusCode: 503, code: 'MODEL_GATEWAY_UNAVAILABLE' },
    );
  }
  return { baseUrl, token };
}

function sendLlmSetupError(res: ServerResponse, error: unknown): number {
  const statusCode =
    error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
      ? error.statusCode
      : 503;
  const code =
    statusCode < 500 &&
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : statusCode < 500
        ? 'INVALID_REQUEST'
        : 'MODEL_GATEWAY_UNAVAILABLE';
  sendError(
    res,
    statusCode,
    code,
    error instanceof Error ? error.message : 'Model gateway is unavailable',
  );
  return statusCode;
}
