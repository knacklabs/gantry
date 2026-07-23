import { randomUUID } from 'node:crypto';

import type {
  MemoryLlmClient,
  MemoryLlmQueryOpts,
} from '../../../domain/ports/memory-llm-client.js';
import type { AgentRunId } from '../../../domain/events/events.js';
import { runWithMemoryOperationTimeout } from '../../../shared/memory-dreaming-timeout.js';
import {
  findModelByRunnerModel,
  type ModelRouteId,
} from '../../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../../shared/model-provider-registry.js';
import {
  hasGatewayMemoryAccess,
  resolveGatewayMemoryInjection,
} from '../openai-memory/memory-gateway-injection.js';
import { createAnthropicChatBatchCapability } from './anthropic-chat-batch.js';

const ANTHROPIC_VERSION = '2023-06-01';
const CLASSIFIER_MAX_TOKENS = 256;

interface MessagesResponse {
  content?: Array<{
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
  }>;
}

export function createDirectAnthropicClassifierLlmClient(): MemoryLlmClient {
  return {
    isConfigured: hasGatewayMemoryAccess,
    query: runDirectAnthropicClassifierQuery,
    batch: createAnthropicChatBatchCapability(),
  };
}

async function runDirectAnthropicClassifierQuery(
  opts: MemoryLlmQueryOpts,
): Promise<string> {
  if (!hasGatewayMemoryAccess()) {
    throw new Error(
      'Anthropic classifier access is not configured (configure brokered model access)',
    );
  }
  return runWithMemoryOperationTimeout(
    (signal) => requestDirectAnthropicCompletion({ ...opts, signal }),
    {
      timeoutMs: opts.timeoutMs,
      parentSignal: opts.signal,
      label: 'permission classifier LLM query',
    },
  );
}

async function requestDirectAnthropicCompletion(
  opts: MemoryLlmQueryOpts,
): Promise<string> {
  opts.signal?.throwIfAborted();
  const modelEntry = findModelByRunnerModel(
    opts.modelProfile?.runnerModel ?? opts.model,
  );
  const routeId = (opts.modelProfile?.modelRoute ??
    modelEntry?.modelRoute.id) as ModelRouteId | undefined;
  if (!routeId) {
    throw new Error(
      'Permission classifier model route unknown does not support Anthropic Messages.',
    );
  }
  const provider = getModelProviderDefinition(routeId);
  if (!provider || provider.responseFamily !== 'anthropic') {
    throw new Error(
      `Permission classifier model route ${routeId} does not support Anthropic Messages.`,
    );
  }

  const gateway = await resolveGatewayMemoryInjection({
    appId: opts.appId,
    modelRouteId: routeId,
    runId: `permission-classifier:${randomUUID()}` as AgentRunId,
  });
  try {
    opts.signal?.throwIfAborted();
    const { baseUrl, token } = readGatewayProjection(
      provider.gateway.sdkProjection,
      gateway.injection.env,
    );
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
        messages: [{ role: 'user', content: opts.prompt }],
        tools: [
          {
            name: 'permission_verdict',
            description: 'Return the permission classifier verdict.',
            input_schema: {
              type: 'object',
              properties: {
                decision: { type: 'string', enum: ['allow', 'ask'] },
                reason: { type: 'string' },
              },
              required: ['decision', 'reason'],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'permission_verdict' },
      }),
      signal: opts.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `Anthropic classifier query failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
      );
    }
    const parsed = (await response.json()) as MessagesResponse;
    opts.signal?.throwIfAborted();
    const verdict = (parsed.content ?? []).find(
      (block) =>
        block.type === 'tool_use' && block.name === 'permission_verdict',
    );
    if (verdict?.input !== undefined) {
      return JSON.stringify(verdict.input);
    }
    return (parsed.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
  } finally {
    await gateway.revoke();
  }
}

function readGatewayProjection(
  projection: { baseUrlEnv: string; tokenEnv: string },
  env: Record<string, string>,
): { baseUrl: string; token: string } {
  const baseUrl = env[projection.baseUrlEnv];
  const token = env[projection.tokenEnv];
  if (!baseUrl || !token?.startsWith('gtw_')) {
    throw new Error(
      'Anthropic classifier requires a run-scoped Gantry Model Gateway projection.',
    );
  }
  return { baseUrl, token };
}
