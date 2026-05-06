import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import type {
  AgentCredentialBroker,
  AgentCredentialBrokerInput,
  AgentCredentialBrokerCapabilities,
} from '../../../domain/ports/agent-credential-broker.js';
import type {
  AgentCredentialInjection,
  AgentCredentialBrokerBinding,
  CredentialBrokerHealth,
} from '../../../domain/models/credentials.js';
import { MODEL_RUNTIME_CREDENTIAL_IDENTIFIER } from '../../../domain/models/credentials.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { CredentialBrokerConfigError } from '../../../domain/models/credential-errors.js';
import { filterTrustedOnecliEnv } from './env-policy.js';
import { validateOnecliUrl } from './policy.js';

type OneCliClient = Pick<OneCLI, 'getContainerConfig' | 'ensureAgent'>;
type OneCliAgentRuntimeConfig = Awaited<
  ReturnType<OneCliClient['getContainerConfig']>
>;

export interface OnecliAgentCredentialBrokerOptions {
  onecliUrl?: string;
  dataDir: string;
  timeoutMs?: number;
  configCacheTtlMs?: number;
  client?: OneCliClient;
}

export class OnecliAgentCredentialBroker implements AgentCredentialBroker {
  private static readonly DEFAULT_CONFIG_CACHE_TTL_MS = 0;

  private readonly client?: OneCliClient;
  private readonly normalizedUrl?: string;
  private readonly urlError?: string;
  private readonly configCache = new Map<
    string,
    { expiresAt: number; config: OneCliAgentRuntimeConfig }
  >();
  private readonly configInflight = new Map<
    string,
    Promise<OneCliAgentRuntimeConfig>
  >();
  private readonly caCache = new Map<string, { hash: string; path: string }>();

  constructor(private readonly options: OnecliAgentCredentialBrokerOptions) {
    const rawUrl = options.onecliUrl?.trim() || '';
    if (rawUrl) {
      const validation = validateOnecliUrl(rawUrl);
      if (!validation.ok || !validation.normalizedUrl) {
        this.urlError = validation.error || 'Invalid ONECLI_URL.';
      } else {
        this.normalizedUrl = validation.normalizedUrl;
      }
    }
    this.client =
      options.client ??
      (this.normalizedUrl
        ? new OneCLI({
            url: this.normalizedUrl,
            timeout: options.timeoutMs,
          })
        : undefined);
  }

  getCapabilities(): AgentCredentialBrokerCapabilities {
    return {
      profile: 'onecli',
      supportsAgentBinding: true,
      supportsModelRuntimeProfile: true,
      modelRuntimeProfileIdentifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
      returnsRawSecrets: false,
      projectsProviderTokens: true,
      projectedSecretEnvKeys: ['ANTHROPIC_AUTH_TOKEN'],
    };
  }

  async getInjection(
    input: AgentCredentialBrokerInput,
  ): Promise<AgentCredentialInjection> {
    const credentialIdentifier = this.resolveCredentialIdentifier(
      input.binding,
    );
    const config = await this.getAgentRuntimeConfig(credentialIdentifier);
    const { env, credentialProviders, droppedKeys } = filterTrustedOnecliEnv(
      config.env || {},
    );
    if (droppedKeys.length > 0) {
      logger.warn(
        {
          droppedKeys: droppedKeys.sort().slice(0, 20),
          droppedCount: droppedKeys.length,
        },
        'Dropped disallowed OneCLI env keys',
      );
    }
    this.applyCaCertificate(env, config.caCertificate, credentialIdentifier);
    const httpProxy = env.HTTP_PROXY || env.http_proxy;
    const httpsProxy = env.HTTPS_PROXY || env.https_proxy;

    return {
      env,
      ...(credentialProviders ? { credentialProviders } : {}),
      applied: true,
      brokerProfile: 'onecli',
      ...(httpProxy || httpsProxy
        ? { proxy: { http: httpProxy, https: httpsProxy } }
        : {}),
      certificates: {
        nodeExtraCaCertsPath: env.NODE_EXTRA_CA_CERTS,
      },
    };
  }

