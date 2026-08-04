import { nowIso } from '../../../../shared/time/datetime.js';
import { buildTaskLifecycleRuntimeEvent, } from '../../../../runner/task-lifecycle-events.js';
const GANTRY_TASK_LIFECYCLE_EVENT = Symbol('GantryTaskLifecycleStreamEvent');
const GANTRY_TASK_LIFECYCLE_EVENT_NAME = 'gantry_task_lifecycle';
export function buildGantryTaskLifecycleStreamEvent(input) {
    const event = {
        event: GANTRY_TASK_LIFECYCLE_EVENT_NAME,
        data: { output: input },
    };
    Object.defineProperty(event, GANTRY_TASK_LIFECYCLE_EVENT, {
        value: true,
        enumerable: false,
    });
    return event;
}
export async function normalizeDeepAgentStream(input) {
    const usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
    let accumulatedText = '';
    let sawPartialText = false;
    let sawFirstEvent = false;
    let sawFirstVisibleText = false;
    for await (const event of input.events) {
        if (!sawFirstEvent) {
            sawFirstEvent = true;
            input.onFirstEvent?.(event.event);
        }
        if (event.event === 'on_chat_model_stream') {
            const chunk = event.data?.chunk;
            accumulateUsageFromChunk(chunk, usage);
            const delta = textFromChunk(chunk);
            if (delta) {
                if (!sawFirstVisibleText) {
                    sawFirstVisibleText = true;
                    input.onFirstVisibleText?.();
                }
                accumulatedText += delta;
                sawPartialText = true;
                input.emit({
                    status: 'success',
                    result: delta,
                    newSessionId: input.newSessionId,
                });
            }
            continue;
        }
        if (event.event === 'on_chat_model_end') {
            accumulateUsageFromChunk(event.data?.output, usage);
            continue;
        }
        if (event.event === 'on_tool_start' && typeof event.name === 'string') {
            input.onToolStart?.(event.name);
        }
        const taskEvent = taskLifecycleRuntimeEventFromStreamEvent(input.runtimeEventContext, event);
        if (taskEvent) {
            input.emit({
                status: 'success',
                result: null,
                newSessionId: input.newSessionId,
                runtimeEventOnly: true,
                runtimeEvents: [taskEvent],
            });
        }
    }
    // The terminal frame is emitted by the caller (runner index) so there is
    // exactly one terminal marker per user-visible turn and it can carry the
    // continuation/stop decision. The normalizer only streams deltas.
    return {
        text: accumulatedText,
        usage,
        terminalResult: sawPartialText ? null : accumulatedText || null,
        terminalUsage: normalizedUsage(usage, input.modelId, input.cacheProvider),
        terminalContextUsage: contextUsageSnapshot(usage, input.modelId, input.modelProfile),
    };
}
function taskLifecycleRuntimeEventFromStreamEvent(context, event) {
    if (!context || !isGantryTaskLifecycleStreamEvent(event))
        return null;
    return buildTaskLifecycleRuntimeEvent(context, taskLifecycleInputFromValue(event.data?.output));
}
function isGantryTaskLifecycleStreamEvent(event) {
    return (event.event === GANTRY_TASK_LIFECYCLE_EVENT_NAME &&
        event[GANTRY_TASK_LIFECYCLE_EVENT] === true);
}
function taskLifecycleInputFromValue(value) {
    if (!value || typeof value !== 'object') {
        return { kind: 'notification', taskId: '' };
    }
    const record = value;
    const kind = taskLifecycleKind(record.kind);
    const patch = record.patch && typeof record.patch === 'object'
        ? record.patch
        : {};
    return {
        kind,
        taskId: stringField(record, 'taskId') ?? '',
        toolUseId: stringField(record, 'toolUseId'),
        description: stringField(record, 'description'),
        subagentType: stringField(record, 'subagentType'),
        taskType: stringField(record, 'taskType'),
        workflowName: stringField(record, 'workflowName'),
        skipTranscript: record.skipTranscript === true,
        lastToolName: stringField(record, 'lastToolName'),
        summary: stringField(record, 'summary'),
        status: stringField(record, 'status'),
        usage: taskLifecycleUsage(record.usage),
        patch: {
            status: stringField(patch, 'status'),
            description: stringField(patch, 'description'),
            endTime: numberField(patch, 'endTime'),
            totalPausedMs: numberField(patch, 'totalPausedMs'),
            isBackgrounded: typeof patch.isBackgrounded === 'boolean'
                ? patch.isBackgrounded
                : undefined,
            hasError: patch.hasError === true,
        },
    };
}
function taskLifecycleKind(value) {
    return value === 'started' ||
        value === 'progress' ||
        value === 'updated' ||
        value === 'notification'
        ? value
        : 'notification';
}
function taskLifecycleUsage(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const record = value;
    return {
        totalTokens: numberField(record, 'totalTokens'),
        toolUses: numberField(record, 'toolUses'),
        durationMs: numberField(record, 'durationMs'),
    };
}
function stringField(value, key) {
    const field = value[key];
    return typeof field === 'string' && field.trim().length > 0
        ? field
        : undefined;
}
function numberField(value, key) {
    const field = value[key];
    return typeof field === 'number' && Number.isFinite(field)
        ? field
        : undefined;
}
function textFromChunk(chunk) {
    if (!chunk || typeof chunk !== 'object')
        return '';
    const record = chunk;
    if (Array.isArray(record.contentBlocks)) {
        return textFromContent(record.contentBlocks);
    }
    if (Array.isArray(record.content_blocks)) {
        return textFromContent(record.content_blocks);
    }
    return textFromContent(record.content);
}
function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content.map(textFromContentPart).join('');
    }
    return '';
}
function textFromContentPart(part) {
    if (typeof part === 'string')
        return part;
    if (part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        typeof part.text === 'string') {
        return part.text;
    }
    return '';
}
function accumulateUsageFromChunk(chunk, usage) {
    if (!chunk || typeof chunk !== 'object')
        return;
    const metadata = chunk.usage_metadata;
    const input = readNumber(readPath(metadata, 'input_tokens'));
    const output = readNumber(readPath(metadata, 'output_tokens'));
    // usage_metadata on AIMessageChunks is cumulative for a single model turn, so
    // keep the largest seen rather than summing partial deltas.
    if (input > usage.inputTokens)
        usage.inputTokens = input;
    if (output > usage.outputTokens)
        usage.outputTokens = output;
    // Cache reads/writes ride on the final/cumulative chunk and are read off BOTH
    // shapes, preferring the raw provider fields when present:
    //   - raw provider usage on response_metadata.usage.prompt_tokens_details.*
    //     ({cached_tokens, cache_write_tokens}). ChatOpenAI surfaces this on its
    //     final empty chunk; the fake OpenRouter gateway also carries it. Writes
    //     are ONLY available here (no LangChain-normalized name exists).
    //   - LangChain's normalized usage_metadata.input_token_details.cache_read /
    //     .cache_creation. ChatOpenRouter only maps cached_tokens -> cache_read,
    //     so reads land here even when the raw usage is absent.
    const rawUsage = readPath(chunk, 'response_metadata.usage');
    // Cache-read field varies by upstream provider, so read the FIRST present:
    //   - prompt_tokens_details.cached_tokens (OpenAI / Groq / xAI / Fireworks /
    //     Cerebras / Gemini / OpenRouter — nested);
    //   - prompt_cache_hit_tokens (DeepSeek — flat, alongside
    //     prompt_cache_miss_tokens);
    //   - cached_tokens (Together — flat);
    //   - the LangChain-normalized usage_metadata.input_token_details.cache_read
    //     fallback.
    const cacheRead = firstFinite(readPath(rawUsage, 'prompt_tokens_details.cached_tokens'), readPath(rawUsage, 'prompt_cache_hit_tokens'), readPath(rawUsage, 'cached_tokens'), readPath(metadata, 'input_token_details.cache_read'));
    const cacheWrite = firstFinite(readPath(rawUsage, 'prompt_tokens_details.cache_write_tokens'), readPath(metadata, 'input_token_details.cache_creation'));
    // Cumulative-per-turn, same as input/output: keep the largest seen.
    if (cacheRead > usage.cacheReadTokens)
        usage.cacheReadTokens = cacheRead;
    if (cacheWrite > usage.cacheWriteTokens)
        usage.cacheWriteTokens = cacheWrite;
}
function readNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
// First finite number among the candidates (provider raw field preferred over
// the LangChain-normalized one). Returns 0 when none is a finite number.
function firstFinite(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
    }
    return 0;
}
// Safe dotted-path read over an unknown object graph (mirrors the host
// normalizer's readPath in shared/model-usage.ts).
function readPath(input, path) {
    let cursor = input;
    for (const segment of path.split('.')) {
        if (cursor === null || typeof cursor !== 'object')
            return undefined;
        cursor = cursor[segment];
    }
    return cursor;
}
function normalizedUsage(usage, modelId, cacheProvider) {
    const provider = cacheProvider ?? 'none';
    // A prompt-cache lane (openai/openrouter-provider) supports cache accounting;
    // 'none' means the model has no prompt cache so reads/writes are unsupported.
    const supportsCacheAccounting = provider !== 'none';
    const cacheReadTokens = supportsCacheAccounting ? usage.cacheReadTokens : 0;
    const cacheWriteTokens = supportsCacheAccounting ? usage.cacheWriteTokens : 0;
    return {
        ...(modelId ? { model: modelId } : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        // Cache reads are already counted inside input_tokens, so the billable
        // (non-cached) input is input - reads (mirrors the host normalizer).
        totalBillableInputTokens: supportsCacheAccounting
            ? Math.max(0, usage.inputTokens - cacheReadTokens)
            : usage.inputTokens,
        cacheProvider: provider,
        cacheStatus: cacheStatusFor(cacheReadTokens, cacheWriteTokens, supportsCacheAccounting),
        at: nowIso(),
    };
}
// Cache-status mapping identical to the host normalizer
// (shared/model-usage.ts normalizeCacheStatus): on a supported lane, reads+
// writes -> 'partial', reads -> 'hit', writes -> 'miss', neither -> 'unknown';
// an unsupported lane is always 'unsupported'.
function cacheStatusFor(read, write, supported) {
    if (!supported)
        return 'unsupported';
    if (read > 0 && write > 0)
        return 'partial';
    if (read > 0)
        return 'hit';
    if (write > 0)
        return 'miss';
    return 'unknown';
}
function contextUsageSnapshot(usage, modelId, profile) {
    const maxTokens = profile.maxInputTokens ?? 0;
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const percentage = maxTokens > 0 ? Math.min(100, (totalTokens / maxTokens) * 100) : 0;
    return {
        totalTokens,
        maxTokens,
        percentage,
        ...(modelId ? { model: modelId } : {}),
        categories: [],
        apiUsage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
        },
        at: nowIso(),
    };
}
