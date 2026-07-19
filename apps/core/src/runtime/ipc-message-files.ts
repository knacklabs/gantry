import { resolveCoreMessageAttachments } from '../application/core-tools/send-message.js';
import type { CoreMessageFile } from '../application/core-tools/send-message.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import type { IpcDeps } from './ipc-domain-types.js';

export type ParsedIpcMessageFile = CoreMessageFile;

export function parseIpcMessageFiles(
  rawFiles: unknown,
): ParsedIpcMessageFile[] {
  if (!Array.isArray(rawFiles)) return [];
  const files: ParsedIpcMessageFile[] = [];
  for (const entry of rawFiles.slice(0, 5)) {
    if (!isPlainObject(entry)) continue;
    if (
      entry.source !== undefined &&
      entry.source !== 'artifact' &&
      entry.source !== 'workspace'
    ) {
      throw new Error('Invalid IPC message file source');
    }
    const filePath = toTrimmedString(entry.path, { maxLen: 1024 });
    if (!filePath) continue;
    if (entry.source === 'workspace') {
      files.push({ source: 'workspace', path: filePath });
      continue;
    }
    const scope = toTrimmedString(entry.scope, { maxLen: 120 });
    files.push({
      source: 'artifact',
      ...(scope ? { scope } : {}),
      path: filePath,
      ...(typeof entry.version === 'number'
        ? { version: Math.floor(entry.version) }
        : {}),
    });
  }
  return files;
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
}) {
  return resolveCoreMessageAttachments({
    appId: input.appId,
    sourceAgentFolder: input.sourceAgentFolder,
    text: input.text,
    files: input.files,
    store: input.deps.getFileArtifactStore?.(),
  });
}
