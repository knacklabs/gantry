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
          // startedAt after llm ends (1+300=301) so it is a distinct non-overlapping span
          startedAt: 310,
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
          startedAt: 18,
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
    // v2 timeline: sections exist, version === 2
    expect(saved[0].timingsJson.version).toBe(2);
    expect(saved[0].totalMs).toBeGreaterThan(0);
    const sections = (
      saved[0].timingsJson as { sections: Array<{ kind: string }> }
    ).sections;
    expect(sections.map((s) => s.kind)).toContain('guardrail');
    expect(sections.map((s) => s.kind)).toContain('llm');
    expect(sections.map((s) => s.kind)).toContain('tool');
    expect(saved[0].payloadsJson).toBeNull();
    expect(saved[0].createdAt).toBe('2026-06-14T00:00:00.000Z');
  });

  it('persists exact SDK-reported reply LLM cost in timingsJson when present', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved);

    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:42',
      appId: 'app:test',
      outboundMessageId: 'outbound:cost',
      llmTurns: [
        {
          ms: 300,
          startedAt: 18,
          detail: {
            model: 'sonnet',
            stopReason: 'end_turn',
            tokens: { in: 10, out: 2, cacheRead: 8, cacheWrite: 0 },
          },
        },
      ],
      llmUsage: { costUsd: 0.0042 },
    });

    expect(saved).toHaveLength(1);
    expect(saved[0].timingsJson).toMatchObject({
      llmUsage: { costUsd: 0.0042 },
    });
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
    });

    expect(saved[0].payloadsJson).not.toBeNull();
    // tool is the only section; its index is 0 in v2
    expect(saved[0].payloadsJson).toMatchObject({
      0: { request: { q: 1 }, response: { r: 2 } },
    });
  });

  it('persists operational sections and gated cache payload slots', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved, {
      payloadsEnabled: () => true,
    });

    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:cache',
      appId: 'app:test',
      outboundMessageId: 'outbound:cache',
      windowStart: 1000,
      windowEnd: 1100,
      operationalSections: [
        { kind: 'message_persist', startedAt: 1000, ms: 10 },
        {
          kind: 'cache_use',
          startedAt: 1010,
          ms: 20,
          payload: {
            cache: {
              provider: 'anthropic',
              modelAlias: 'sonnet',
              promptShapeKey: 'boondi-support:v1',
              cacheReadTokens: 1024,
              cacheWriteTokens: 0,
              input: { sdk: 'request' },
              output: { usage: 'response' },
              capturedAt: '2026-06-17T12:30:00.000Z',
            },
          },
        },
      ],
      now: () => new Date('2026-06-17T12:31:00.000Z'),
    });

    expect(saved).toHaveLength(1);
    const timeline = saved[0].timingsJson as {
      sections: Array<{ kind: string; label: string; ms: number }>;
    };
    expect(timeline.sections.map((section) => section.kind)).toEqual([
      'message_persist',
      'cache_use',
      'gap',
    ]);
    expect(saved[0].payloadsJson).toEqual({
      1: {
        cache: {
          provider: 'anthropic',
          modelAlias: 'sonnet',
          promptShapeKey: 'boondi-support:v1',
          cacheReadTokens: 1024,
          cacheWriteTokens: 0,
          input: { sdk: 'request' },
          output: { usage: 'response' },
          capturedAt: '2026-06-17T12:30:00.000Z',
        },
      },
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

  it('builds a command trace with a command section', async () => {
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
    const sections = (
      saved[0].timingsJson as {
        sections: Array<{ kind: string; label: string }>;
      }
    ).sections;
    expect(sections[0]).toMatchObject({
      kind: 'command',
      label: '/new',
    });
  });

  it('assembles a v2 wall-clock timeline when windowStart/windowEnd/send/startup are provided', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved, {
      drain: () => [],
    });

    const windowStart = 1000;
    const windowEnd = 2500;
    const llmStartedAt = 1200;
    const llmMs = 800;

    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:99',
      appId: 'app:test',
      outboundMessageId: 'outbound:xyz',
      runHandle: 'gantry-run-2',
      windowStart,
      windowEnd,
      send: { startedAt: 2100, endedAt: windowEnd },
      startup: { startedAt: windowStart, readyAt: 1150 },
      llmTurns: [
        {
          ms: llmMs,
          startedAt: llmStartedAt,
          detail: { model: 'sonnet', stopReason: 'end_turn' },
        },
      ],
      now: () => new Date('2026-06-14T00:00:00.000Z'),
    });

    expect(saved.length).toBe(1);
    const row = saved[0];

    // v2 assertions
    expect(row.timingsJson.version).toBe(2);
    expect(row.totalMs).toBe(windowEnd - windowStart); // 1500

    const timeline = row.timingsJson as {
      version: 2;
      totalMs: number;
      sections: Array<{ kind: string; ms: number }>;
    };
    // sections must sum to totalMs
    const sectionsSum = timeline.sections.reduce((s, x) => s + x.ms, 0);
    expect(sectionsSum).toBe(row.totalMs);

    // must contain startup, llm, send sections
    const kinds = timeline.sections.map((s) => s.kind);
    expect(kinds).toContain('startup');
    expect(kinds).toContain('llm');
    expect(kinds).toContain('send');
  });

  it('uses runner-observed tool spans when no core MCP proxy span was captured', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved);

    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:tool',
      appId: 'app:test',
      outboundMessageId: 'outbound:tool',
      windowStart: 0,
      windowEnd: 1000,
      llmTurns: [
        {
          startedAt: 100,
          ms: 100,
          detail: { model: 'sonnet', stopReason: 'tool_use' },
        },
        {
          startedAt: 700,
          ms: 100,
          detail: { model: 'sonnet', stopReason: 'end_turn' },
        },
      ],
      toolCalls: [
        {
          server: 'shopify-api',
          tool: 'get_recent_orders_with_details',
          startedAt: 250,
          ms: 400,
          ok: true,
          requestBytes: 12,
          responseBytes: 34,
        },
      ],
      now: () => new Date('2026-06-14T00:00:00.000Z'),
    });

    const timeline = saved[0].timingsJson as {
      sections: Array<{ kind: string; label: string; ms: number }>;
    };
    expect(timeline.sections.map((section) => section.kind)).toContain('tool');
    expect(
      timeline.sections.find((section) => section.kind === 'tool'),
    ).toMatchObject({
      label: 'get_recent_orders_with_details',
      ms: 400,
    });
  });

  it('does not double-count runner tool spans that overlap core proxy spans', async () => {
    const saved: MessageTraceRow[] = [];
    const port = makePort(saved, {
      drain: () => [
        {
          server: 'shopify-api',
          tool: 'get_recent_orders_with_details',
          startedAt: 240,
          ms: 420,
          ok: true,
          requestBytes: 12,
          responseBytes: 34,
        },
      ],
    });

    await persistReplyTrace({
      replyTrace: port,
      kind: 'reply',
      chatJid: 'wa:tool',
      appId: 'app:test',
      outboundMessageId: 'outbound:tool',
      runHandle: 'gantry-run-tool',
      windowStart: 0,
      windowEnd: 1000,
      llmTurns: [
        {
          startedAt: 100,
          ms: 100,
          detail: { model: 'sonnet', stopReason: 'tool_use' },
        },
        {
          startedAt: 700,
          ms: 100,
          detail: { model: 'sonnet', stopReason: 'end_turn' },
        },
      ],
      toolCalls: [
        {
          server: 'gantry',
          tool: 'mcp_call_tool',
          startedAt: 230,
          ms: 450,
          ok: true,
          requestBytes: 12,
          responseBytes: 34,
        },
      ],
      now: () => new Date('2026-06-14T00:00:00.000Z'),
    });

    const timeline = saved[0].timingsJson as {
      sections: Array<{ kind: string; label: string; ms: number }>;
    };
    const toolSections = timeline.sections.filter(
      (section) => section.kind === 'tool',
    );
    expect(toolSections).toHaveLength(1);
    expect(toolSections[0]).toMatchObject({
      label: 'get_recent_orders_with_details',
      ms: 420,
    });
  });
});
