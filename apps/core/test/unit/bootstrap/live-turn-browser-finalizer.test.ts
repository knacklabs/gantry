import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLiveTurnBrowserFinalizer } from '@core/app/bootstrap/live-turn-browser-finalizer.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { resolveConversationBrowserProfile } from '@core/shared/browser-profile-scope.js';

const consumeBrowserProfileActivityMock = vi.hoisted(() => vi.fn());
const isBrowserProfileSyncEnabledMock = vi.hoisted(() => vi.fn());
const snapshotBrowserProfileMock = vi.hoisted(() => vi.fn());
const getProfileMock = vi.hoisted(() => vi.fn());

vi.mock('@core/runtime/browser-profile-sync.js', () => ({
  consumeBrowserProfileActivity: consumeBrowserProfileActivityMock,
  isBrowserProfileSyncEnabled: isBrowserProfileSyncEnabledMock,
  snapshotBrowserProfile: snapshotBrowserProfileMock,
}));

vi.mock('@core/runtime/browser-profiles.js', () => ({
  getProfile: getProfileMock,
}));

describe('live-turn-browser-finalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects the agent-specific route when finalizing a multi-agent queue key', async () => {
    const closeBrowserSession = vi.fn(async () => undefined);
    const closeBrowserToolBackends = vi.fn(async () => undefined);
    const queueJid = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');
    const alphaRoute = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');
    const betaRoute = makeAgentThreadQueueKey('sl:C123', 'agent:beta');

    const finalizer = buildLiveTurnBrowserFinalizer({
      getConversationRoutes: () => ({
        [betaRoute]: { folder: 'beta' },
        [alphaRoute]: { folder: 'alpha' },
      }),
      closeBrowserSession,
      closeBrowserToolBackends,
      warn: vi.fn(),
    });

    consumeBrowserProfileActivityMock.mockReturnValue(true);
    isBrowserProfileSyncEnabledMock.mockReturnValue(true);
    getProfileMock.mockReturnValue({
      dir: '/tmp/profile',
      userDataDir: '/tmp/user-data',
    });

    await finalizer({ queueJid, runId: 'run-1', fencingVersion: 2 });

    const profileName = resolveConversationBrowserProfile({
      agentId: 'alpha',
      workspaceKey: 'alpha',
      conversationId: 'sl:C123',
    });
    expect(closeBrowserSession).toHaveBeenCalledWith(profileName);
    expect(closeBrowserToolBackends).toHaveBeenCalledWith(profileName);
    expect(snapshotBrowserProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName,
        snapshotRunId: 'run-1',
        snapshotFencingVersion: 2,
      }),
    );
  });

  it('selects a legacy bare route that matches the queue agent by folder', async () => {
    const closeBrowserSession = vi.fn(async () => undefined);
    const closeBrowserToolBackends = vi.fn(async () => undefined);
    const queueJid = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');

    const finalizer = buildLiveTurnBrowserFinalizer({
      getConversationRoutes: () => ({
        'sl:C123': { folder: 'alpha' },
      }),
      closeBrowserSession,
      closeBrowserToolBackends,
      warn: vi.fn(),
    });

    consumeBrowserProfileActivityMock.mockReturnValue(true);
    isBrowserProfileSyncEnabledMock.mockReturnValue(true);
    getProfileMock.mockReturnValue({
      dir: '/tmp/profile',
      userDataDir: '/tmp/user-data',
    });

    await finalizer({ queueJid, runId: 'run-1', fencingVersion: 2 });

    const profileName = resolveConversationBrowserProfile({
      agentId: 'alpha',
      workspaceKey: 'alpha',
      conversationId: 'sl:C123',
    });
    expect(closeBrowserSession).toHaveBeenCalledWith(profileName);
    expect(closeBrowserToolBackends).toHaveBeenCalledWith(profileName);
    expect(snapshotBrowserProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileName }),
    );
  });

  it('does not match a legacy bare route for a sibling folder', async () => {
    const closeBrowserSession = vi.fn(async () => undefined);
    const closeBrowserToolBackends = vi.fn(async () => undefined);
    const queueJid = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');

    const finalizer = buildLiveTurnBrowserFinalizer({
      getConversationRoutes: () => ({
        'sl:C123': { folder: 'beta' },
      }),
      closeBrowserSession,
      closeBrowserToolBackends,
      warn: vi.fn(),
    });

    await finalizer({ queueJid, runId: 'run-1', fencingVersion: 2 });

    expect(consumeBrowserProfileActivityMock).not.toHaveBeenCalled();
    expect(closeBrowserSession).not.toHaveBeenCalled();
    expect(closeBrowserToolBackends).not.toHaveBeenCalled();
    expect(snapshotBrowserProfileMock).not.toHaveBeenCalled();
  });

  it('does not fall back to a sibling route when the agent-specific route is missing', async () => {
    const closeBrowserSession = vi.fn(async () => undefined);
    const closeBrowserToolBackends = vi.fn(async () => undefined);
    const queueJid = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');
    const betaRoute = makeAgentThreadQueueKey('sl:C123', 'agent:beta');

    const finalizer = buildLiveTurnBrowserFinalizer({
      getConversationRoutes: () => ({
        [betaRoute]: { folder: 'beta' },
      }),
      closeBrowserSession,
      closeBrowserToolBackends,
      warn: vi.fn(),
    });

    await finalizer({ queueJid, runId: 'run-1', fencingVersion: 2 });

    expect(consumeBrowserProfileActivityMock).not.toHaveBeenCalled();
    expect(closeBrowserSession).not.toHaveBeenCalled();
    expect(closeBrowserToolBackends).not.toHaveBeenCalled();
    expect(snapshotBrowserProfileMock).not.toHaveBeenCalled();
  });
});
