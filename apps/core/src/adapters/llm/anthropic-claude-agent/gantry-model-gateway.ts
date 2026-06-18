import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import type { AppId } from '../../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../../domain/events/runtime-event-types.js';
import type { AgentCredentialBroker } from '../../../domain/ports/agent-credential-broker.js';
import type { ModelCredentialRepository } from '../../../domain/ports/repositories.js';
import type {
  AgentCredentialBrokerInput,
  AgentCredentialBrokerCapabilities,
} from '../../../domain/ports/agent-credential-broker.js';
import type {
  AgentCredentialInjection,
  CredentialBrokerHealth,
} from '../../../domain/models/credentials.js';
import type { ModelCredentialProvider } from '../../../domain/model-credentials/model-credentials.js';
import {
  applyRateCap,
  GatewayRateLimiter,
  type GatewayProviderRateLimits,
} from './gantry-model-gateway-rate-limit.js';
import {
  getModelProviderByGatewayPath,
  getModelProviderDefinition,
  getDefaultModelRouteProvider,
  listExecutableModelProviders,
  normalizeModelProviderId,
  resolveModelCredentialMode,
  type ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  assertProviderPathAllowed,
  injectProviderAuth,
  resolveGatewayUpstream,
} from './gantry-model-gateway-routing.js';
import {
  ALLOWED_GATEWAY_METHODS,
  DEFAULT_LOOPBACK_HOST,
  GatewayBadRequestError,
  GatewayRequestBodyTooLargeError,
  assertRawGatewayPathIsConfined,
  buildConfinedUpstreamUrl,
  constantTimeEquals,
  hostForUrl,
  normalizeGatewayBindHost,
  pipeUpstreamBody,
  readBearerToken,
  readRequestBody,
  sanitizeProxyHeaders,
  sendGatewayJson,
  shouldForwardGatewayResponseHeader,
} from './gantry-model-gateway-http.js';

const TOKEN_PREFIX = 'gtw_';
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TOKEN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

interface GatewayTokenRecord {
  token: string;
  appId: AppId;
  providerId: ModelCredentialProvider;
  authMode: string;
  schemaVersion: number;
  credentialFingerprint: string;
  createdAtMs: number;
  expiresAtMs: number;
  agentId?: RuntimeEventPublishInput['agentId'];
  runId?: RuntimeEventPublishInput['runId'];
  jobId?: RuntimeEventPublishInput['jobId'];
  conversationId?: RuntimeEventPublishInput['conversationId'];
  threadId?: RuntimeEventPublishInput['threadId'];
}

export class GantryModelGatewayBroker implements AgentCredentialBroker {
  private readonly credentialService: ModelCredentialService;
  private server?: http.Server;
  private listenPromise?: Promise<void>;
  private port = 0;
  private readonly tokens = new Map<string, GatewayTokenRecord>();
  private readonly bindHost: string;
  private readonly tokenTtlMs: number;
  private readonly tokenSweepIntervalMs: number;
  private readonly maxTokens: number;
  private readonly requestBodyLimitBytes: number;
  private readonly upstreamTimeoutMs: number;
  private tokenSweepTimer?: NodeJS.Timeout;
  private readonly audit?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  // In-memory per-(app, provider) sliding-window rate limiter. The settings
  // getter is read live so a reload applies without rebuilding the broker.
  private readonly rateLimiter: GatewayRateLimiter;

  constructor(
    private readonly credentials: ModelCredentialRepository,
    options: {
      bindHost?: string;
      tokenTtlMs?: number;
      tokenSweepIntervalMs?: number;
      maxTokens?: number;
      requestBodyLimitBytes?: number;
      upstreamTimeoutMs?: number;
      audit?: (event: RuntimeEventPublishInput) => Promise<unknown> | unknown;
      limits?: () => GatewayProviderRateLimits;
    } = {},
  ) {
    this.credentialService = new ModelCredentialService(credentials);
    this.bindHost = normalizeGatewayBindHost(
      options.bindHost ?? DEFAULT_LOOPBACK_HOST,
    );
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.tokenSweepIntervalMs =
      options.tokenSweepIntervalMs ?? DEFAULT_TOKEN_SWEEP_INTERVAL_MS;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.requestBodyLimitBytes =
      options.requestBodyLimitBytes ?? DEFAULT_REQUEST_BODY_LIMIT_BYTES;
    this.upstreamTimeoutMs =
      options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.audit = options.audit;
    this.rateLimiter = new GatewayRateLimiter(options.limits);
  }

