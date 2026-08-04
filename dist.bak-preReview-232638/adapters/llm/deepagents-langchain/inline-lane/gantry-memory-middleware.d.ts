import { type BaseMessage } from '@langchain/core/messages';
import { createAgentMemoryMiddleware } from 'deepagents';
import type { ProviderInlineAgentLoopLane } from '../../inline-lane-dispatcher.js';
export declare function buildInlineTurnMessages(prompt: string, memoryContextBlock?: string): BaseMessage[];
export declare function createGantryScopedMemoryMiddleware(input: {
    currentQuery: () => string;
    searchMemory(query: string): Promise<string>;
}): ReturnType<typeof createAgentMemoryMiddleware>;
export declare function searchGantryScopedMemory(input: Parameters<ProviderInlineAgentLoopLane>[0], query: string, signal: AbortSignal): Promise<string>;
