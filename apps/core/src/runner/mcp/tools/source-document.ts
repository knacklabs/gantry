import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createSignedIpcRequestEnvelope } from '../../../shared/ipc-signing.js';
import {
  TASKS_DIR,
  chatJid,
  appId,
  agentId,
  threadId,
  memoryUserId,
  memoryDefaultScope,
  memoryIpcAllowedActions,
  memoryReviewerIsControlApprover,
  MEMORY_IPC_AUTH_TOKEN,
  IPC_RESPONSE_KEY_ID,
  sourceWorkspaceMemoryId,
  runId,
} from '../context.js';
import { writeIpcFile, waitForTaskResponse } from '../ipc.js';
import { makeIpcId } from '../ipc-ids.js';
import { parseRendererRequest } from '../../../source-documents/renderer/validation.js';
const text = z.string().min(1).max(100000);
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text }).strict(),
  z
    .object({
      type: z.literal('heading'),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      text,
    })
    .strict(),
  z
    .object({
      type: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(text).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('table'),
      headers: z.array(text).min(1).max(20),
      rows: z.array(z.array(text).min(1).max(20)).min(1).max(200),
    })
    .strict(),
]);
export function registerSourceDocumentTools(server: McpServer) {
  const creation = z
    .object({
      format: z.enum(['pdf', 'docx']),
      fileName: z.string().min(1).max(128),
      title: z.string().min(1).max(200),
      blocks: z.array(block).min(1).max(200),
      citationIds: z.array(z.string().min(1).max(256)).max(100),
      metadataFields: z.array(z.string().min(1).max(256)).max(100),
    })
    .strict();
  const conversion = z
    .object({
      convertExistingArtifactId: z.string().min(1).max(256),
      targetFormat: z.enum(['pdf', 'docx']),
    })
    .strict();
  const operation = z.union([creation, conversion]);
  const advertised = z
    .object({
      ...Object.fromEntries(
        Object.entries(creation.shape).map(([name, schema]) => [
          name,
          schema.optional(),
        ]),
      ),
      convertExistingArtifactId:
        conversion.shape.convertExistingArtifactId.optional(),
      targetFormat: conversion.shape.targetFormat.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (!operation.safeParse(value).success)
        ctx.addIssue({
          code: 'custom',
          message:
            'Choose exactly one complete creation or format-only conversion operation',
        });
    });
  server.registerTool(
    'source_document',
    {
      description:
        'Create a cited PDF/DOCX with a safe filename ending in the selected format extension. Every table row must have exactly as many cells as its headers; total title and block text must not exceed 100000 characters. Or convert an existing selected published artifact by supplying ONLY convertExistingArtifactId and targetFormat. Conversion preserves the original title, blocks and references exactly. Never rewrite content for a format-only request. Returns a trusted receipt for final artifacts; no file bytes or paths. An invalid_document_input result is not an artifact: correct the input before retrying.',
      inputSchema: advertised,
    },
    async (rawArgs) => {
      const args = operation.parse(rawArgs);
      if ('format' in args) {
        const { citationIds: _citations, metadataFields: _metadata, ...document } = args;
        try {
          parseRendererRequest(Buffer.from(JSON.stringify({ version: 1, ...document })));
        } catch {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              status: 'invalid_document_input',
              retryable: true,
              message: 'No document was submitted or created. Correct the input: use a safe non-reserved filename ending in the chosen .pdf or .docx extension, rectangular tables, valid text without control characters, and at most 100000 total title/block characters. Retry only after correcting the input; do not claim a file exists.',
            }) }],
          };
        }
      }
      if (!sourceWorkspaceMemoryId || !runId)
        throw new Error(
          'Document generation requires an active authorized source answer',
        );
      const taskId = makeIpcId('source-document');
      const authorization = createSignedIpcRequestEnvelope(
        MEMORY_IPC_AUTH_TOKEN,
        {
          requestId: makeIpcId('source-doc-auth'),
          action: 'source_document',
          payload: {},
          context: {
            appId,
            agentId,
            chatJid,
            ...(threadId ? { threadId } : {}),
            ...(memoryUserId ? { personId: memoryUserId } : {}),
            ...(IPC_RESPONSE_KEY_ID
              ? { responseKeyId: IPC_RESPONSE_KEY_ID }
              : {}),
            sourceWorkspaceMemoryId,
            runId,
            sourceRunId: runId,
            defaultScope: memoryDefaultScope,
            allowedActions: memoryIpcAllowedActions,
            reviewerIsControlApprover: memoryReviewerIsControlApprover,
          },
          expiresAt: new Date(Date.now() + 55000).toISOString(),
        },
      );
      const conversionRequest =
        'convertExistingArtifactId' in args ? args : undefined;
      const creationRequest = 'format' in args ? args : undefined;
      const { citationIds, metadataFields, ...document } =
        creationRequest ?? {};
      writeIpcFile(TASKS_DIR, {
        type: 'file_artifact',
        taskId,
        chatJid,
        targetJid: chatJid,
        payload: {
          action: 'render_source_document',
          ...(conversionRequest
            ? conversionRequest
            : {
                document: { version: 1, ...document },
                citationIds,
                metadataFields,
              }),
          authorization,
        },
      });
      const response = await waitForTaskResponse(taskId, 55000);
      if (!response?.ok)
        throw new Error('Document generation failed or was canceled');
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response.data) },
        ],
      };
    },
  );
}