  async healthCheck(
    input?: AgentCredentialBrokerInput,
  ): Promise<CredentialBrokerHealth> {
    if (!this.client) {
      return {
        status: 'fail',
        message: this.urlError || 'ONECLI_URL is missing.',
        nextAction: 'Set ONECLI_URL to the reachable OneCLI gateway URL.',
      };
    }
    try {
      const binding = input?.binding || {
        profile: 'onecli' as const,
        purpose: 'model_runtime' as const,
      };
      const config = await this.getAgentRuntimeConfig(
        this.resolveCredentialIdentifier(binding),
      );
      filterTrustedOnecliEnv(config.env || {});
      return {
        status: 'pass',
        message: `Connected to OneCLI at ${this.normalizedUrl}.`,
      };
    } catch (err) {
      return {
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        nextAction: 'Confirm the Model Access URL and gateway availability.',
      };
    }
  }

  async ensureAgent(input: {
    name: string;
    identifier: string;
  }): Promise<{ created?: boolean }> {
    if (!this.client) return {};
    return this.client.ensureAgent(input);
  }

  private applyCaCertificate(
    env: Record<string, string>,
    caCertificate: string | undefined,
    credentialIdentifier: string,
  ): void {
    if (!caCertificate) return;

    const caDir = path.join(this.options.dataDir, 'onecli');
    const caHash = createHash('sha256').update(caCertificate).digest('hex');
    const cacheKey = credentialIdentifier;
    const cached = this.caCache.get(cacheKey);
    if (cached?.hash === caHash && fs.existsSync(cached.path)) {
      env.NODE_EXTRA_CA_CERTS = cached.path;
      return;
    }
    const caPath = path.join(
      caDir,
      `${this.caFileStem(credentialIdentifier)}.pem`,
    );
    const tempPath = `${caPath}.${process.pid}.${randomUUID()}.tmp`;
    fs.mkdirSync(caDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(caDir, 0o700);
    try {
      fs.writeFileSync(tempPath, caCertificate, { mode: 0o600 });
      fs.renameSync(tempPath, caPath);
      fs.chmodSync(caPath, 0o600);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    env.NODE_EXTRA_CA_CERTS = caPath;
    this.caCache.set(cacheKey, { hash: caHash, path: caPath });
    logger.info(
      { agentIdentifier: credentialIdentifier, caPath },
      'Applied OneCLI CA certificate for host runner',
    );
  }

  private async getAgentRuntimeConfig(
    resolvedAgentIdentifier: string,
  ): Promise<OneCliAgentRuntimeConfig> {
    if (!this.client) {
      throw new CredentialBrokerConfigError(
        this.urlError ||
          'OneCLI credential mode is enabled but ONECLI_URL is not configured.',
      );
    }
    const cacheKey = resolvedAgentIdentifier;
    const now = Date.now();
    const cached = this.configCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.config;
    }
    const inflight = this.configInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }
    const ttlMs =
      this.options.configCacheTtlMs ??
      OnecliAgentCredentialBroker.DEFAULT_CONFIG_CACHE_TTL_MS;
    const request = this.client
      .getContainerConfig(resolvedAgentIdentifier)
      .then((config) => {
        if (ttlMs > 0) {
          this.configCache.set(cacheKey, {
            config,
            expiresAt: Date.now() + ttlMs,
          });
        }
        return config;
      })
      .finally(() => {
        this.configInflight.delete(cacheKey);
      });
    this.configInflight.set(cacheKey, request);
    return request;
  }

  private resolveCredentialIdentifier(
    binding: AgentCredentialBrokerBinding,
  ): string {
    const purpose = binding.purpose ?? 'model_runtime';
    if (purpose === 'model_runtime') {
      return MODEL_RUNTIME_CREDENTIAL_IDENTIFIER;
    }
    const identifier = binding.agentIdentifier?.trim();
    if (!identifier) {
      throw new CredentialBrokerConfigError(
        'Tool capability credential projection requires an explicit agent identifier.',
      );
    }
    return identifier;
  }

  private caFileStem(credentialIdentifier: string): string {
    const hash = createHash('sha256')
      .update(credentialIdentifier)
      .digest('hex')
      .slice(0, 16);
    return `gateway-ca-${hash}`;
  }
}
