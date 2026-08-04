import { type CallableAgentToolInput } from '../../application/core-tools/callable-agent-tools.js';
import type { CoreMessageFile } from '../../application/core-tools/send-message.js';
interface ZodFactory {
    object(shape: Record<string, unknown>): any;
    string(): any;
    number(): any;
    boolean(): any;
    array(schema: unknown): any;
    enum(values: readonly string[]): any;
    literal(value: string): any;
    union(options: readonly unknown[]): any;
}
export interface CoreToolInputSchema<Output> {
    safeParse(input: unknown): {
        success: true;
        data: Output;
    } | {
        success: false;
        error: {
            issues: Array<{
                message: string;
            }>;
        };
    };
}
export type CoreToolInputByName = {
    send_message: {
        text: string;
        files?: CoreMessageFile[];
        sender?: string;
    };
    ask_user_question: {
        questions: Array<{
            question: string;
            header: string;
            options: Array<{
                label: string;
                description: string;
            }>;
            multiSelect: boolean;
        }>;
    };
    memory_search: {
        query: string;
        workspace_folder?: string;
        limit?: number;
    };
    memory_save: {
        scope?: 'user' | 'group' | 'global';
        workspace_folder?: string;
        kind?: 'preference' | 'decision' | 'fact' | 'correction' | 'constraint';
        key: string;
        value: string;
        confidence?: number;
        source?: string;
    };
    delegate_task: {
        objective: string;
        context?: string;
        expectedOutput?: string;
        targetAgentId?: string;
        timeoutMs?: number;
    };
    task_get: {
        taskId: string;
    };
    task_list: Record<string, never>;
    task_cancel: {
        taskId: string;
    };
    task_message: {
        taskId: string;
        message: string;
    };
};
export type CoreToolSchemas = {
    [Name in keyof CoreToolInputByName]: CoreToolInputSchema<CoreToolInputByName[Name]>;
} & {
    callable_agent: CoreToolInputSchema<CallableAgentToolInput>;
};
export declare function createCoreToolSchemas(z: ZodFactory): CoreToolSchemas;
export {};
