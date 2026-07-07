import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresBrainRepository } from '@core/adapters/storage/postgres/repositories/brain-repository.postgres.js';
import {
  _setRuntimeStorageForTest,
  closeRuntimeStorage,
} from '@core/adapters/storage/postgres/runtime-store.js';
import { BrainService } from '@core/brain/brain-service.js';
import { runBrainEmbeddingBackfill } from '@core/brain/brain-embedding-backfill.js';
import { processMemoryRequest } from '@core/memory/memory-ipc.js';
import { runBrainCommand } from '@core/cli/brain.js';
import type { EmbeddingProvider } from '@core/memory/memory-embeddings.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const DIMENSIONS = 1536;
const embeddingConfig = {
  provider: 'test',
  model: 'fake',
  dimensions: DIMENSIONS,
};

function vectorFor(text: string): number[] {
  const vector = new Array(DIMENSIONS).fill(0);
  if (/acme|alice|roster/i.test(text)) vector[0] = 1;
  else if (/beacon|project/i.test(text)) vector[1] = 1;
  else vector[2] = 1;
  return vector;
}

const fakeProvider: EmbeddingProvider = {
  isEnabled: () => true,
  validateConfiguration: () => undefined,
  expectedDimensions: () => DIMENSIONS,
  embedMany: async (texts) => texts.map(vectorFor),
  embedOne: async (text) => vectorFor(text),
};

maybeDescribe('company brain postgres core', () => {
  let runtime: PostgresIntegrationRuntime;
  let brain: BrainService;
  let repo: PostgresBrainRepository;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'company_brain',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    repo = new PostgresBrainRepository(runtime.service.db);
    brain = new BrainService(repo);
  }, 60_000);

  afterAll(async () => {
    await closeRuntimeStorage().catch(() => undefined);
    await runtime.cleanup();
  });

  it('creates pages, entities, edges, and the vector index', async () => {
    await brain.write({
      appId: 'default',
      slug: 'acme-roster',
      markdown: `---
title: Acme roster
people: [Alice]
companies: [Acme]
---
Alice works at Acme.`,
      sourceKind: 'import',
      sourceRef: 'fixtures/acme-roster.md',
    });
    await brain.write({
      appId: 'default',
      slug: 'beacon-project',
      markdown: `---
title: Beacon project
projects: [Beacon]
assignee: Beacon: Alice
---
Beacon is the customer reporting project.`,
      sourceKind: 'import',
      sourceRef: 'fixtures/beacon-project.md',
    });

    const status = await brain.status('default');
    expect(status).toMatchObject({ pages: 2 });
    expect(status.entities).toBeGreaterThanOrEqual(3);
    expect(status.edges).toBeGreaterThanOrEqual(2);

    const index = await runtime.service.pool.query(
      `select indexdef from pg_indexes where schemaname = $1 and indexname = 'idx_brain_page_embeddings_hnsw'`,
      [runtime.schemaName],
    );
    expect(index.rows).toHaveLength(1);
    expect(String(index.rows[0].indexdef)).toContain('hnsw');
  });

  it('serves lexical search and graph-only questions', async () => {
    const search = await brain.search({
      appId: 'default',
      query: 'customer reporting project',
    });
    expect(search[0]?.page.slug).toBe('beacon-project');

    const answer = await brain.query({
      appId: 'default',
      question: 'who works at Acme?',
    });
    expect(answer.answer).toContain('Alice');
    expect(answer.citations[0]?.slug).toBe('acme-roster');
  });

  it('shares brain_write content across agent MCP callers', async () => {
    const write = await processMemoryRequest(
      {
        requestId: 'brain-cross-agent-write',
        action: 'brain_write',
        payload: {
          slug: 'handoff-note',
          markdown: '# Handoff note\n\nThe launch checklist mentions Finch.',
        },
        context: { appId: 'default', agentId: 'agent-a' },
        allowedActions: ['brain_write'],
      } as never,
      'agent-a',
    );
    expect(write.ok).toBe(true);

    const search = await processMemoryRequest(
      {
        requestId: 'brain-cross-agent-search',
        action: 'brain_search',
        payload: { query: 'Finch launch checklist' },
        context: { appId: 'default', agentId: 'agent-b' },
        allowedActions: ['brain_search'],
      } as never,
      'agent-b',
    );
    expect(search.ok).toBe(true);
    const results = (
      search.data as { results: Array<{ page: { slug: string } }> }
    ).results;
    expect(results.some((result) => result.page.slug === 'handoff-note')).toBe(
      true,
    );
  });

  it('backfills current page embeddings', async () => {
    const embedded = new BrainService(repo, {
      embedding: { config: embeddingConfig, provider: fakeProvider },
    });
    const before = await embedded.status('default');
    expect(before.pendingEmbeddings).toBeGreaterThan(0);

    const result = await runBrainEmbeddingBackfill({
      brain: embedded,
      appId: 'default',
      limit: 20,
    });
    expect(result).toContain('indexed');

    const after = await embedded.status('default');
    expect(after.readyEmbeddings).toBe(after.pages);
    expect(after.pendingEmbeddings).toBe(0);
  });

  it('keeps CLI import idempotent', async () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-brain-'));
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-brain-home-'),
    );
    const oldDatabaseUrl = process.env.GANTRY_DATABASE_URL;
    const oldSchema = process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA;
    const oldHome = process.env.GANTRY_HOME;
    const oldBootstrap = process.env.GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING;
    try {
      fs.writeFileSync(
        path.join(fixtureDir, 'cli-roster.md'),
        `---
title: CLI roster
people: [Dana]
companies: [Knacklabs]
---
Dana works at Knacklabs.`,
      );
      fs.mkdirSync(path.join(fixtureDir, 'team-a'));
      fs.mkdirSync(path.join(fixtureDir, 'team-b'));
      fs.writeFileSync(
        path.join(fixtureDir, 'team-a', 'README.md'),
        '# Team A readme',
      );
      fs.writeFileSync(
        path.join(fixtureDir, 'team-b', 'README.md'),
        '# Team B readme',
      );
      process.env.GANTRY_DATABASE_URL = process.env.GANTRY_TEST_DATABASE_URL;
      process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA = runtime.schemaName;
      process.env.GANTRY_HOME = runtimeHome;
      process.env.GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING = '1';

      const before = await brain.status('default');
      expect(await runBrainCommand(runtimeHome, ['import', fixtureDir])).toBe(
        0,
      );
      const first = await brain.status('default');
      // Duplicate basenames in different directories must not collide:
      // slugs derive from the path relative to the import root.
      expect(first.pages - before.pages).toBe(3);
      expect(await runBrainCommand(runtimeHome, ['import', fixtureDir])).toBe(
        0,
      );
      _setRuntimeStorageForTest(runtime.storageRuntime);
      const second = await brain.status('default');
      expect(second.pages).toBe(first.pages);
    } finally {
      if (oldDatabaseUrl === undefined) delete process.env.GANTRY_DATABASE_URL;
      else process.env.GANTRY_DATABASE_URL = oldDatabaseUrl;
      if (oldSchema === undefined)
        delete process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA;
      else process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA = oldSchema;
      if (oldHome === undefined) delete process.env.GANTRY_HOME;
      else process.env.GANTRY_HOME = oldHome;
      if (oldBootstrap === undefined)
        delete process.env.GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING;
      else process.env.GANTRY_BOOTSTRAP_SETTINGS_IF_MISSING = oldBootstrap;
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });
});
