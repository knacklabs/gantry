import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { launchSourceDocumentRenderer } from '../../../src/source-documents/launcher.js';
const request = {
  version: 1 as const,
  format: 'pdf' as const,
  fileName: 'answer.pdf',
  title: 'Answer',
  blocks: [{ type: 'paragraph' as const, text: 'Cited answer' }],
};
async function script(code: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'doc-launch-'));
  const file = path.join(dir, 'cli.mjs');
  await writeFile(file, code);
  return { file, close: () => rm(dir, { recursive: true, force: true }) };
}
describe('native source document subprocess', () => {
  it('verifies actual bytes and keeps provider credentials out of subprocess', async () => {
    const bytes = Buffer.from('%PDF-1.7\nDocument');
    const result = {
      version: 1,
      rendererVersion: 'v1',
      fileName: 'answer.pdf',
      contentType: 'application/pdf',
      bytesBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    };
    const child = await script(
      `process.stdin.resume();process.stdin.on('end',()=>{if(process.env.ANTHROPIC_API_KEY)process.exit(2);process.stdout.write(${JSON.stringify(JSON.stringify(result))});});`,
    );
    try {
      const value = await launchSourceDocumentRenderer(request, {
        entrypoint: child.file,
        deadlineAtMs: Date.now() + 5000,
      });
      expect(value.bytes).toEqual(bytes);
      expect(value.result.sha256).toBe(result.sha256);
    } finally {
      await child.close();
    }
  });
  it('terminates a hung renderer within the remaining execution budget', async () => {
    const child = await script('setInterval(()=>{},1000);');
    try {
      await expect(
        launchSourceDocumentRenderer(request, {
          entrypoint: child.file,
          deadlineAtMs: Date.now() + 50,
        }),
      ).rejects.toThrow(/failed|expired/);
    } finally {
      await child.close();
    }
  });
  it('rejects forged byte hashes and cancels subprocess output', async () => {
    const child = await script(
      `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({version:1,rendererVersion:'v1',fileName:'answer.pdf',contentType:'application/pdf',bytesBase64:'JVBERi0=',sha256:'0'.repeat(64),sizeBytes:5})));`,
    );
    try {
      await expect(
        launchSourceDocumentRenderer(request, {
          entrypoint: child.file,
          deadlineAtMs: Date.now() + 5000,
        }),
      ).rejects.toThrow(/failed/);
    } finally {
      await child.close();
    }
  });
});
