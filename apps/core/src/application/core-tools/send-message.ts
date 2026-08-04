import type { FileArtifactStore } from '../../domain/ports/file-artifact-store.js';
import type {
  MessageFileAttachment,
  MessageSendOptions,
} from '../../domain/types.js';
import {
  normalizeFileArtifactPath,
  normalizeFileArtifactScope,
} from '../../domain/file-artifacts/virtual-path.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { logger } from '../../infrastructure/logging/logger.js';

export type CoreMessageFile =
  | {
      source?: 'artifact';
      scope?: string;
      path: string;
      version?: number;
    }
  | {
      source: 'workspace';
      path: string;
    };

export interface CoreSendMessageInput {
  text: string;
  files?: CoreMessageFile[];
  sender?: string;
}

export interface CoreSendMessageContext {
  appId?: string;
  sourceAgentFolder: string;
  targetJid: string;
  threadId?: string;
  providerAccountId?: string;
  isScheduledJob?: boolean;
}

export interface CoreSendMessageDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void>;
  getFileArtifactStore?: () => FileArtifactStore | undefined;
  readWorkspaceAttachment?: (
    sourceAgentFolder: string,
    virtualPath: string,
  ) => Promise<WorkspaceMessageAttachmentResolution>;
}

export type WorkspaceMessageAttachmentResolution =
  | { status: 'resolved'; attachment: MessageFileAttachment }
  | { status: 'missing' }
  | { status: 'failed'; reason: string };

export const MAX_MESSAGE_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function sendCoreMessage(input: {
  message: CoreSendMessageInput;
  context: CoreSendMessageContext;
  deps: CoreSendMessageDeps;
}): Promise<{ sent: boolean; message: string }> {
  if (input.context.isScheduledJob) {
    return {
      sent: false,
      message:
        'Scheduled job message suppressed. The scheduler will send one completion notification when the job finishes.',
    };
  }
  const resolved = await resolveCoreMessageAttachments({
    appId: input.context.appId,
    sourceAgentFolder: input.context.sourceAgentFolder,
    text: input.message.text,
    files: input.message.files,
    store: input.deps.getFileArtifactStore?.(),
    readWorkspaceAttachment: input.deps.readWorkspaceAttachment,
  });
  await input.deps.sendMessage(input.context.targetJid, resolved.text, {
    ...(input.context.threadId ? { threadId: input.context.threadId } : {}),
    ...(input.context.providerAccountId
      ? { providerAccountId: input.context.providerAccountId }
      : {}),
    files: resolved.files,
  });
  return { sent: true, message: 'Message sent.' };
}

export async function resolveCoreMessageAttachments(input: {
  appId?: string;
  sourceAgentFolder: string;
  text: string;
  files?: CoreMessageFile[];
  store?: FileArtifactStore;
  readWorkspaceAttachment?: CoreSendMessageDeps['readWorkspaceAttachment'];
}): Promise<{ text: string; files?: MessageFileAttachment[] }> {
  if (!input.files?.length) return { text: input.text };
  const lines = [input.text.trimEnd(), '', 'Attachments:'];
  const attachments: MessageFileAttachment[] = [];
  const agentId = agentIdForFolder(input.sourceAgentFolder);
  for (const file of input.files) {
    if (file.source === 'workspace') {
      let workspace: WorkspaceMessageAttachmentResolution = {
        status: 'missing',
      };
      try {
        if (input.readWorkspaceAttachment) {
          workspace = await input.readWorkspaceAttachment(
            input.sourceAgentFolder,
            file.path,
          );
        }
      } catch (error) {
        appendUnavailableAttachment(
          lines,
          input,
          agentId,
          file,
          'workspace file could not be read',
          error,
        );
        continue;
      }
      if (workspace.status === 'resolved') {
        lines.push(
          `- ${file.path} (${workspace.attachment.contentType}, ${workspace.attachment.sizeBytes} bytes)`,
        );
        attachments.push(workspace.attachment);
        continue;
      }
      appendUnavailableAttachment(
        lines,
        input,
        agentId,
        file,
        workspace.status === 'failed'
          ? workspace.reason
          : 'workspace file not found',
      );
      continue;
    }

    let virtualScope: string;
    try {
      virtualScope = normalizeFileArtifactScope(file.scope || 'default');
    } catch (error) {
      appendUnavailableAttachment(
        lines,
        input,
        agentId,
        file,
        `invalid scope: ${errorMessage(error)}`,
        error,
      );
      continue;
    }

    let virtualPath: string;
    try {
      virtualPath = normalizeFileArtifactPath(file.path);
    } catch (error) {
      appendUnavailableAttachment(
        lines,
        input,
        agentId,
        file,
        `invalid path: ${errorMessage(error)}`,
        error,
      );
      continue;
    }

    if (!input.appId || !input.store) {
      appendUnavailableAttachment(
        lines,
        input,
        agentId,
        file,
        'FileArtifact store unavailable',
      );
      continue;
    }

    let descriptor:
      | Awaited<ReturnType<FileArtifactStore['listFileArtifacts']>>[number]
      | undefined;
    try {
      [descriptor] = await input.store.listFileArtifacts({
        appId: input.appId,
        agentId,
        virtualScope,
        virtualPath,
        ...(file.version ? { version: file.version } : {}),
        limit: 1,
      });
    } catch (error) {
      appendUnavailableAttachment(
        lines,
        input,
        agentId,
        file,
        'FileArtifact lookup failed',
        error,
      );
      continue;
    }
    if (!descriptor) {
      appendUnavailableAttachment(
        lines,
        input,
        agentId,
        file,
        'FileArtifact not found',
      );
      continue;
    }
    if (descriptor.sizeBytes > MAX_MESSAGE_FILE_ATTACHMENT_BYTES) {
      appendUnavailableAttachment(lines, input, agentId, file, 'exceeds 25 MB');
      continue;
    }
    try {
      const result = await input.store.readFileArtifact({
        appId: input.appId,
        agentId,
        virtualScope,
        virtualPath,
        version: file.version ?? descriptor.version,
      });
      const artifact = result.artifact;
      lines.push(
        `- ${artifact.virtualPath} (${artifact.contentType}, ${artifact.sizeBytes} bytes)`,
      );
      attachments.push({
        filename: artifact.virtualPath.split('/').pop() || 'attachment',
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        content:
          typeof result.content === 'string'
            ? Buffer.from(result.content)
            : result.content,
      });
    } catch (error) {
      appendUnavailableAttachment(
        lines,
        input,
        agentId,
        file,
        'FileArtifact read failed',
        error,
      );
    }
  }
  return {
    text: lines.join('\n'),
    ...(attachments.length ? { files: attachments } : {}),
  };
}

function appendUnavailableAttachment(
  lines: string[],
  input: { appId?: string },
  agentId: string,
  file: CoreMessageFile,
  reason: string,
  error?: unknown,
): void {
  lines.push(`- Attachment unavailable: ${reason}`);
  logger.warn(
    {
      appId: input.appId ?? 'unknown',
      agentId,
      source: file.source ?? 'artifact',
      ...(file.source !== 'workspace'
        ? { scope: file.scope || 'default' }
        : {}),
      path: file.path,
      reason,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    },
    'Outbound message attachment unavailable',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
