import { describe, expect, it, vi } from 'vitest';

import type {
  FileArtifact,
  FileArtifactId,
} from '@core/domain/file-artifacts/file-artifact.js';
import type { FileArtifactStore } from '@core/domain/ports/file-artifact-store.js';
import { resolveBrowserFileAttachPayload } from '@core/runtime/browser-file-attach-source.js';

function artifact(virtualScope: string, virtualPath: string): FileArtifact {
  return {
    id: 'artifact-1' as FileArtifactId,
    appId: 'app-1',
    agentId: 'agent-1',
    virtualScope,
    virtualPath,
    version: 1,
    storageType: 'local-filesystem',
    storageRef: '/tmp/artifact-1',
    contentHash: 'hash-1',
    sizeBytes: 5,
    contentType: 'text/plain',
    metadata: {},
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

describe('browser file attach artifact source', () => {
  it('refuses a protected artifact by id and by path after resolution using the artifact virtualScope and virtualPath with the fixed refusal text and still resolves an ordinary artifact', async () => {
    const readFileArtifact = vi
      .fn<FileArtifactStore['readFileArtifact']>()
      .mockResolvedValueOnce({
        artifact: artifact('workspace', 'settings.yaml'),
        content: 'secret',
      })
      .mockResolvedValueOnce({
        artifact: artifact('prompt-profile', 'AGENTS.md'),
        content: 'secret',
      })
      .mockResolvedValueOnce({
        artifact: artifact('workspace', 'notes/a.txt'),
        content: 'hello',
      });
    const getFileArtifactStore = () =>
      ({ readFileArtifact }) as unknown as FileArtifactStore;
    const resolve = (source: Record<string, unknown>) =>
      resolveBrowserFileAttachPayload({
        request: {
          action: 'file_attach',
          payload: { source },
          appId: 'app-1',
          agentId: 'agent-1',
        },
        sourceAgentFolder: 'agent-1',
        getFileArtifactStore,
      });

    await expect(
      resolve({ type: 'artifact', artifactId: 'artifact-protected' }),
    ).rejects.toThrow(
      "Refused: settings.yaml is protected. This is not a permission question — don't retry, tell the owner.",
    );
    await expect(
      resolve({ type: 'artifact', scope: 'workspace', path: 'alias.md' }),
    ).rejects.toThrow(
      "Refused: AGENTS.md is protected. This is not a permission question — don't retry, tell the owner.",
    );
    await expect(
      resolve({ type: 'artifact', scope: 'workspace', path: 'notes/a.txt' }),
    ).resolves.toEqual({
      source: {
        type: 'bytes',
        name: 'a.txt',
        content: Buffer.from('hello').toString('base64'),
        encoding: 'base64',
      },
    });
  });
});
