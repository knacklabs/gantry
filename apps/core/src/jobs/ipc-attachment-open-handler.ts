import { openMaterializedAttachmentReadOnly } from '../shared/provider-attachment-materialization.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  classifyAndLogAttachmentFailure,
  summarizeAttachmentFailureError,
  type AttachmentFailureEvidence,
  type AttachmentFailureErrorSummary,
} from '../application/attachments/attachment-failure.js';
import { ATTACHMENT_MAX_BYTES } from '../application/attachments/attachment-resolver.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import {
  createInboundAttachmentStorageRef,
  writeInboundAttachment,
} from '../shared/inbound-attachment-writer.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';

const attachmentOpenHandler: TaskHandler = (context) =>
  handleAttachment(context, 'view');

const attachmentMaterializeHandler: TaskHandler = (context) =>
  handleAttachment(context, 'materialize');

async function handleAttachment(
  context: TaskContext,
  mode: 'view' | 'materialize',
): Promise<void> {
  const { data, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createTaskResponder(
    context.sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  if (!data.appId || !data.providerAccountId) {
    reject(
      'Attachment open requires signed app and provider scope.',
      'forbidden',
    );
    return;
  }
  if (
    !data.chatJid ||
    data.targetJid !== data.chatJid ||
    !sourceAgentFolderJids.includes(data.chatJid)
  ) {
    reject(
      'Attachment open must use the originating conversation.',
      'forbidden',
    );
    return;
  }
  const attachmentId = toTrimmedString(data.payload?.attachmentId, {
    maxLen: 512,
  });
  if (!attachmentId) {
    reject('Attachment id is required.', 'invalid_request');
    return;
  }
  if (!context.deps.openAttachment) {
    reject('Attachment resolver is not ready.', 'preflight_failed');
    return;
  }
  let result: Awaited<
    ReturnType<NonNullable<typeof context.deps.openAttachment>>
  >;
  const startedAt = Date.now();
  try {
    result = await context.deps.openAttachment({
      attachmentId,
      appId: data.appId,
      providerAccountId: data.providerAccountId,
      conversationJid: data.chatJid,
      ...(data.authThreadId ? { threadId: data.authThreadId } : {}),
      mode,
      ...(mode === 'materialize'
        ? {
            workspaceRoot: resolveWorkspaceFolderPath(
              context.sourceAgentFolder,
            ),
          }
        : {}),
    });
  } catch (error) {
    const failure = classifyHandlerFailure(
      context,
      attachmentId,
      { kind: 'unexpected' },
      startedAt,
      {
        errorSummary: summarizeAttachmentFailureError(error),
        ...(mode === 'materialize'
          ? { workspaceFolder: context.sourceAgentFolder }
          : {}),
      },
    );
    acceptData(
      'Attachment unavailable.',
      mode === 'materialize'
        ? { status: 'unreachable', content: failure.content }
        : { content: failure.content },
    );
    return;
  }
  if (mode === 'materialize') {
    await respondToMaterialize(
      context,
      result,
      acceptData,
      attachmentId,
      startedAt,
    );
    return;
  }
  acceptData('Attachment opened.', {
    content: result.content,
    ...(result.status === 'opened' && result.image
      ? { image: result.image }
      : {}),
  });
}

async function respondToMaterialize(
  context: TaskContext,
  result: Awaited<
    ReturnType<NonNullable<TaskContext['deps']['openAttachment']>>
  >,
  acceptData: ReturnType<typeof createTaskResponder>['acceptData'],
  attachmentId: string,
  startedAt: number,
): Promise<void> {
  if (result.status === 'already_in_workspace') {
    const bytes = await workspaceFileSize(
      context.sourceAgentFolder,
      result.workspaceRelativePath,
    );
    if (bytes === null) {
      const failure = classifyHandlerFailure(
        context,
        attachmentId,
        { kind: 'unexpected' },
        startedAt,
      );
      acceptData('Attachment unavailable.', {
        status: 'unreachable',
        content: failure.content,
      });
      return;
    }
    acceptData('Attachment is already in the workspace.', {
      status: 'already_in_workspace',
      path: result.workspaceRelativePath,
      bytes,
    });
    return;
  }
  if (result.status !== 'opened') {
    acceptData('Attachment unavailable.', {
      status: result.status,
      content: result.content,
    });
    return;
  }

  const workspaceRoot = resolveWorkspaceFolderPath(context.sourceAgentFolder);
  const quarantineRelativePath = createInboundAttachmentStorageRef(
    result.fileName,
  ).replace(/^attachments\//u, 'quarantine/');
  const quarantineDir = path.join(workspaceRoot, 'quarantine');
  let source: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await fs.mkdir(quarantineDir, { recursive: true });
    const quarantineStat = await fs.lstat(quarantineDir);
    if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()) {
      throw new Error('Workspace quarantine must be a physical directory');
    }
    source = await openMaterializedAttachmentReadOnly(result.materializedPath);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const writeResult = await writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath: quarantineRelativePath,
      content: {
        async read() {
          const { bytesRead } = await source!.read(buffer, 0, buffer.length);
          return bytesRead === 0
            ? { done: true }
            : { done: false, value: buffer.subarray(0, bytesRead) };
        },
      },
      maxBytes: ATTACHMENT_MAX_BYTES,
    });
    if (writeResult.status === 'too-large') {
      const failure = classifyHandlerFailure(
        context,
        attachmentId,
        { kind: 'too_large' },
        startedAt,
      );
      acceptData('Attachment is too large.', {
        status: 'too_large',
        content: failure.content,
      });
      return;
    }
    logger.info(
      {
        sourceAgentFolder: context.sourceAgentFolder,
        attachmentId: context.data.payload?.attachmentId,
        chatJid: context.data.chatJid,
        bytes: writeResult.bytes,
        quarantinePath: quarantineRelativePath,
      },
      'Attachment materialized into workspace quarantine',
    );
    acceptData('Attachment materialized.', {
      status: 'materialized',
      path: quarantineRelativePath,
      bytes: writeResult.bytes,
    });
  } catch (error) {
    const failure = classifyHandlerFailure(
      context,
      attachmentId,
      { kind: 'unexpected' },
      startedAt,
      {
        errorSummary: summarizeAttachmentFailureError(error),
        workspaceFolder: context.sourceAgentFolder,
      },
    );
    acceptData('Attachment unavailable.', {
      status: 'unreachable',
      content: failure.content,
    });
  } finally {
    await source?.close().catch(() => undefined);
  }
}

