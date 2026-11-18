import { ConvertSourceDocumentRequestSchema } from '@gantry/contracts';
import type { TaskContext } from './ipc-types.js';
import { validateMemoryIpcAuthRequest } from '../runtime/ipc-auth-validation.js';
import { createSourceDocument } from '../source-documents/service.js';
import { parseRendererRequest } from '../source-documents/renderer/validation.js';
export async function handleSourceDocumentTask(context: TaskContext) {
  const payload = context.data.payload!;
  const raw = payload.authorization;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Source document authority is required');
  if ((raw as Record<string, unknown>).action !== 'source_document')
    throw new Error('Source document operation authority mismatch');
  const auth = validateMemoryIpcAuthRequest(
    raw as Record<string, unknown>,
    context.sourceAgentFolder,
    'source document',
  );
  if (
    !auth.appId ||
    !auth.agentId ||
    !auth.userId ||
    !auth.chatJid ||
    !auth.sourceRunId ||
    !auth.sourceWorkspaceMemoryId ||
    auth.appId !== context.data.appId ||
    auth.agentId !== context.data.agentId ||
    auth.chatJid !== context.data.chatJid ||
    auth.sourceRunId !== context.data.sourceRunId
  )
    throw new Error('Source document scope mismatch');
  const store = context.deps.getFileArtifactStore?.();
  if (!store) throw new Error('Source document storage unavailable');
  const isConversion = Object.hasOwn(payload, 'convertExistingArtifactId');
  const allowed = isConversion
    ? ['action', 'authorization', 'convertExistingArtifactId', 'targetFormat']
    : ['action', 'authorization', 'document', 'citationIds', 'metadataFields'];
  if (Object.keys(payload).some((key) => !allowed.includes(key)))
    throw new Error('Invalid source document operation fields');
  const operation = isConversion
    ? ConvertSourceDocumentRequestSchema.parse({
        convertExistingArtifactId: payload.convertExistingArtifactId,
        targetFormat: payload.targetFormat,
      })
    : undefined;
  const document = operation
    ? undefined
    : parseRendererRequest(Buffer.from(JSON.stringify(payload.document)));
  return createSourceDocument({
    scope: {
      appId: auth.appId,
      agentId: auth.agentId,
      chatJid: auth.chatJid,
      personId: auth.userId,
      workspaceId: auth.sourceWorkspaceMemoryId,
      runId: auth.sourceRunId,
    },
    ...(operation
      ? operation
      : {
          document: document!,
          citationIds: payload.citationIds as string[],
          metadataFields: payload.metadataFields as string[],
        }),
    store,
  });
}
