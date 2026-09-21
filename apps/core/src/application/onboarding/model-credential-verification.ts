import { randomUUID } from 'node:crypto';

import { createAgentCredentialBroker } from '../../adapters/credentials/agent-credential-broker-factory.js';
import { getAgentCredentialInjection } from '../credentials/agent-credential-service.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRunId } from '../../domain/events/events.js';
import type { ModelCredential } from '../../domain/model-credentials/model-credentials.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import {
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
} from '../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../shared/model-provider-registry.js';
import { ONBOARDING_MODEL_PROBE_TIMEOUT_MS } from './onboarding-state-machine.js';

const PROBE_TEXT = 'Reply with exactly: GANTRY_MODEL_OK';
const PROBE_TOOL_NAME = 'gantry_probe_echo';
const PROBE_TOOL_VALUE = 'GANTRY_MODEL_OK';
const PROBE_TOOL_TEXT = `Call the ${PROBE_TOOL_NAME} tool with value set to exactly: ${PROBE_TOOL_VALUE}`;

// Onboarding previously only proved a plain, non-streaming, tool-free chat
// completion worked. Real DeepAgents turns stream and bind tools, so a model
// that passes the plain check can still crash on its first real turn (seen
// with a Bedrock Kimi K2.5 credential). This flag lets that stricter
// streaming+tool-call assertion actually block onboarding once it has been
// observed clean in production; until then a failure is logged, not thrown,
// so the new check can't newly break onboarding for a model that used to pass.
const STRICT_PROBE_ENV = 'GANTRY_ONBOARDING_STRICT_MODEL_PROBE';

function strictProbeEnabled(): boolean {
  return process.env[STRICT_PROBE_ENV] === '1';
}

class ModelCredentialRejectedError extends Error {}

export function isModelCredentialRejectedError(
  error: unknown,
): error is ModelCredentialRejectedError {
  return error instanceof ModelCredentialRejectedError;
}

export async function verifyOnboardingModelCredential(input: {
  appId: AppId;
  credential: ModelCredential;
  modelAlias: string;
  timeoutMs?: number;
}): Promise<{ routeId: string; modelId: string }> {
  const selection = resolveModelSelectionForWorkload(input.modelAlias, 'chat');
  if (!selection.ok) throw new Error(selection.message);
  if (selection.entry.modelRoute.id !== input.credential.providerId) {
    throw new Error(
      'The selected model does not belong to the staged provider.',
    );
  }
  const repository = candidateRepository(input.credential);
  const broker = await createAgentCredentialBroker({
    mode: 'gantry',
    modelCredentials: repository,
  });
  if (!broker) throw new Error('Gantry Model Gateway is not available.');
  const runId = `onboarding-probe:${randomUUID()}` as AgentRunId;
  try {
    const injection = await getAgentCredentialInjection({
      mode: 'gantry',
      purpose: 'model_runtime',
      appId: input.appId,
      runId,
      modelRouteId: selection.entry.modelRoute.id,
      broker,
    });
    const provider = getModelProviderDefinition(selection.entry.modelRoute.id);
    if (!provider)
      throw new Error('The selected model provider is unavailable.');
    const baseUrl = injection.env[provider.gateway.sdkProjection.baseUrlEnv];
    const token = injection.env[provider.gateway.sdkProjection.tokenEnv];
    if (!baseUrl || !token)
      throw new Error('Model Gateway did not issue a probe binding.');
    await invokeProbe({
      baseUrl,
      token,
      entry: selection.entry,
      providerLabel: provider.label,
      timeoutMs: input.timeoutMs ?? ONBOARDING_MODEL_PROBE_TIMEOUT_MS,
    });
    return {
      routeId: selection.entry.modelRoute.id,
      modelId: selection.entry.modelRoute.providerModelId,
    };
  } finally {
    await Promise.allSettled([
      broker.revokeInjection?.({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId: input.appId,
          runId,
          modelRouteId: input.credential.providerId,
        },
      }),
      broker.close?.(),
    ]);
  }
}

// Exported for direct unit testing of the streaming/tool-call and soft-fail
// logic without needing to fake the credential-broker/injection chain.
export async function invokeProbe(input: {
  baseUrl: string;
  token: string;
  entry: ModelCatalogEntry;
  providerLabel: string;
  timeoutMs: number;
}): Promise<void> {
  const anthropic = input.entry.responseFamily === 'anthropic';
  // The Anthropic SDK lane never runs through the production code path this
  // deep check targets (DeepAgents Claude turns are SDK-only, not built via
  // the streaming/tool-binding runner), so it keeps the original plain probe.
  const deepCheck =
    !anthropic &&
    (input.entry.capabilities.streaming || input.entry.capabilities.toolUse);
  if (!deepCheck) {
    await runPlainProbe(input, anthropic);
    return;
  }
  await runDeepProbe(input);
}

