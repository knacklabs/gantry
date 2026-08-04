import type { BaseMessage } from '@langchain/core/messages';
export type CachePromptControlMode = 'automatic' | 'explicit' | 'none';
export declare const MAX_CACHE_CONTROL_BREAKPOINTS = 4;
export declare function parseCachePromptControlMode(value: string | undefined): CachePromptControlMode;
export declare function applyCachePromptControl(messages: BaseMessage[], mode: CachePromptControlMode): BaseMessage[];
