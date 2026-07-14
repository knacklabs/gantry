import { resolveCoreMessageAttachments } from '../application/core-tools/send-message.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import type { IpcDeps } from './ipc-domain-types.js';

export interface ParsedIpcMessageFile {
  scope?: string;
  path: string;
  version?: number;
}

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
}) {
  return resolveCoreMessageAttachments({
    appId: input.appId,
    sourceAgentFolder: input.sourceAgentFolder,
    text: input.text,
    files: input.files,
    store: input.deps.getFileArtifactStore?.(),
  });
}