// The OpenAI SDK (and this hand-rolled probe, mirroring it) posts to
// `${baseUrl}/chat/completions` verbatim — no default `/v1` insertion for a
// custom base URL. Every other provider's gateway path prefix already bakes
// in `/v1` (or an equivalent) on the registry side, so the gateway combines
// it correctly for them; native `openai` alone needs it appended here,
// exactly like apps/core/src/adapters/llm/deepagents-langchain/runner/
// model-factory.ts does for the same reason (that file's own production
// callers hit the identical gap).
function chatCompletionsUrl(baseUrl: string, modelRouteId: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  return modelRouteId === 'openai'
    ? `${trimmed}/v1/chat/completions`
    : `${trimmed}/chat/completions`;
}

async function runPlainProbe(
  input: {
    baseUrl: string;
    token: string;
    entry: ModelCatalogEntry;
    providerLabel: string;
    timeoutMs: number;
  },
  anthropic: boolean,
): Promise<void> {
  const response = await fetch(
    anthropic
      ? `${input.baseUrl.replace(/\/$/, '')}/v1/messages`
      : chatCompletionsUrl(input.baseUrl, input.entry.modelRoute.id),
    {
      method: 'POST',
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}),
      },
      body: JSON.stringify(
        anthropic
          ? {
              model: input.entry.modelRoute.providerModelId,
              max_tokens: 16,
              messages: [{ role: 'user', content: PROBE_TEXT }],
            }
          : {
              model: input.entry.modelRoute.providerModelId,
              messages: [{ role: 'user', content: PROBE_TEXT }],
              ...(input.entry.modelRoute.id === 'openai'
                ? { max_completion_tokens: 16 }
                : { max_tokens: 16 }),
            },
      ),
    },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  raiseForUpstreamFailure(response, input.providerLabel, body);
  const text = probeText(body, anthropic);
  if (!text) throw new Error('Model probe returned no text.');
}

// Exercises the same protocol shape a real DeepAgents turn uses: a streamed
// chat completion with a tool bound and forced. This is what caught nothing
// before (the plain probe never streams or binds a tool), so it is the check
// that actually proves the model/gateway combination can run a real turn.
async function runDeepProbe(input: {
  baseUrl: string;
  token: string;
  entry: ModelCatalogEntry;
  providerLabel: string;
  timeoutMs: number;
}): Promise<void> {
  const useTools = input.entry.capabilities.toolUse;
  const body = JSON.stringify({
    model: input.entry.modelRoute.providerModelId,
    stream: true,
    messages: [
      { role: 'user', content: useTools ? PROBE_TOOL_TEXT : PROBE_TEXT },
    ],
    ...(input.entry.modelRoute.id === 'openai'
      ? { max_completion_tokens: 64 }
      : { max_tokens: 64 }),
    ...(useTools
      ? {
          tools: [
            {
              type: 'function',
              function: {
                name: PROBE_TOOL_NAME,
                description: 'Echo the given value back.',
                parameters: {
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                },
              },
            },
          ],
          // 'auto', not a forced tool_choice: reasoning-family models (e.g.
          // OpenAI's GPT-5.x) reject a forced tool_choice combined with
          // stream:true with a 400, and forcing it doesn't reflect real
          // DeepAgents traffic anyway (model-factory.ts leaves tool_choice
          // unset/auto too). The prompt still asks for the tool explicitly,
          // so a model that supports tools normally still calls it.
          tool_choice: 'auto',
        }
      : {}),
  });
  const fetchOnce = () =>
    fetch(chatCompletionsUrl(input.baseUrl, input.entry.modelRoute.id), {
      method: 'POST',
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
      },
      body,
    });
  const response = await fetchWithOneRetry(fetchOnce);
  const errorBody = response.ok
    ? null
    : ((await response.json().catch(() => null)) as unknown);
  raiseForUpstreamFailure(response, input.providerLabel, errorBody);
  const stream = await readToolCallStream(response);
  if (stream.chunkCount === 0)
    throw new Error('Model probe stream produced no output.');
  if (useTools && !stream.sawExpectedToolCall) {
    const message = `${input.providerLabel} streamed a response but never called the requested tool (${PROBE_TOOL_NAME}).`;
    if (strictProbeEnabled()) throw new Error(message);
    console.warn(
      `[onboarding-model-probe] ${message} Passing onboarding anyway because ${STRICT_PROBE_ENV} is not set to "1".`,
    );
  }
}

