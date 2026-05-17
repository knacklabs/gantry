import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previousIpcDir = process.env.MYCLAW_IPC_DIR;

beforeEach(() => {
  process.env.MYCLAW_IPC_DIR = '/tmp/myclaw-file-tool-test';
  process.env.MYCLAW_GROUP_FOLDER = 'test-agent';
  process.env.MYCLAW_CHAT_JID = 'sl:C123';
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@core/runner/mcp/ipc.js');
  if (previousIpcDir === undefined) delete process.env.MYCLAW_IPC_DIR;
  else process.env.MYCLAW_IPC_DIR = previousIpcDir;
  delete process.env.MYCLAW_GROUP_FOLDER;
  delete process.env.MYCLAW_CHAT_JID;
});

describe('mcp__myclaw__file', () => {
  it('sends compact FileArtifact requests through signed host IPC', async () => {
    const writeIpcFile = vi.fn();
    const waitForTaskResponse = vi.fn(async () => ({
      ok: true,
      data: {
        ok: true,
        artifacts: [
          {
            id: 'file-artifact:1',
            scope: 'scratch',
            path: 'notes/today.md',
            version: 1,
            contentHash: 'sha256:test',
            sizeBytes: 12,
            contentType: 'text/markdown',
            createdAt: '2026-05-14T00:00:00.000Z',
          },
        ],
      },
    }));
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      waitForTaskResponse,
    }));
    const { handleFileToolAction, measureFileToolPayloadSize } =
      await import('@core/runner/mcp/tools/file.js');

    const response = JSON.parse(
      await handleFileToolAction({
        action: 'list',
        scope: 'scratch',
        path: 'notes/today.md',
      }),
    );

    expect(response).toMatchObject({ ok: true });
    expect(response.artifacts[0]).not.toHaveProperty('storageRef');
    expect(writeIpcFile).toHaveBeenCalledWith(
      '/tmp/myclaw-file-tool-test/tasks',
      expect.objectContaining({
        type: 'file_artifact',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: {
          action: 'list',
          scope: 'scratch',
          path: 'notes/today.md',
        },
      }),
    );
    expect(measureFileToolPayloadSize(response)).toBeLessThan(250);
  });

  it('returns compact rejection when host IPC rejects or times out', async () => {
    const writeIpcFile = vi.fn();
    const waitForTaskResponse = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Protected prompt FileArtifact mutations require capability.',
      })
      .mockResolvedValueOnce(null);
    vi.doMock('@core/runner/mcp/ipc.js', () => ({
      writeIpcFile,
      waitForTaskResponse,
    }));
    const { handleFileToolAction } =
      await import('@core/runner/mcp/tools/file.js');

    await expect(
      handleFileToolAction({
        action: 'write',
        path: 'CLAUDE.md',
        content: 'bad',
        protected: true,
      }).then(JSON.parse),
    ).resolves.toMatchObject({
      ok: false,
      status: 'rejected',
      reason: 'Protected prompt FileArtifact mutations require capability.',
    });
    await expect(
      handleFileToolAction({ action: 'read', path: 'notes/today.md' }).then(
        JSON.parse,
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 'rejected',
      reason: 'FileArtifact request timed out waiting for host confirmation.',
    });
  });
});
