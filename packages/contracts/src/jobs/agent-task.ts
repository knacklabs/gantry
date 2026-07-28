import { z } from 'zod';

export const JobAgentTaskSchema = z
  .object({
    responseSchema: z
      .record(z.string(), z.unknown())
      .refine((schema) => schema.type === 'object', {
        message: 'responseSchema root type must be "object"',
      })
      .optional(),
    callerResolvedTools: z
      .object({
        tools: z
          .array(
            z
              .object({
                name: z.string().min(1).max(80),
                description: z.string().min(1).max(1_000),
                inputSchema: z.record(z.string(), z.unknown()),
              })
              .strict(),
          )
          .min(1)
          .max(32),
        maxInteractions: z.number().int().positive().max(256),
        interactionTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(30 * 60_000),
      })
      .strict()
      .optional(),
    delegatedCompletionGate: z
      .object({
        toolName: z.string().min(1).max(80),
        taskKeys: z.array(z.string().min(1).max(80)).min(1).max(32),
        maxNoProgressContinuations: z.number().int().positive().max(10),
      })
      .strict()
      .optional(),
    executionPolicy: z
      .object({
        totalTimeoutMs: z
          .number()
          .int()
          .min(30_000)
          .max(2 * 60 * 60_000),
      })
      .strict(),
    modelControls: z
      .object({
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
        thinking: z
          .union([
            z.object({ mode: z.literal('off') }).strict(),
            z
              .object({
                mode: z.literal('on'),
                budgetTokens: z.number().int().positive().optional(),
              })
              .strict(),
          ])
          .optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    requiredSkill: z
      .object({ name: z.string().min(1), contentHash: z.string().min(1) })
      .strict()
      .optional(),
    interactionBudget: z
      .object({
        maxTotal: z.number().int().positive().max(256),
        scopes: z.record(z.string().min(1), z.number().int().nonnegative()),
      })
      .strict()
      .optional(),
  })
  .strict();

export type JobAgentTask = z.infer<typeof JobAgentTaskSchema>;
