import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readRuntimeMemorySettingsSnapshot,
  readRuntimeStorageSettingsSnapshot,
} from '@core/cli/runtime-settings.js';

const tempDirs: string[] = [];

function writeSettings(contents: string): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'myclaw-runtime-settings-'),
  );
  tempDirs.push(runtimeHome);
  fs.writeFileSync(path.join(runtimeHome, 'settings.yaml'), contents, 'utf-8');
  return runtimeHome;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readRuntimeMemorySettingsSnapshot', () => {
  it('parses boolean fields with inline comments', () => {
    const runtimeHome = writeSettings(`
memory:
  enabled: false # disabled for test
  root: memory
  embeddings:
    enabled: true # enabled
`);

    const snapshot = readRuntimeMemorySettingsSnapshot(runtimeHome);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.embeddingsEnabled).toBe(true);
    expect(snapshot.root).toBe('memory');
  });

  it('throws when memory.root is missing', () => {
    const runtimeHome = writeSettings(`
memory:
  enabled: true
`);

    expect(() => readRuntimeMemorySettingsSnapshot(runtimeHome)).toThrow(
      /memory\.root must be set explicitly/i,
    );
  });

  it('throws when memory.enabled is not a boolean', () => {
    const runtimeHome = writeSettings(`
memory:
  enabled: yes
  root: memory
`);

    expect(() => readRuntimeMemorySettingsSnapshot(runtimeHome)).toThrow(
      /memory\.enabled must be true or false/i,
    );
  });

  it('throws when memory.embeddings.provider is not supported', () => {
    const runtimeHome = writeSettings(`
memory:
  enabled: true
  root: memory
  embeddings:
    enabled: true
    provider: none
`);

    expect(() => readRuntimeMemorySettingsSnapshot(runtimeHome)).toThrow(
      /memory\.embeddings\.provider must be disabled or openai/i,
    );
  });

  it('parses JSON settings format', () => {
    const runtimeHome = writeSettings(
      JSON.stringify(
        {
          memory: {
            enabled: true,
            root: 'memory-json',
            embeddings: {
              enabled: false,
              provider: 'disabled',
              model: 'text-embedding-3-large',
            },
            dreaming: {
              enabled: true,
            },
            llm: {
              models: {
                extractor: 'claude-haiku-4-5-20251001',
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const snapshot = readRuntimeMemorySettingsSnapshot(runtimeHome);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.root).toBe('memory-json');
    expect(snapshot.embeddingsEnabled).toBe(false);
    expect(snapshot.dreamingEnabled).toBe(true);
    expect(snapshot.llmExtractorModel).toBe('claude-haiku-4-5-20251001');
  });

  it('ignores legacy session summary model keys in JSON snapshot', () => {
    const runtimeHome = writeSettings(
      JSON.stringify(
        {
          memory: {
            enabled: true,
            root: 'memory-json',
            llm: {
              models: {
                extractor: 'claude-haiku-4-5-20251001',
                session_summary: 'legacy-model',
                sessionSummary: 'legacy-model-2',
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const snapshot = readRuntimeMemorySettingsSnapshot(runtimeHome);
    expect(snapshot.llmExtractorModel).toBe('claude-haiku-4-5-20251001');
    expect((snapshot as Record<string, unknown>).llmSessionSummaryModel).toBe(
      undefined,
    );
  });

  it('ignores legacy session summary model keys in YAML snapshot', () => {
    const runtimeHome = writeSettings(`
memory:
  enabled: true
  root: memory
  llm:
    models:
      extractor: claude-haiku-4-5-20251001
      session_summary: legacy-model
      sessionSummary: legacy-model-2
`);

    const snapshot = readRuntimeMemorySettingsSnapshot(runtimeHome);
    expect(snapshot.llmExtractorModel).toBe('claude-haiku-4-5-20251001');
    expect((snapshot as Record<string, unknown>).llmSessionSummaryModel).toBe(
      undefined,
    );
  });
});

describe('readRuntimeStorageSettingsSnapshot', () => {
  it('returns defaults when storage block is absent', () => {
    const runtimeHome = writeSettings(`
memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`);
    const snapshot = readRuntimeStorageSettingsSnapshot(runtimeHome);
    expect(snapshot.provider).toBeUndefined();
    expect(snapshot.sqlitePath).toBeUndefined();
    expect(snapshot.postgresUrlEnv).toBeUndefined();
  });

  it('parses storage block fields', () => {
    const runtimeHome = writeSettings(`
storage:
  provider: postgres
  sqlite:
    path: store/custom.db
  postgres:
    url_env: CUSTOM_DB_URL
    schema: custom_myclaw
memory:
  enabled: true
  root: memory
  embeddings:
    enabled: false
    provider: disabled
    model: text-embedding-3-large
  dreaming:
    enabled: false
`);
    const snapshot = readRuntimeStorageSettingsSnapshot(runtimeHome);
    expect(snapshot.provider).toBe('postgres');
    expect(snapshot.sqlitePath).toBe('store/custom.db');
    expect(snapshot.postgresUrlEnv).toBe('CUSTOM_DB_URL');
    expect(snapshot.postgresSchema).toBe('custom_myclaw');
  });

  it('throws when storage.provider is not sqlite or postgres', () => {
    const runtimeHome = writeSettings(`
storage:
  provider: mysql
memory:
  enabled: true
  root: memory
`);
    expect(() => readRuntimeStorageSettingsSnapshot(runtimeHome)).toThrow(
      /storage\.provider must be sqlite or postgres/i,
    );
  });

  it('throws when storage.postgres.schema is not a safe identifier', () => {
    const runtimeHome = writeSettings(`
storage:
  provider: postgres
  postgres:
    schema: "bad-schema;drop"
memory:
  enabled: true
  root: memory
`);
    expect(() => readRuntimeStorageSettingsSnapshot(runtimeHome)).toThrow(
      /storage\.postgres\.schema must be a valid PostgreSQL schema identifier/i,
    );
  });
});
