import {
  query,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import {
  getCredentialBrokerRuntimeConfig,
  getRuntimeSettingsForConfig,
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

interface SDKTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | SDKTextBlock[] };
  parent_tool_use_id: null;
  session_id: string;
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

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readUsage(message: unknown): ClaudeUsage | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const row = message as {
    type?: unknown;
    usage?: Record<string, unknown>;
    modelUsage?: Record<
      string,
      {
        inputTokens?: unknown;
        outputTokens?: unknown;
        cacheReadInputTokens?: unknown;
        cacheCreationInputTokens?: unknown;
      }
    >;
  };
  if (row.type !== 'result') return undefined;
  if (row.usage && typeof row.usage === 'object') {
    const usage: ClaudeUsage = {
      input_tokens: numeric(row.usage.input_tokens),
      output_tokens: numeric(row.usage.output_tokens),
    };
    const cacheRead = optionalNumeric(row.usage.cache_read_input_tokens);
    const cacheWrite = optionalNumeric(row.usage.cache_creation_input_tokens);
    if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
    if (cacheWrite !== undefined) {
      usage.cache_creation_input_tokens = cacheWrite;
    }
    return usage;
  }
  if (row.modelUsage && typeof row.modelUsage === 'object') {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    for (const usage of Object.values(row.modelUsage)) {
      inputTokens += numeric(usage.inputTokens);
      outputTokens += numeric(usage.outputTokens);
      cacheReadTokens += numeric(usage.cacheReadInputTokens);
      cacheCreationTokens += numeric(usage.cacheCreationInputTokens);
    }
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
    };
  }
  return undefined;
}

function buildCacheableSystemPrompt(
  systemPrompt?: string,
): string[] | undefined {
  const trimmed = systemPrompt?.trim();
  if (!trimmed) return undefined;
  return [trimmed, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
}

function buildUserContent(opts: ClaudeQueryOpts): string | SDKTextBlock[] {
  if (opts.userBlocks?.length) {
    return opts.userBlocks.map((block) => ({
      type: 'text',
      text: block.text,
      ...(block.cacheStatic
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }));
  }
  return opts.prompt;
}

async function* buildPrompt(
  opts: ClaudeQueryOpts,
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: buildUserContent(opts),
    },
    parent_tool_use_id: null,
    session_id: '',
  };
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
    // Honor per-provider rate caps for memory traffic, same getter runtime-app
    // uses for the interactive broker. Without it the broker admits unlimited.
    limits: () => getRuntimeSettingsForConfig().limits,
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
    if (!modelEntry) {
      // Fail closed: an uncatalogued model cannot have its gateway
      // projection verified, and skipping the check would let a raw
      // provider key reach the runner. Custom aliases register catalog
      // entries, so a miss here is a real configuration error.
      throw new Error(
        `Model "${opts.modelProfile?.runnerModel ?? opts.model}" is not in the model catalog; cannot verify Gantry Model Gateway credentials for memory queries.`,
      );
    }
    validateModelCredentialProjectionForEntry({
      model: modelEntry,
      projection: {
        env: injection.env,
        credentialProviders: injection.credentialProviders,
        brokerProfile: injection.brokerProfile,
      },
    });
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
      prompt: opts.userBlocks?.length ? buildPrompt(opts) : opts.prompt,
      options: {
        abortController,
        model: opts.model,
        maxTurns: 1,
        systemPrompt: buildCacheableSystemPrompt(opts.systemPrompt),
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
    let usage: ClaudeUsage | undefined;

    try {
      for await (const message of stream) {
        opts.signal?.throwIfAborted();
        assistantText += readAssistantText(message);
        usage = readUsage(message) ?? usage;
        if (!resultText) {
          resultText = readResultText(message);
        }
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    opts.signal?.throwIfAborted();
    if (usage) {
      opts.onUsage?.(usage);
    }

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
