import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderAttachmentMaterializer,
  readProviderAttachment,
} from '@core/shared/provider-attachment-materialization.js';

const temporaryRoots: string[] = [];
const MINIMAL_DOCX = Buffer.from(
  'UEsDBBQAAAAIAOhoA13MVIwQ4AAAAJwBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2Qy07DMBBFf8XyFsUTukAIJekCyhJYlA+w7Eli4Zc8bil/z6QtXaDC0r6PM7rd+hC82GMhl2Ivb1UrBUaTrItTL9+3z829XA/d9isjCbZG6uVca34AIDNj0KRSxsjKmErQlZ9lgqzNh54QVm17BybFirE2demQQ/eEo975KjYH/j5hC3qS4vFkXFi91Dl7Z3RlHfbR/qI0Z4Li5NFDs8t0wwYJVwmL8jfgnHvlHYqzKN50qS86sAs+U7Fgk9kFTqr/a67cmcbRGbzkl7ZckkEiHjh4dVGCdvHnfjjOPXwDUEsDBBQAAAAIAOhoA102V97cogAAABgBAAALAAAAX3JlbHMvLnJlbHONzzsOwjAMBuCrRN6pCwNCqGkXhNQVlQNEiZtGNA8l4XV7MjBQxMBo+/dnuekedmY3isl4x2Fd1cDISa+M0xzOw3G1g65tTjSLXBJpMiGxsuIShynnsEdMciIrUuUDuTIZfbQilzJqDEJehCbc1PUW46cBS5P1ikPs1RrY8Az0j+3H0Ug6eHm15PKPE1+JIouoKXO4+6hQvdtVYQHbBhcvti9QSwMEFAAAAAgA6GgDXWDSmdOwAAAA7AAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOsY7CMAyGXyXKDikMJ1S1ZQDdeicEEqtJDK3U2FVsKLw9TRlYPsv+5c+uts/Ymwcm6Zhqu1oW1iB5Dh3dans6/i421ogCBeiZsLYvFLttqrEM7O8RSc0kICnH2raqQ+mc+BYjyJIHpCm7coqgU5tubuQUhsQeRSZ/7N26KH5chI5sVl44vHIdMlKGNgeEAJcezf5vdzagCr7NZyuX08w0c94R9Pqf3Dz4yNz30eYNUEsBAhQDFAAAAAgA6GgDXcxUjBDgAAAAnAEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACADoaANdNlfe3KIAAAAYAQAACwAAAAAAAAAAAAAAgAERAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACADoaANdYNKZ07AAAADsAAAAEQAAAAAAAAAAAAAAgAHcAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAuwIAAAAA',
  'base64',
);

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

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

async function writeProviderAttachment(
  root: string,
  fileName: string,
  content: Buffer,
): Promise<void> {
  await fs.writeFile(path.join(root, fileName), content);
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

  it('extracts readable text from PDF attachments', async () => {
    const root = await temporaryMaterializationRoot();
    await writeProviderAttachment(
      root,
      'report.pdf',
      minimalPdf('Readable PDF attachment'),
    );

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/report.pdf',
      attachment: { fileName: 'report.pdf', contentType: 'application/pdf' },
    });

    expect(result).toMatchObject({ status: 'opened' });
    expect(result.status === 'opened' ? result.content : '').toContain(
      'Readable PDF attachment',
    );
  });

  it('keeps plain text off the document extractor entirely', async () => {
    stubReads(Buffer.from('plain text body'), 4_096);
    const extract = vi.fn();

    const result = await readProviderAttachment({
      materializationRoot: await temporaryMaterializationRoot(),
      workspaceRoots: [],
      storageRef: 'provider-attachments/notes.txt',
      attachment: { fileName: 'notes.txt', contentType: 'text/plain' },
      extract,
    });

    expect(result).toMatchObject({
      status: 'opened',
      content: 'plain text body',
    });
    expect(extract).not.toHaveBeenCalled();
  });

  it('accepts documents whose full text is short', async () => {
    const root = await temporaryMaterializationRoot();
    await writeProviderAttachment(root, 'memo.pdf', minimalPdf('Approved'));

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/memo.pdf',
      attachment: { fileName: 'memo.pdf', contentType: 'application/pdf' },
    });

    expect(result.status === 'opened' ? result.content : '').toContain(
      'Approved',
    );
  });

  it('errors with vision guidance for image attachments', async () => {
    const root = await temporaryMaterializationRoot();
    await writeProviderAttachment(
      root,
      'screenshot.png',
      Buffer.from('89504e470d0a1a0a', 'hex'),
    );

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/screenshot.png',
      attachment: { fileName: 'screenshot.png', contentType: 'image/png' },
    });

    const content = result.status === 'opened' ? result.content : '';
    expect(content).toMatch(/^ERROR: /);
    expect(content).toContain('supports image input');
  });

  it('errors with scanned guidance for image-only PDFs', async () => {
    const root = await temporaryMaterializationRoot();
    await writeProviderAttachment(root, 'scan.pdf', minimalPdf(''));

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/scan.pdf',
      attachment: { fileName: 'scan.pdf', contentType: 'application/pdf' },
    });

    const content = result.status === 'opened' ? result.content : '';
    expect(content).toMatch(/^ERROR: /);
    expect(content).toContain('scanned or image-only PDF');
  });

  it('rejects documents beyond the extraction size limit', async () => {
    const root = await temporaryMaterializationRoot();
    const big = Buffer.alloc(21 * 1024 * 1024);
    minimalPdf('padding').copy(big);
    await writeProviderAttachment(root, 'huge.pdf', big);

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/huge.pdf',
      attachment: { fileName: 'huge.pdf', contentType: 'application/pdf' },
    });

    const content = result.status === 'opened' ? result.content : '';
    expect(content).toMatch(/^ERROR: /);
    expect(content).toContain('larger than 20 MB');
  });

  it('extracts readable text from modern Office attachments', async () => {
    const root = await temporaryMaterializationRoot();
    await writeProviderAttachment(root, 'report.docx', MINIMAL_DOCX);

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/report.docx',
      attachment: {
        fileName: 'report.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    });

    expect(result).toMatchObject({ status: 'opened' });
    expect(result.status === 'opened' ? result.content : '').toContain(
      'Readable DOCX attachment',
    );
  });

  it('returns honest guidance for legacy Office attachments', async () => {
    const root = await temporaryMaterializationRoot();
    await writeProviderAttachment(root, 'report.doc', Buffer.from('legacy'));

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/report.doc',
      attachment: { fileName: 'report.doc', contentType: 'application/msword' },
    });

    expect(result).toMatchObject({ status: 'opened' });
    expect(result.status === 'opened' ? result.content : '').toContain(
      'legacy Microsoft Office format',
    );
  });

  it('does not crash the agent when a document cannot be parsed', async () => {
    const root = await temporaryMaterializationRoot();
    await writeProviderAttachment(root, 'broken.pdf', Buffer.from('not a PDF'));

    const result = await readProviderAttachment({
      materializationRoot: root,
      workspaceRoots: [],
      storageRef: 'provider-attachments/broken.pdf',
      attachment: { fileName: 'broken.pdf', contentType: 'application/pdf' },
    });

    expect(result).toMatchObject({ status: 'opened' });
    const content = result.status === 'opened' ? result.content : '';
    expect(content).toMatch(/^ERROR: /);
    expect(content).toContain('could not be read as a PDF');
  });
});
