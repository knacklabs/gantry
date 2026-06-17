import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FileArtifactDescriptor } from '../../../domain/file-artifacts/file-artifact.js';
import { chatJid, lockedAccessPreset, TASKS_DIR } from '../context.js';
import { makeIpcId } from '../ipc-ids.js';
import { waitForTaskResponse, writeIpcFile } from '../ipc.js';

const FILE_ARTIFACT_TASK_TIMEOUT_MS = 30_000;
const MAX_READ_LIMIT_BYTES = 256 * 1024;

const fileToolSchema = {
  action: z.enum(['list', 'read', 'write', 'promote_scratch']),
  artifactId: z
    .string()
    .optional()
    .describe('Opaque artifact id returned by list or write.'),
  scope: z
    .string()
    .optional()
    .describe('Virtual file scope. Defaults to "default".'),
  path: z
    .string()
    .optional()
    .describe('Safe relative virtual path. Required except broad list calls.'),
  version: z.number().int().positive().optional(),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Read byte offset. Defaults to 0.'),
  readLimit: z
    .number()
    .int()
    .positive()
    .max(MAX_READ_LIMIT_BYTES)
    .optional()
    .describe('Maximum bytes returned by read. Defaults to 64 KiB.'),
  content: z
    .string()
    .optional()
    .describe('Content for write. Use UTF-8 text unless encoding is base64.'),
  encoding: z.enum(['utf8', 'base64']).optional(),
  contentType: z.string().optional(),
  targetScope: z
    .string()
    .optional()
    .describe('Target virtual scope for promote_scratch. Defaults to default.'),
  targetPath: z
    .string()
    .optional()
    .describe('Target safe relative virtual path for promote_scratch.'),
  protected: z
    .boolean()
    .optional()
    .describe(
      lockedAccessPreset
        ? 'Honored only for protected config writes when this MCP process has admin context. Profile files (SOUL.md, AGENTS.md) cannot be written here.'
        : 'Honored only for protected config writes (settings.yaml, .mcp.json, SKILL.md) when this MCP process has admin context. Profile files (SOUL.md, AGENTS.md) cannot be written here — use request_agent_profile_update.',
    ),
  limit: z.number().int().positive().max(100).optional(),
};

export function registerFileTools(server: McpServer): void {
  server.tool(
    'file',
    'List, read, write, or promote Gantry FileArtifacts by virtual scope/path. Descriptors are compact by default; file content is returned only by read. Host filesystem paths and storage refs are never exposed.',
    fileToolSchema,
    async (args) => {
      const result = await handleFileToolAction(args);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );
}

export async function handleFileToolAction(
  args: z.infer<z.ZodObject<typeof fileToolSchema>>,
): Promise<string> {
  return requestHostFileArtifactAction(args);
}

async function requestHostFileArtifactAction(
  args: z.infer<z.ZodObject<typeof fileToolSchema>>,
): Promise<string> {
  const taskId = makeIpcId('file-artifact');
  writeIpcFile(TASKS_DIR, {
    type: 'file_artifact',
    taskId,
    chatJid,
    targetJid: chatJid,
    payload: compactPayload(args),
  });
  const response = await waitForTaskResponse(
    taskId,
    FILE_ARTIFACT_TASK_TIMEOUT_MS,
  );
  if (!response) {
    return 'That file action was rejected: the host did not confirm it in time.';
  }
  if (!response.ok) {
    return `That file action was rejected: ${response.error || 'the file action failed.'}`;
  }
  const data =
    response.data &&
    typeof response.data === 'object' &&
    !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : {};
  if (typeof data.content === 'string') return data.content;
  if (Array.isArray(data.artifacts)) {
    if (data.artifacts.length === 0) return 'No files found.';
    const lines = data.artifacts.map((entry) => {
      const rec =
        entry && typeof entry === 'object'
          ? (entry as Record<string, unknown>)
          : {};
      return `- ${String(rec.virtualPath ?? rec.path ?? 'file')}`;
    });
    return [`Files (${data.artifacts.length}):`, ...lines].join('\n');
  }
  const artifact =
    data.artifact && typeof data.artifact === 'object'
      ? (data.artifact as Record<string, unknown>)
      : undefined;
  const path = artifact
    ? String(artifact.virtualPath ?? artifact.path ?? '')
    : '';
  return path ? `Saved ${path}.` : 'Done.';
}

export function measureFileToolPayloadSize(value: unknown): number {
  return Buffer.byteLength(compactJson(value), 'utf-8');
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function compactPayload(
  args: z.infer<z.ZodObject<typeof fileToolSchema>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  );
}

export function descriptorPayloadBytes(
  descriptors: readonly FileArtifactDescriptor[],
): number {
  return measureFileToolPayloadSize({ ok: true, artifacts: descriptors });
}
