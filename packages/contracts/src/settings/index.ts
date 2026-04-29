import { z } from 'zod';

export const RuntimeSettingsPublicSchema = z
  .object({
    agent: z
      .object({
        name: z.string(),
        defaultModel: z.string(),
      })
      .strict(),
    memory: z
      .object({
        enabled: z.boolean(),
        dreaming: z
          .object({
            enabled: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type RuntimeSettingsPublic = z.infer<typeof RuntimeSettingsPublicSchema>;

export const RuntimeSettingsResponseSchema = z
  .object({
    settings: RuntimeSettingsPublicSchema,
  })
  .strict();
export type RuntimeSettingsResponse = z.infer<
  typeof RuntimeSettingsResponseSchema
>;

export const UpdateRuntimeSettingsRequestSchema = z
  .object({
    agent: z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        defaultModel: z.string().optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        enabled: z.boolean().optional(),
        dreaming: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type UpdateRuntimeSettingsRequest = z.infer<
  typeof UpdateRuntimeSettingsRequestSchema
>;

export const UpdateRuntimeSettingsResponseSchema = z
  .object({
    settings: RuntimeSettingsPublicSchema,
    changed: z.array(z.string()),
    restartRequired: z.boolean(),
  })
  .strict();
export type UpdateRuntimeSettingsResponse = z.infer<
  typeof UpdateRuntimeSettingsResponseSchema
>;
