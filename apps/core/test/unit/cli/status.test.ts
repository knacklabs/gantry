import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { collectRuntimeStatus } from '@core/cli/status.js';
import { settingsFilePath } from '@core/cli/runtime-home.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-status-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  return home;
}

describe('runtime status', () => {
  it('creates settings.yaml when collecting status', () => {
    const runtimeHome = createRuntimeHome();
    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(false);

    const status = collectRuntimeStatus(import.meta.url, runtimeHome);

    expect(fs.existsSync(settingsFilePath(runtimeHome))).toBe(true);
    expect(
      status.channels.find((channel) => channel.id === 'telegram')?.enabled,
    ).toBe(false);
    expect(
      status.channels.find((channel) => channel.id === 'slack')?.enabled,
    ).toBe(false);
  });
});