function classifyHandlerFailure(
  context: TaskContext,
  attachmentId: string,
  evidence: AttachmentFailureEvidence,
  startedAt: number,
  details?: {
    errorSummary?: AttachmentFailureErrorSummary;
    workspaceFolder?: string;
  },
) {
  return classifyAndLogAttachmentFailure({
    evidence,
    provider: 'unknown',
    providerAccountId: context.data.providerAccountId ?? 'unknown',
    conversationJid: context.data.chatJid ?? 'unknown',
    attachmentId,
    elapsedMs: Date.now() - startedAt,
    ...(details?.errorSummary ? { errorSummary: details.errorSummary } : {}),
    ...(details?.workspaceFolder
      ? { workspaceFolder: details.workspaceFolder }
      : {}),
  });
}

async function workspaceFileSize(
  sourceAgentFolder: string,
  workspaceRelativePath: string,
): Promise<number | null> {
  try {
    const workspaceRoot = await fs.realpath(
      resolveWorkspaceFolderPath(sourceAgentFolder),
    );
    const resolved = await fs.realpath(
      path.resolve(workspaceRoot, workspaceRelativePath),
    );
    const relative = path.relative(workspaceRoot, resolved);
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    const stat = await fs.lstat(resolved);
    return stat.isFile() && stat.nlink === 1 ? stat.size : null;
  } catch {
    return null;
  }
}

export const attachmentOpenTaskHandlers: Record<string, TaskHandler> = {
  attachment_open: attachmentOpenHandler,
  attachment_materialize: attachmentMaterializeHandler,
};
