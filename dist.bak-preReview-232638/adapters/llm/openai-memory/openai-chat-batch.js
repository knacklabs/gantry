import { randomUUID } from 'node:crypto';
import { findModelByRunnerModel, } from '../../../shared/model-catalog.js';
import { getModelProviderDefinition, } from '../../../shared/model-provider-registry.js';
import { assertChatBatchUploadSize, CHAT_BATCH_RESULT_LIMIT_BYTES, CHAT_BATCH_RESULT_LIMIT_ROWS, fetchBatchJson, fetchBatchJsonl, estimateChatBatchCostUsd, finiteNumber, } from '../chat-batch-http.js';
import { resolveGatewayMemoryInjection } from './memory-gateway-injection.js';
const OPENAI_BATCH_LIST_PAGE_LIMIT = 100;
const OPENAI_BATCH_LIST_MAX_PAGES = 5;
export function createOpenAiChatBatchCapability() {
    return {
        preflightBatch: async (opts) => withOpenAiGateway(opts, opts.requests.length, undefined, async () => {
            buildOpenAiBatchInput(opts);
        }),
        submitBatch: async (opts) => withOpenAiGateway(opts, opts.requests.length, undefined, async ({ baseUrl, token }) => {
            const input = buildOpenAiBatchInput(opts);
            const form = new FormData();
            form.append('purpose', 'batch');
            form.append('file', new Blob([input], { type: 'application/jsonl' }), 'gantry-chat-batch.jsonl');
            const file = await fetchBatchJson({
                provider: 'OpenAI',
                operation: 'input upload',
                url: `${baseUrl}/v1/files`,
                init: {
                    method: 'POST',
                    headers: { authorization: `Bearer ${token}` },
                    body: form,
                },
                signal: opts.signal,
            });
            if (!file.id) {
                throw new Error('OpenAI batch input upload returned no file id.');
            }
            await opts.onSubmissionStart();
            const batch = await fetchBatchJson({
                provider: 'OpenAI',
                operation: 'submission',
                url: `${baseUrl}/v1/batches`,
                init: {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${token}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        input_file_id: file.id,
                        endpoint: '/v1/chat/completions',
                        completion_window: '24h',
                        metadata: {
                            gantry_batch_correlation_id: opts.correlationId,
                        },
                    }),
                },
                signal: opts.signal,
            });
            if (!batch.id) {
                throw new Error('OpenAI batch submission returned no batch id.');
            }
            return { batchId: batch.id };
        }),
        pollBatch: async (opts) => withOpenAiGateway(opts, 1, opts.batchId, async ({ baseUrl, token }) => pollOpenAiBatch(baseUrl, token, opts.batchId, opts.signal)),
        fetchBatchResults: async (opts) => withOpenAiGateway(opts, 1, opts.batchId, async ({ baseUrl, token }) => {
            const batch = await getOpenAiBatch(baseUrl, token, opts.batchId, opts.signal);
            const handles = [batch.output_file_id, batch.error_file_id].filter((id) => Boolean(id));
            if (handles.length === 0) {
                throw new Error('OpenAI batch result has no downloadable result file.');
            }
            const parsed = [];
            const budget = { bytesRead: 0, rowsRead: 0 };
            for (const fileId of handles) {
                parsed.push(...(await fetchBatchJsonl({
                    provider: 'OpenAI',
                    operation: 'result download',
                    url: `${baseUrl}/v1/files/${encodeURIComponent(fileId)}/content`,
                    init: {
                        method: 'GET',
                        headers: { authorization: `Bearer ${token}` },
                    },
                    signal: opts.signal,
                    maxBytes: CHAT_BATCH_RESULT_LIMIT_BYTES,
                    maxRows: CHAT_BATCH_RESULT_LIMIT_ROWS,
                    budget,
                })));
            }
            return parseOpenAiRows(parsed, opts.modelProfile?.runnerModel ?? opts.model);
        }),
        findBatchByCorrelationId: async (opts) => withOpenAiGateway(opts, 1, undefined, async ({ baseUrl, token }) => {
            let after;
            for (let page = 0; page < OPENAI_BATCH_LIST_MAX_PAGES; page += 1) {
                const url = new URL(`${baseUrl}/v1/batches`);
                url.searchParams.set('limit', String(OPENAI_BATCH_LIST_PAGE_LIMIT));
                if (after)
                    url.searchParams.set('after', after);
                const listed = await fetchBatchJson({
                    provider: 'OpenAI',
                    operation: 'reconciliation list',
                    url: url.toString(),
                    init: {
                        method: 'GET',
                        headers: { authorization: `Bearer ${token}` },
                    },
                    signal: opts.signal,
                });
                const match = (listed.data ?? []).find((batch) => batch.metadata?.gantry_batch_correlation_id ===
                    opts.correlationId);
                if (match?.id)
                    return { batchId: match.id };
                if (!listed.has_more)
                    return null;
                after = listed.last_id ?? listed.data?.at(-1)?.id;
                if (!after)
                    return null;
            }
            return null;
        }),
    };
}
async function withOpenAiGateway(scope, modelBatchRequestCount, modelBatchId, fn) {
    scope.signal?.throwIfAborted();
    const provider = requireOpenAiBatchProvider(scope);
    const gateway = await resolveGatewayMemoryInjection({
        appId: scope.appId,
        modelRouteId: provider.id,
        runId: `memory-query:batch:${randomUUID()}`,
        purpose: 'model_batch',
        modelBatchRequestCount,
        ...(modelBatchId ? { modelBatchId } : {}),
    });
    try {
        const projection = provider.gateway.sdkProjection;
        const baseUrl = gateway.injection.env[projection.baseUrlEnv];
        const token = gateway.injection.env[projection.tokenEnv];
        if (!baseUrl || !token?.startsWith('gtw_')) {
            throw new Error('OpenAI chat batch requires a batch-scoped Gantry Model Gateway projection.');
        }
        return await fn({ baseUrl, token });
    }
    finally {
        await gateway.revoke();
    }
}
function requireOpenAiBatchProvider(scope) {
    const routeId = resolveRouteId(scope);
    const provider = routeId ? getModelProviderDefinition(routeId) : undefined;
    if (!provider?.batch || provider.responseFamily !== 'openai') {
        throw new Error(`Memory model route ${routeId ?? 'unknown'} does not support OpenAI chat batches.`);
    }
    return provider;
}
function resolveRouteId(scope) {
    if (scope.modelProfile?.modelRoute)
        return scope.modelProfile.modelRoute;
    return (findModelByRunnerModel(scope.modelProfile?.runnerModel ?? scope.model)
        ?.modelRoute.id ?? undefined);
}
function assertSubmission(correlationId, requests) {
    if (!correlationId.trim()) {
        throw new Error('OpenAI chat batch correlation id is required.');
    }
    if (requests.length === 0) {
        throw new Error('OpenAI chat batch requires at least one request.');
    }
    const ids = new Set();
    for (const request of requests) {
        if (!request.customId.trim() || ids.has(request.customId)) {
            throw new Error('OpenAI chat batch custom ids must be non-empty and unique.');
        }
        ids.add(request.customId);
    }
}
function buildCompletionBody(model, request, maxOutputTokens) {
    const messages = [];
    if (request.systemPrompt) {
        messages.push({ role: 'system', content: request.systemPrompt });
    }
    if (request.userBlocks?.length) {
        for (const block of request.userBlocks) {
            messages.push({ role: 'user', content: block.text });
        }
    }
    else {
        messages.push({ role: 'user', content: request.prompt });
    }
    return {
        model,
        messages,
        ...(maxOutputTokens ? { max_completion_tokens: maxOutputTokens } : {}),
        ...(request.responseSchema
            ? {
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: request.responseSchema.name,
                        ...(request.responseSchema.description
                            ? { description: request.responseSchema.description }
                            : {}),
                        strict: true,
                        schema: request.responseSchema.schema,
                    },
                },
            }
            : {}),
    };
}
async function pollOpenAiBatch(baseUrl, token, batchId, signal) {
    const batch = await getOpenAiBatch(baseUrl, token, batchId, signal);
    return {
        batchId,
        state: mapOpenAiBatchState(batch.status),
        ...(batch.errors
            ? { error: JSON.stringify(batch.errors).slice(0, 300) }
            : {}),
    };
}
function getOpenAiBatch(baseUrl, token, batchId, signal) {
    return fetchBatchJson({
        provider: 'OpenAI',
        operation: 'poll',
        url: `${baseUrl}/v1/batches/${encodeURIComponent(batchId)}`,
        init: {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` },
        },
        signal,
    });
}
function mapOpenAiBatchState(status) {
    switch (status) {
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        case 'expired':
            return 'expired';
        case 'cancelled':
            return 'cancelled';
        default:
            return 'pending';
    }
}
function parseOpenAiRows(rows, model) {
    const result = [];
    const ids = new Set();
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('OpenAI batch result row must be an object.');
        }
        const row = raw;
        if (!row.custom_id || ids.has(row.custom_id)) {
            throw new Error('OpenAI batch result custom ids must be present and unique.');
        }
        ids.add(row.custom_id);
        const body = row.response?.body;
        const error = row.error ?? body?.error;
        if (error !== undefined) {
            result.push({
                customId: row.custom_id,
                error: stringifyError(error),
            });
            continue;
        }
        const statusCode = row.response?.status_code;
        if (typeof statusCode === 'number' &&
            (statusCode < 200 || statusCode >= 300)) {
            result.push({
                customId: row.custom_id,
                error: `OpenAI batch request failed with status ${statusCode}.`,
            });
            continue;
        }
        const text = (body?.choices ?? [])
            .map((choice) => choice.message?.content ?? '')
            .join('')
            .trim();
        result.push({
            customId: row.custom_id,
            ...(text
                ? { text }
                : { error: 'OpenAI batch result contained no completion text.' }),
            ...(body?.usage ? { usage: openAiUsage(body, model) } : {}),
        });
    }
    return result;
}
function openAiUsage(body, model) {
    const usage = body?.usage ?? {};
    const promptTokens = finiteNumber(usage.prompt_tokens) ?? 0;
    const cachedTokens = finiteNumber(usage.prompt_tokens_details
        ?.cached_tokens) ?? 0;
    const normalized = {
        input_tokens: promptTokens,
        output_tokens: finiteNumber(usage.completion_tokens) ?? 0,
        ...(cachedTokens ? { cache_read_input_tokens: cachedTokens } : {}),
    };
    return {
        ...normalized,
        provider_reported_cost_usd: estimateChatBatchCostUsd(model, normalized),
    };
}
function buildOpenAiBatchInput(opts) {
    assertSubmission(opts.correlationId, opts.requests);
    const input = opts.requests
        .map((request) => JSON.stringify({
        custom_id: request.customId,
        method: 'POST',
        url: '/v1/chat/completions',
        body: buildCompletionBody(opts.model, request, opts.maxOutputTokens),
    }))
        .join('\n');
    assertChatBatchUploadSize(input, 'OpenAI');
    return input;
}
function stringifyError(error) {
    if (typeof error === 'string')
        return error.slice(0, 300);
    return JSON.stringify(error ?? {}).slice(0, 300);
}
