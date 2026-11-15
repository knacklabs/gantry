import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  durableCallerToolResolution,
  requestCallerResolvedTool,
  settleCallerResolvedTool,
  updateCallerResolvedTool,
} from '@core/application/interactions/caller-resolved-tool-coordinator.js';
import { configurePendingInteractionDurability } from '@core/application/interactions/pending-interaction-durability.js';

afterEach(() => {
  configurePendingInteractionDurability(null);
  vi.useRealTimers();
});

describe('caller-resolved tool coordinator', () => {
  it('keeps CAPTCHA answers ephemeral while retaining non-secret settlement evidence', () => {
    const durable = durableCallerToolResolution(['humanAnswer'], {
      status: 'resolved',
      result: { humanAnswer: 'captcha-secret' },
    });
    expect(durable).toEqual({
      status: 'resolved',
      result: { humanAnswer: '[REDACTED]' },
    });
    expect(JSON.stringify(durable)).not.toContain('captcha-secret');

    const origin = {
      status: 'resolved' as const,
      result: {
        approved: true,
        permissionScope: { origin: 'https://example.test' },
      },
    };
    expect(durableCallerToolResolution([], origin)).toBe(origin);
  });

  it('settles the waiting tool exactly once', async () => {
    let emitted!: () => void;
    const required = new Promise<void>((resolve) => (emitted = resolve));
    const result = requestCallerResolvedTool({
      appId: 'app',
      runId: 'run-1',
      sourceAgentFolder: 'agent-folder',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      toolName: 'opaque_tool',
      toolInput: { query: 'value' },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      emitRequired: async () => emitted(),
    });
    await required;

    const settlement = {
      appId: 'app',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      idempotencyKey: 'delivery-1',
      resolution: { status: 'resolved' as const, result: { answer: 42 } },
    };
    await expect(settleCallerResolvedTool(settlement)).resolves.toBe(
      'resolved',
    );
    await expect(result).resolves.toEqual({ answer: 42 });
    await expect(settleCallerResolvedTool(settlement)).resolves.toBe(
      'idempotent',
    );
  });

  it('rejects an answer for an older CAPTCHA image version', async () => {
    const updatePendingInteractionPayload = vi.fn(async ({ update }) => {
      update({ toolInput: {}, interactionVersion: 1 });
      return true;
    });
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => ({}) as never),
        findPendingInteractionByRequest: vi.fn(async () => ({
          idempotencyKey: 'question:captcha-versioned',
        })) as never,
        updatePendingInteractionPayload,
        resolvePendingInteraction: vi.fn(async () => true),
      } as never,
    });
    const waiting = requestCallerResolvedTool({
      appId: 'app',
      runId: 'run-1',
      sourceAgentFolder: 'agent-folder',
      sessionId: 'session-1',
      interactionId: 'captcha-versioned',
      toolName: 'captcha_tool',
      toolInput: { evidenceRefs: ['old-image'] },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      emitRequired: async () => undefined,
    });

    await expect(
      updateCallerResolvedTool({
        appId: 'app',
        sourceAgentFolder: 'agent-folder',
        sessionId: 'session-1',
        interactionId: 'captcha-versioned',
        expectedVersion: 1,
        toolInput: { evidenceRefs: ['new-image'] },
      }),
    ).resolves.toBe(2);
    await expect(
      settleCallerResolvedTool({
        appId: 'app',
        sessionId: 'session-1',
        interactionId: 'captcha-versioned',
        idempotencyKey: 'old-answer',
        interactionVersion: 1,
        resolution: { status: 'resolved', result: { humanAnswer: 'old' } },
      }),
    ).resolves.toBe('stale');
    await expect(
      settleCallerResolvedTool({
        appId: 'app',
        sessionId: 'session-1',
        interactionId: 'captcha-versioned',
        idempotencyKey: 'new-answer',
        interactionVersion: 2,
        resolution: { status: 'resolved', result: { humanAnswer: 'fresh' } },
      }),
    ).resolves.toBe('resolved');
    await expect(waiting).resolves.toEqual({ humanAnswer: 'fresh' });
  });

  it('allows a refreshed CAPTCHA interaction to be rejected without a version', async () => {
    const updatePendingInteractionPayload = vi.fn(async ({ update }) => {
      update({ toolInput: {}, interactionVersion: 1 });
      return true;
    });
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => ({}) as never),
        findPendingInteractionByRequest: vi.fn(async () => ({
          idempotencyKey: 'question:captcha-rejected',
        })) as never,
        updatePendingInteractionPayload,
        resolvePendingInteraction: vi.fn(async () => true),
      } as never,
    });
    const controller = new AbortController();
    const waiting = requestCallerResolvedTool({
      appId: 'app',
      runId: 'run-1',
      sourceAgentFolder: 'agent-folder',
      sessionId: 'session-1',
      interactionId: 'captcha-rejected',
      toolName: 'captcha_tool',
      toolInput: { evidenceRefs: ['old-image'] },
      timeoutMs: 5_000,
      signal: controller.signal,
      emitRequired: async () => undefined,
    });
    void waiting.catch(() => undefined);

    await expect(
      updateCallerResolvedTool({
        appId: 'app',
        sourceAgentFolder: 'agent-folder',
        sessionId: 'session-1',
        interactionId: 'captcha-rejected',
        expectedVersion: 1,
        toolInput: { evidenceRefs: ['new-image'] },
      }),
    ).resolves.toBe(2);
    const outcome = await settleCallerResolvedTool({
      appId: 'app',
      sessionId: 'session-1',
      interactionId: 'captcha-rejected',
      idempotencyKey: 'rejection',
      resolution: { status: 'rejected', error: 'Caller declined.' },
    });
    if (outcome !== 'resolved') controller.abort();

    expect(outcome).toBe('resolved');
    await expect(waiting).rejects.toThrow('Caller declined.');
  });
});
