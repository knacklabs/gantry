import { z } from 'zod';

const JsonObjectSchema = z.record(z.string(), z.unknown());

function hasObjectResultRoot(schema: Record<string, unknown>): boolean {
  if (schema.type === 'object') return true;
  const variants = schema.oneOf ?? schema.anyOf;
  return (
    Array.isArray(variants) &&
    variants.length > 0 &&
    variants.every(
      (variant) =>
        Boolean(variant) &&
        typeof variant === 'object' &&
        !Array.isArray(variant) &&
        hasObjectResultRoot(variant as Record<string, unknown>),
    )
  );
}

export const JobAgentTaskSchema = z
  .object({
    observability: z
      .object({
        traceparent: z
          .string()
          .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/iu),
      })
      .strict()
      .optional(),
    responseSchema: JsonObjectSchema.refine(
      hasObjectResultRoot,
      'responseSchema must produce only object results',
    ).optional(),
    callerResolvedTools: z
      .object({
        tools: z
          .array(
            z
              .object({
                name: z.string().min(1).max(80),
                description: z.string().min(1).max(1_000),
                inputSchema: JsonObjectSchema,
              })
              .strict(),
          )
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
    completionGate: z
      .object({
        toolName: z.string().min(1).max(80),
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
  })
  .strict();

export type JobAgentTask = z.infer<typeof JobAgentTaskSchema>;
