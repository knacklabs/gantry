import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  hasRouteForConversation,
  resolveConversationMessageRoute,
} from '@core/control/server/external-ingress-adapter.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '@core/application/jobs/job-access.js';
import { acceptMessageForControl } from '@core/control/server/session-interaction-adapter.js';

describe('external ingress adapter', () => {
  it('shares the boot session interaction and keeps admission ids at accepting call sites', () => {
    const serverSource = readFileSync(
      'apps/core/src/control/server/index.ts',
      'utf8',
    );
    const routesSource = readFileSync(
      'apps/core/src/control/server/routes/sessions.ts',
      'utf8',
    );
    const sessionAdapterSource = readFileSync(
      'apps/core/src/control/server/session-interaction-adapter.ts',
      'utf8',
    );
    const ingressAdapterSource = readFileSync(
      'apps/core/src/control/server/external-ingress-adapter.ts',
      'utf8',
    );

    expect(serverSource.match(/new SessionInteractionModule\(/g)).toHaveLength(
      1,
    );
    for (const dependency of [
      'control',
      'ops',
      'repositories',
      'runtimeEvents',
      'getConfiguredAgentRuntime',
    ]) {
      expect(serverSource).toContain(`get ${dependency}()`);
    }
    expect(routesSource.match(/ctx\.sessionInteraction/g)).toHaveLength(7);
    expect(routesSource).not.toContain('liveAdmissionAppId');
    expect(sessionAdapterSource).not.toContain(
      'createSessionInteractionModule',
    );
    expect(sessionAdapterSource).toContain(
      'ctx.sessionInteraction.acceptMessage(',
    );
    expect(ingressAdapterSource).toContain('sessions: ctx.sessionInteraction');
    expect(ingressAdapterSource).toContain('liveAdmissionAppId');
  });

  it('passes each message-accept caller admission id to the shared module', async () => {
    const acceptMessage = vi.fn(async () => ({
      accepted: true as const,
      messageId: 'message-1',
      acceptedEventId: 1,
      enqueue: {
        conversationJid: 'app:app-one:conv-one',
        threadId: null,
        queueKey: 'app:app-one:conv-one',
        durableAdmissionCreated: true,
      },
    }));
    const ctx = {
      liveTurnsEnabled: true,
      sessionInteraction: { acceptMessage },
      app: { queue: { enqueueMessageCheck: vi.fn() } },
    } as never;
    const input = {
      appId: 'app-one',
      sessionId: 'session-one',
      message: 'hello',
    };

    await acceptMessageForControl(ctx, input);
    expect(acceptMessage).toHaveBeenLastCalledWith(
      input,
      DEFAULT_JOB_RUNTIME_APP_ID,
    );

    (ctx as { liveTurnsEnabled: boolean }).liveTurnsEnabled = false;
    await acceptMessageForControl(ctx, input);
    expect(acceptMessage).toHaveBeenLastCalledWith(input, null);
  });

  it('uses the conversation provider account when resolving live routes', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack-alpha')]: {
        folder: 'ops',
        providerAccountId: 'slack-alpha',
      },
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack-beta')]: {
        folder: 'ops',
        providerAccountId: 'slack-beta',
      },
    };

    expect(
      resolveConversationMessageRoute(
        routes,
        'sl:C123',
        null,
        'slack-beta',
        'agent:ops',
      ),
    ).toEqual({
      agentId: 'agent:ops',
      queueKey: makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        null,
        'slack-beta',
      ),
    });
  });

  it('requires a matching provider account for routability precheck', () => {
    const routes = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:ops', null, 'slack-alpha')]: {
        folder: 'ops',
        providerAccountId: 'slack-alpha',
      },
    };

    expect(
      hasRouteForConversation(routes, 'sl:C123', null, 'slack-alpha'),
    ).toBe(true);
    expect(hasRouteForConversation(routes, 'sl:C123', null, 'slack-beta')).toBe(
      false,
    );
  });

  it('accepts thread-scoped routes during routability precheck', () => {
    const routes = {
      [makeAgentThreadQueueKey(
        'sl:C123',
        'agent:ops',
        '1749.1',
        'slack-alpha',
      )]: {
        folder: 'ops',
        providerAccountId: 'slack-alpha',
      },
    };

    expect(
      hasRouteForConversation(routes, 'sl:C123', '1749.1', 'slack-alpha'),
    ).toBe(true);
    expect(
      hasRouteForConversation(routes, 'sl:C123', null, 'slack-alpha'),
    ).toBe(false);
  });
});
