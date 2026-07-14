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

export interface CoreMessageFile {
  scope?: string;
  path: string;
  version?: number;
}

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
}

const MAX_MESSAGE_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
}): Promise<{ text: string; files?: MessageFileAttachment[] }> {
  if (!input.files?.length) return { text: input.text };
  if (!input.appId || !input.store) {
    return { text: withUnavailableAttachments(input.text, input.files.length) };
  }
  const lines = [input.text.trimEnd(), '', 'Attachments:'];
  const attachments: MessageFileAttachment[] = [];
  const agentId = agentIdForFolder(input.sourceAgentFolder);
  for (const file of input.files) {
    try {
      const virtualScope = normalizeFileArtifactScope(file.scope || 'default');
      const virtualPath = normalizeFileArtifactPath(file.path);
      const [descriptor] = await input.store.listFileArtifacts({
        appId: input.appId,
        agentId,
        virtualScope,
        virtualPath,
        ...(file.version ? { version: file.version } : {}),
        limit: 1,
      });
      if (
        !descriptor ||
        descriptor.sizeBytes > MAX_MESSAGE_FILE_ATTACHMENT_BYTES
      ) {
        lines.push('- Attachment unavailable.');
        continue;
      }
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
    } catch {
      lines.push('- Attachment unavailable.');
    }
  }
  return {
    text: lines.join('\n'),
    ...(attachments.length ? { files: attachments } : {}),
  };
}

function withUnavailableAttachments(text: string, count: number): string {
  return [
    text.trimEnd(),
    '',
    'Attachments:',
    ...Array.from({ length: count }, () => '- Attachment unavailable.'),
  ].join('\n');
}
