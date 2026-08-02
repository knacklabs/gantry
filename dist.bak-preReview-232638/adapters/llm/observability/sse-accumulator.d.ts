export { createSseFrameSplitter, isOpenAiUsageOnlyFrame, sseFrameData, type SseFrameSplitter, } from './sse-frame-splitter.js';
export type SseStreamKind = 'anthropic' | 'openai';
export interface SseToolCall {
    id?: string;
    name?: string;
    arguments?: unknown;
    mcpServer?: string;
    choiceIndex?: number;
    complete?: boolean;
    correlationArguments?: unknown;
}
export interface SseAssistantMessage {
    [key: string]: unknown;
    role: 'assistant';
    content?: unknown;
    tool_calls?: Array<{
        id?: string;
        type: 'function';
        function: {
            name?: string;
            arguments?: unknown;
        };
    }>;
}
export interface SseAccumulatorResult {
    model?: string;
    usage?: Record<string, unknown>;
    completionText?: string;
    toolCalls?: SseToolCall[];
    assistantMessage?: SseAssistantMessage;
    assistantMessages?: SseAssistantMessage[];
    finishReason?: string;
    finishReasons?: string[];
    errorMessage?: string;
}
export interface SseAccumulator {
    push: (chunk: Buffer) => void;
    pushFrame: (frame: string) => void;
    takeToolCallsReady: () => boolean;
    result: () => SseAccumulatorResult;
}
export declare function createSseAccumulator(kind: SseStreamKind, captureContent: boolean): SseAccumulator;
