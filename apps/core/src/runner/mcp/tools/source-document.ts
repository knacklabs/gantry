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
        'Create a cited PDF/DOCX, or convert an existing selected published artifact by supplying ONLY convertExistingArtifactId and targetFormat. Conversion preserves the original title, blocks and references exactly. Never rewrite content for a format-only request. Returns a trusted receipt for final artifacts; no file bytes or paths.',
      inputSchema: advertised,
    },
    async (rawArgs) => {
      const args = operation.parse(rawArgs);
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
