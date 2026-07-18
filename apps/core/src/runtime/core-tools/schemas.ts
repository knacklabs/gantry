import {
  createCallableAgentToolSchema,
  type CallableAgentToolInput,
} from '../../application/core-tools/callable-agent-tools.js';

interface ZodFactory {
  object(shape: Record<string, unknown>): any;
  string(): any;
  number(): any;
  boolean(): any;
  array(schema: unknown): any;
  enum(values: readonly string[]): any;
}

export interface CoreToolInputSchema<Output> {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: Output }
    | { success: false; error: { issues: Array<{ message: string }> } };
}

export type CoreToolInputByName = {
  send_message: {
    text: string;
    files?: Array<{ scope?: string; path: string; version?: number }>;
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
  memory_search: { query: string; workspace_folder?: string; limit?: number };
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
  task_get: { taskId: string };
  task_list: Record<string, never>;
  task_cancel: { taskId: string };
  task_message: { taskId: string; message: string };
};

export type CoreToolSchemas = {
  [Name in keyof CoreToolInputByName]: CoreToolInputSchema<
    CoreToolInputByName[Name]
  >;
} & { callable_agent: CoreToolInputSchema<CallableAgentToolInput> };

export function createCoreToolSchemas(z: ZodFactory): CoreToolSchemas {
  const taskIdSchema = z.object({ taskId: z.string().min(1).max(160) });
  return {
    send_message: z.object({
      text: z.string(),
      files: z
        .array(
          z.object({
            scope: z.string().optional(),
            path: z.string(),
            version: z.number().int().positive().optional(),
          }),
        )
        .max(5)
        .optional(),
      sender: z.string().optional(),
    }),
    ask_user_question: z.object({
      questions: z
        .array(
          z.object({
            question: z.string(),
            header: z.string().max(12),
            options: z
              .array(
                z.object({
                  label: z.string(),
                  description: z.string(),
                }),
              )
              .min(2)
              .max(4),
            multiSelect: z.boolean().default(false),
          }),
        )
        .min(1)
        .max(4),
    }),
    memory_search: z.object({
      query: z.string(),
      workspace_folder: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    memory_save: z.object({
      scope: z.enum(['user', 'group', 'global']).optional(),
      workspace_folder: z.string().optional(),
      kind: z
        .enum(['preference', 'decision', 'fact', 'correction', 'constraint'])
        .optional(),
      key: z.string(),
      value: z.string(),
      confidence: z.number().min(0).max(1).optional(),
      source: z.string().optional(),
    }),
    delegate_task: z.object({
      objective: z.string().min(1).max(10_000),
      context: z.string().max(20_000).optional(),
      expectedOutput: z.string().max(2_000).optional(),
      targetAgentId: z.string().min(1).max(160).optional(),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(30 * 60_000)
        .optional(),
    }),
    callable_agent: createCallableAgentToolSchema(z),
    task_get: taskIdSchema,
    task_list: z.object({}),
    task_cancel: taskIdSchema,
    task_message: z.object({
      taskId: z.string().min(1).max(160),
      message: z.string().min(1).max(10_000),
    }),
  };
}
