import { context, diag, DiagLogLevel, ROOT_CONTEXT, SpanStatusCode, trace, } from '@opentelemetry/api';
import { BatchSpanProcessor, NodeTracerProvider, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes, } from '@opentelemetry/resources';
import { logger } from '../logging/logger.js';
export const TRACE_CONTENT_MAX_CHARS = 16_000;
// Legacy gen_ai.prompt/gen_ai.completion keys are what both Langfuse and
// LangSmith map natively today; flip to gen_ai.input.messages /
// gen_ai.output.messages once both backends ingest the newer semconv.
export const ATTR_PROMPT = 'gen_ai.prompt';
export const ATTR_COMPLETION = 'gen_ai.completion';
let state;
const turnSpans = new Map();
const turnSpanEndCallbacks = new Map();
const DELEGATION_PARENT_TTL_MS = 30 * 60_000;
const MAX_DELEGATION_PARENTS = 1024;
const delegationParentsByCall = new Map();
const delegationParentsByTask = new Map();
function removeDelegationParent(entry) {
    if (delegationParentsByCall.get(entry.key) === entry) {
        delegationParentsByCall.delete(entry.key);
    }
    const taskKey = entry.taskId ? `${entry.runId}\0${entry.taskId}` : undefined;
    if (taskKey && delegationParentsByTask.get(taskKey) === entry) {
        delegationParentsByTask.delete(taskKey);
    }
}
function pruneDelegationParents() {
    const now = Date.now();
    for (const entry of delegationParentsByCall.values()) {
        if (entry.expiresAt <= now)
            removeDelegationParent(entry);
    }
    while (delegationParentsByCall.size > MAX_DELEGATION_PARENTS) {
        const oldest = delegationParentsByCall.values().next().value;
        if (!oldest)
            break;
        removeDelegationParent(oldest);
    }
}
function finishTurnChildren(runId) {
    const callbacks = turnSpanEndCallbacks.get(runId);
    turnSpanEndCallbacks.delete(runId);
    for (const callback of callbacks ?? []) {
        try {
            callback();
        }
        catch {
            // fail-open
        }
    }
}
export function parseOtlpHeaders(raw) {
    if (!raw?.trim())
        return undefined;
    const headers = {};
    for (const pair of raw.split(',')) {
        const separator = pair.indexOf('=');
        if (separator <= 0)
            continue;
        const key = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (key)
            headers[key] = value;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}
export function initTracing(config, testExporter) {
    if (!config.enabled || state)
        return;
    const exporter = testExporter ??
        new OTLPTraceExporter({
            ...(config.endpoint ? { url: config.endpoint } : {}),
            ...(config.headers ? { headers: config.headers } : {}),
        });
    const spanProcessor = testExporter
        ? new SimpleSpanProcessor(testExporter)
        : new BatchSpanProcessor(exporter);
    const provider = new NodeTracerProvider({
        resource: defaultResource().merge(resourceFromAttributes({
            'service.name': 'gantry-runtime',
            ...(config.environment
                ? { 'deployment.environment.name': config.environment }
                : {}),
        })),
        sampler: new ParentBasedSampler({
            root: new TraceIdRatioBasedSampler(config.sampleRate),
        }),
        spanLimits: { attributeValueLengthLimit: 32_768 },
        spanProcessors: [spanProcessor],
    });
    diag.setLogger({
        verbose: () => { },
        debug: () => { },
        info: () => { },
        warn: (message) => logger.warn({ message }, 'OTel tracing'),
        error: (message) => logger.warn({ message }, 'OTel tracing error'),
    }, DiagLogLevel.WARN);
    state = {
        provider,
        tracer: provider.getTracer('gantry'),
        captureContent: config.captureContent,
    };
}
export async function shutdownTracing() {
    const current = state;
    for (const runId of turnSpanEndCallbacks.keys())
        finishTurnChildren(runId);
    state = undefined;
    turnSpans.clear();
    turnSpanEndCallbacks.clear();
    delegationParentsByCall.clear();
    delegationParentsByTask.clear();
    if (!current)
        return;
    try {
        await current.provider.shutdown();
    }
    catch (err) {
        logger.warn({ err: String(err) }, 'OTel tracing shutdown failed');
    }
}
export function tracingEnabled() {
    return state !== undefined;
}
export function contentCaptureEnabled() {
    return state?.captureContent ?? false;
}
export function tracer() {
    return state?.tracer;
}
export function getTurnSpan(runId) {
    return turnSpans.get(runId);
}
export function registerDelegationToolSpan(input) {
    if (!state || !turnSpans.has(input.runId))
        return;
    pruneDelegationParents();
    const key = `${input.runId}\0${input.callId}`;
    const existing = delegationParentsByCall.get(key);
    if (existing)
        removeDelegationParent(existing);
    delegationParentsByCall.set(key, {
        key,
        runId: input.runId,
        callId: input.callId,
        ...(input.objective?.trim() ? { objective: input.objective.trim() } : {}),
        span: input.span,
        expiresAt: Date.now() + DELEGATION_PARENT_TTL_MS,
    });
    pruneDelegationParents();
}
export function settleDelegationToolSpan(input) {
    pruneDelegationParents();
    const entry = delegationParentsByCall.get(`${input.runId}\0${input.callId}`);
    if (!entry)
        return;
    if (!input.taskId) {
        removeDelegationParent(entry);
        return;
    }
    entry.taskId = input.taskId;
    delegationParentsByTask.set(`${entry.runId}\0${input.taskId}`, entry);
}
export function takeDelegationToolSpan(input) {
    pruneDelegationParents();
    let entry = input.parentTaskId
        ? delegationParentsByTask.get(`${input.parentRunId}\0${input.parentTaskId}`)
        : undefined;
    if (!entry) {
        const candidates = [...delegationParentsByCall.values()].filter((candidate) => candidate.runId === input.parentRunId);
        const objectiveMatches = candidates.filter((candidate) => candidate.objective && input.prompt.includes(candidate.objective));
        entry =
            objectiveMatches.length === 1
                ? objectiveMatches[0]
                : candidates.length === 1
                    ? candidates[0]
                    : undefined;
    }
    if (!entry)
        return undefined;
    removeDelegationParent(entry);
    return entry.span;
}
export function registerTurnSpanEndCallback(runId, callback) {
    if (!state || !turnSpans.has(runId))
        return () => { };
    const callbacks = turnSpanEndCallbacks.get(runId) ?? new Set();
    callbacks.add(callback);
    turnSpanEndCallbacks.set(runId, callbacks);
    return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0)
            turnSpanEndCallbacks.delete(runId);
    };
}
export function boundedContent(value) {
    return value.length > TRACE_CONTENT_MAX_CHARS
        ? `${value.slice(0, TRACE_CONTENT_MAX_CHARS)}…[truncated]`
        : value;
}
export const MAX_ATTRIBUTE_CHARS = 32_768;
const TRUNCATION_SUFFIX = '…[truncated]';
const MIN_ENTRY_CONTENT = 256;
// Serialize message arrays to VALID JSON that fits the OTel attribute value
// limit — the SDK's own limit cuts mid-string, producing unparseable
// content, and JSON escaping (control chars → \uXXXX) can inflate bounded
// raw text past the limit. Geometric halving keeps this ~linear in the
// input size, unlike per-entry re-serialization.
export function boundedJsonArray(entries) {
    // Pass 1: geometric halving of oversized content (~linear overall).
    let serialized = JSON.stringify(entries);
    while (serialized.length > MAX_ATTRIBUTE_CHARS) {
        let shrunk = false;
        for (const entry of entries) {
            if (entry.content.length > MIN_ENTRY_CONTENT) {
                const base = entry.content.endsWith(TRUNCATION_SUFFIX)
                    ? entry.content.slice(0, -TRUNCATION_SUFFIX.length)
                    : entry.content;
                entry.content =
                    base.slice(0, Math.floor(base.length / 2)) + TRUNCATION_SUFFIX;
                shrunk = true;
            }
        }
        if (!shrunk)
            break;
        serialized = JSON.stringify(entries);
    }
    if (serialized.length <= MAX_ATTRIBUTE_CHARS)
        return serialized;
    // Pass 2: too many short entries — keep the largest suffix (most recent
    // messages) that fits, in one O(n) walk; popping one entry per full
    // re-serialization would be quadratic on the request hot path.
    let budget = MAX_ATTRIBUTE_CHARS - 2;
    const kept = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const cost = JSON.stringify(entries[index]).length + 1;
        if (cost > budget)
            break;
        budget -= cost;
        kept.push(entries[index]);
    }
    kept.reverse();
    return JSON.stringify(kept);
}
const NOOP_TURN_SPAN = {
    setInput: () => { },
    setOutput: () => { },
    end: () => { },
};
export function startTurnSpan(input, parentContext) {
    const current = state;
    if (!current)
        return NOOP_TURN_SPAN;
    try {
        const span = current.tracer.startSpan(`invoke_agent ${input.agentName}`, {
            attributes: {
                'gen_ai.operation.name': 'invoke_agent',
                'gen_ai.agent.name': input.agentName,
                ...(input.agentId ? { 'gen_ai.agent.id': input.agentId } : {}),
                ...(input.conversationId
                    ? { 'session.id': input.conversationId }
                    : {}),
                ...(input.userId ? { 'user.id': input.userId } : {}),
                ...(input.appId ? { 'gantry.app_id': input.appId } : {}),
                'gantry.run_id': input.runId,
                ...(input.parentRunId
                    ? { 'gantry.parent_run_id': input.parentRunId }
                    : {}),
                ...(input.jobId ? { 'gantry.job_id': input.jobId } : {}),
                ...(input.threadId ? { 'gantry.thread_id': input.threadId } : {}),
                ...(input.continuation ? { 'gantry.continuation': true } : {}),
            },
        }, parentContext);
        turnSpans.set(input.runId, span);
        let ended = false;
        return {
            traceId: span.spanContext().traceId,
            setInput: (content) => {
                if (!ended && current.captureContent) {
                    span.setAttribute(ATTR_PROMPT, boundedJsonArray([
                        { role: 'user', content: boundedContent(content) },
                    ]));
                }
            },
            setOutput: (content) => {
                if (!ended && current.captureContent) {
                    span.setAttribute(ATTR_COMPLETION, boundedJsonArray([
                        { role: 'assistant', content: boundedContent(content) },
                    ]));
                }
            },
            end: (outcome, error) => {
                if (ended)
                    return;
                ended = true;
                finishTurnChildren(input.runId);
                turnSpans.delete(input.runId);
                try {
                    span.setAttribute('gantry.turn_outcome', outcome);
                    if (outcome === 'error') {
                        // Runner errors can echo prompt/result text; honor capture_content.
                        span.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: error
                                ? current.captureContent
                                    ? boundedContent(error)
                                    : 'agent turn failed'
                                : undefined,
                        });
                    }
                    span.end();
                }
                catch (err) {
                    logger.warn({ err: String(err) }, 'Failed to end turn span');
                }
            },
        };
    }
    catch (err) {
        logger.warn({ err: String(err) }, 'Failed to start turn span');
        return NOOP_TURN_SPAN;
    }
}
export function childContextFor(parent) {
    return trace.setSpan(ROOT_CONTEXT, parent);
}
export { context, SpanStatusCode };
