import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createInboundAttachmentStorageRef,
  writeInboundAttachment,
} from '@core/shared/inbound-attachment-writer.js';

describe('writeInboundAttachment', () => {
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'inbound-attachment-')),
    );
    outsideRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'inbound-attachment-outside-')),
    );
    await fs.mkdir(path.join(workspaceRoot, 'attachments'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  it('writes buffered content through a temp descriptor and publishes it', async () => {
    const content = Buffer.from('buffered attachment');

    await expect(
      writeInboundAttachment({
        workspaceRoot,
        workspaceRelativePath: 'attachments/report.txt',
        content,
        maxBytes: 1024,
      }),
    ).resolves.toEqual({ status: 'written', bytes: content.byteLength });

    await expect(
      fs.readFile(path.join(workspaceRoot, 'attachments', 'report.txt')),
    ).resolves.toEqual(content);
  });

  it('writes streaming content through the same descriptor path', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    let index = 0;

    await expect(
      writeInboundAttachment({
        workspaceRoot,
        workspaceRelativePath: 'attachments/report.bin',
        content: {
          read: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true },
        },
        maxBytes: 1024,
      }),
    ).resolves.toEqual({ status: 'written', bytes: 5 });

    await expect(
      fs.readFile(path.join(workspaceRoot, 'attachments', 'report.bin')),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });

  it('does not follow a pre-existing final-file symlink', async () => {
    const outsidePath = path.join(outsideRoot, 'outside.txt');
    const finalPath = path.join(workspaceRoot, 'attachments', 'report.txt');
    await fs.writeFile(outsidePath, 'outside-original');
    await fs.symlink(outsidePath, finalPath);

    const write = writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath: 'attachments/report.txt',
      content: Buffer.from('attacker-controlled'),
      maxBytes: 1024,
    });

    await expect(write).resolves.toEqual({
      status: 'written',
      bytes: 19,
    });
    await expect(fs.readFile(finalPath, 'utf8')).resolves.toBe(
      'attacker-controlled',
    );

    await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe(
      'outside-original',
    );
  });

  it('does not follow a final-file symlink planted while the temp is open', async () => {
    const outsidePath = path.join(outsideRoot, 'outside.txt');
    const finalPath = path.join(workspaceRoot, 'attachments', 'report.txt');
    await fs.writeFile(outsidePath, 'outside-original');
    let reads = 0;

    const write = writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath: 'attachments/report.txt',
      content: {
        read: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              done: false,
              value: new Uint8Array([1, 2, 3]),
            };
          }
          await fs.symlink(outsidePath, finalPath);
          return { done: true };
        },
      },
      maxBytes: 1024,
    });

    await expect(write).resolves.toEqual({ status: 'written', bytes: 3 });
    await expect(fs.readFile(finalPath)).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );

    await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe(
      'outside-original',
    );
  });

  it('does not create an outside file when the attachment directory is swapped before final open', async () => {
    const attachmentDir = path.join(workspaceRoot, 'attachments');
    const movedAttachmentDir = path.join(workspaceRoot, 'attachments-original');
    const outsidePath = path.join(outsideRoot, 'report.txt');
    let reads = 0;

    const write = writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath: 'attachments/report.txt',
      content: {
        read: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              done: false,
              value: new Uint8Array([1, 2, 3]),
            };
          }
          await fs.rename(attachmentDir, movedAttachmentDir);
          await fs.symlink(outsideRoot, attachmentDir, 'dir');
          return { done: true };
        },
      },
      maxBytes: 1024,
    });

    if (process.platform === 'linux') {
      await expect(write).resolves.toEqual({ status: 'written', bytes: 3 });
      await expect(
        fs.readFile(path.join(movedAttachmentDir, 'report.txt')),
      ).resolves.toEqual(Buffer.from([1, 2, 3]));
    } else {
      await expect(write).rejects.toThrow();
    }

    const outsideContent = await fs
      .readFile(outsidePath)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    expect(outsideContent?.byteLength ?? 0).toBe(0);
    expect(outsideContent).toBeNull();
    await expect(fs.stat(outsidePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not expose a partial final file when a write fails', async () => {
    let reads = 0;

    await expect(
      writeInboundAttachment({
        workspaceRoot,
        workspaceRelativePath: 'attachments/report.txt',
        content: {
          read: async () => {
            reads += 1;
            if (reads === 1) {
              return {
                done: false,
                value: new Uint8Array([1, 2, 3]),
              };
            }
            throw new Error('simulated mid-write failure');
          },
        },
        maxBytes: 1024,
      }),
    ).rejects.toThrow('simulated mid-write failure');

    await expect(
      fs.stat(path.join(workspaceRoot, 'attachments', 'report.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.readdir(path.join(workspaceRoot, 'attachments')),
    ).resolves.toEqual([]);
  });

  it('removes the temp file when streamed content is too large', async () => {
    await expect(
      writeInboundAttachment({
        workspaceRoot,
        workspaceRelativePath: 'attachments/report.txt',
        content: {
          read: async () => ({
            done: false,
            value: new Uint8Array([1, 2, 3, 4]),
          }),
        },
        maxBytes: 3,
      }),
    ).resolves.toEqual({ status: 'too-large', bytes: 4 });

    await expect(
      fs.stat(path.join(workspaceRoot, 'attachments', 'report.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.readdir(path.join(workspaceRoot, 'attachments')),
    ).resolves.toEqual([]);
  });

  it('bounds long storage names by encoded bytes and preserves the extension', async () => {
    const storageRef = createInboundAttachmentStorageRef(
      `${'a'.repeat(236)}.pdf`,
    );
    const finalName = path.posix.basename(storageRef);
    const tempComponentBytes =
      1 + Buffer.byteLength(finalName) + 1 + 32 + Buffer.byteLength('.tmp');

    expect(finalName).toMatch(/^[a-f0-9]{16}-a+\.pdf$/);
    expect(Buffer.byteLength(finalName)).toBeLessThanOrEqual(217);
    expect(tempComponentBytes).toBeLessThanOrEqual(255);

    await expect(
      writeInboundAttachment({
        workspaceRoot,
        workspaceRelativePath: storageRef,
        content: Buffer.from('long-name'),
        maxBytes: 1024,
      }),
    ).resolves.toEqual({ status: 'written', bytes: 9 });
    await expect(
      fs.readFile(path.join(workspaceRoot, ...storageRef.split('/')), 'utf8'),
    ).resolves.toBe('long-name');
  });

  it('persists same-named attachments under distinct immutable storage refs', async () => {
    const firstRef = createInboundAttachmentStorageRef('report.pdf');
    const secondRef = createInboundAttachmentStorageRef('report.pdf');

    expect(firstRef).toMatch(/^attachments\/[a-f0-9]{16}-report\.pdf$/);
    expect(secondRef).toMatch(/^attachments\/[a-f0-9]{16}-report\.pdf$/);
    expect(secondRef).not.toBe(firstRef);

    await writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath: firstRef,
      content: Buffer.from('first'),
      maxBytes: 1024,
    });
    await writeInboundAttachment({
      workspaceRoot,
      workspaceRelativePath: secondRef,
      content: Buffer.from('second'),
      maxBytes: 1024,
    });

    await expect(
      fs.readFile(path.join(workspaceRoot, ...firstRef.split('/')), 'utf8'),
    ).resolves.toBe('first');
    await expect(
      fs.readFile(path.join(workspaceRoot, ...secondRef.split('/')), 'utf8'),
    ).resolves.toBe('second');
  });
});
