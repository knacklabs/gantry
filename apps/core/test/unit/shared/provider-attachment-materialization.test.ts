import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderAttachmentMaterializer,
  readProviderAttachment,
} from '@core/shared/provider-attachment-materialization.js';

const temporaryRoots: string[] = [];

async function temporaryMaterializationRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'gantry-provider-attachment-read-'),
  );
  temporaryRoots.push(root);
  return root;
}

function stubReads(content: Buffer, maxBytesPerRead: number): void {
  vi.spyOn(fs, 'open').mockResolvedValue({
    read: vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => {
        const sourceOffset = position ?? 0;
        const bytesRead = Math.min(
          maxBytesPerRead,
          length,
          content.length - sourceOffset,
        );
        if (bytesRead > 0) {
          content.copy(buffer, offset, sourceOffset, sourceOffset + bytesRead);
        }
        return { bytesRead, buffer };
      },
    ),
    close: vi.fn(),
  } as unknown as FileHandle);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })),
  );
});

describe('provider attachment materialization reads', () => {
  it('mints provider refs at the host and writes outside workspace roots', async () => {
    const materializationRoot = await temporaryMaterializationRoot();
    const workspaceRoot = await temporaryMaterializationRoot();
    const materialize = createProviderAttachmentMaterializer({
      materializationRoot,
      workspaceRoots: () => [workspaceRoot],
    });
    const body = new Response('live bytes').body!.getReader();

    const result = await materialize({ fileName: 'report.txt', content: body });

    expect(result.storageRef).toMatch(
      /^provider-attachments\/[a-f0-9]{16}-report\.txt$/,
    );
    await expect(
      fs.readFile(
        path.join(
          materializationRoot,
          result.storageRef.slice('provider-attachments/'.length),
        ),
        'utf8',
      ),
    ).resolves.toBe('live bytes');
    expect(
      path.relative(workspaceRoot, materializationRoot).startsWith('..'),
    ).toBe(true);

    await result.reclaim();
    await expect(
      fs.stat(
        path.join(
          materializationRoot,
          result.storageRef.slice('provider-attachments/'.length),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a stream refused by the authoritative writer cap', async () => {
    const cancel = vi.fn(async () => undefined);
    const materialize = createProviderAttachmentMaterializer({
      materializationRoot: await temporaryMaterializationRoot(),
      workspaceRoots: () => [],
      writer: vi.fn(async () => ({ status: 'too-large', bytes: 50_000_001 })),
    });

    await expect(
      materialize({
        fileName: 'large.bin',
        content: { read: vi.fn(), cancel },
      }),
    ).rejects.toThrow('Provider attachment exceeds max allowed size');
    expect(cancel).toHaveBeenCalledWith('too_large');
  });

  it('continues after legal short reads until the full file reaches EOF', async () => {
    stubReads(Buffer.from('complete attachment'), 1);

    const result = await readProviderAttachment({
      materializationRoot: await temporaryMaterializationRoot(),
      workspaceRoots: [],
      storageRef: 'provider-attachments/report.txt',
      attachment: { fileName: 'report.txt', contentType: 'text/plain' },
    });

    expect(result).toMatchObject({
      status: 'opened',
      content: 'complete attachment',
    });
  });

  it('marks content truncated when short reads reach the output limit', async () => {
    stubReads(Buffer.alloc(80_001, 'a'), 4_096);

    const result = await readProviderAttachment({
      materializationRoot: await temporaryMaterializationRoot(),
      workspaceRoots: [],
      storageRef: 'provider-attachments/report.txt',
      attachment: { fileName: 'report.txt', contentType: 'text/plain' },
    });

    expect(result).toMatchObject({ status: 'opened' });
    expect(result.status === 'opened' ? result.content : '').toMatch(
      /\[Attachment content truncated\.\]$/,
    );
  });
});
