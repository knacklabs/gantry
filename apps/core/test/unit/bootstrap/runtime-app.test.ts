import { describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from '@core/domain/types.js';

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Main Agent',
    folder: 'main_agent',
    trigger: '@main',
    added_at: '2026-04-24T09:00:00.000Z',
    requiresTrigger: false,
    isMain: true,
    ...overrides,
  };
}

async function loadRuntimeApp() {
  vi.resetModules();
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return {
      ...actual,
      ASSISTANT_NAME: 'Main Agent',
      DATA_DIR: '/tmp/myclaw-test',
      MYCLAW_IPC_AUTH_SECRET: 'runtime-app-test-secret',
      getCredentialBrokerRuntimeConfig: () => ({
        mode: 'onecli',
        onecliUrl: 'http://localhost:10254',
        externalBrokerBaseUrl: undefined,
      }),
    };
  });
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeOpsRepository: vi.fn(() => {
      throw new Error('ops repository should not be used by this test');
    }),
    getRuntimeSkillArtifactStore: vi.fn(),
    getRuntimeStorage: vi.fn(),
  }));
  return import('@core/app/bootstrap/runtime-app.js');
}

describe('runtime app credential binding', () => {
  it('ensures the shared Model Access profile once for registered groups', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const firstGroup = makeGroup();
    const ensureCredentialBinding = vi.fn(async () => ({ created: true }));
    const app = createRuntimeApp({ ensureCredentialBinding });

    app.setRegisteredGroupsForTest({
      'tg:first': firstGroup,
      'tg:second': makeGroup({
        name: 'Side Agent',
        folder: 'side_agent',
        isMain: false,
      }),
    });

    await app.ensureCredentialBindingsForRegisteredGroups();
    await app.ensureCredentialBindingsForRegisteredGroups();

    expect(ensureCredentialBinding).toHaveBeenCalledTimes(1);
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:first',
      group: firstGroup,
      agentIdentifier: 'myclaw-model-access',
    });
  });

  it('retries the shared Model Access profile after a failed ensure attempt', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const group = makeGroup();
    const ensureCredentialBinding = vi
      .fn()
      .mockRejectedValueOnce(new Error('OneCLI starting'))
      .mockResolvedValueOnce({ created: false });
    const app = createRuntimeApp({ ensureCredentialBinding });

    app.setRegisteredGroupsForTest({ 'tg:first': group });

    await app.ensureCredentialBindingsForRegisteredGroups();
    await app.ensureCredentialBindingsForRegisteredGroups();

    expect(ensureCredentialBinding).toHaveBeenCalledTimes(2);
  });
});
