import {
  normalizeFileArtifactPath,
  normalizeFileArtifactScope,
} from '../domain/file-artifacts/virtual-path.js';
import type { MessageFileAttachment } from '../domain/types.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import type { IpcDeps } from './ipc-domain-types.js';

export interface ParsedIpcMessageFile {
  scope?: string;
  path: string;
  version?: number;
}

const MAX_MESSAGE_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function parseIpcMessageFiles(
  rawFiles: unknown,
): ParsedIpcMessageFile[] {
  if (!Array.isArray(rawFiles)) return [];
  return rawFiles
    .slice(0, 5)
    .map((entry) => {
      if (!isPlainObject(entry)) return null;
      const filePath = toTrimmedString(entry.path, { maxLen: 1024 });
      if (!filePath) return null;
      const scope = toTrimmedString(entry.scope, { maxLen: 120 });
      return {
        ...(scope ? { scope } : {}),
        path: filePath,
        ...(typeof entry.version === 'number'
          ? { version: Math.floor(entry.version) }
          : {}),
      };
    })
    .filter((entry): entry is ParsedIpcMessageFile => entry !== null);
}

export async function appendOwnedFileArtifactDegradeText(input: {
  deps: IpcDeps;
  appId?: string;
  sourceAgentFolder: string;
  text: string;
  files?: ParsedIpcMessageFile[];
}): Promise<string> {
  return (await resolveOwnedFileArtifactMessage(input)).text;
}

export async function resolveOwnedFileArtifactMessage(input: {
  deps: IpcDeps;
  appId?: string;
  sourceAgentFolder: string;
  text: string;
  files?: ParsedIpcMessageFile[];
}): Promise<{ text: string; files?: MessageFileAttachment[] }> {
  if (!input.files?.length) return { text: input.text };
  if (!input.appId)
    return { text: withUnavailableAttachments(input.text, input.files.length) };
  const store = input.deps.getFileArtifactStore?.();
  if (!store)
    return { text: withUnavailableAttachments(input.text, input.files.length) };
  const lines = [input.text.trimEnd(), '', 'Attachments:'];
  const attachments: MessageFileAttachment[] = [];
  const agentId = memoryAgentIdForWorkspaceFolder(input.sourceAgentFolder);
  for (const file of input.files) {
    try {
      const virtualScope = normalizeFileArtifactScope(file.scope || 'default');
      const virtualPath = normalizeFileArtifactPath(file.path);
      const [descriptor] = await store.listFileArtifacts({
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
      const result = await store.readFileArtifact({
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
