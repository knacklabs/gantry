import { describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';

function makeGroup(
  overrides: Partial<ConversationRoute> = {},
): ConversationRoute {
  return {
    name: 'Default Agent',
    folder: 'main_agent',
    trigger: '@main',
    added_at: '2026-04-24T09:00:00.000Z',
    requiresTrigger: false,
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
      ASSISTANT_NAME: 'Default Agent',
      DATA_DIR: '/tmp/gantry-test',
      GANTRY_IPC_AUTH_SECRET: 'runtime-app-test-secret',
      getCredentialBrokerRuntimeConfig: () => ({
        mode: 'gantry',
        model_gatewayUrl: 'http://localhost:10254',
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
    getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
  }));
  return import('@core/app/bootstrap/runtime-app.js');
}

async function loadRuntimeAppWithGroupProcessorSpy() {
  vi.resetModules();
  const createGroupProcessor = vi.fn(() => ({
    processGroupMessages: vi.fn(async () => true),
  }));
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return {
      ...actual,
      ASSISTANT_NAME: 'Default Agent',
      DATA_DIR: '/tmp/gantry-test',
      GANTRY_IPC_AUTH_SECRET: 'runtime-app-test-secret',
      getCredentialBrokerRuntimeConfig: () => ({
        mode: 'gantry',
        model_gatewayUrl: 'http://localhost:10254',
        externalBrokerBaseUrl: undefined,
      }),
    };
  });
  vi.doMock('@core/runtime/group-processing.js', () => ({
    createGroupProcessor,
  }));
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeRepositories: vi.fn(() => {
      throw new Error('ops repository should not be used by this test');
    }),
    getRuntimeSkillArtifactStore: vi.fn(),
    getRuntimeStorage: vi.fn(),
    getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
  }));
  const runtimeApp = await import('@core/app/bootstrap/runtime-app.js');
  return { ...runtimeApp, createGroupProcessor };
}

describe('runtime app credential binding', () => {
  it('ensures shared Model Access once and agent-scoped tool profiles for registered groups', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const firstGroup = makeGroup();
    const sideGroup = makeGroup({
      name: 'Side Agent',
      folder: 'side_agent',
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
      agentIdentifier: 'gantry-model-access',
      agentName: 'Gantry Model Access',
    });
    expect(ensureCredentialBinding).toHaveBeenCalledWith({
      groupJid: 'tg:first',
      group: firstGroup,
      agentIdentifier: 'agent:main_agent',
      agentName: 'Default Agent',
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
      .mockRejectedValueOnce(new Error('Gantry Model Gateway starting'))
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
        agentIdentifier: 'gantry-model-access',
        agentName: 'Gantry Model Access',
      },
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'agent:main_agent',
        agentName: 'Default Agent',
      },
      {
        groupJid: 'tg:first',
        group,
        agentIdentifier: 'gantry-model-access',
        agentName: 'Gantry Model Access',
      },
    ]);
  });

  it('delegates provider-visible streaming support to channel runtime', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const app = createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];
    expect(capturedDeps).toBeDefined();

    app.setChannelRuntime({
      hasChannel: vi.fn(() => true),
      supportsStreaming: vi.fn(() => true),
      supportsProgress: vi.fn(() => false),
      sendMessage: vi.fn(async () => {}),
      sendStreamingChunk: vi.fn(async () => true),
      resetStreaming: vi.fn(),
      setTyping: vi.fn(async () => {}),
      sendProgressUpdate: vi.fn(async () => {}),
    });

    expect(capturedDeps?.channelRuntime.supportsStreaming('tg:primary')).toBe(
      true,
    );
  });

  it('preserves an explicit empty thread cursor for first-message retry', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor: vi.fn(),
      } as any,
    });
    const globalCursor =
      '{"timestamp":"2026-06-04 05:44:24.529+00","id":"1780551864.529109"}';
    const threadQueueJid = 'sl:C1234567890::thread:1780551797.956909';

    app.setLastTimestamp(globalCursor);
    app.setAgentCursor(threadQueueJid, '');

    await expect(app.getOrRecoverCursor(threadQueueJid)).resolves.toBe('');
    expect(setRouterState).not.toHaveBeenCalledWith(
      'last_agent_timestamp',
      expect.any(String),
    );
  });
});
