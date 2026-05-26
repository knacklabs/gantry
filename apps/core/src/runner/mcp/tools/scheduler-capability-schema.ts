import { z } from 'zod';

import { isAbsoluteFilePath } from '../../../shared/path-validation.js';

export const schedulerCapabilityRequirementSchema = z
  .object({
    capability_id: z
      .string()
      .describe('Stable semantic capability id, such as google.sheets.write'),
    reason: z.string().describe('Why this job needs the capability'),
    implementation: z
      .object({
        kind: z.enum([
          'configured_access',
          'local_cli',
          'mcp_server',
          'builtin_tool',
        ]),
        name: z
          .string()
          .optional()
          .describe('Human-readable implementation name, such as gog'),
        executable_path: z.string().optional(),
        executable_version: z.string().optional(),
        executable_hash: z.string().optional(),
        command_template: z.string().optional(),
        auth_preflight: z.string().optional(),
        protected_paths: z.array(z.string()).optional(),
        network_hosts: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const implementation = value.implementation;
    if (implementation?.kind !== 'local_cli') return;
    const executablePath = implementation.executable_path?.trim();
    const commandTemplate = implementation.command_template?.trim();
    if (!executablePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'executable_path'],
        message: 'local_cli executable_path is required.',
      });
      return;
    }
    if (!isAbsoluteFilePath(executablePath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'executable_path'],
        message: 'local_cli executable_path must be absolute.',
      });
    }
    if (!implementation.executable_version?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'executable_version'],
        message: 'local_cli executable_version is required.',
      });
    }
    if (!implementation.executable_hash?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'executable_hash'],
        message: 'local_cli executable_hash is required.',
      });
    }
    if (!commandTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'command_template'],
        message: 'local_cli command_template is required.',
      });
      return;
    }
    if (commandTemplate.split(/\s+/)[0] !== executablePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'command_template'],
        message: 'local_cli command_template must start with executable_path.',
      });
    }
    const authPreflight = implementation.auth_preflight?.trim();
    if (authPreflight && authPreflight.split(/\s+/)[0] !== executablePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'auth_preflight'],
        message: 'local_cli auth_preflight must start with executable_path.',
      });
    }
  });
