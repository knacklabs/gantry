import { type EffortLevel, type ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import type { SessionSlashCommand } from './types.js';
import type { AgentPersona } from '../../../../shared/agent-persona.js';
interface SessionSlashRunOptions {
    command: string;
    kind: 'model';
    sdkEnv: Record<string, string | undefined>;
    assistantName?: string;
    configuredModel?: string;
    configuredThinking?: ThinkingConfig;
    configuredEffort?: EffortLevel;
    systemPromptAppend?: string;
    persona?: AgentPersona;
    silent?: boolean;
}
interface SessionSlashRunResult {
    status: 'success' | 'error';
    newSessionId?: string;
    hadError: boolean;
    resultEmitted: boolean;
    error?: string;
}
export declare function parseSessionSlashCommand(prompt: string): SessionSlashCommand | null;
export declare function runSessionSlashCommand(opts: SessionSlashRunOptions): Promise<SessionSlashRunResult>;
export {};
