import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ATTACHMENT_UNREACHABLE_COPY } from '@core/application/attachments/attachment-failure.js';
import { attachmentOpenTaskHandlers } from '@core/jobs/ipc-attachment-open-handler.js';
import { taskIpcResponsePath } from '@core/jobs/ipc-shared.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import { resolveWorkspaceFolderPath } from '@core/platform/workspace-folder.js';
import {
  createIpcAuthEnvelope,
  revokeIpcResponseSigningKey,
} from '@core/runtime/ipc-auth.js';

const sourceAgentFolder = 'attachment_test';
const taskId = 'attachment-error-sanitization';
const responsePath = taskIpcResponsePath(sourceAgentFolder, taskId);
let responseKeyId: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(responsePath, { force: true });
  if (responseKeyId) {
    revokeIpcResponseSigningKey(responseKeyId, sourceAgentFolder);
    responseKeyId = undefined;
  }
});

describe('attachment open IPC handler', () => {
  it('refuses to materialize when the CAS source is a symlink', async () => {
    const { openMaterializedAttachmentReadOnly } =
      await import('@core/shared/provider-attachment-materialization.js');
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'cas-'));
    const real = pathMod.join(dir, 'real.bin');
    const link = pathMod.join(dir, 'link.bin');
    await fsp.writeFile(real, 'secret');
    await fsp.symlink(real, link);
    await expect(openMaterializedAttachmentReadOnly(link)).rejects.toThrow();
    const ok = await openMaterializedAttachmentReadOnly(real);
    await ok.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  it('keeps host filesystem errors out of the runner response', async () => {
    const envelope = createIpcAuthEnvelope(sourceAgentFolder);
    responseKeyId = envelope.responseKeyId;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const handler = attachmentOpenTaskHandlers.attachment_open;
    if (!handler) throw new Error('attachment_open handler is not registered');

    const token = 'xoxb-123456789012345678901234';
    const signedUrl =
      'https://files.slack.test/private/report.csv?token=signed-secret-value';
    const workspacePath = '/private/host/attachments/secret/report.csv';
    const fileContent = 'name,total Ada,42';
    const nestedCause = 'nested provider response body';

    await handler({
      data: {
        type: 'attachment_open',
        taskId,
        appId: 'app-1',
        providerAccountId: 'slack-default',
        chatJid: 'sl:C1',
        targetJid: 'sl:C1',
        responseKeyId,
        payload: { attachmentId: 'attachment-1' },
      },
      sourceAgentFolder,
      sourceAgentFolderJids: ['sl:C1'],
      conversationBindings: {},
      deps: {
        openAttachment: async () => {
          throw Object.assign(
            new TypeError(
              `download failed token=${token} signedUrl=${signedUrl} workspacePath=${workspacePath} fileContent=${fileContent} cause=${nestedCause}`,
            ),
            { code: 'EATTACHMENT' },
          );
        },
      } as never,
    });

    const responseText = fs.readFileSync(responsePath, 'utf8');
    expect(responseText).not.toContain('/private/host');
    expect(JSON.parse(responseText)).toMatchObject({
      ok: true,
      data: { content: ATTACHMENT_UNREACHABLE_COPY },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [logContext] = warn.mock.calls[0] ?? [];
    expect(logContext).toMatchObject({
      cause: 'unknown',
      errorName: 'TypeError',
      errorCode: 'EATTACHMENT',
      errorMessage: expect.stringContaining('download failed'),
    });
    expect(Object.keys(logContext as Record<string, unknown>)).toEqual([
      'cause',
      'provider',
      'providerAccountId',
      'conversationJid',
      'attachmentId',
      'elapsedMs',
      'errorName',
      'errorCode',
      'errorMessage',
    ]);
    const serializedLog = JSON.stringify(logContext);
    for (const privateValue of [
      token,
      signedUrl,
      workspacePath,
      fileContent,
      nestedCause,
    ]) {
      expect(serializedLog).not.toContain(privateValue);
    }
    expect(serializedLog).not.toContain('stack');
  });
});

describe('attachment materialize', () => {
  it('streams the resolved attachment into the workspace quarantine through the hardened writer', async () => {
    const folder = 'attachment_materialize_test';
    const materializeTaskId = 'attachment-materialize-stream';
    const materializeResponsePath = taskIpcResponsePath(
      folder,
      materializeTaskId,
    );
    const envelope = createIpcAuthEnvelope(folder);
    const workspaceRoot = resolveWorkspaceFolderPath(folder);
    const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cas-'));
    const casPath = path.join(casRoot, 'report.csv');
    const bytes = Buffer.from('name,total\nAda,42\n');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(casPath, bytes);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    try {
      const handler = attachmentOpenTaskHandlers.attachment_materialize;
      if (!handler) {
        throw new Error('attachment_materialize handler is not registered');
      }
      await handler({
        data: {
          type: 'attachment_materialize',
          taskId: materializeTaskId,
          appId: 'app-1',
          providerAccountId: 'slack-default',
          chatJid: 'sl:C1',
          targetJid: 'sl:C1',
          responseKeyId: envelope.responseKeyId,
          payload: { attachmentId: 'attachment-1' },
        },
        sourceAgentFolder: folder,
        sourceAgentFolderJids: ['sl:C1'],
        conversationBindings: {},
        deps: {
          openAttachment: async (input: { mode?: string }) => {
            expect(input.mode).toBe('materialize');
            return {
              status: 'opened',
              content: '',
              materializedPath: casPath,
              storageRef: 'provider-attachments/report.csv',
              fileName: 'report.csv',
            } as const;
          },
        } as never,
      });

      const response = JSON.parse(
        fs.readFileSync(materializeResponsePath, 'utf8'),
      );
      expect(response).toMatchObject({
        ok: true,
        data: {
          status: 'materialized',
          path: expect.stringMatching(
            /^quarantine\/[0-9a-f]{16}-report\.csv$/u,
          ),
          bytes: bytes.byteLength,
        },
      });
      const quarantinePath = response.data.path as string;
      expect(fs.readFileSync(path.join(workspaceRoot, quarantinePath))).toEqual(
        bytes,
      );
      expect(info).toHaveBeenCalledWith(
        {
          sourceAgentFolder: folder,
          attachmentId: 'attachment-1',
          chatJid: 'sl:C1',
          bytes: bytes.byteLength,
          quarantinePath,
        },
        'Attachment materialized into workspace quarantine',
      );
    } finally {
      info.mockRestore();
      fs.rmSync(materializeResponsePath, { force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(casRoot, { recursive: true, force: true });
      revokeIpcResponseSigningKey(envelope.responseKeyId, folder);
    }
  });

  it('returns workspace-local refs without copying them', async () => {
    const folder = 'attachment_materialize_local_test';
    const localTaskId = 'attachment-materialize-local';
    const localResponsePath = taskIpcResponsePath(folder, localTaskId);
    const envelope = createIpcAuthEnvelope(folder);
    const workspaceRoot = resolveWorkspaceFolderPath(folder);
    const localPath = 'attachments/live.txt';
    fs.mkdirSync(path.join(workspaceRoot, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, localPath), 'live bytes');

    try {
      await attachmentOpenTaskHandlers.attachment_materialize!({
        data: {
          type: 'attachment_materialize',
          taskId: localTaskId,
          appId: 'app-1',
          providerAccountId: 'telegram-default',
          chatJid: 'tg:C1',
          targetJid: 'tg:C1',
          responseKeyId: envelope.responseKeyId,
          payload: { attachmentId: 'attachment-live' },
        },
        sourceAgentFolder: folder,
        sourceAgentFolderJids: ['tg:C1'],
        conversationBindings: {},
        deps: {
          openAttachment: async () => ({
            status: 'already_in_workspace',
            content: 'Attachment is already in the workspace.',
            workspaceRelativePath: localPath,
            fileName: 'live.txt',
          }),
        } as never,
      });

      expect(
        JSON.parse(fs.readFileSync(localResponsePath, 'utf8')),
      ).toMatchObject({
        ok: true,
        data: {
          status: 'already_in_workspace',
          path: localPath,
          bytes: Buffer.byteLength('live bytes'),
        },
      });
      expect(fs.existsSync(path.join(workspaceRoot, 'quarantine'))).toBe(false);
    } finally {
      fs.rmSync(localResponsePath, { force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      revokeIpcResponseSigningKey(envelope.responseKeyId, folder);
    }
  });

  it('refuses a symlinked quarantine directory', async () => {
    const folder = 'attachment_materialize_symlink_test';
    const symlinkTaskId = 'attachment-materialize-symlink';
    const symlinkResponsePath = taskIpcResponsePath(folder, symlinkTaskId);
    const envelope = createIpcAuthEnvelope(folder);
    const workspaceRoot = resolveWorkspaceFolderPath(folder);
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-quarantine-outside-'),
    );
    const casRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-cas-'));
    const casPath = path.join(casRoot, 'report.txt');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(casPath, 'host bytes');
    fs.symlinkSync(outsideRoot, path.join(workspaceRoot, 'quarantine'), 'dir');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    try {
      await attachmentOpenTaskHandlers.attachment_materialize!({
        data: {
          type: 'attachment_materialize',
          taskId: symlinkTaskId,
          appId: 'app-1',
          providerAccountId: 'slack-default',
          chatJid: 'sl:C1',
          targetJid: 'sl:C1',
          responseKeyId: envelope.responseKeyId,
          payload: { attachmentId: 'attachment-1' },
        },
        sourceAgentFolder: folder,
        sourceAgentFolderJids: ['sl:C1'],
        conversationBindings: {},
        deps: {
          openAttachment: async () => ({
            status: 'opened',
            content: '',
            materializedPath: casPath,
            storageRef: 'provider-attachments/report.txt',
            fileName: 'report.txt',
          }),
        } as never,
      });

      expect(
        JSON.parse(fs.readFileSync(symlinkResponsePath, 'utf8')),
      ).toMatchObject({
        ok: true,
        data: {
          status: 'unreachable',
          content: ATTACHMENT_UNREACHABLE_COPY,
        },
      });
      expect(fs.readdirSync(outsideRoot)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const [logContext] = warn.mock.calls[0] ?? [];
      expect(logContext).toMatchObject({
        cause: 'unknown',
        workspaceFolder: folder,
        errorName: 'Error',
      });
      expect(JSON.stringify(logContext)).not.toContain(workspaceRoot);
      expect(JSON.stringify(logContext)).not.toContain(outsideRoot);
    } finally {
      fs.rmSync(symlinkResponsePath, { force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
      fs.rmSync(casRoot, { recursive: true, force: true });
      revokeIpcResponseSigningKey(envelope.responseKeyId, folder);
    }
  });
});
