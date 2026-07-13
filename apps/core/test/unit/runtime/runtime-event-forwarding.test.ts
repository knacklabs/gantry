import { describe, expect, it, vi } from 'vitest';

import { forwardRuntimeEvents } from '@core/runtime/runtime-event-forwarding.js';

describe('runtime event forwarding', () => {
  it('keeps raw route ids in payload instead of FK fields', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await forwardRuntimeEvents({
      output: {
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'run.startup_diagnostic',
            actor: 'runtime',
            responseMode: 'none',
            payload: {
              provider: 'deepagents',
              diagnostic: 'runner_startup',
            },
          },
        ],
      },
      publishRuntimeEvent,
      runtimeAppId: 'app-one',
      turnAgentId: 'agent-one',
      runId: 'run-one',
      chatJid: 'sl:C123',
      sessionThreadId: '1710000000.000100',
      forwardedKeys: new Set(),
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        agentId: 'agent-one',
        runId: 'run-one',
        eventType: 'run.startup_diagnostic',
        actor: 'runtime',
        responseMode: 'none',
        payload: expect.objectContaining({
          provider: 'deepagents',
          diagnostic: 'runner_startup',
          conversationJid: 'sl:C123',
          threadId: '1710000000.000100',
        }),
      }),
    );
    const event = publishRuntimeEvent.mock.calls[0]?.[0];
    expect(event).not.toHaveProperty('conversationId');
    expect(event).not.toHaveProperty('threadId');
  });

  it('preserves canonical FK ids from runner events', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await forwardRuntimeEvents({
      output: {
        status: 'success',
        result: null,
        runtimeEvents: [
          {
            eventType: 'run.startup_diagnostic',
            actor: 'runtime',
            responseMode: 'none',
            conversationId: 'conversation:slack_default:sl:C123',
            threadId: 'thread:slack_default:sl:C123:1710000000.000100',
            payload: {
              provider: 'deepagents',
              diagnostic: 'runner_startup',
            },
          },
        ],
      },
      publishRuntimeEvent,
      runtimeAppId: 'app-one',
      turnAgentId: 'agent-one',
      runId: 'run-one',
      chatJid: 'sl:C123',
      sessionThreadId: '1710000000.000100',
      forwardedKeys: new Set(),
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:slack_default:sl:C123',
        threadId: 'thread:slack_default:sl:C123:1710000000.000100',
        payload: expect.objectContaining({
          conversationJid: 'conversation:slack_default:sl:C123',
          threadId: 'thread:slack_default:sl:C123:1710000000.000100',
        }),
      }),
    );
  });
});
