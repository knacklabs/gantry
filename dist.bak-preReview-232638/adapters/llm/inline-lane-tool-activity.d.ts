import type { RunnerOutputFrame } from '../../runner/runner-frame.js';
interface ToolActivityLaneInput {
    input: {
        isScheduledJob?: boolean;
        appId?: string;
        agentId?: string;
        runId?: string;
        jobId?: string;
        chatJid: string;
        threadId?: string;
    };
    coreTools: {
        tools: readonly {
            name: string;
        }[];
    };
    emitOutput(output: RunnerOutputFrame): Promise<void>;
}
export interface InlineToolActivity {
    run<T>(toolName: string, operation: () => Promise<T>): Promise<T>;
    start(id: string, toolName: string): Promise<void>;
    finish(id: string, toolName: string, outcome: 'success' | 'failure'): Promise<void>;
    close(): void;
}
export declare function createInlineToolActivity(input: ToolActivityLaneInput): InlineToolActivity;
export {};
