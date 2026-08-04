import type { PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { RunScopedToolSuccessLedger } from '../../../../runner/tool-gate-core.js';
export declare function toolResponseIsError(response: unknown): boolean;
export declare function recordSuccessfulToolUse(hookInput: Pick<PostToolUseHookInput, 'tool_name' | 'tool_response'>, toolSuccessLedger: RunScopedToolSuccessLedger): void;