// Network-level failures (connection reset, DNS hiccup, timeout) are retried
// once so a transient blip during onboarding isn't mistaken for the model
// genuinely being unusable; a deterministic HTTP error response is not
// retried (fetchOnce still resolves normally for those, it just doesn't throw).
async function fetchWithOneRetry(
  fetchOnce: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fetchOnce();
    // Intentional catch-all: fetch() only throws for connectivity failures
    // (DNS, connection reset, our own AbortSignal timeout) — HTTP error
    // responses resolve normally and are handled by the caller instead. The
    // single retry is the whole point of this helper.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return await fetchOnce();
  }
}

function raiseForUpstreamFailure(
  response: Response,
  providerLabel: string,
  body: unknown,
): void {
  if (response.ok) return;
  if (response.status === 401) {
    throw new ModelCredentialRejectedError(
      `${providerLabel} rejected the credentials. Generate a current credential and retry.`,
    );
  }
  const detail = upstreamErrorMessage(body);
  throw new Error(
    `Model probe failed with upstream status ${response.status}${detail ? `: ${detail}` : '.'}`,
  );
}

// Handles both shapes seen in practice: the upstream provider's own nested
// `{ error: { message } }` (OpenAI/Anthropic), and Gantry's own Model Gateway
// error body when the gateway itself rejects the request before proxying it
// — a flat `{ error: string, message: string }` (see gantry-model-gateway.ts).
// Falls back to a truncated raw dump rather than ever silently coming back
// empty, so a probe failure is never a dead end again.
function upstreamErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const nestedError = record.error;
  if (nestedError && typeof nestedError === 'object') {
    const message = (nestedError as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  if (typeof record.message === 'string' && record.message)
    return record.message;
  if (typeof nestedError === 'string' && nestedError) return nestedError;
  // body always originates from response.json(), so it is already
  // JSON-safe (no circular refs/BigInt) — stringify can't throw here.
  return JSON.stringify(body).slice(0, 500);
}

async function readToolCallStream(
  response: Response,
): Promise<{ chunkCount: number; sawExpectedToolCall: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { chunkCount: 0, sawExpectedToolCall: false };
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;
  let sawExpectedToolCall = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (!payload || payload === '[DONE]') continue;
      chunkCount += 1;
      if (sawExpectedToolCall) continue;
      sawExpectedToolCall = chunkContainsExpectedToolCall(payload);
    }
  }
  return { chunkCount, sawExpectedToolCall };
}

function chunkContainsExpectedToolCall(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{
        delta?: { tool_calls?: Array<{ function?: { name?: string } }> };
      }>;
    };
    const toolCalls = parsed.choices?.[0]?.delta?.tool_calls ?? [];
    return toolCalls.some((call) => call.function?.name === PROBE_TOOL_NAME);
    // Intentional catch-all: a malformed/unexpected SSE data line should not
    // crash the probe — treat it as "no tool call in this chunk" and keep
    // reading; chunkCount above already reflects that a byte stream arrived.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return false;
  }
}

function probeText(value: unknown, anthropic: boolean): string {
  if (!value || typeof value !== 'object') return '';
  const body = value as Record<string, unknown>;
  if (anthropic) {
    const content = Array.isArray(body.content) ? body.content : [];
    return content
      .map((item) =>
        item &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('')
      .trim();
  }
  const first = Array.isArray(body.choices) ? body.choices[0] : null;
  if (!first || typeof first !== 'object') return '';
  const message = (first as { message?: unknown }).message;
  return message &&
    typeof message === 'object' &&
    typeof (message as { content?: unknown }).content === 'string'
    ? (message as { content: string }).content.trim()
    : '';
}

function candidateRepository(
  credential: ModelCredential,
): ModelCredentialRepository {
  return {
    getModelCredential: async ({ appId, providerId }) =>
      appId === credential.appId && providerId === credential.providerId
        ? credential
        : null,
    listModelCredentials: async ({ appId }) =>
      appId === credential.appId ? [credential] : [],
    upsertModelCredential: async () => {
      throw new Error('Onboarding probe credentials are read-only.');
    },
    disableModelCredential: async () => {
      throw new Error('Onboarding probe credentials are read-only.');
    },
    deleteModelCredential: async () => {
      throw new Error('Onboarding probe credentials are read-only.');
    },
  };
}
