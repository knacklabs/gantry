import { describe, expect, it, vi } from 'vitest';

import { dispatchPreparedPermissionCard } from '@core/jobs/permission-card-delivery.js';

function claimed() {
  return {
    delivery: { id: 'delivery:1', appId: 'default' },
    item: {
      id: 'item:1',
      permissionPromptId: 'prompt:1',
      claimToken: 'claim:1',
      canonicalText: 'Approval required',
    },
  } as any;
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    getSetupPermissionPromptForDispatch: vi.fn(async () => ({
      request: {
        requestId: 'request:1',
        sourceAgentFolder: 'main_agent',
        toolName: 'RunCommand',
      },
      providerAlias: 'alias:1',
    })),
    beginSend: vi.fn(async () => 'begun' as const),
    ...overrides,
  } as any;
}

describe('prepared permission-card dispatch', () => {
  it('does not checkpoint or send when adapter preflight fails', async () => {
    const outbound = service();
    const result = await dispatchPreparedPermissionCard({
      service: outbound,
      claimed: claimed(),
      now: () => '2026-08-13T10:00:00.000Z',
      prepare: () => {
        throw new Error('surface unavailable');
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: 'surface unavailable',
    });
    expect(outbound.beginSend).not.toHaveBeenCalled();
  });

  it('checkpoints before exactly one provider send and returns its locator', async () => {
    const order: string[] = [];
    const outbound = service({
      beginSend: vi.fn(async () => {
        order.push('begin');
        return 'begun' as const;
      }),
    });
    const send = vi.fn(async () => {
      order.push('send');
      return {
        delivery: { externalMessageId: 'message:1' },
        locator: {
          provider: 'telegram',
          conversationId: '123',
          messageId: 'message:1',
        },
      };
    });

    const result = await dispatchPreparedPermissionCard({
      service: outbound,
      claimed: claimed(),
      now: () => '2026-08-13T10:00:00.000Z',
      prepare: () => ({ send }),
    });

    expect(order).toEqual(['begin', 'send']);
    expect(send).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'sent',
      providerMessageId: 'message:1',
      permissionPromptLocator: { provider: 'telegram', messageId: 'message:1' },
    });
  });

  it('classifies every post-checkpoint provider exception as ambiguous', async () => {
    const result = await dispatchPreparedPermissionCard({
      service: service(),
      claimed: claimed(),
      now: () => '2026-08-13T10:00:00.000Z',
      prepare: () => ({
        send: vi.fn(async () => {
          throw new Error('connection reset');
        }),
      }),
    });

    expect(result).toMatchObject({ status: 'partially_delivered' });
  });

  it('does not call the provider when the lease-fenced checkpoint is rejected', async () => {
    const send = vi.fn();
    const result = await dispatchPreparedPermissionCard({
      service: service({ beginSend: vi.fn(async () => 'lease_lost' as const) }),
      claimed: claimed(),
      now: () => '2026-08-13T10:00:00.000Z',
      prepare: () => ({ send }),
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('active lease'),
    });
    expect(send).not.toHaveBeenCalled();
  });
});
