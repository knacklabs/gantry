import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { inspectMemoryHealth } from '@core/cli/memory-health.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';

function runtimeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-memory-health-'));
}

describe('memory health', () => {
  it('fails unknown embedding providers before runtime use', () => {
    const settings = createDefaultRuntimeSettings();
    settings.memory.embeddings.enabled = true;
    settings.memory.embeddings.provider = 'not-registered';
    settings.memory.embeddings.model = 'custom-embedding-model';

    const health = inspectMemoryHealth(runtimeHome(), settings, {});

    expect(health.embeddingCheck.status).toBe('fail');
    expect(health.embeddingCheck.message).toContain(
      'Unknown embedding provider',
    );
  });
});
