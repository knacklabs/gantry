import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const runtimeHomes: string[] = [];

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-agent-name-'),
  );
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

async function loadAgentCommand() {
  const log = {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('@clack/prompts', () => ({
    isCancel: () => false,
    note: vi.fn(),
    log,
  }));
  const { runAgentCommand } = await import('@core/cli/group.js');
  return { runAgentCommand, log };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@clack/prompts');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('agent name command', () => {
  it('does not print restart guidance for live-applied agent defaults', async () => {
    const runtimeHome = makeRuntimeHome();
    saveRuntimeSettings(runtimeHome, loadRuntimeSettings(runtimeHome));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runAgentCommand, log } = await loadAgentCommand();

    const code = await runAgentCommand(runtimeHome, ['name', 'New Agent']);

    expect(code).toBe(0);
    expect(consoleLog).not.toHaveBeenCalledWith(
      'This change requires a restart to take effect — run `gantry restart`.',
    );
    expect(log.info).not.toHaveBeenCalled();
  });
});
