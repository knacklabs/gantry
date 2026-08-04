import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FileArtifactId } from '@core/domain/file-artifacts/file-artifact.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('Postgres file artifact store', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'file_artifacts',
    });
    await runtime.service.pool.query(
      `INSERT INTO apps (id, slug, name, status) VALUES ($1, $2, $3, 'active') ON CONFLICT DO NOTHING`,
      ['app:test', 'file-artifact-test', 'FileArtifact Test'],
    );
    for (const agentId of [
      'agent:alpha',
      'agent:versioned',
      'agent:other',
      'agent:concurrent',
      'agent:expected-version',
      'agent:promoter',
      'agent:binary',
    ]) {
      await runtime.service.pool.query(
        `INSERT INTO agents (id, app_id, name, status) VALUES ($1, $2, $3, 'active') ON CONFLICT DO NOTHING`,
        [agentId, 'app:test', agentId],
      );
    }
  }, 60_000);

  afterAll(async () => {
    if (!runtime) return;
    await runtime.cleanup();
  });

  it('round-trips text artifacts through compact descriptors', async () => {
    const store = runtime.storageRuntime.fileArtifacts;
    const artifact = await store.writeFileArtifact({
      appId: 'app:test',
      agentId: 'agent:alpha',
      virtualScope: 'default',
      virtualPath: 'notes/result.md',
      content: '  leading whitespace is data\n',
      contentType: 'text/markdown',
      createdBy: 'agent:alpha',
      metadata: { source: 'unit' },
    });

    const descriptors = await store.listFileArtifacts({
      appId: 'app:test',
      agentId: 'agent:alpha',
      virtualScope: 'default',
      virtualPath: 'notes/result.md',
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: artifact.id,
      scope: 'default',
      path: 'notes/result.md',
      version: 1,
      contentType: 'text/markdown',
      createdBy: 'agent:alpha',
    });
    expect(descriptors[0]).not.toHaveProperty('storageRef');

    await expect(
      store.readFileArtifact({
        appId: 'app:test',
        agentId: 'agent:alpha',
        id: artifact.id,
      }),
    ).resolves.toMatchObject({
      artifact: expect.objectContaining({
        metadata: { source: 'unit' },
      }),
      content: '  leading whitespace is data\n',
    });
  });

  it('versions artifacts per owner and returns the latest path version', async () => {
    const store = runtime.storageRuntime.fileArtifacts;
    const owner = {
      appId: 'app:test',
      agentId: 'agent:versioned',
      virtualScope: 'default',
      virtualPath: 'reports/daily.txt',
      contentType: 'text/plain',
    };
    const first = await store.writeFileArtifact({
      ...owner,
      content: 'first version',
    });
    const second = await store.writeFileArtifact({
      ...owner,
      content: 'second version',
    });
    const otherAgent = await store.writeFileArtifact({
      ...owner,
      agentId: 'agent:other',
      content: 'other agent first version',
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(otherAgent.version).toBe(1);

    await expect(
      store.readFileArtifact({
        appId: owner.appId,
        agentId: owner.agentId,
        virtualScope: owner.virtualScope,
        virtualPath: owner.virtualPath,
      }),
    ).resolves.toMatchObject({ content: 'second version' });
    await expect(
      store.readFileArtifact({
        appId: owner.appId,
        agentId: owner.agentId,
        virtualScope: owner.virtualScope,
        virtualPath: owner.virtualPath,
        version: 1,
      }),
    ).resolves.toMatchObject({ content: 'first version' });

    await runtime.service.pool.query(
      `UPDATE file_artifacts SET created_at = $1 WHERE id = $2`,
      ['2035-01-01T00:00:00.000Z', first.id],
    );
    await expect(
      store.readFileArtifact({
        appId: owner.appId,
        agentId: owner.agentId,
        virtualScope: owner.virtualScope,
        virtualPath: owner.virtualPath,
      }),
    ).resolves.toMatchObject({ content: 'second version' });
    await expect(
      store.listFileArtifacts({
        appId: owner.appId,
        agentId: owner.agentId,
        virtualScope: owner.virtualScope,
        virtualPath: owner.virtualPath,
        version: 1,
      }),
    ).resolves.toMatchObject([
      expect.objectContaining({
        id: first.id,
        version: 1,
      }),
    ]);
  });

  it('allocates versions atomically for concurrent writers', async () => {
    const store = runtime.storageRuntime.fileArtifacts;
    const owner = {
      appId: 'app:test',
      agentId: 'agent:concurrent',
      virtualScope: 'default',
      virtualPath: 'reports/concurrent.txt',
      contentType: 'text/plain',
    };

    const artifacts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.writeFileArtifact({
          ...owner,
          content: `concurrent version ${index}`,
        }),
      ),
    );

    expect(
      artifacts.map((artifact) => artifact.version).sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const listed = await store.listFileArtifacts({
      appId: owner.appId,
      agentId: owner.agentId,
      virtualScope: owner.virtualScope,
      virtualPath: owner.virtualPath,
      limit: 10,
    });
    expect(listed.map((artifact) => artifact.version)).toEqual([
      8, 7, 6, 5, 4, 3, 2, 1,
    ]);
  });

  it('rejects concurrent writers with the same expected version atomically', async () => {
    const store = runtime.storageRuntime.fileArtifacts;
    const owner = {
      appId: 'app:test',
      agentId: 'agent:expected-version',
      virtualScope: 'prompt-profile',
      virtualPath: 'main_agent/AGENTS.md',
      contentType: 'text/markdown',
    };
    await store.writeFileArtifact({
      ...owner,
      content: '# initial',
    });

    const results = await Promise.allSettled(
      ['# next a', '# next b'].map((content) =>
        store.writeFileArtifact({
          ...owner,
          content,
          expectedVersion: 1,
        }),
      ),
    );

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({
      name: 'FileArtifactVersionConflictError',
      latestVersion: 2,
    });
    const listed = await store.listFileArtifacts({
      appId: owner.appId,
      agentId: owner.agentId,
      virtualScope: owner.virtualScope,
      virtualPath: owner.virtualPath,
      limit: 10,
    });
    expect(listed.map((artifact) => artifact.version)).toEqual([2, 1]);
  });

  it('promotes scratch artifacts with lineage metadata', async () => {
    const store = runtime.storageRuntime.fileArtifacts;
    const scratch = await store.writeFileArtifact({
      appId: 'app:test',
      agentId: 'agent:promoter',
      virtualScope: 'scratch',
      virtualPath: 'drafts/report.txt',
      content: 'draft bytes',
      contentType: 'text/plain',
      createdBy: 'agent:promoter',
    });

    const promoted = await store.promoteScratch({
      appId: 'app:test',
      agentId: 'agent:promoter',
      scratchPath: 'drafts/report.txt',
      targetScope: 'default',
      targetPath: 'reports/report.txt',
      createdBy: 'agent:promoter',
      metadata: { reviewed: true },
    });

    expect(promoted).toMatchObject({
      virtualScope: 'default',
      virtualPath: 'reports/report.txt',
      version: 1,
      promotedFromArtifactId: scratch.id,
      metadata: {
        reviewed: true,
        promotedFromScope: 'scratch',
        promotedFromPath: 'drafts/report.txt',
        promotedFromVersion: 1,
      },
    });
    await expect(
      store.readFileArtifact({
        appId: 'app:test',
        agentId: 'agent:promoter',
        id: promoted.id,
      }),
    ).resolves.toMatchObject({ content: 'draft bytes' });
  });

  it('validates stored binary bytes by hash and size', async () => {
    const store = runtime.storageRuntime.fileArtifacts;
    const content = new Uint8Array([0, 1, 2, 250, 255]);
    const artifact = await store.writeFileArtifact({
      appId: 'app:test',
      agentId: 'agent:binary',
      virtualScope: 'default',
      virtualPath: 'bin/blob.dat',
      content,
      contentType: 'application/octet-stream',
    });

    const result = await store.readFileArtifact({
      appId: 'app:test',
      agentId: 'agent:binary',
      id: artifact.id as FileArtifactId,
    });

    expect(result.content).toBeInstanceOf(Uint8Array);
    expect([...Buffer.from(result.content as Uint8Array)]).toEqual([
      0, 1, 2, 250, 255,
    ]);
  });

  it('cleans staged bytes when metadata insert is rejected', async () => {
    const store = runtime.storageRuntime.fileArtifacts;
    const filesRoot = path.join(runtime.artifactRoot, 'files');
    const before = listStoredFiles(filesRoot);

    await expect(
      store.writeFileArtifact({
        appId: 'app:test',
        agentId: 'agent:missing',
        virtualScope: 'default',
        virtualPath: 'notes/rejected.txt',
        content: 'rejected',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow();

    expect(listStoredFiles(filesRoot)).toEqual(before);
  });
});

function listStoredFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      if (entry.isFile()) out.push(entryPath);
    }
  };
  walk(root);
  return out.sort();
}
