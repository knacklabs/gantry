import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import {
  getCredentialBrokerRuntimeConfig,
  type ClaudeAuthMode,
} from '../../../config/index.js';
import { getAgentCredentialInjection } from '../../../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../../credentials/agent-credential-broker-factory.js';
import { getRuntimeStorage } from '../../storage/postgres/runtime-store.js';
import type { AgentCredentialBroker } from '../../../domain/ports/agent-credential-broker.js';
import type { AgentCredentialInjection } from '../../../domain/models/credentials.js';
import type { AgentRunId } from '../../../domain/events/events.js';
import type { AppId } from '../../../domain/app/app.js';
import type { MemoryLlmModelProfile } from '../../../domain/ports/memory-llm-client.js';
import {
  abortReason,
  runWithMemoryOperationTimeout,
} from '../../../shared/memory-dreaming-timeout.js';
import { AGENT_CREDENTIAL_ENV_KEYS } from '../../../config/source-classification.js';
import { applyNeutralCaTrustAliases } from '../../../shared/neutral-ca-trust-env.js';
import {
  findModelByRunnerModel,
  type ModelRouteId,
} from '../../../shared/model-catalog.js';
import { validateModelCredentialProjectionForEntry } from './model-provider-credential-validation.js';
import {
  SDK_NATIVE_SKILL_DISABLE_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
} from './native-sdk-skills.js';
import { logger } from '../../../infrastructure/logging/logger.js';

export interface ClaudeQueryOpts {
  appId: AppId;
  model: string;
  modelProfile?: MemoryLlmModelProfile;
  prompt: string;
  systemPrompt?: string;
  userBlocks?: Array<{
    text: string;
    cacheStatic?: boolean;
  }>;
  onUsage?: (usage: ClaudeUsage) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeAuthAvailability {
  hasOauthToken: boolean;
  hasApiKey: boolean;
  mode: ClaudeAuthMode;
}

let memoryCredentialBrokerPromise:
  | Promise<AgentCredentialBroker | undefined>
  | undefined;
let memoryCredentialBrokerConfigKey = '';

export function getClaudeAuthAvailability(): ClaudeAuthAvailability {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  return {
    hasOauthToken: false,
    hasApiKey: false,
    mode: brokerConfig.mode === 'gantry' ? 'broker' : 'none',
  };
}

export function hasClaudeAuthConfigured(): boolean {
  return getClaudeAuthAvailability().mode !== 'none';
}

function readAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const row = message as {
    type?: unknown;
    message?: { content?: unknown };
  };
  if (row.type !== 'assistant') return '';
  const content = row.message?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      out += typed.text;
    }
  }
  return out;
}

function readResultText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const row = message as { type?: unknown; result?: unknown };
  if (row.type !== 'result') return '';
  return typeof row.result === 'string' ? row.result : '';
}

function flattenPrompt(opts: ClaudeQueryOpts): string {
  const parts: string[] = [];
  if (opts.systemPrompt) {
    parts.push(`System:\n${opts.systemPrompt}`);
  }
  if (opts.userBlocks?.length) {
    parts.push(...opts.userBlocks.map((block) => block.text));
  } else {
    parts.push(opts.prompt);
  }
  return parts.join('\n\n');
}

