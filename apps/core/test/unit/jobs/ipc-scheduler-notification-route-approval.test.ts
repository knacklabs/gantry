import { describe, expect, it, vi } from 'vitest';

import { createApproveJobNotificationRoutes } from '@core/jobs/ipc-scheduler-notification-route-approval.js';
import type { TaskContext } from '@core/jobs/ipc-types.js';

function makeContext(
  overrides: Partial<{
    requestPermissionApproval: unknown;
    appId: string;
    authThreadId: string;
  }> = {},
): TaskContext {
  return {
    data: {
      appId: overrides.appId ?? 'app-one',
      authThreadId: overrides.authThreadId ?? 'thread-1',
    },
    sourceAgentFolder: 'team',
    deps: {
      requestPermissionApproval: overrides.requestPermissionApproval,
    },
    conversationBindings: {},
    sourceAgentFolderJids: ['tg:team'],
  } as unknown as TaskContext;
}

const baseRequest = {
  operation: 'create' as const,
  jobId: 'job-1',
  jobName: 'Notify sales',
  authenticatedContext: {
    conversationJid: 'tg:team',
    threadId: 'thread-1',
    workspaceKey: 'team',
    providerAccountId: 'telegram_main',
  },
  requestedRoutes: [
    {
      conversationJid: 'tg:team',
      threadId: 'thread-1',
      providerAccountId: 'telegram_main',
      label: 'primary',
    },
    {
      conversationJid: 'tg:sales',
      threadId: null,
      label: 'Sales channel',
    },
  ],
  existingRoutes: [],
  routesBeyondContext: [
    {
      conversationJid: 'tg:sales',
      threadId: null,
      label: 'Sales channel',
    },
  ],
};

describe('createApproveJobNotificationRoutes', () => {
  it('fails closed when no approval surface is configured', async () => {
    const approve = createApproveJobNotificationRoutes(makeContext());
    const result = await approve!(baseRequest);
    expect(result).toEqual({
      approved: false,
      reason: 'No approval surface configured for this agent.',
    });
  });

  it('requests same-channel approval targeting the originating conversation, and maps an approval', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      kind: 'decision' as const,
      decision: { approved: true, reason: 'looks fine', decidedBy: 'U1' },
    }));
    const approve = createApproveJobNotificationRoutes(
      makeContext({ requestPermissionApproval }),
    );
    const result = await approve!(baseRequest);

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'tg:team',
        threadId: 'thread-1',
        decisionPolicy: 'same_channel',
        decisionOptions: ['allow_once', 'cancel'],
        toolName: 'scheduler_upsert_job',
        toolInput: { routesBeyondContext: baseRequest.routesBeyondContext },
      }),
    );
    expect(result).toEqual({
      approved: true,
      reason: 'looks fine',
      approvedConversationJid: 'tg:team',
    });
  });

  it('maps a denied decision without granting approvedConversationJid overreach', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      kind: 'decision' as const,
      decision: { approved: false, reason: 'not approved' },
    }));
    const approve = createApproveJobNotificationRoutes(
      makeContext({ requestPermissionApproval }),
    );
    const result = await approve!(baseRequest);
    expect(result).toEqual({
      approved: false,
      reason: 'not approved',
      approvedConversationJid: 'tg:team',
    });
  });

  it('fails closed when the approval prompt could not be delivered', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      kind: 'delivery_failure' as const,
      code: 'target_missing' as const,
      retryable: false,
      delivered: 'no' as const,
      userMessage: 'channel is gone',
    }));
    const approve = createApproveJobNotificationRoutes(
      makeContext({ requestPermissionApproval }),
    );
    const result = await approve!(baseRequest);
    expect(result).toEqual({
      approved: false,
      reason: 'Could not deliver approval prompt: channel is gone',
    });
  });
});
