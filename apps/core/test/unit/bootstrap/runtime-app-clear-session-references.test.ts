import { describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';

function makeGroup(): ConversationRoute {
  return {
    name: 'Default Agent',
    folder: 'main_agent',
    trigger: '@main',
    added_at: '2026-04-24T09:00:00.000Z',
    requiresTrigger: false,
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
    getRuntimeRepositories: vi.fn(),
    getRuntimeSkillArtifactStore: vi.fn(),
    getRuntimeStorage: vi.fn(() => ({})),
    getConfiguredModelProvidersForApp: vi.fn(async () => new Set<string>()),
    resolveRuntimePersonIdentity: vi.fn(),
  }));
  return import('@core/app/bootstrap/runtime-app.js');
}

describe('runtime app', () => {
  it('clearSessionForChatJid returns the retired provider-session references', async () => {
    const retiredReferences = [
      {
        providerSessionId: 'provider-session:1',
        externalSessionId: 'external-session:1',
        executionProviderId: 'anthropic:claude-agent-sdk',
      },
    ] as const;
    const deleteSession = vi.fn(async () => retiredReferences);
    const { createRuntimeApp } = await loadRuntimeApp();
    const app = createRuntimeApp({
      opsRepository: { deleteSession } as never,
    });
    app.setConversationRoutesForTest({ 'tg:chat': makeGroup() });

    await expect(app.clearSessionForChatJid('tg:chat')).resolves.toBe(
      retiredReferences,
    );
    expect(deleteSession).toHaveBeenCalledWith('main_agent', undefined, {
      conversationJid: 'tg:chat',
      providerAccountId: undefined,
      conversationKind: undefined,
      memoryUserId: undefined,
    });
  });
});
