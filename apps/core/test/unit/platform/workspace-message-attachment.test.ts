import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => ({ root: '', outsideRoot: '' }));

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: vi.fn(() => workspace.root),
}));

import { readWorkspaceMessageAttachment } from '@core/platform/workspace-message-attachment.js';

describe('readWorkspaceMessageAttachment', () => {
  beforeEach(async () => {
    workspace.root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-workspace-attachment-')),
    );
    workspace.outsideRoot = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), 'gantry-workspace-attachment-outside-'),
      ),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspace.root, { recursive: true, force: true });
    await fs.rm(workspace.outsideRoot, { recursive: true, force: true });
  });

  it('round-trips a real workspace file without filesystem mocks', async () => {
    const content = Buffer.from('real workspace bytes');
    await fs.writeFile(path.join(workspace.root, 'report.txt'), content);

    await expect(
      readWorkspaceMessageAttachment('video-agent', 'report.txt'),
    ).resolves.toMatchObject({
      status: 'resolved',
      attachment: {
        filename: 'report.txt',
        contentType: 'text/plain',
        sizeBytes: content.byteLength,
        content,
      },
    });
  });

  it('rejects a FIFO without waiting for a writer', async () => {
    const fifoPath = path.join(workspace.root, 'attachment.pipe');
    execFileSync('mkfifo', [fifoPath]);
    const openSpy = vi.spyOn(fs, 'open');

    await expect(
      readWorkspaceMessageAttachment('video-agent', 'attachment.pipe'),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'workspace path is not a regular file',
    });
    expect(openSpy).not.toHaveBeenCalled();
  }, 1_000);

  it('rejects a hard link to a file outside the workspace', async () => {
    const outsideFile = path.join(workspace.outsideRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    await fs.link(outsideFile, path.join(workspace.root, 'report.txt'));

    await expect(
      readWorkspaceMessageAttachment('video-agent', 'report.txt'),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'path is multiply linked',
    });
  });

  it('rejects an ancestor-symlink swap at the atomic open boundary', async () => {
    const ancestorPath = path.join(workspace.root, 'reports');
    const movedAncestorPath = path.join(workspace.root, 'reports-original');
    await fs.mkdir(ancestorPath);
    await fs.writeFile(path.join(ancestorPath, 'report.txt'), 'public');
    const outsideFile = path.join(workspace.outsideRoot, 'report.txt');
    await fs.writeFile(outsideFile, 'secret');
    const canonicalTargetPath = await fs.realpath(
      path.join(ancestorPath, 'report.txt'),
    );

    const originalOpen = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, 'open')
      .mockImplementationOnce(async (openedPath, flags, mode) => {
        await fs.rename(ancestorPath, movedAncestorPath);
        await fs.symlink(workspace.outsideRoot, ancestorPath, 'dir');
        return originalOpen(openedPath, flags, mode);
      });

    const resolution = await readWorkspaceMessageAttachment(
      'video-agent',
      'reports/report.txt',
    );

    expect(resolution).toEqual(
      process.platform === 'darwin'
        ? {
            status: 'failed',
            reason: 'workspace file could not be read',
          }
        : {
            status: 'failed',
            reason: 'invalid path: canonical workspace path changed after open',
          },
    );
    expect(openSpy).toHaveBeenCalledWith(
      canonicalTargetPath,
      process.platform === 'darwin'
        ? fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | 0x20000000
        : fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
    );
  });
});
