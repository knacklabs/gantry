import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeAgentSessionRepository } from '@core/domain/repositories/ops-repo.js';
import type { SessionMemoryCollector } from '@core/domain/ports/session-memory-collector.js';

const mockGetRuntimeSettingsForConfig = vi.hoisted(() => vi.fn());

vi.mock('@core/config/index.js', () => ({
  getRuntimeSettingsForConfig: mockGetRuntimeSettingsForConfig,
}));

vi.mock('@core/runtime/memory-dreaming-runner.js', () => ({
  runDreamingForGroup: vi.fn(),
}));

import { createCollectCurrentSessionMemoryHandler } from '@core/runtime/group-session-command-state.js';

function setWatcher(enabled: boolean): void {
  mockGetRuntimeSettingsForConfig.mockReturnValue({
    agents: {
      boondi_support: {
        memory: {
          digestAndShortMemoryWatcher: {
            enabled,
            conversationIdleAfterMs: 120000,
            pollIntervalMs: 30000,
            model: 'haiku',
          },
        },
      },
    },
  });
}

function makeOps(): RuntimeAgentSessionRepository {
  return {
    getAgentTurnContext: vi.fn(async () => ({
      appId: 'app-default',
      agentId: 'agent:boondi_support',
      agentSessionId: 'session-1',
    })),
    setSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessionsByAgentFolder: vi.fn(),
  };
}

describe('createCollectCurrentSessionMemoryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWatcher(true);
  });

  it('uses the digest watcher model and timeout for manual digest collection', async () => {
    const collectMemory: SessionMemoryCollector = vi
      .fn()
      .mockResolvedValue({ saved: 1, digestCreated: true });
    const ops = makeOps();

    const result = await createCollectCurrentSessionMemoryHandler({
      ops: () => ops,
      group: { folder: 'boondi_support', conversationKind: 'dm' },
      chatJid: 'conversation:wa:919654405340',
      threadId: null,
      defaultScope: 'user',
      collectMemory,
      executionAdapter: { id: 'test-provider' },
    })({ excludeMessageIds: ['msg-command'] });

    expect(result).toEqual({ saved: 1, digestCreated: true });
    expect(collectMemory).toHaveBeenCalledWith({
      agentSessionId: 'session-1',
      trigger: 'session-end',
      defaultScope: 'user',
      model: 'haiku',
      timeoutMs: 45000,
      excludeMessageIds: ['msg-command'],
    });
  });

  it('still collects memory for manual digest when the background watcher is disabled', async () => {
    setWatcher(false);
    const collectMemory: SessionMemoryCollector = vi
      .fn()
      .mockResolvedValue({ saved: 1, digestCreated: true });

    const result = await createCollectCurrentSessionMemoryHandler({
      ops: () => makeOps(),
      group: { folder: 'boondi_support', conversationKind: 'dm' },
      chatJid: 'conversation:wa:919654405340',
      threadId: null,
      defaultScope: 'user',
      collectMemory,
      executionAdapter: { id: 'test-provider' },
    })();

    expect(result).toEqual({ saved: 1, digestCreated: true });
    expect(collectMemory).toHaveBeenCalledWith({
      agentSessionId: 'session-1',
      trigger: 'session-end',
      defaultScope: 'user',
      model: 'haiku',
      timeoutMs: 45000,
    });
  });
});
