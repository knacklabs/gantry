import { type Span } from '@opentelemetry/api';
import { tracer } from '../../../infrastructure/observability/tracing.js';
import type { SseAccumulatorResult, SseStreamKind } from './sse-accumulator.js';
import { type ToolCall } from './genai-message-attributes.js';
interface PendingToolSpan {
    span: Span;
    startedAt: number;
    delegation: boolean;
    unregisterTurnEnd: () => void;
}
export declare const pendingToolsByRun: Map<string, Map<string, PendingToolSpan>>;
export declare function finishPendingToolSpans(runId: string, kind: SseStreamKind | undefined, request: Record<string, unknown>, captureContent: boolean): void;
export declare function startPendingToolSpans(input: {
    runId: string;
    parent: Span;
    activeTracer: NonNullable<ReturnType<typeof tracer>>;
    toolCalls: ToolCall[];
    captureContent: boolean;
}): void;
export declare function failPendingToolSpans(runId: string, callIds: ReadonlySet<string>): void;
export declare function streamedToolCalls(kind: SseStreamKind | undefined, streamed: SseAccumulatorResult): ToolCall[];
export {};
