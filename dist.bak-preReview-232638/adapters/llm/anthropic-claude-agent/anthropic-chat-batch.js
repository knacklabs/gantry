import { randomUUID } from 'node:crypto';
import { findModelByRunnerModel, } from '../../../shared/model-catalog.js';
import { getModelProviderDefinition, } from '../../../shared/model-provider-registry.js';
import { assertChatBatchUploadSize, CHAT_BATCH_RESULT_LIMIT_BYTES, CHAT_BATCH_RESULT_LIMIT_ROWS, estimateChatBatchCostUsd, fetchBatchJson, fetchBatchJsonl, finiteNumber, } from '../chat-batch-http.js';
import { resolveGatewayMemoryInjection } from '../openai-memory/memory-gateway-injection.js';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BATCH_MAX_OUTPUT_TOKENS = 4096;
export function createAnthropicChatBatchCapability() {
    return {
        preflightBatch: async (opts) => withAnthropicGateway(opts, opts.requests.length, async () => {
            buildAnthropicBatchBody(opts);
        }),
        submitBatch: async (opts) => withAnthropicGateway(opts, opts.requests.length, async ({ baseUrl, token }) => {
            const body = buildAnthropicBatchBody(opts);
            await opts.onSubmissionStart();
            const batch = await fetchBatchJson({
                provider: 'Anthropic',
                operation: 'submission',
                url: `${baseUrl}/v1/messages/batches`,
                init: {
                    method: 'POST',
                    headers: anthropicHeaders(token, true),
                    body,
                },
                signal: opts.signal,
            });
            if (!batch.id) {
                throw new Error('Anthropic batch submission returned no batch id.');
            }
            return { batchId: batch.id };
        }),
        pollBatch: async (opts) => withAnthropicGateway(opts, 1, async ({ baseUrl, token }) => {
            const batch = await getAnthropicBatch(baseUrl, token, opts.batchId, opts.signal);
            return {
                batchId: opts.batchId,
                state: mapAnthropicBatchState(batch.processing_status),
            };
        }),
        fetchBatchResults: async (opts) => withAnthropicGateway(opts, 1, async ({ baseUrl, token }) => {
            const rows = await fetchBatchJsonl({
                provider: 'Anthropic',
                operation: 'result download',
                url: `${baseUrl}/v1/messages/batches/${encodeURIComponent(opts.batchId)}/results`,
                init: {
                    method: 'GET',
                    headers: anthropicHeaders(token),
                },
                signal: opts.signal,
                maxBytes: CHAT_BATCH_RESULT_LIMIT_BYTES,
                maxRows: CHAT_BATCH_RESULT_LIMIT_ROWS,
            });
            return parseAnthropicRows(rows, opts.modelProfile?.runnerModel ?? opts.model);
        }),
        findBatchByCorrelationId: async (opts) => withAnthropicGateway(opts, 1, async ({ baseUrl, token }) => {
            // Anthropic Message Batches expose a read-only list endpoint but do not
            // carry caller metadata that can safely identify Gantry's submission.
            // Listing is still useful as best-effort provider reachability; never
            // infer a match from payload or timing and never submit from reconcile.
            await fetchBatchJson({
                provider: 'Anthropic',
                operation: 'reconciliation list',
                url: `${baseUrl}/v1/messages/batches?limit=100`,
                init: {
                    method: 'GET',
                    headers: anthropicHeaders(token),
                },
                signal: opts.signal,
            });
            return null;
        }),
    };
}
async function withAnthropicGateway(scope, modelBatchRequestCount, fn) {
    scope.signal?.throwIfAborted();
    const provider = requireAnthropicBatchProvider(scope);
    const gateway = await resolveGatewayMemoryInjection({
        appId: scope.appId,
        modelRouteId: provider.id,
        runId: `memory-query:batch:${randomUUID()}`,
        purpose: 'model_batch',
        modelBatchRequestCount,
    });
    try {
        const projection = provider.gateway.sdkProjection;
        const baseUrl = gateway.injection.env[projection.baseUrlEnv];
        const token = gateway.injection.env[projection.tokenEnv];
        if (!baseUrl || !token?.startsWith('gtw_')) {
            throw new Error('Anthropic chat batch requires a batch-scoped Gantry Model Gateway projection.');
        }
        return await fn({ baseUrl, token });
    }
    finally {
        await gateway.revoke();
    }
}
function requireAnthropicBatchProvider(scope) {
    const routeId = resolveRouteId(scope);
    const provider = routeId ? getModelProviderDefinition(routeId) : undefined;
    if (!provider?.batch || provider.responseFamily !== 'anthropic') {
        throw new Error(`Memory model route ${routeId ?? 'unknown'} does not support Anthropic chat batches.`);
    }
    return provider;
}
function resolveRouteId(scope) {
    if (scope.modelProfile?.modelRoute)
        return scope.modelProfile.modelRoute;
    return (findModelByRunnerModel(scope.modelProfile?.runnerModel ?? scope.model)
        ?.modelRoute.id ?? undefined);
}
function anthropicHeaders(token, json = false) {
    return {
        authorization: `Bearer ${token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(json ? { 'content-type': 'application/json' } : {}),
    };
}
function assertSubmission(correlationId, requests) {
    if (!correlationId.trim()) {
        throw new Error('Anthropic chat batch correlation id is required.');
    }
    if (requests.length === 0) {
        throw new Error('Anthropic chat batch requires at least one request.');
    }
    const ids = new Set();
    for (const request of requests) {
        if (!request.customId.trim() || ids.has(request.customId)) {
            throw new Error('Anthropic chat batch custom ids must be non-empty and unique.');
        }
        ids.add(request.customId);
    }
}
function buildMessageParams(model, request, maxOutputTokens) {
    const content = request.userBlocks?.length
        ? request.userBlocks.map((block) => ({
            type: 'text',
            text: block.text,
            ...(block.cacheStatic ? { cache_control: { type: 'ephemeral' } } : {}),
        }))
        : request.prompt;
    return {
        model,
        max_tokens: maxOutputTokens ?? DEFAULT_BATCH_MAX_OUTPUT_TOKENS,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        messages: [{ role: 'user', content }],
        ...(request.responseSchema
            ? {
                tools: [
                    {
                        name: request.responseSchema.name,
                        ...(request.responseSchema.description
                            ? { description: request.responseSchema.description }
                            : {}),
                        input_schema: request.responseSchema.schema,
                    },
                ],
                tool_choice: {
                    type: 'tool',
                    name: request.responseSchema.name,
                },
            }
            : {}),
    };
}
function getAnthropicBatch(baseUrl, token, batchId, signal) {
    return fetchBatchJson({
        provider: 'Anthropic',
        operation: 'poll',
        url: `${baseUrl}/v1/messages/batches/${encodeURIComponent(batchId)}`,
        init: {
            method: 'GET',
            headers: anthropicHeaders(token),
        },
        signal,
    });
}
function mapAnthropicBatchState(status) {
    return status === 'ended' ? 'completed' : 'pending';
}
function parseAnthropicRows(rows, model) {
    const result = [];
    const ids = new Set();
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Anthropic batch result row must be an object.');
        }
        const row = raw;
        if (!row.custom_id || ids.has(row.custom_id)) {
            throw new Error('Anthropic batch result custom ids must be present and unique.');
        }
        ids.add(row.custom_id);
        if (row.result?.type !== 'succeeded' || !row.result.message) {
            result.push({
                customId: row.custom_id,
                error: stringifyError(row.result?.error ??
                    `Anthropic batch request ${row.result?.type ?? 'failed'}.`),
            });
            continue;
        }
        const message = row.result.message;
        const toolInputs = (message.content ?? [])
            .filter((block) => block.type === 'tool_use' && block.input !== undefined)
            .map((block) => JSON.stringify(block.input));
        const text = (toolInputs.length
            ? toolInputs
            : (message.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? ''))
            .join('')
            .trim();
        result.push({
            customId: row.custom_id,
            ...(text
                ? { text }
                : { error: 'Anthropic batch result contained no completion text.' }),
            ...(message.usage ? { usage: anthropicUsage(message, model) } : {}),
        });
    }
    return result;
}
function anthropicUsage(message, model) {
    const usage = message.usage ?? {};
    const cacheReadTokens = finiteNumber(usage.cache_read_input_tokens);
    const cacheCreationTokens = finiteNumber(usage.cache_creation_input_tokens);
    const normalized = {
        input_tokens: finiteNumber(usage.input_tokens) ?? 0,
        output_tokens: finiteNumber(usage.output_tokens) ?? 0,
        ...(cacheReadTokens ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(cacheCreationTokens
            ? { cache_creation_input_tokens: cacheCreationTokens }
            : {}),
    };
    return {
        ...normalized,
        provider_reported_cost_usd: estimateChatBatchCostUsd(model, normalized),
    };
}
function buildAnthropicBatchBody(opts) {
    assertSubmission(opts.correlationId, opts.requests);
    const body = JSON.stringify({
        requests: opts.requests.map((request) => ({
            custom_id: request.customId,
            params: buildMessageParams(opts.model, request, opts.maxOutputTokens),
        })),
    });
    assertChatBatchUploadSize(body, 'Anthropic');
    return body;
}
function stringifyError(error) {
    if (typeof error === 'string')
        return error.slice(0, 300);
    return JSON.stringify(error ?? {}).slice(0, 300);
}
