export interface SDKTextBlock {
    type: 'text';
    text: string;
}
interface SDKUserMessage {
    type: 'user';
    message: {
        role: 'user';
        content: string | SDKTextBlock[];
    };
    parent_tool_use_id: null;
    session_id: string;
}
/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
export declare class MessageStream {
    private queue;
    private waiting;
    private done;
    pushInitialPrompt(prompt: string, memoryContext?: string): void;
    pushContent(content: string | SDKTextBlock[]): void;
    end(): void;
    [Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage>;
}
export {};
