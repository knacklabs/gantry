import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readProviderAttachment } from '@core/shared/provider-attachment-materialization.js';

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
