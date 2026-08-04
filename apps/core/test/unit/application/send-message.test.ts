import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const workspace = vi.hoisted(() => ({ root: '', outsideRoot: '' }));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: vi.fn(() => workspace.root),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: { warn },
}));

import { resolveCoreMessageAttachments } from '@core/application/core-tools/send-message.js';
import { readWorkspaceMessageAttachment } from '@core/platform/workspace-message-attachment.js';
import { createCoreToolSchemas } from '@core/runtime/core-tools/schemas.js';

function emptyStore() {
  return {
    listFileArtifacts: vi.fn(async () => []),
    readFileArtifact: vi.fn(),
  } as never;
}

function descriptor(sizeBytes = 1_024) {
  return {
    id: 'artifact-1',
    virtualScope: 'reports',
    virtualPath: 'report.bin',
    version: 1,
    contentHash: 'sha256:test',
    sizeBytes,
    contentType: 'application/octet-stream',
    createdAt: '2026-07-19T00:00:00.000Z',
  };
}

describe('send_message file schema', () => {
  const schema = createCoreToolSchemas(z).send_message;

  it('defaults omitted sources to artifacts and enforces source-specific fields', () => {
    expect(
      schema.safeParse({ text: 'Attached.', files: [{ path: 'report.txt' }] })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({
        text: 'Attached.',
        files: [{ source: 'artifact', scope: 'reports', path: 'report.txt' }],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        text: 'Attached.',
        files: [{ source: 'workspace', scope: 'reports', path: 'report.txt' }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        text: 'Attached.',
        files: [{ source: 'remote', path: 'report.txt' }],
      }).success,
    ).toBe(false);
  });
});

describe('resolveCoreMessageAttachments', () => {
  beforeEach(async () => {
    warn.mockClear();
    workspace.root = await fs.realpath(
      await fs.mkdtemp(
        path.join(os.tmpdir(), 'gantry-send-message-workspace-'),
      ),
    );
    workspace.outsideRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'gantry-send-message-outside-')),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspace.root, { recursive: true, force: true });
    await fs.rm(workspace.outsideRoot, { recursive: true, force: true });
  });

  it('treats a source-less reference as a FileArtifact only', async () => {
    const readWorkspaceAttachment = vi.fn(readWorkspaceMessageAttachment);
    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ scope: 'renders', path: 'missing.mp4' }],
      store: emptyStore(),
      readWorkspaceAttachment,
    });

    expect(result.text).toContain(
      '- Attachment unavailable: FileArtifact not found',
    );
    expect(readWorkspaceAttachment).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        appId: 'app:test',
        agentId: 'agent:video-agent',
        source: 'artifact',
        scope: 'renders',
        path: 'missing.mp4',
        reason: 'FileArtifact not found',
      },
      'Outbound message attachment unavailable',
    );
  });

  it('reports an oversized FileArtifact without reading it', async () => {
    const readFileArtifact = vi.fn();
    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ source: 'artifact', scope: 'renders', path: 'report.bin' }],
      store: {
        listFileArtifacts: vi.fn(async () => [descriptor(26 * 1024 * 1024)]),
        readFileArtifact,
      } as never,
      readWorkspaceAttachment: readWorkspaceMessageAttachment,
    });

    expect(result.text).toContain('- Attachment unavailable: exceeds 25 MB');
    expect(readFileArtifact).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:video-agent',
        scope: 'renders',
        path: 'report.bin',
        reason: 'exceeds 25 MB',
      }),
      'Outbound message attachment unavailable',
    );
  });

  it('rejects workspace paths containing dot-dot segments', async () => {
    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ source: 'workspace', path: '../secret.txt' }],
      store: emptyStore(),
      readWorkspaceAttachment: readWorkspaceMessageAttachment,
    });

    expect(result.text).toContain(
      '- Attachment unavailable: invalid path: workspace path must be relative and cannot contain .. segments',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:video-agent',
        source: 'workspace',
        path: '../secret.txt',
        reason: expect.stringContaining('invalid path:'),
      }),
      'Outbound message attachment unavailable',
    );
  });

  it('reports a missing workspace file without querying FileArtifacts', async () => {
    const store = emptyStore() as {
      listFileArtifacts: ReturnType<typeof vi.fn>;
      readFileArtifact: ReturnType<typeof vi.fn>;
    };
    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ source: 'workspace', path: 'missing.mp4' }],
      store: store as never,
      readWorkspaceAttachment: readWorkspaceMessageAttachment,
    });

    expect(result.text).toContain(
      '- Attachment unavailable: workspace file not found',
    );
    expect(store.listFileArtifacts).not.toHaveBeenCalled();
    expect(store.readFileArtifact).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:video-agent',
        source: 'workspace',
        path: 'missing.mp4',
        reason: 'workspace file not found',
      }),
      'Outbound message attachment unavailable',
    );
  });

  it('reports FileArtifact read failures instead of silently degrading', async () => {
    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ source: 'artifact', scope: 'reports', path: 'report.bin' }],
      store: {
        listFileArtifacts: vi.fn(async () => [descriptor()]),
        readFileArtifact: vi.fn(async () => {
          throw new Error('read failed');
        }),
      } as never,
      readWorkspaceAttachment: readWorkspaceMessageAttachment,
    });

    expect(result.text).toContain(
      '- Attachment unavailable: FileArtifact read failed',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'FileArtifact read failed',
        error: 'read failed',
      }),
      'Outbound message attachment unavailable',
    );
  });

  it('resolves an explicitly selected workspace MP4', async () => {
    await fs.mkdir(path.join(workspace.root, 'renders'));
    await fs.writeFile(
      path.join(workspace.root, 'renders', 'clip.mp4'),
      Buffer.from([0, 1, 2, 3]),
    );
    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ source: 'workspace', path: 'renders/clip.mp4' }],
      store: emptyStore(),
      readWorkspaceAttachment: readWorkspaceMessageAttachment,
    });

    expect(result.text).toBe(
      'Rendered.\n\nAttachments:\n- renders/clip.mp4 (video/mp4, 4 bytes)',
    );
    expect(result.files).toEqual([
      {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 4,
        content: Buffer.from([0, 1, 2, 3]),
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('resolves a workspace filename containing spaces and Unicode', async () => {
    await fs.writeFile(
      path.join(workspace.root, 'résumé final.txt'),
      'approved',
    );
    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ source: 'workspace', path: 'résumé final.txt' }],
      store: emptyStore(),
      readWorkspaceAttachment: readWorkspaceMessageAttachment,
    });

    expect(result.text).toBe(
      'Rendered.\n\nAttachments:\n- résumé final.txt (text/plain, 8 bytes)',
    );
    expect(result.files).toEqual([
      {
        filename: 'résumé final.txt',
        contentType: 'text/plain',
        sizeBytes: 8,
        content: Buffer.from('approved'),
      },
    ]);
  });

  it('rejects a workspace symlink that resolves outside the workspace', async () => {
    const outsideFile = path.join(workspace.outsideRoot, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret');
    await fs.symlink(outsideFile, path.join(workspace.root, 'escape.txt'));

    const result = await resolveCoreMessageAttachments({
      appId: 'app:test',
      sourceAgentFolder: 'video-agent',
      text: 'Rendered.',
      files: [{ source: 'workspace', path: 'escape.txt' }],
      store: emptyStore(),
      readWorkspaceAttachment: readWorkspaceMessageAttachment,
    });

    expect(result.files).toBeUndefined();
    expect(result.text).toContain(
      '- Attachment unavailable: invalid path: resolved path escapes the workspace folder',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'escape.txt',
        reason: 'invalid path: resolved path escapes the workspace folder',
      }),
      'Outbound message attachment unavailable',
    );
  });

  it('rejects a final-component symlink swapped in after containment', async () => {
    const targetPath = path.join(workspace.root, 'report.txt');
    const outsideFile = path.join(workspace.outsideRoot, 'secret.txt');
    await fs.writeFile(targetPath, 'public');
    await fs.writeFile(outsideFile, 'secret');
    const canonicalTargetPath = await fs.realpath(targetPath);
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi
      .spyOn(fs, 'open')
      .mockImplementationOnce(async (openedPath, flags, mode) => {
        await fs.unlink(targetPath);
        await fs.symlink(outsideFile, targetPath);
        return originalOpen(openedPath, flags, mode);
      });

    const result = await readWorkspaceMessageAttachment(
      'video-agent',
      'report.txt',
    );

    expect(result).toEqual({
      status: 'failed',
      reason: 'workspace file could not be read',
    });
    expect(openSpy).toHaveBeenCalledWith(
      canonicalTargetPath,
      process.platform === 'darwin'
        ? fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | 0x20000000
        : fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
    );
  });

  it('rejects a workspace file larger than 25 MB before reading it', async () => {
    const largePath = path.join(workspace.root, 'large.mp4');
    await fs.writeFile(largePath, '');
    await fs.truncate(largePath, 26 * 1024 * 1024);
    const handle = await fs.open(largePath, 'r');
    const readSpy = vi.spyOn(handle, 'read');
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);

    const resolution = await readWorkspaceMessageAttachment(
      'video-agent',
      'large.mp4',
    );

    expect(resolution).toEqual({ status: 'failed', reason: 'exceeds 25 MB' });
    expect(readSpy).not.toHaveBeenCalled();
  });
});
