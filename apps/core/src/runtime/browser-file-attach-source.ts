import path from 'path';

import type { FileArtifactId } from '../domain/file-artifacts/file-artifact.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import type { BrowserBackendAction } from '../shared/browser-backend-actions.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';

export interface BrowserFileAttachRequest {
  action: BrowserBackendAction;
  payload: Record<string, unknown>;
  appId?: string;
  agentId?: string;
}

export async function resolveBrowserFileAttachPayload(input: {
  request: BrowserFileAttachRequest;
  sourceAgentFolder: string;
  getFileArtifactStore?: () => FileArtifactStore | undefined;
}): Promise<Record<string, unknown>> {
  if (input.request.action !== 'file_attach') return input.request.payload;
  const source = input.request.payload.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return input.request.payload;
  }
  const row = source as Record<string, unknown>;
  if (row.type !== 'artifact') return input.request.payload;
  const store = input.getFileArtifactStore?.();
  if (!store) {
    throw new Error(
      'file_attach artifact source requires FileArtifact storage.',
    );
  }
  const appId = input.request.appId;
  if (!appId) {
    throw new Error('file_attach artifact source requires signed app scope.');
  }
  const artifactId = stringField(row, 'artifactId');
  const scope = stringField(row, 'scope');
  const virtualPath = stringField(row, 'path');
  if (!artifactId && !virtualPath) {
    throw new Error('file_attach artifact source requires artifactId or path.');
  }
  const result = await store.readFileArtifact({
    appId,
    agentId:
      input.request.agentId ??
      memoryAgentIdForWorkspaceFolder(input.sourceAgentFolder),
    ...(artifactId ? { id: artifactId as FileArtifactId } : {}),
    ...(scope ? { virtualScope: scope } : {}),
    ...(virtualPath ? { virtualPath } : {}),
  });
  const content =
    typeof result.content === 'string'
      ? Buffer.from(result.content, 'utf8')
      : Buffer.from(result.content);
  return {
    ...input.request.payload,
    source: {
      type: 'bytes',
      name:
        stringField(row, 'name') ??
        path.basename(result.artifact.virtualPath || 'artifact.bin'),
      content: content.toString('base64'),
      encoding: 'base64',
    },
  };
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