  async getInjection(
    input: AgentCredentialBrokerInput,
  ): Promise<AgentCredentialInjection> {
    const provider = gatewayProviderFor(
      input.binding.modelCredentialProviderId ??
        input.binding.modelRouteId ??
        defaultGatewayProviderId(),
    );
    const providerId = provider.id as ModelCredentialProvider;
    const appId = requireBindingAppId(input);
    const credential = await this.credentialService.getActiveCredential({
      appId,
      providerId,
    });
    if (!credential) {
      throw new Error(
        `Model credential for ${providerId} is not configured. Run \`gantry credentials model set ${providerId}\`.`,
      );
    }
    resolveModelCredentialMode(provider, credential.authMode);
    await this.ensureListening();
    this.sweepExpiredTokens();
    if (this.tokens.size >= this.maxTokens) {
      throw new Error('Gantry Model Gateway token capacity is exhausted.');
    }
    const token = `${TOKEN_PREFIX}${randomUUID().replace(/-/g, '')}`;
    this.tokens.set(token, {
      token,
      appId,
      providerId,
      authMode: credential.authMode,
      schemaVersion: credential.schemaVersion,
      credentialFingerprint: credential.fingerprint,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + this.tokenTtlMs,
      ...(input.binding.agentId ? { agentId: input.binding.agentId } : {}),
      ...(input.binding.runId ? { runId: input.binding.runId } : {}),
      ...(input.binding.jobId ? { jobId: input.binding.jobId } : {}),
      ...(input.binding.conversationId
        ? { conversationId: input.binding.conversationId }
        : {}),
      ...(input.binding.threadId ? { threadId: input.binding.threadId } : {}),
    });
    await this.publishGatewayTokenAudit(
      this.tokens.get(token)!,
      'token_issued',
    );
    const env = projectGatewayTokenEnv({
      provider,
      baseUrl: `http://${hostForUrl(this.bindHost)}:${this.port}/${provider.gateway.pathSegment}`,
      token,
    });
    return {
      env,
      credentialProviders: {
        [provider.gateway.sdkProjection.credentialProviderEnvKey]:
          provider.gateway.sdkProjection.credentialProvider,
      },
      applied: true,
      brokerProfile: 'gantry',
      brokerAuthMode: credential.authMode,
    };
  }

  async healthCheck(
    input?: AgentCredentialBrokerInput,
  ): Promise<CredentialBrokerHealth> {
    const provider = gatewayProviderFor(
      input?.binding.modelCredentialProviderId ??
        input?.binding.modelRouteId ??
        defaultGatewayProviderId(),
    );
    const providerId = provider.id as ModelCredentialProvider;
    if (!input?.binding.appId) {
      return {
        status: 'fail',
        message:
          'Gantry Model Gateway requires an app-scoped credential binding.',
        nextAction: 'Pass appId when checking model gateway credentials.',
      };
    }
    const appId = input.binding.appId;
    const credential = await this.credentials.getModelCredential({
      appId,
      providerId,
    });
    if (!credential || credential.status !== 'active') {
      return {
        status: 'fail',
        message: `Gantry Model Gateway is missing an active ${providerId} credential.`,
        nextAction: `Run \`gantry credentials model set ${providerId}\`.`,
      };
    }
    return {
      status: 'pass',
      message: `Gantry Model Gateway has an active ${provider.label} credential.`,
      details: [`fingerprint=${credential.fingerprint}`],
    };
  }

  getCapabilities(): AgentCredentialBrokerCapabilities {
    return {
      profile: 'gantry',
      supportsAgentBinding: false,
      supportsModelRuntimeProfile: true,
      modelRuntimeProfileIdentifier: 'gantry-model-access',
      returnsRawSecrets: true,
      projectsProviderTokens: false,
      projectedSecretEnvKeys: projectedModelCredentialEnvKeys(),
    };
  }

