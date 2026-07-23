import { z } from 'zod';

import { isAbsoluteFilePath } from '../../../shared/path-validation.js';

const schedulerImplementationSchema = z.object({
  kind: z.enum([
    'configured_access',
    'local_cli',
    'mcp_server',
    'builtin_tool',
  ]),
  name: z.string().optional().describe('Human-readable implementation name'),
  executable_path: z.string().optional(),
  executable_version: z.string().optional(),
  executable_hash: z.string().optional(),
  command_template: z.string().optional(),
  auth_preflight: z.string().optional(),
  protected_paths: z.array(z.string()).optional(),
  network_hosts: z.array(z.string()).optional(),
});

function validateLocalCliImplementation(
  implementation: z.infer<typeof schedulerImplementationSchema> | undefined,
  ctx: z.RefinementCtx,
  basePath: (string | number)[] = [],
): void {
  if (implementation?.kind !== 'local_cli') return;
  const executablePath = implementation.executable_path?.trim();
  const commandTemplate = implementation.command_template?.trim();
  const at = (field: string) => [...basePath, 'implementation', field];
  if (!executablePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: at('executable_path'),
      message: 'local_cli executable_path is required.',
    });
    return;
  }
  if (!isAbsoluteFilePath(executablePath)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: at('executable_path'),
      message: 'local_cli executable_path must be absolute.',
    });
  }
  if (!implementation.executable_version?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: at('executable_version'),
      message: 'local_cli executable_version is required.',
    });
  }
  if (!implementation.executable_hash?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: at('executable_hash'),
      message: 'local_cli executable_hash is required.',
    });
  }
  if (!commandTemplate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: at('command_template'),
      message: 'local_cli command_template is required.',
    });
    return;
  }
  if (commandTemplate.split(/\s+/)[0] !== executablePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: at('command_template'),
      message: 'local_cli command_template must start with executable_path.',
    });
  }
  const authPreflight = implementation.auth_preflight?.trim();
  if (authPreflight && authPreflight.split(/\s+/)[0] !== executablePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: at('auth_preflight'),
      message: 'local_cli auth_preflight must start with executable_path.',
    });
  }
}

export const schedulerAccessRequirementSchema = z
  .object({
    target: z.union([
      z
        .object({
          kind: z.literal('tool_rule'),
          rule: z
            .string()
            .describe(
              'Readable tool rule: capability:<id>, Browser, exact mcp__gantry__ tool, or scoped RunCommand(...).',
            ),
        })
        .strict(),
      z
        .object({
          kind: z.literal('capability'),
          capability_id: z.string(),
          implementation: schedulerImplementationSchema.optional(),
        })
        .strict(),
      z.object({ kind: z.literal('mcp_server'), server: z.string() }).strict(),
    ]),
    reason: z.string().optional().describe('Why this job needs the access'),
  })
  .superRefine((value, ctx) => {
    if (value.target.kind === 'capability') {
      validateLocalCliImplementation(value.target.implementation, ctx, [
        'target',
      ]);
    }
  });
export type SchedulerAccessRequirementInput = z.infer<
  typeof schedulerAccessRequirementSchema
>;
