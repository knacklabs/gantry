import { describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

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
    getRuntimeStorage: vi.fn(() => ({})),
    getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
    resolveRuntimePersonIdentity: vi.fn(),
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
    getRuntimeStorage: vi.fn(() => ({})),
    getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
    resolveRuntimePersonIdentity: vi.fn(),
  }));
  const runtimeApp = await import('@core/app/bootstrap/runtime-app.js');
  return { ...runtimeApp, createGroupProcessor };
}

async function loadRuntimeAppWithPersistedRoutes(
  routes: Record<string, ConversationRoute>,
) {
  vi.resetModules();

  const ensureAgentDefaults = vi.fn(async () => undefined);
  const PromptProfileService = vi.fn(function PromptProfileService() {
    return { ensureAgentDefaults };
  });
  const writeProfileFileMirror = vi.fn(async () => undefined);
  const profileFileMirrorExists = vi.fn(async () => false);
  const fileArtifacts = {};

  vi.doMock('@core/application/agents/prompt-profile-service.js', () => ({
    PromptProfileService,
  }));
  vi.doMock('@core/platform/profile-file-mirror.js', () => ({
    writeProfileFileMirror,
    profileFileMirrorExists,
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
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeRepositories: vi.fn(() => {
      throw new Error('ops repository should not be used by this test');
    }),
    getRuntimeStorage: vi.fn(() => ({ fileArtifacts })),
    getRuntimeSkillArtifactStore: vi.fn(),
    getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
    resolveRuntimePersonIdentity: vi.fn(),
  }));
  vi.doMock('@core/runtime/group-processing.js', () => ({
    createGroupProcessor: vi.fn(() => ({
      processGroupMessages: vi.fn(async () => true),
    })),
  }));

  const { createRuntimeApp } =
    await import('@core/app/bootstrap/runtime-app.js');
  return {
    app: createRuntimeApp({
      opsRepository: {
        getRouterState: vi.fn(async () => '{}'),
        getAllConversationRoutes: vi.fn(async () => routes),
      } as any,
    }),
    ensureAgentDefaults,
    promptProfileServiceCtor: PromptProfileService,
    writeProfileFileMirror,
    profileFileMirrorExists,
    fileArtifacts,
  };
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

  it('threads provider account options through channel lookup', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const app = createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];
    const hasChannel = vi.fn(() => true);
    const supportsStreaming = vi.fn(() => true);
    const supportsProgress = vi.fn(() => false);

    app.setChannelRuntime({
      hasChannel,
      supportsStreaming,
      supportsProgress,
      sendMessage: vi.fn(async () => {}),
      sendStreamingChunk: vi.fn(async () => true),
      resetStreaming: vi.fn(),
      setTyping: vi.fn(async () => {}),
      sendProgressUpdate: vi.fn(async () => {}),
    });

    expect(
      capturedDeps?.channelRuntime.hasChannel('sl:C123', {
        providerAccountId: 'slack_beta',
      }),
    ).toBe(true);
    expect(hasChannel).toHaveBeenCalledWith('sl:C123', {
      providerAccountId: 'slack_beta',
    });
    expect(
      capturedDeps?.channelRuntime.supportsStreaming('sl:C123', {
        providerAccountId: 'slack_beta',
      }),
    ).toBe(true);
    expect(
      capturedDeps?.channelRuntime.supportsProgress('sl:C123', {
        providerAccountId: 'slack_beta',
      }),
    ).toBe(false);
    expect(supportsStreaming).toHaveBeenCalledWith('sl:C123', {
      providerAccountId: 'slack_beta',
    });
    expect(supportsProgress).toHaveBeenCalledWith('sl:C123', {
      providerAccountId: 'slack_beta',
    });
  });

  it('resolves agent-qualified routes without overwriting sibling agents', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const app = createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];

    const first = makeGroup({ folder: 'alpha' });
    const second = makeGroup({ folder: 'beta' });
    app.setConversationRoutesForTest({
      'sl:C123::agent:agent%3Aalpha': first,
      'sl:C123::agent:agent%3Abeta': second,
    });

    expect(capturedDeps?.getGroup('sl:C123', undefined, 'agent:alpha')).toBe(
      first,
    );
    expect(capturedDeps?.getGroup('sl:C123', undefined, 'agent:beta')).toBe(
      second,
    );
    expect(capturedDeps?.getGroup('sl:C123')).toBeUndefined();
  });

  it('unregisters all routes for a bare provider conversation', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const deleteConversationRoute = vi.fn(async () => undefined);
    const app = createRuntimeApp({
      opsRepository: { deleteConversationRoute } as any,
    });
    const alpha = makeGroup({ folder: 'alpha' });
    const beta = makeGroup({ folder: 'beta' });
    const defaultRoute = makeGroup({ folder: 'default' });
    const alphaKey = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');
    const betaThreadKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:beta',
      'T1',
    );

    app.setConversationRoutesForTest({
      [alphaKey]: alpha,
      [betaThreadKey]: beta,
      'sl:C123': defaultRoute,
    });

    await app.unregisterConversationRoute('sl:C123');

    expect(app.getConversationRoutes()).toEqual({});
    expect(deleteConversationRoute).toHaveBeenCalledWith('sl:C123');
    expect(deleteConversationRoute).toHaveBeenCalledWith(alphaKey);
    expect(deleteConversationRoute).toHaveBeenCalledWith(betaThreadKey);
  });

  it('projects conversation routes with provider account scoped keys', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const app = createRuntimeApp();
    const route = makeGroup({
      folder: 'alpha',
      providerAccountId: 'slack-one',
    });

    await app.projectConversationRoute('sl:C123', route);

    expect(app.getConversationRoutes()).toEqual({
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:alpha',
        undefined,
        'slack-one',
      )]: route,
    });
  });

  it('unregisters one agent-qualified route without deleting sibling routes', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const deleteConversationRoute = vi.fn(async () => undefined);
    const app = createRuntimeApp({
      opsRepository: { deleteConversationRoute } as any,
    });
    const alpha = makeGroup({ folder: 'alpha' });
    const beta = makeGroup({ folder: 'beta' });
    const alphaKey = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');
    const betaKey = makeAgentThreadQueueKey('sl:C123', 'agent:beta');

    app.setConversationRoutesForTest({
      [alphaKey]: alpha,
      [betaKey]: beta,
    });

    await app.unregisterConversationRoute(betaKey);

    expect(app.getConversationRoutes()).toEqual({ [alphaKey]: alpha });
    expect(deleteConversationRoute).toHaveBeenCalledWith(betaKey);
  });

  it('resolves the exact thread route before the whole-conversation route', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const app = createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];

    const wholeRoute = makeGroup({ folder: 'alpha', name: 'Alpha Whole' });
    const threadRoute = makeGroup({ folder: 'alpha', name: 'Alpha Thread' });
    app.setConversationRoutesForTest({
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: wholeRoute,
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1')]: threadRoute,
    });

    expect(capturedDeps?.getGroup('sl:C123', 'T1', 'agent:alpha')).toBe(
      threadRoute,
    );
    expect(capturedDeps?.getGroup('sl:C123', 'T2', 'agent:alpha')).toBe(
      wholeRoute,
    );
    expect(capturedDeps?.getGroup('sl:C123', undefined, 'agent:alpha')).toBe(
      wholeRoute,
    );
  });

  it('does not resolve a thread-scoped route for a top-level queue', async () => {
    const { createRuntimeApp, createGroupProcessor } =
      await loadRuntimeAppWithGroupProcessorSpy();
    const app = createRuntimeApp();
    const capturedDeps = vi.mocked(createGroupProcessor).mock.calls[0]?.[0];

    app.setConversationRoutesForTest({
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha', 'T1')]: makeGroup({
        folder: 'alpha',
      }),
    });

    expect(
      capturedDeps?.getGroup('sl:C123', undefined, 'agent:alpha'),
    ).toBeUndefined();
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
    const threadQueueJid = 'sl:C1234567890::thread:1780551797.956909';

    app.setAgentCursor(threadQueueJid, '');

    await expect(app.getOrRecoverCursor(threadQueueJid)).resolves.toBe('');
    expect(setRouterState).not.toHaveBeenCalledWith(
      'last_agent_timestamp',
      expect.any(String),
    );
  });

  it('seeds agent-qualified cursors from a legacy bare cursor', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn();
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const queueJid = 'sl:C123::agent:agent%3Aalpha';

    app.setAgentCursor('sl:C123', 'legacy-cursor');

    await expect(app.getOrRecoverCursor(queueJid)).resolves.toBe(
      'legacy-cursor',
    );
    app.setAgentCursor('sl:C123', 'new-root-cursor');
    await expect(app.getOrRecoverCursor(queueJid)).resolves.toBe(
      'legacy-cursor',
    );
    expect(getLastBotMessageCursor).not.toHaveBeenCalled();
    expect(setRouterState).not.toHaveBeenCalled();
  });

  it('does not seed provider-qualified cursors from a bare chat cursor', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn(async () => undefined);
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const queueJid = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      undefined,
      'slack-two',
    );

    app.setAgentCursor('sl:C123', 'wrong-account-cursor');

    await expect(app.getOrRecoverCursor(queueJid)).resolves.toBe('');
    expect(getLastBotMessageCursor).toHaveBeenCalledWith('sl:C123', {
      providerAccountId: 'slack-two',
    });
    expect(setRouterState).not.toHaveBeenCalled();
  });

  it('seeds provider-qualified cursors from a provider-scoped chat cursor', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn();
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const providerQueueJid = makeAgentThreadQueueKey(
      'sl:C123',
      undefined,
      undefined,
      'slack-two',
    );
    const agentQueueJid = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      undefined,
      'slack-two',
    );

    app.setAgentCursor(providerQueueJid, 'provider-cursor');

    await expect(app.getOrRecoverCursor(agentQueueJid)).resolves.toBe(
      'provider-cursor',
    );
    expect(getLastBotMessageCursor).not.toHaveBeenCalled();
    expect(setRouterState).not.toHaveBeenCalled();
  });

  it('seeds agent-qualified thread cursors from a legacy thread cursor', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn();
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const threadQueueJid = 'sl:C123::thread:thread%3Aone';
    const agentThreadQueueJid =
      'sl:C123::thread:thread%3Aone::agent:agent%3Aalpha';

    app.setAgentCursor(threadQueueJid, 'thread-cursor');

    await expect(app.getOrRecoverCursor(agentThreadQueueJid)).resolves.toBe(
      'thread-cursor',
    );
    app.setAgentCursor(threadQueueJid, 'new-thread-cursor');
    await expect(app.getOrRecoverCursor(agentThreadQueueJid)).resolves.toBe(
      'thread-cursor',
    );
    expect(getLastBotMessageCursor).not.toHaveBeenCalled();
    expect(setRouterState).not.toHaveBeenCalled();
  });

  it('does not seed provider-qualified thread cursors from unscoped thread cursors', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn();
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const unscopedThreadQueueJid = makeAgentThreadQueueKey(
      'sl:C123',
      undefined,
      'thread:one',
    );
    const agentThreadQueueJid = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      'thread:one',
      'slack-two',
    );

    app.setAgentCursor(unscopedThreadQueueJid, 'wrong-thread-cursor');

    await expect(app.getOrRecoverCursor(agentThreadQueueJid)).resolves.toBe('');
    expect(getLastBotMessageCursor).not.toHaveBeenCalled();
    expect(setRouterState).not.toHaveBeenCalled();
  });

  it('does not recover agent-qualified thread cursors from chat-wide cursors', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn(async () => ({
      timestamp: '2026-06-30T00:00:00.000Z',
      id: 'bot-1',
    }));
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const agentThreadQueueJid =
      'sl:C123::thread:thread%3Aone::agent:agent%3Aalpha';

    app.setAgentCursor('sl:C123', 'bare-chat-cursor');

    await expect(app.getOrRecoverCursor(agentThreadQueueJid)).resolves.toBe('');
    expect(getLastBotMessageCursor).not.toHaveBeenCalled();
    expect(setRouterState).not.toHaveBeenCalled();
  });

  it('recovers agent-qualified cursors from the last bot cursor', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn(async () => ({
      timestamp: '2026-06-30T00:00:00.000Z',
      id: 'bot-1',
    }));
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const queueJid = 'sl:C999::agent:agent%3Aalpha';
    const recoveredCursor = JSON.stringify({
      timestamp: '2026-06-30T00:00:00.000Z',
      id: 'bot-1',
    });

    await expect(app.getOrRecoverCursor(queueJid)).resolves.toBe(
      recoveredCursor,
    );
    expect(getLastBotMessageCursor).toHaveBeenCalledWith('sl:C999', {
      providerAccountId: undefined,
    });
    const persistedState = JSON.parse(
      setRouterState.mock.calls[0]?.[1] as string,
    ) as Record<string, string>;
    expect(persistedState[queueJid]).toBe(recoveredCursor);
  });

  it('recovers provider-qualified cursors from provider-scoped bot cursor lookup', async () => {
    const { createRuntimeApp } = await loadRuntimeApp();
    const setRouterState = vi.fn(async () => undefined);
    const getLastBotMessageCursor = vi.fn(async () => ({
      timestamp: '2026-06-30T00:00:00.000Z',
      id: 'bot-1',
    }));
    const app = createRuntimeApp({
      opsRepository: {
        setRouterState,
        getLastBotMessageCursor,
      } as any,
    });
    const queueJid = makeAgentThreadQueueKey(
      'sl:C999',
      'agent:alpha',
      undefined,
      'slack-two',
    );

    await expect(app.getOrRecoverCursor(queueJid)).resolves.toBe(
      JSON.stringify({
        timestamp: '2026-06-30T00:00:00.000Z',
        id: 'bot-1',
      }),
    );
    expect(getLastBotMessageCursor).toHaveBeenCalledWith('sl:C999', {
      providerAccountId: 'slack-two',
    });
  });

  it('seeds persisted route folders once and creates profile mirrors', async () => {
    const firstAlpha = makeGroup({
      name: 'Alpha Agent',
      folder: 'alpha',
      agentConfig: {
        relationshipMode: 'organization',
        persona: 'sales',
      },
    });
    const duplicateAlpha = makeGroup({
      name: 'Alpha Duplicate',
      folder: 'alpha',
      added_at: '2026-04-25T09:00:00.000Z',
      agentConfig: {
        relationshipMode: 'organization',
        persona: 'marketing',
      },
    });
    const beta = makeGroup({
      name: 'Beta Agent',
      folder: 'beta',
      added_at: '2026-04-26T09:00:00.000Z',
      agentConfig: {
        relationshipMode: 'organization',
        persona: 'research',
      },
    });

    const {
      app,
      ensureAgentDefaults,
      promptProfileServiceCtor,
      writeProfileFileMirror,
      profileFileMirrorExists,
      fileArtifacts,
    } = await loadRuntimeAppWithPersistedRoutes({
      'tg:thread-alpha-a': firstAlpha,
      'tg:thread-alpha-b': duplicateAlpha,
      'tg:thread-beta': beta,
    });

    await app.loadState();

    const calls = vi
      .mocked(ensureAgentDefaults)
      .mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentFolder: 'alpha',
          agentName: 'Alpha Agent',
          relationshipMode: 'organization',
          accessPreset: 'full',
        }),
        expect.objectContaining({
          agentFolder: 'beta',
          agentName: 'Beta Agent',
          relationshipMode: 'organization',
          accessPreset: 'full',
        }),
      ]),
    );
    expect(calls.filter((call) => call.agentFolder === 'alpha')).toHaveLength(
      1,
    );
    expect(calls.filter((call) => call.agentFolder === 'beta')).toHaveLength(1);

    const ctorOptions = vi.mocked(promptProfileServiceCtor).mock.calls[0]?.[0];
    expect(ctorOptions?.mirrorProfileFile).toBe(writeProfileFileMirror);
    expect(ctorOptions?.mirrorFileExists).toBe(profileFileMirrorExists);
    expect(ctorOptions?.fileArtifactStore()).toBe(fileArtifacts);
  });

  it('keeps persisted persona routing state during startup default seeding', async () => {
    const route = makeGroup({
      name: 'Sales Agent',
      folder: 'persona-folder',
      agentConfig: {
        persona: 'sales',
        relationshipMode: 'organization',
      },
    });

    const { app } = await loadRuntimeAppWithPersistedRoutes({
      'tg:sales': route,
    });
    await app.loadState();

    expect(app.getConversationRoutes()['tg:sales']?.agentConfig?.persona).toBe(
      'sales',
    );
  });
});
