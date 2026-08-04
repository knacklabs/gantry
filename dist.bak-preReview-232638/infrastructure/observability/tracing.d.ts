import { context, SpanStatusCode, type Context, type Span, type Tracer } from '@opentelemetry/api';
import { type SpanExporter } from '@opentelemetry/sdk-trace-node';
export interface TracingRuntimeConfig {
    enabled: boolean;
    endpoint?: string;
    headers?: Record<string, string>;
    captureContent: boolean;
    sampleRate: number;
    environment?: string;
}
export declare const TRACE_CONTENT_MAX_CHARS = 16000;
export declare const ATTR_PROMPT = "gen_ai.prompt";
export declare const ATTR_COMPLETION = "gen_ai.completion";
export declare function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined;
export declare function initTracing(config: TracingRuntimeConfig, testExporter?: SpanExporter): void;
export declare function shutdownTracing(): Promise<void>;
export declare function tracingEnabled(): boolean;
export declare function contentCaptureEnabled(): boolean;
export declare function tracer(): Tracer | undefined;
export declare function getTurnSpan(runId: string): Span | undefined;
export declare function registerDelegationToolSpan(input: {
    runId: string;
    callId: string;
    objective?: string;
    span: Span;
}): void;
export declare function settleDelegationToolSpan(input: {
    runId: string;
    callId: string;
    taskId?: string;
}): void;
export declare function takeDelegationToolSpan(input: {
    parentRunId: string;
    parentTaskId?: string;
    prompt: string;
}): Span | undefined;
export declare function registerTurnSpanEndCallback(runId: string, callback: () => void): () => void;
export declare function boundedContent(value: string): string;
export declare const MAX_ATTRIBUTE_CHARS = 32768;
export declare function boundedJsonArray(entries: {
    role: string;
    content: string;
}[]): string;
export interface TurnSpanHandle {
    traceId?: string;
    setInput: (content: string) => void;
    setOutput: (content: string) => void;
    end: (outcome: 'success' | 'error' | 'stopped', error?: string) => void;
}
export declare function startTurnSpan(input: {
    runId: string;
    parentRunId?: string;
    appId?: string;
    agentId?: string;
    agentName: string;
    conversationId?: string;
    threadId?: string;
    jobId?: string;
    userId?: string;
    continuation?: boolean;
}, parentContext?: Context): TurnSpanHandle;
export declare function childContextFor(parent: Span): Context;
export { context, SpanStatusCode };
export type { Span };
