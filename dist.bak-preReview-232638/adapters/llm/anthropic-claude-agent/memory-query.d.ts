import { type ClaudeAuthMode } from '../../../config/index.js';
import type { AppId } from '../../../domain/app/app.js';
import type { MemoryLlmModelProfile } from '../../../domain/ports/memory-llm-client.js';
export interface ClaudeQueryOpts {
    appId: AppId;
    model: string;
    modelProfile?: MemoryLlmModelProfile;
    prompt: string;
    systemPrompt?: string;
    userBlocks?: Array<{
        text: string;
        cacheStatic?: boolean;
    }>;
    onUsage?: (usage: ClaudeUsage) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export interface ClaudeUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}
export interface ClaudeAuthAvailability {
    hasOauthToken: boolean;
    hasApiKey: boolean;
    mode: ClaudeAuthMode;
}
export declare function getClaudeAuthAvailability(): ClaudeAuthAvailability;
export declare function hasClaudeAuthConfigured(): boolean;
export declare function runClaudeQuery(opts: ClaudeQueryOpts): Promise<string>;
