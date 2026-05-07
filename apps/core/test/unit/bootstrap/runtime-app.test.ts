import { describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';

function makeGroup(
  overrides: Partial<ConversationRoute> = {},
): ConversationRoute {
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
    getRuntimeRepositories: vi.fn(() => {
      throw new Error('ops repository should not be used by this test');
    }),
    getRuntimeSkillArtifactStore: vi.fn(),
    getRuntimeStorage: vi.fn(),
  }));
  return import('@core/app/bootstrap/runtime-app.js');
}

describe('runtime app credential binding', () => {
  it('ensures shared Model Access once and agent-scoped tool profiles for registered groups', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const firstGroup = makeGroup();
    const sideGroup = makeGroup({
      name: 'Side Agent',
      folder: 'side_agent',
      isMain: false,
    });
    const ensureCredentialBinding = vi.fn(async () => ({ created: true }));
    const app = createRuntimeApp({ ensureCredentialBinding });

    app.setConversationRoutesForTest({
      'tg:first': firstGroup,
      'tg:second': sideGroup,
    });

    await app.ensureCredentialBindingsForConversationRoutes();
    await app.ensureCredentialBindingsForConversationRoutes();

    expect(ensureCredentialBinding).toHaveBeenCalledTimes(3);
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:first',
      group: firstGroup,
      agentIdentifier: 'myclaw-model-access',
      agentName: 'MyClaw Model Access',
    });
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:first',
      group: firstGroup,
      agentIdentifier: 'agent:main_agent',
      agentName: 'Main Agent',
    });
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:second',
      group: sideGroup,
      agentIdentifier: 'agent:side_agent',
      agentName: 'Side Agent',
    });
  });

  it('retries a failed credential profile ensure attempt', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const group = makeGroup();
    const ensureCredentialBinding = vi
      .fn()
      .mockRejectedValueOnce(new Error('OneCLI starting'))
      .mockResolvedValueOnce({ created: false });
    const app = createRuntimeApp({ ensureCredentialBinding });

    app.setConversationRoutesForTest({ 'tg:first': group });

    await app.ensureCredentialBindingsForConversationRoutes();
    await app.ensureCredentialBindingsForConversationRoutes();

    expect(ensureCredentialBinding).toHaveBeenCalledTimes(3);
    expect(ensureCredentialBinding.mock.calls.map(([input]) => input)).toEqual([
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'myclaw-model-access',
        agentName: 'MyClaw Model Access',
      },
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'agent:main_agent',
        agentName: 'Main Agent',
      },
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'myclaw-model-access',
        agentName: 'MyClaw Model Access',
      },
    ]);
  });
});
