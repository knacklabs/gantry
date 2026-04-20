import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { readRuntimeMemorySettingsSnapshot } from '@core/core/runtime-memory-settings.js';

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
                session_summary: 'claude-haiku-4-5-20251001',
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
    expect(snapshot.llmSessionSummaryModel).toBe('claude-haiku-4-5-20251001');
  });
});
