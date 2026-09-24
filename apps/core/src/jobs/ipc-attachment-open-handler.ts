import { openMaterializedAttachmentReadOnly } from '../shared/provider-attachment-materialization.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  classifyAndLogAttachmentFailure,
  type AttachmentFailureEvidence,
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
import { motorClaimIntegrationConfig } from '../config/index.js';

const attachmentOpenHandler: TaskHandler = (context) =>
  handleAttachment(context, 'view');

const attachmentMaterializeHandler: TaskHandler = (context) =>
  handleAttachment(context, 'materialize');

const claimEvidenceStoreHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createTaskResponder(
    context.sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const claimConfig = motorClaimIntegrationConfig();
  if (
    !claimConfig.evidenceAgentFolder ||
    context.sourceAgentFolder !== claimConfig.evidenceAgentFolder
  ) {
    reject('This agent cannot store motor claim evidence.', 'forbidden');
    return;
  }
  if (
    !data.appId ||
    !data.providerAccountId ||
    !data.chatJid ||
    data.targetJid !== data.chatJid ||
    !sourceAgentFolderJids.includes(data.chatJid) ||
    !context.deps.openAttachment
  ) {
    reject(
      'Claim evidence requires a verified originating conversation.',
      'forbidden',
    );
    return;
  }
  const attachmentId = toTrimmedString(data.payload?.attachmentId, {
    maxLen: 512,
  });
  const claimId = toTrimmedString(data.payload?.claimId, { maxLen: 64 });
  const documentType = toTrimmedString(data.payload?.documentType, {
    maxLen: 64,
  });
  const mimeType = toTrimmedString(data.payload?.mimeType, { maxLen: 64 });
  const extractedText =
    typeof data.payload?.extractedText === 'string'
      ? data.payload.extractedText.slice(0, 12000)
      : '';
  const fields = data.payload?.extractedFields;
  if (
    !attachmentId ||
    !claimId ||
    !/^CLM-[A-Z0-9-]{4,32}$/.test(claimId) ||
    ![
      'damage_photo',
      'repair_estimate',
      'incident_report',
      'policy_document',
      'other',
    ].includes(documentType ?? '') ||
    !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(
      mimeType ?? '',
    ) ||
    !fields ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    Object.keys(fields).length > 30
  ) {
    reject('Invalid claim evidence details.', 'invalid_request');
    return;
  }
  const extractedFields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      key.length > 80 ||
      !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
      (value !== null &&
        !['string', 'number', 'boolean'].includes(typeof value)) ||
      (typeof value === 'string' && value.length > 1000)
    ) {
      reject('Invalid extracted claim field.', 'invalid_request');
      return;
    }
    extractedFields[key] = value as string | number | boolean | null;
  }
  const serviceUrl = claimConfig.reviewServiceUrl;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(serviceUrl)) {
    reject(
      'Motor claim evidence service is not configured.',
      'preflight_failed',
    );
    return;
  }
  let result: Awaited<
    ReturnType<NonNullable<typeof context.deps.openAttachment>>
  >;
  try {
    result = await context.deps.openAttachment({
      attachmentId,
      appId: data.appId,
      providerAccountId: data.providerAccountId,
      conversationJid: data.chatJid,
      ...(data.authThreadId ? { threadId: data.authThreadId } : {}),
      mode: 'view',
      workspaceRoot: resolveWorkspaceFolderPath(context.sourceAgentFolder),
    });
  } catch {
    reject('The original attachment could not be opened.', 'preflight_failed');
    return;
  }
  if (result.status !== 'opened') {
    reject('The original attachment is unavailable.', 'preflight_failed');
    return;
  }
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    file = await openMaterializedAttachmentReadOnly(result.materializedPath);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) {
      reject(
        'Claim evidence must be a non-empty file under 20 MB.',
        'invalid_request',
      );
      return;
    }
    const bytes = await file.readFile();
    const requestId = `evidence-${createHash('sha256').update(`${claimId}\0${attachmentId}`).digest('hex').slice(0, 40)}`;
    const actualText =
      mimeType === 'application/pdf' && !result.content.startsWith('ERROR:')
        ? result.content.slice(0, 12000)
        : extractedText;
    const response = await fetch(`${serviceUrl}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        claimId,
        requestId,
        documentType,
        fileName: result.fileName,
        mimeType,
        dataBase64: bytes.toString('base64'),
        extractedText: actualText,
        extractedFields,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const output = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      reject(
        `Claim evidence was not stored (${typeof output.error === 'string' ? output.error : 'service error'}).`,
        'preflight_failed',
      );
      return;
    }
    const evidence = output.evidence as Record<string, unknown> | undefined;
    const claim = output.claim as Record<string, unknown> | undefined;
    acceptData('Claim evidence stored.', {
      evidenceId: evidence?.evidenceId,
      claimId,
      fileName: result.fileName,
      mimeType,
      extractedFields,
      extractionStatus: evidence?.extractionStatus,
      claimStatus: claim?.status,
      replayed: output.replayed === true,
    });
  } catch {
    reject(
      'The original attachment could not be stored. Please retry.',
      'preflight_failed',
    );
  } finally {
    await file?.close().catch(() => undefined);
  }
};

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
      workspaceRoot: resolveWorkspaceFolderPath(context.sourceAgentFolder),
    });
  } catch {
    const failure = classifyHandlerFailure(
      context,
      attachmentId,
      { kind: 'unexpected' },
      startedAt,
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
  } catch {
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
  } finally {
    await source?.close().catch(() => undefined);
  }
}

function classifyHandlerFailure(
  context: TaskContext,
  attachmentId: string,
  evidence: AttachmentFailureEvidence,
  startedAt: number,
) {
  return classifyAndLogAttachmentFailure({
    evidence,
    provider: 'unknown',
    providerAccountId: context.data.providerAccountId ?? 'unknown',
    conversationJid: context.data.chatJid ?? 'unknown',
    attachmentId,
    elapsedMs: Date.now() - startedAt,
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
  claim_evidence_store: claimEvidenceStoreHandler,
};