async function resolveGantryMemoryInjection(
  appId: AppId,
  modelRouteId: ModelRouteId,
  runId: AgentRunId,
): Promise<{
  injection: AgentCredentialInjection;
  revoke: () => Promise<void>;
}> {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const configKey = `${brokerConfig.mode}:${brokerConfig.gatewayBindHost}`;
  if (memoryCredentialBrokerConfigKey !== configKey) {
    void memoryCredentialBrokerPromise
      ?.then((broker) => broker?.close?.())
      .catch((error) => {
        logger.warn(
          { err: error },
          'Failed to close replaced memory credential broker',
        );
      });
    memoryCredentialBrokerPromise = undefined;
    memoryCredentialBrokerConfigKey = configKey;
  }
  if (brokerConfig.mode !== 'gantry') {
    throw new Error('Gantry Model Gateway is not configured for Claude access');
  }
  memoryCredentialBrokerPromise ??= createAgentCredentialBroker({
    mode: brokerConfig.mode,
    modelCredentials: getRuntimeStorage().repositories.modelCredentials,
    gatewayBindHost: brokerConfig.gatewayBindHost,
    publishRuntimeEvent: (event) =>
      getRuntimeStorage().runtimeEvents.publish(event),
  }).catch((error) => {
    memoryCredentialBrokerPromise = undefined;
    throw error;
  });
  const broker = requireGantryBroker(await memoryCredentialBrokerPromise);
  const injection = await getAgentCredentialInjection({
    mode: 'gantry',
    purpose: 'model_runtime',
    appId,
    runId,
    modelRouteId,
    broker,
  });
  return {
    injection,
    revoke: () =>
      broker.revokeInjection?.({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId,
          runId,
          modelRouteId,
        },
      }) ?? Promise.resolve(),
  };
}

function requireGantryBroker(
  broker: AgentCredentialBroker | undefined,
): AgentCredentialBroker {
  if (!broker) {
    throw new Error(
      'Gantry Model Gateway is enabled but no model gateway broker was provided.',
    );
  }
  return broker;
}

async function runWithGantryGateway(opts: ClaudeQueryOpts): Promise<string> {
  opts.signal?.throwIfAborted();
  const modelEntry = opts.modelProfile
    ? findModelByRunnerModel(opts.modelProfile.runnerModel)
    : findModelByRunnerModel(opts.model);
  const runId = `memory-query:${randomUUID()}` as AgentRunId;
  const gateway = await resolveGantryMemoryInjection(
    opts.appId,
    modelEntry?.modelRoute.id ?? 'anthropic',
    runId,
  );
  try {
    const injection = gateway.injection;
    opts.signal?.throwIfAborted();
    if (modelEntry) {
      validateModelCredentialProjectionForEntry({
        model: modelEntry,
        projection: {
          env: injection.env,
          credentialProviders: injection.credentialProviders,
          brokerProfile: injection.brokerProfile,
        },
      });
    }
    const sdkEnv = {
      ...scrubAmbientAgentCredentials(injection.env),
      ...SDK_NATIVE_SKILL_DISABLE_ENV,
    };
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(abortReason(opts.signal!));
    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    }
    const stream = query({
      prompt: flattenPrompt(opts),
      options: {
        abortController,
        model: opts.model,
        maxTurns: 1,
        env: sdkEnv,
        settings: {
          autoMemoryEnabled: false,
          skillOverrides: SDK_NATIVE_SKILL_OVERRIDES,
        },
        skills: [],
        settingSources: [],
      },
    }) as AsyncIterable<unknown>;

    let assistantText = '';
    let resultText = '';

    try {
      for await (const message of stream) {
        opts.signal?.throwIfAborted();
        assistantText += readAssistantText(message);
        if (!resultText) {
          resultText = readResultText(message);
        }
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    opts.signal?.throwIfAborted();

    return (assistantText || resultText).trim();
  } finally {
    await gateway.revoke();
  }
}

function scrubAmbientAgentCredentials(
  brokerEnv: Record<string, string>,
): Record<string, string> {
  const env = {
    ...Object.fromEntries(AGENT_CREDENTIAL_ENV_KEYS.map((key) => [key, ''])),
    ...brokerEnv,
  };
  applyNeutralCaTrustAliases(env);
  return env;
}

export async function runClaudeQuery(opts: ClaudeQueryOpts): Promise<string> {
  if (!hasClaudeAuthConfigured()) {
    throw new Error(
      'Claude auth is not configured (configure brokered model access)',
    );
  }
  return runWithMemoryOperationTimeout(
    (signal) => runWithGantryGateway({ ...opts, signal }),
    {
      timeoutMs: opts.timeoutMs,
      parentSignal: opts.signal,
      label: 'memory LLM query',
    },
  );
}
