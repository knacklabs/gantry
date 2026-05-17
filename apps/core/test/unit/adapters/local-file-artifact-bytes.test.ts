import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalFileArtifactBytes } from '@core/adapters/artifacts/files/local-file-artifact-bytes.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('LocalFileArtifactBytes', () => {
  it('stores bytes under the configured files root and verifies hash metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-files-'));
    roots.push(root);
    const bytes = new LocalFileArtifactBytes(root);

    const stored = await bytes.putBytes({
      id: 'file-artifact:test' as never,
      appId: 'app-1',
      agentId: 'agent-1',
      virtualScope: 'scratch',
      virtualPath: 'notes/today.md',
      version: 1,
      content: 'hello',
    });

    expect(stored.storageRef).not.toContain(root);
    expect(stored.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      fs.existsSync(path.join(root, ...stored.storageRef.split('/'))),
    ).toBe(true);
    expect(
      (
        await bytes.getBytes(stored.storageRef, {
          hash: stored.contentHash,
          sizeBytes: stored.sizeBytes,
        })
      ).toString('utf8'),
    ).toBe('hello');
  });

  it('rejects storage refs that escape the files root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-files-'));
    roots.push(root);
    const bytes = new LocalFileArtifactBytes(root);

    await expect(
      bytes.getBytes('../outside', { hash: 'sha256:nope', sizeBytes: 1 }),
    ).rejects.toThrow(/Invalid file artifact storage ref/);
  });

  it('detects tampered bytes and removes stored content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-files-'));
    roots.push(root);
    const bytes = new LocalFileArtifactBytes(root);
    const stored = await bytes.putBytes({
      id: 'file-artifact:tamper' as never,
      appId: 'app-1',
      agentId: 'agent-1',
      virtualScope: 'default',
      virtualPath: 'bin/blob.dat',
      version: 1,
      content: 'original',
    });
    const filePath = path.join(root, ...stored.storageRef.split('/'));
    fs.writeFileSync(filePath, 'tampered');

    await expect(
      bytes.getBytes(stored.storageRef, {
        hash: stored.contentHash,
        sizeBytes: stored.sizeBytes,
      }),
    ).rejects.toThrow(/File artifact hash mismatch/);

    await bytes.removeBytes(stored.storageRef);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('creates a writable storage root during health checks', async () => {
    const root = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-files-')),
      'nested',
      'files',
    );
    roots.push(path.dirname(path.dirname(root)));
    const bytes = new LocalFileArtifactBytes(root);

    await expect(bytes.healthCheck()).resolves.toBeUndefined();
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });
});
