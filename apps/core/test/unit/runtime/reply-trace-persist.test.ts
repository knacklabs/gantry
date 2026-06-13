import { describe, expect, it, vi } from 'vitest';
import { persistReplyTrace } from '@core/runtime/reply-trace-persist.js';
import type { ReplyTracePort } from '@core/runtime/group-processing-types.js';
import type { MessageTraceRow } from '@core/adapters/storage/postgres/repositories/message-trace-repository.postgres.js';

function makePort(
  saved: MessageTraceRow[],
  over: Partial<ReplyTracePort> = {},
): ReplyTracePort {
  return {
    drain: () => [],
    saveTrace: async (row) => {
      saved.push(row);
    },
    payloadsEnabled: () => false,
    ...over,
  };
}

describe('persistReplyTrace', () => {
  it('saves a reply trace keyed by messageIdFor(chatJid, outboundId) with assembled timings', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved, {
      drain: () => [
        {
          server: 'srv',
          tool: 'search',
          ms: 21,
          ok: true,
          startedAt: 2,
          requestBytes: 5,
          responseBytes: 9,
        },
      ],
    });

    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:42',
      appId: 'app:test',
      outboundMessageId: 'outbound:abc',
      runHandle: 'gantry-run-1',
      guardrail: {
        ms: 18,
        startedAt: 0,
        detail: {
          mode: 'deterministic',
          decision: 'allow',
          reason: 'inconclusive_inline_guardrail',
          inlineAttached: true,
        },
      },
      llmTurns: [
        {
          ms: 300,
          startedAt: 1,
          detail: {
            model: 'sonnet',
            stopReason: 'end_turn',
            tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 0 },
          },
        },
      ],
      now: () => new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(saved.length).toBe(1);
    expect(saved[0].messageId).toBe('message:wa:42:outbound:abc');
    expect(saved[0].kind).toBe('reply');
    expect(saved[0].appId).toBe('app:test');
    expect(saved[0].conversationId).toBe('wa:42');
    expect(saved[0].totalMs).toBe(18 + 300 + 21);
    expect(saved[0].timingsJson.stages.map((s) => s.kind)).toEqual([
      'guardrail',
      'llm',
      'tool',
    ]);
    expect(saved[0].payloadsJson).toBeNull();
    expect(saved[0].createdAt).toBe('2026-06-14T00:00:00.000Z');
  });

  it('populates payloadsJson only when payloads are enabled', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved, {
      payloadsEnabled: () => true,
      drain: () => [
        {
          server: 'srv',
          tool: 'search',
          ms: 21,
          ok: true,
          startedAt: 2,
          requestBytes: 5,
          responseBytes: 9,
          request: { q: 1 },
          response: { r: 2 },
        },
      ],
    });

    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:42',
      appId: 'app:test',
      outboundMessageId: 'outbound:abc',
      runHandle: 'gantry-run-1',
      systemPrompt: { hash: 'h', chars: 10 },
    });

    expect(saved[0].payloadsJson).not.toBeNull();
    // tool stage is index 1 (guardrail absent → llm absent → only tool here)
    expect(saved[0].payloadsJson).toMatchObject({
      0: { request: { q: 1 }, response: { r: 2 } },
    });
  });

  it('does not save when there are no stages at all', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved);
    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:42',
      appId: 'app:test',
      outboundMessageId: 'outbound:abc',
      runHandle: 'gantry-run-1',
    });
    expect(saved.length).toBe(0);
  });

  it('never throws when assembly or save fails', async () => {
    const port: ReplyTracePort = {
      drain: () => {
        throw new Error('drain blew up');
      },
      saveTrace: async () => {
        throw new Error('save blew up');
      },
      payloadsEnabled: () => false,
    };
    await expect(
      persistReplyTrace({
        replyTrace: port,
        kind: 'reply',
        chatJid: 'wa:42',
        appId: 'app:test',
        outboundMessageId: 'outbound:abc',
        runHandle: 'gantry-run-1',
        guardrail: {
          ms: 1,
          startedAt: 0,
          detail: { mode: 'both', decision: 'allow', inlineAttached: false },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('builds a command trace with a command stage', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved);
    await persistReplyTrace({
      replyTrace: port,
      kind: 'command',
      chatJid: 'wa:42',
      appId: 'app:test',
      outboundMessageId: 'cmd-reply-1',
      runHandle: 'gantry-run-1',
      command: { name: '/new', ms: 4, startedAt: 0 },
    });
    expect(saved[0].kind).toBe('command');
    expect(saved[0].timingsJson.stages[0]).toMatchObject({
      kind: 'command',
      label: '/new',
    });
  });
});
