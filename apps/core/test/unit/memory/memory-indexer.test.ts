import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DisabledEmbeddingClient,
  type EmbeddingProvider,
} from '@core/memory/memory-embeddings.js';
import { MemoryIndexer } from '@core/memory/memory-indexer.js';
import { MemoryStore } from '@core/memory/memory-store.js';

const tempRoots: string[] = [];

function writeItemMarkdown(
  filePath: string,
  input: { id: string; key: string },
): void {
  const content = [
    '---',
    `id: ${input.id}`,
    'scope: group',
    'group_folder: team',
    'kind: fact',
    `key: ${input.key}`,
    'source: test',
    'confidence: 0.9',
    '---',
    '',
    '## Value',
    'Ravi',
    '',
    '## Why',
    'Directly edited from markdown.',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf-8');
}

function writeKnowledgeMarkdown(filePath: string, body: string): void {
  const content = [
    '# Team Knowledge',
    '',
    body,
    '',
    'Use this document for retrieval tests in memory indexing.',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf-8');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('MemoryIndexer', () => {
  it('does not resurrect tombstoned items during reindex', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-indexer-'));
    tempRoots.push(root);
    const memoryRoot = path.join(root, 'memory');
    const itemDir = path.join(memoryRoot, 'items', 'fact');
    fs.mkdirSync(itemDir, { recursive: true });
    const filePath = path.join(itemDir, 'owner.md');
    writeItemMarkdown(filePath, { id: 'mem-owner', key: 'owner' });

    const store = new MemoryStore(path.join(root, 'memory.db'));
    store.saveItem({
      id: 'mem-owner',
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'owner',
      value: 'Ravi',
      why: 'From prior session',
      source: 'test',
      confidence: 0.9,
      source_folder: 'items',
      file_path: filePath,
      content_hash: 'stale-hash',
      indexed_at: '2026-01-01T00:00:00.000Z',
    });
    store.softDeleteItem('mem-owner');

    const indexer = new MemoryIndexer(
      memoryRoot,
      store,
      new DisabledEmbeddingClient(),
    );
    indexer.indexFile(filePath);

    const active = store.findItemByKey({
      scope: 'group',
      groupFolder: 'team',
      key: 'owner',
    });
    const tombstoned = store.getItemByIdAny('mem-owner');

    expect(active).toBeNull();
    expect(tombstoned).not.toBeNull();
    expect(tombstoned?.is_deleted).toBe(true);
    store.close();
  });

  it('uses frontmatter id as stable identity for new item files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-indexer-'));
    tempRoots.push(root);
    const memoryRoot = path.join(root, 'memory');
    const itemDir = path.join(memoryRoot, 'items', 'fact');
    fs.mkdirSync(itemDir, { recursive: true });
    const filePath = path.join(itemDir, 'decision.md');
    writeItemMarkdown(filePath, { id: 'mem-decision', key: 'decision' });

    const store = new MemoryStore(path.join(root, 'memory.db'));
    const indexer = new MemoryIndexer(
      memoryRoot,
      store,
      new DisabledEmbeddingClient(),
    );

    indexer.indexFile(filePath);

    const saved = store.getItemById('mem-decision');
    expect(saved).not.toBeNull();
    expect(saved?.key).toBe('decision');
    expect(saved?.file_path).toBe(path.resolve(filePath));
    store.close();
  });

  it('keeps items active when markdown file path changes with same content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-indexer-'));
    tempRoots.push(root);
    const memoryRoot = path.join(root, 'memory');
    const itemDir = path.join(memoryRoot, 'items', 'fact');
    fs.mkdirSync(itemDir, { recursive: true });
    const oldPath = path.join(itemDir, 'old-owner.md');
    const newPath = path.join(itemDir, 'new-owner.md');
    writeItemMarkdown(newPath, { id: 'mem-move', key: 'owner' });
    const content = fs.readFileSync(newPath, 'utf-8');
    const contentHash = crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');

    const store = new MemoryStore(path.join(root, 'memory.db'));
    store.saveItem({
      id: 'mem-move',
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'owner',
      value: 'Ravi',
      why: 'From prior session',
      source: 'test',
      confidence: 0.9,
      source_folder: 'items',
      file_path: oldPath,
      content_hash: contentHash,
      indexed_at: '2026-01-01T00:00:00.000Z',
    });

    const indexer = new MemoryIndexer(
      memoryRoot,
      store,
      new DisabledEmbeddingClient(),
    );
    indexer.reindexStaleFiles();

    const current = store.getItemById('mem-move');
    expect(current).not.toBeNull();
    expect(current?.is_deleted).toBe(false);
    expect(current?.file_path).toBe(path.resolve(newPath));
    store.close();
  });

  it('replaces and removes source chunks as knowledge files change or disappear', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-indexer-'));
    tempRoots.push(root);
    const memoryRoot = path.join(root, 'memory');
    const knowledgeDir = path.join(memoryRoot, 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const filePath = path.join(knowledgeDir, 'architecture.md');

    const store = new MemoryStore(path.join(root, 'memory.db'));
    const indexer = new MemoryIndexer(
      memoryRoot,
      store,
      new DisabledEmbeddingClient(),
    );

    writeKnowledgeMarkdown(
      filePath,
      'First version includes alpha details and onboarding notes for retrieval.',
    );
    indexer.reindexStaleFiles();
    const sourceId = path.resolve(filePath);
    const firstChunks = store.listSourceChunks('knowledge', sourceId);
    expect(firstChunks.length).toBeGreaterThan(0);
    expect(firstChunks.every((chunk) => chunk.scope === 'global')).toBe(true);
    expect(firstChunks.every((chunk) => chunk.group_folder === '_global')).toBe(
      true,
    );
    expect(
      firstChunks.some((chunk) => chunk.text.includes('alpha details')),
    ).toBe(true);
    const firstMatches = store.lexicalSearch('alpha', 'team', 10);
    expect(firstMatches.some((match) => match.source_path === sourceId)).toBe(
      true,
    );

    writeKnowledgeMarkdown(
      filePath,
      'Second version replaces beta guidance and removes previous alpha wording.',
    );
    indexer.reindexStaleFiles();
    const secondChunks = store.listSourceChunks('knowledge', sourceId);
    expect(secondChunks.length).toBeGreaterThan(0);
    expect(secondChunks.every((chunk) => chunk.scope === 'global')).toBe(true);
    expect(
      secondChunks.some((chunk) => chunk.text.includes('beta guidance')),
    ).toBe(true);
    expect(
      secondChunks.some((chunk) => chunk.text.includes('alpha details')),
    ).toBe(false);

    fs.rmSync(filePath, { force: true });
    indexer.reindexStaleFiles();
    expect(store.listSourceChunks('knowledge', sourceId).length).toBe(0);
    store.close();
  });

  it('skips stale async chunk writes after file content changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-indexer-'));
    tempRoots.push(root);
    const memoryRoot = path.join(root, 'memory');
    const knowledgeDir = path.join(memoryRoot, 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const filePath = path.join(knowledgeDir, 'race.md');

    writeKnowledgeMarkdown(filePath, 'alpha generation content for race test');

    const store = new MemoryStore(path.join(root, 'memory.db'));
    let firstReject: (() => void) | null = null;
    const embeddings: EmbeddingProvider = {
      isEnabled: () => true,
      validateConfiguration: () => {},
      embedOne: async () => [0],
      embedMany: vi
        .fn()
        .mockImplementationOnce(
          async () =>
            await new Promise<number[][]>((_resolve, reject) => {
              firstReject = () => reject(new Error('delayed embed failure'));
            }),
        )
        .mockImplementation(async () => {
          throw new Error('embed unavailable');
        }),
    };
    const indexer = new MemoryIndexer(memoryRoot, store, embeddings);

    indexer.reindexStaleFiles();

    writeKnowledgeMarkdown(
      filePath,
      'beta generation content replaces alpha for race test',
    );
    indexer.reindexStaleFiles();

    firstReject?.();
    await indexer.reindexStaleFilesAndWait();

    const sourceId = path.resolve(filePath);
    const chunks = store.listSourceChunks('knowledge', sourceId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => chunk.text.includes('beta generation'))).toBe(
      true,
    );
    expect(
      chunks.some((chunk) => chunk.text.includes('alpha generation')),
    ).toBe(false);
    store.close();
  });
});
