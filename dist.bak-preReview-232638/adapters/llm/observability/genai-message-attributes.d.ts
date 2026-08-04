import type { Span } from '@opentelemetry/api';
import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
import type { SseStreamKind, SseToolCall } from './sse-accumulator.js';
export declare const ATTR_INPUT_MESSAGES = "gen_ai.input.messages";
export declare const ATTR_OUTPUT_MESSAGES = "gen_ai.output.messages";
export declare const TRUNCATION_SUFFIX = "\u2026[truncated]";
export declare const MAX_TOOL_CALLS = 128;
export interface ToolCall extends SseToolCall {
    id: string;
    name: string;
    choiceIndex?: number;
    complete: boolean;
}
export interface ToolResult {
    id: string;
    content: unknown;
    status: 'success' | 'error' | 'unknown';
}
export declare function boundedTraceValue(value: unknown, stringLimit: number, arrayLimit: number, depth?: number): unknown;
export declare function setMessageAttributes(span: Span, legacyKey: string, currentKey: string, messages: Record<string, unknown>[], kind: SseStreamKind | undefined): void;
export declare function providerSystemFor(providerId: string): string;
export declare function providerNameFor(providerId: string): string;
export declare function numeric(value: unknown): number | undefined;
export declare function boundedToolValue(value: unknown): unknown;
export declare function boundedToolJson(value: unknown): string;
export declare function boundedToolIdentity(value: string): string;
export declare function promptMessages(request: Record<string, unknown>): Record<string, unknown>[];
export declare function responseAssistantMessages(kind: SseStreamKind | undefined, response: Record<string, unknown>): Record<string, unknown>[];
export declare function responseToolCalls(kind: SseStreamKind | undefined, response: Record<string, unknown>): ToolCall[];
export declare function requestToolResults(kind: SseStreamKind | undefined, request: Record<string, unknown>): ToolResult[];
export declare function setUsageAttributes(span: Span, usage: Record<string, unknown>, kind: SseStreamKind | undefined): void;
export declare function setNormalizedUsageAttributes(span: Span, usage: NormalizedModelUsage, kind: SseStreamKind | undefined, rawUsage?: Record<string, unknown>): void;