  async revokeInjection(input: AgentCredentialBrokerInput): Promise<void> {
    const provider = gatewayProviderFor(
      input.binding.modelCredentialProviderId ??
        input.binding.modelRouteId ??
        defaultGatewayProviderId(),
    );
    const providerId = provider.id as ModelCredentialProvider;
    const appId = requireBindingAppId(input);
    if (!input.binding.runId) {
      throw new Error('Gantry Model Gateway token revocation requires runId.');
    }
    for (const [token, record] of this.tokens.entries()) {
      if (
        record.appId === appId &&
        record.providerId === providerId &&
        record.runId === input.binding.runId
      ) {
        this.tokens.delete(token);
      }
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listenPromise = undefined;
    this.port = 0;
    this.tokens.clear();
    this.rateLimiter.clear();
    if (this.tokenSweepTimer) {
      clearInterval(this.tokenSweepTimer);
      this.tokenSweepTimer = undefined;
    }
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private ensureListening(): Promise<void> {
    if (this.port > 0) return Promise.resolve();
    this.listenPromise ??= new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch((error) => {
          if (!res.headersSent) {
            res.statusCode =
              error instanceof GatewayRequestBodyTooLargeError
                ? 413
                : error instanceof GatewayBadRequestError
                  ? 400
                  : 502;
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                error:
                  error instanceof GatewayRequestBodyTooLargeError
                    ? 'Model gateway request body is too large'
                    : error instanceof GatewayBadRequestError
                      ? 'Invalid model gateway request'
                      : 'Gantry Model Gateway request failed',
                message: error instanceof Error ? error.message : String(error),
              }),
            );
            return;
          }
          if (!res.writableEnded) res.destroy(error);
        });
      });
      server.on('error', reject);
      server.listen(0, this.bindHost, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Gantry Model Gateway did not bind a TCP port.'));
          return;
        }
        this.server = server;
        this.port = address.port;
        this.startTokenSweep();
        resolve();
      });
    });
    return this.listenPromise;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    assertRawGatewayPathIsConfined(req.url || '/');
    const parsedUrl = new URL(
      req.url || '/',
      `http://${hostForUrl(this.bindHost)}`,
    );
    if (!ALLOWED_GATEWAY_METHODS.has(req.method ?? 'GET')) {
      sendGatewayJson(res, 405, {
        error: 'Model gateway only accepts POST requests.',
      });
      return;
    }
    const [providerSegment, ...pathParts] = parsedUrl.pathname
      .split('/')
      .filter(Boolean);
    const provider = gatewayProviderForPath(providerSegment || '');
    const providerId = provider.id as ModelCredentialProvider;
    const token = readBearerToken(req);
    const tokenRecord = token ? this.tokens.get(token) : undefined;
    if (
      !tokenRecord ||
      tokenRecord.providerId !== providerId ||
      !constantTimeEquals(tokenRecord.token, token)
    ) {
      sendGatewayJson(res, 401, {
        error: 'Unauthorized model gateway request',
      });
      return;
    }
    if (Date.now() >= tokenRecord.expiresAtMs) {
      this.tokens.delete(tokenRecord.token);
      await this.publishGatewayTokenAudit(tokenRecord, 'token_rejected');
      sendGatewayJson(res, 401, {
        error: 'Unauthorized model gateway request',
      });
      return;
    }

    const credential = await this.credentialService.getActiveCredential({
      appId: tokenRecord.appId,
      providerId,
    });
    if (!credential) {
      await this.publishGatewayUseAudit(tokenRecord, {
        outcome: 'credential_missing',
        method: req.method ?? 'GET',
        status: 503,
      });
      sendGatewayJson(res, 503, {
        error: `No active ${providerId} model credential is configured`,
      });
      return;
    }
    if (
      credential.fingerprint !== tokenRecord.credentialFingerprint ||
      credential.authMode !== tokenRecord.authMode ||
      credential.schemaVersion !== tokenRecord.schemaVersion
    ) {
      this.tokens.delete(tokenRecord.token);
      await this.publishGatewayTokenAudit(tokenRecord, 'token_rejected');
      sendGatewayJson(res, 401, {
        error: 'Unauthorized model gateway request',
      });
      return;
    }

    const upstream = resolveGatewayUpstream(
      provider,
      credential.authMode,
      credential.payload,
    );
    const upstreamUrl = buildConfinedUpstreamUrl(
      provider,
      pathParts,
      parsedUrl.search,
      upstream,
    );
    assertProviderPathAllowed(
      provider,
      upstreamUrl.pathname,
      upstream.pathPrefix,
    );

    // In-memory per-(app, provider) sliding-window rate cap. Enforced AFTER
    // credential/path validation and BEFORE body read, auth injection, and
    // upstream fetch, so a rejected request never triggers provider auth work.
    // No DB, no usage-body parsing.
    const rateLimited = await applyRateCap({
      limiter: this.rateLimiter,
      appId: tokenRecord.appId,
      providerId,
      audit: () =>
        this.publishGatewayUseAudit(tokenRecord, {
          outcome: 'rate_limited',
          method: req.method ?? 'GET',
          status: 429,
        }),
      reject: (limit) =>
        sendGatewayJson(res, 429, {
          error: `Rate limit: ${providerId} exceeded ${limit} requests/min for this app.`,
        }),
    });
    if (rateLimited) return;

    const body = await readRequestBody(req, this.requestBodyLimitBytes);
    const headers = sanitizeProxyHeaders(req.headers);
    await injectProviderAuth({
      headers,
      provider,
      authMode: credential.authMode,
      payload: credential.payload,
      method: req.method ?? 'POST',
      upstreamUrl,
      body,
    });

    const upstreamAbort = new AbortController();
    const timeout = setTimeout(
      () =>
        upstreamAbort.abort(
          new Error('Model gateway upstream request timed out.'),
        ),
      this.upstreamTimeoutMs,
    );
    const onClientAbort = () => {
      if (!res.writableEnded) {
        upstreamAbort.abort(new Error('Model gateway client disconnected.'));
      }
    };
    req.on('aborted', onClientAbort);
    res.on('close', onClientAbort);
    let response: Response;
    try {
      response = await fetch(upstreamUrl, {
        method: req.method ?? 'POST',
        headers,
        body,
        signal: upstreamAbort.signal,
      });
    } finally {
      clearTimeout(timeout);
      req.off('aborted', onClientAbort);
      res.off('close', onClientAbort);
    }
    await this.publishGatewayUseAudit(tokenRecord, {
      outcome: response.ok ? 'forwarded' : 'upstream_error',
      method: req.method ?? 'GET',
      status: response.status,
      upstreamHost: upstreamUrl.host,
      upstreamPath: upstreamUrl.pathname,
      credentialFingerprint: credential.fingerprint,
    });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (!shouldForwardGatewayResponseHeader(key)) return;
      res.setHeader(key, value);
    });
    await pipeUpstreamBody(response, res);
  }

  private async publishGatewayUseAudit(
    tokenRecord: GatewayTokenRecord,
    input: {
      outcome:
        | 'forwarded'
        | 'upstream_error'
        | 'credential_missing'
        | 'rate_limited';
      method: string;
      status: number;
      upstreamHost?: string;
      upstreamPath?: string;
      credentialFingerprint?: string;
    },
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit({
        appId: tokenRecord.appId,
        ...(tokenRecord.agentId ? { agentId: tokenRecord.agentId } : {}),
        ...(runtimeEventRunIdFor(tokenRecord)
          ? { runId: runtimeEventRunIdFor(tokenRecord) }
          : {}),
        ...(tokenRecord.jobId ? { jobId: tokenRecord.jobId } : {}),
        ...(tokenRecord.conversationId
          ? { conversationId: tokenRecord.conversationId }
          : {}),
        ...(tokenRecord.threadId ? { threadId: tokenRecord.threadId } : {}),
        eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED,
        actor: 'gantry-model-gateway',
        payload: {
          providerId: tokenRecord.providerId,
          outcome: input.outcome,
          method: input.method,
          status: input.status,
          tokenIssuedAtMs: tokenRecord.createdAtMs,
          tokenExpiresAtMs: tokenRecord.expiresAtMs,
          ...(input.credentialFingerprint
            ? { credentialFingerprint: input.credentialFingerprint }
            : {}),
          ...(input.upstreamHost ? { upstreamHost: input.upstreamHost } : {}),
          ...(input.upstreamPath ? { upstreamPath: input.upstreamPath } : {}),
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Gantry Model Gateway usage audit failed');
    }
  }

  private async publishGatewayTokenAudit(
    tokenRecord: GatewayTokenRecord,
    outcome: 'token_issued' | 'token_rejected',
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit({
        appId: tokenRecord.appId,
        ...(tokenRecord.agentId ? { agentId: tokenRecord.agentId } : {}),
        ...(runtimeEventRunIdFor(tokenRecord)
          ? { runId: runtimeEventRunIdFor(tokenRecord) }
          : {}),
        ...(tokenRecord.jobId ? { jobId: tokenRecord.jobId } : {}),
        ...(tokenRecord.conversationId
          ? { conversationId: tokenRecord.conversationId }
          : {}),
        ...(tokenRecord.threadId ? { threadId: tokenRecord.threadId } : {}),
        eventType: RUNTIME_EVENT_TYPES.CREDENTIAL_MODEL_USED,
        actor: 'gantry-model-gateway',
        payload: {
          providerId: tokenRecord.providerId,
          outcome,
          tokenIssuedAtMs: tokenRecord.createdAtMs,
          tokenExpiresAtMs: tokenRecord.expiresAtMs,
          credentialFingerprint: tokenRecord.credentialFingerprint,
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Gantry Model Gateway token audit failed');
    }
  }

  private startTokenSweep(): void {
    if (this.tokenSweepTimer || this.tokenSweepIntervalMs <= 0) return;
    this.tokenSweepTimer = setInterval(
      () => this.sweepExpiredTokens(),
      this.tokenSweepIntervalMs,
    );
    this.tokenSweepTimer.unref?.();
  }

  private sweepExpiredTokens(nowMs = Date.now()): void {
    for (const [token, record] of this.tokens.entries()) {
      if (nowMs >= record.expiresAtMs) {
        this.tokens.delete(token);
      }
    }
  }
}

function gatewayProviderFor(providerId: string): ModelProviderDefinition {
  const normalized = normalizeModelProviderId(providerId);
  const provider = getModelProviderDefinition(normalized);
  if (provider?.executable && provider.gateway) return provider;
  throw new Error(`Unsupported model gateway provider: ${providerId}`);
}

function runtimeEventRunIdFor(
  tokenRecord: GatewayTokenRecord,
): RuntimeEventPublishInput['runId'] | undefined {
  if (!tokenRecord.runId) return undefined;
  return String(tokenRecord.runId).startsWith('credential-run:')
    ? undefined
    : tokenRecord.runId;
}

function defaultGatewayProviderId(): string {
  const provider = getDefaultModelRouteProvider();
  if (!provider) {
    throw new Error('No default model gateway provider is registered.');
  }
  return provider.id;
}

function gatewayProviderForPath(pathSegment: string): ModelProviderDefinition {
  const provider = getModelProviderByGatewayPath(pathSegment);
  if (provider?.executable && provider.gateway) return provider;
  throw new Error(`Unsupported model gateway provider: ${pathSegment}`);
}

function requireBindingAppId(input: AgentCredentialBrokerInput): AppId {
  if (!input.binding.appId) {
    throw new Error('Gantry Model Gateway credential binding requires appId.');
  }
  return input.binding.appId;
}

function projectGatewayTokenEnv(input: {
  provider: ModelProviderDefinition;
  baseUrl: string;
  token: string;
}): Record<string, string> {
  const projection = input.provider.gateway.sdkProjection;
  return {
    [projection.baseUrlEnv]: input.baseUrl,
    [projection.tokenEnv]: input.token,
    ...(projection.additionalTokenEnv
      ? { [projection.additionalTokenEnv]: input.token }
      : {}),
  };
}

function projectedModelCredentialEnvKeys(): string[] {
  return [
    ...new Set([
      ...listExecutableModelProviders().flatMap((provider) => {
        const projection = provider.gateway.sdkProjection;
        return [
          projection.baseUrlEnv,
          projection.tokenEnv,
          projection.additionalTokenEnv,
        ].filter((key): key is string => Boolean(key));
      }),
    ]),
  ].sort();
}
