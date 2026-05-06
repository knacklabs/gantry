import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  DATA_DIR,
  getCredentialBrokerRuntimeConfig,
  type ClaudeAuthMode,
} from '../config/index.js';
import { resolveExternalCredentialBaseUrl } from '../config/credentials/broker-url-policy.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../adapters/credentials/agent-credential-broker-factory.js';
import { createExternalAgentCredentialInjection } from '../adapters/llm/external-credential-injection.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import { AGENT_CREDENTIAL_ENV_KEYS } from '../config/source-classification.js';

export interface ClaudeQueryOpts {
  model: string;
  prompt: string;
  systemPrompt?: string;
  userBlocks?: Array<{
    text: string;
    cacheStatic?: boolean;
  }>;
  onUsage?: (usage: ClaudeUsage) => void;
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
let memoryCredentialBrokerCacheKey = '';

export function getClaudeAuthAvailability(): ClaudeAuthAvailability {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  return {
    hasOauthToken: false,
    hasApiKey: false,
    mode:
      (brokerConfig.mode === 'onecli' && brokerConfig.onecliUrl.trim()) ||
      (brokerConfig.mode === 'external' &&
        brokerConfig.externalBrokerBaseUrl.trim())
        ? 'broker'
        : 'none',
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

async function resolveOnecliMemoryEnv(): Promise<Record<string, string>> {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const cacheKey = `${brokerConfig.mode}:${brokerConfig.onecliUrl}:${brokerConfig.externalBrokerBaseUrl}`;
  if (memoryCredentialBrokerCacheKey !== cacheKey) {
    memoryCredentialBrokerPromise = undefined;
    memoryCredentialBrokerCacheKey = cacheKey;
  }
  if (brokerConfig.mode === 'external') {
    const injection = await getAgentCredentialInjection({
      mode: 'external',
      purpose: 'model_runtime',
      externalInjection: createExternalAgentCredentialInjection({
        normalizedBaseUrl: resolveExternalCredentialBaseUrl(
          brokerConfig.externalBrokerBaseUrl,
        ),
      }),
    });
    return injection.env;
  }
  if (brokerConfig.mode !== 'onecli') {
    throw new Error('Credential broker is not configured for Claude access');
  }
  if (!brokerConfig.onecliUrl.trim()) {
    throw new Error('OneCLI is not configured for Claude access');
  }
  memoryCredentialBrokerPromise ??= createAgentCredentialBroker({
    mode: brokerConfig.mode,
    onecliUrl: brokerConfig.onecliUrl,
    dataDir: DATA_DIR,
  }).catch((error) => {
    memoryCredentialBrokerPromise = undefined;
    throw error;
  });
  const injection = await getAgentCredentialInjection({
    mode: 'onecli',
    purpose: 'model_runtime',
    broker: requireOnecliBroker(await memoryCredentialBrokerPromise),
  });
  return injection.env;
}

function requireOnecliBroker(
  broker: AgentCredentialBroker | undefined,
): AgentCredentialBroker {
  if (!broker) {
    throw new Error(
      'Credential broker mode is enabled but no agent credential broker was provided.',
    );
  }
  return broker;
}

async function runWithOnecli(opts: ClaudeQueryOpts): Promise<string> {
  const brokerEnv = await resolveOnecliMemoryEnv();
  const sdkEnv = scrubAmbientAgentCredentials(brokerEnv);
  const stream = query({
    prompt: flattenPrompt(opts),
    options: {
      model: opts.model,
      maxTurns: 1,
      env: sdkEnv,
    },
  }) as AsyncIterable<unknown>;

  let assistantText = '';
  let resultText = '';

  for await (const message of stream) {
    assistantText += readAssistantText(message);
    if (!resultText) {
      resultText = readResultText(message);
    }
  }

  return (assistantText || resultText).trim();
}

function scrubAmbientAgentCredentials(
  brokerEnv: Record<string, string>,
): Record<string, string> {
  return {
    ...Object.fromEntries(AGENT_CREDENTIAL_ENV_KEYS.map((key) => [key, ''])),
    ...brokerEnv,
  };
}

export async function runClaudeQuery(opts: ClaudeQueryOpts): Promise<string> {
  if (!hasClaudeAuthConfigured()) {
    throw new Error(
      'Claude auth is not configured (configure brokered model access)',
    );
  }
  return runWithOnecli(opts);
}
