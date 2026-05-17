import { describe, expect, it, vi } from 'vitest';

import { collectDurableMemoryFromRepositories } from '@core/memory/boundary-extraction-core.js';

describe('collectDurableMemoryFromRepositories', () => {
  function makeRepositories() {
    const digests: unknown[] = [];
    const evidence: unknown[] = [];
    const saveAgentSessionDigest = vi
      .fn()
      .mockImplementation(async (value) => digests.push(value));
    const saveBoundaryEvidence = vi.fn().mockImplementation(async (value) => {
      evidence.push(value);
      return { id: `mev-${evidence.length}` };
    });
    return {
      digests,
      evidence,
      saveAgentSessionDigest,
      saveBoundaryEvidence,
      repositories: {
        agentSessions: {
          getAgentSession: vi.fn().mockResolvedValue({
            id: 'agent-session:1',
            appId: 'default',
            agentId: 'agent:kai',
            conversationId: 'conversation:tg-1',
            threadId: undefined,
            userId: 'user:1',
            status: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
        messages: {
          listRecentMessages: vi.fn().mockResolvedValue([
            {
              id: 'message:1',
              appId: 'default',
              conversationId: 'conversation:tg-1',
              direction: 'inbound',
              parts: [{ kind: 'text', text: 'Remember this.' }],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ]),
        },
        memory: {
          listPriorMemoryItems: vi.fn().mockResolvedValue([]),
          saveBoundaryEvidence,
        },
        sessionDigests: {
          saveAgentSessionDigest,
        },
      },
    };
  }

  it('persists digest before saving automatic DM boundary evidence with user-scope candidate metadata', async () => {
    const { repositories, digests, evidence, saveAgentSessionDigest } =
      makeRepositories();

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'user',
      extractFacts: () => [
        {
          scope: 'group',
          kind: 'preference',
          key: 'preference:reply-style',
          value: 'Ravi prefers concise replies.',
          why: 'Ravi asked for concise replies in this session.',
          confidence: 0.9,
        },
      ],
    });

    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      metadata: {
        sessionScope: {
          appId: 'default',
          agentId: 'agent:kai',
          conversationId: 'conversation:tg-1',
          userId: 'user:1',
          threadId: null,
        },
      },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      subjectType: 'user',
      subjectId: 'user:1',
      userId: 'user:1',
      metadata: {
        trigger: 'session-end',
        memoryCandidate: {
          scope: 'user',
          kind: 'preference',
          key: 'preference:reply-style',
        },
      },
    });
    expect(saveAgentSessionDigest.mock.invocationCallOrder[0]).toBeLessThan(
      repositories.memory.saveBoundaryEvidence.mock.invocationCallOrder[0],
    );
  });

  it('records extraction outcome metadata on zero-fact boundary digests', async () => {
    const { repositories, digests, evidence } = makeRepositories();

    const result = await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => ({
        facts: [],
        status: 'auth_unavailable',
        zeroFactReason: 'auth_unavailable',
      }),
    });

    expect(result).toEqual({ saved: 0 });
    expect(evidence).toHaveLength(0);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      metadata: {
        boundaryCapture: {
          status: 'digest_captured',
          trigger: 'session-end',
          turnCount: 1,
          plannedEvidenceCount: 0,
        },
        extraction: {
          status: 'auth_unavailable',
          factCount: 0,
          zeroFactReason: 'auth_unavailable',
        },
      },
    });
  });

  it('includes generated memory text in the saved digest when facts are also extracted', async () => {
    const { repositories, digests, evidence } = makeRepositories();

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => ({
        facts: [
          {
            scope: 'group',
            kind: 'fact',
            key: 'fact:release-owner',
            value: 'Kartik owns release approval.',
            why: 'The session said Kartik owns release approval.',
            confidence: 0.91,
          },
        ],
        status: 'facts_extracted',
        generatedMemory:
          'Generated summary: Kartik owns release approval for this channel.',
      }),
    });

    expect(evidence).toHaveLength(1);
    expect(digests).toHaveLength(1);
    expect((digests[0] as { digest: string }).digest).toContain(
      'Generated summary: Kartik owns release approval for this channel.',
    );
  });

  it('records array-only zero-fact extractors as qualified empty outcomes', async () => {
    const { repositories, digests } = makeRepositories();

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => [],
    });

    expect(digests[0]).toMatchObject({
      metadata: {
        extraction: {
          status: 'empty_qualified',
          factCount: 0,
          zeroFactReason: 'no_qualifying_facts',
        },
      },
    });
  });

  it('preserves explicit outcome-unavailable provider reports', async () => {
    const { repositories, digests, evidence } = makeRepositories();

    const result = await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => ({
        facts: [],
        status: 'outcome_unavailable',
        zeroFactReason: 'outcome_unavailable',
      }),
    });

    expect(result).toEqual({ saved: 0 });
    expect(evidence).toHaveLength(0);
    expect(digests[0]).toMatchObject({
      metadata: {
        extraction: {
          status: 'outcome_unavailable',
          factCount: 0,
          zeroFactReason: 'outcome_unavailable',
        },
      },
    });
  });

  it('persists automatic channel boundary evidence with group-scope candidate metadata', async () => {
    const { repositories, evidence } = makeRepositories();

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => [
        {
          scope: 'user',
          kind: 'decision',
          key: 'decision:release-process',
          value: 'The channel release process requires owner review.',
          why: 'The channel discussion required owner review before release.',
          confidence: 0.9,
        },
      ],
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      subjectType: 'channel',
      subjectId: 'conversation:tg-1',
      channelId: 'conversation:tg-1',
      metadata: {
        memoryCandidate: {
          scope: 'group',
          kind: 'decision',
          key: 'decision:release-process',
        },
      },
    });
  });

  it('does not persist extractor global scope as app/common memory from automatic boundaries', async () => {
    const { repositories, evidence } = makeRepositories();

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => [
        {
          scope: 'global',
          kind: 'constraint',
          key: 'constraint:no-app-memory-from-boundaries',
          value: 'Automatic boundary extraction must not write app memory.',
          why: 'The channel policy forbids writing common memory automatically.',
          confidence: 0.95,
        },
      ],
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      subjectType: 'channel',
      subjectId: 'conversation:tg-1',
      metadata: {
        memoryCandidate: {
          scope: 'group',
          kind: 'constraint',
        },
      },
    });
    expect(evidence[0]).not.toMatchObject({
      subjectType: 'common',
    });
  });

  it('treats thread scope as a channel child and not a user top-level boundary', async () => {
    const { repositories, evidence } = makeRepositories();
    repositories.agentSessions.getAgentSession = vi.fn().mockResolvedValue({
      id: 'agent-session:threaded',
      appId: 'default',
      agentId: 'agent:kai',
      conversationId: 'conversation:sl-C123',
      threadId: 'thread:abc',
      userId: 'user:1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:threaded',
      trigger: 'session-end',
      repositories,
      defaultScope: 'user',
      extractFacts: () => [
        {
          scope: 'user',
          kind: 'preference',
          key: 'preference:reply-style',
          value: 'Prefer concise replies.',
          why: 'The user requested concise responses.',
          confidence: 0.9,
        },
      ],
    });
    expect(evidence[0]).toMatchObject({
      subjectType: 'user',
      subjectId: 'user:1',
      userId: 'user:1',
    });
    expect(evidence[0]).not.toHaveProperty('threadId');

    evidence.length = 0;
    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:threaded',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => [
        {
          scope: 'group',
          kind: 'decision',
          key: 'decision:thread-policy',
          value: 'Thread policies stay scoped to their channel thread.',
          why: 'Thread discussion established a thread-local policy.',
          confidence: 0.92,
        },
      ],
    });
    expect(evidence[0]).toMatchObject({
      subjectType: 'channel',
      subjectId: 'conversation:sl-C123',
      channelId: 'conversation:sl-C123',
      threadId: 'thread:abc',
    });
  });

  it('saves canonical session thread boundary evidence under the app-memory raw thread id', async () => {
    const { repositories, evidence } = makeRepositories();
    repositories.agentSessions.getAgentSession = vi.fn().mockResolvedValue({
      id: 'agent-session:canonical-thread',
      appId: 'default',
      agentId: 'agent:kai',
      conversationId: 'conversation:sl:C123',
      threadId: 'thread:sl:C123:topic-7',
      userId: 'user:1',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:canonical-thread',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts: () => [
        {
          scope: 'group',
          kind: 'decision',
          key: 'decision:thread-policy',
          value: 'Thread evidence is saved under the raw provider thread id.',
          why: 'Hydration and dreaming resolve channel threads using raw ids.',
          confidence: 0.92,
        },
      ],
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      subjectType: 'channel',
      subjectId: 'conversation:sl:C123',
      channelId: 'conversation:sl:C123',
      threadId: 'topic-7',
    });
    expect(evidence[0]).not.toMatchObject({
      threadId: 'thread:sl:C123:topic-7',
    });
  });

  it('passes only current-agent app-grade prior memory into boundary extraction', async () => {
    const { repositories } = makeRepositories();
    repositories.agentSessions.getAgentSession = vi.fn().mockResolvedValue({
      id: 'agent-session:shared-thread',
      appId: 'default',
      agentId: 'agent:bravo',
      conversationId: 'conversation:sl:C123',
      threadId: 'thread:sl:C123:topic-7',
      userId: 'user:shared',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    repositories.memory.listPriorMemoryItems = vi
      .fn()
      .mockImplementation(async ({ session }) =>
        [
          {
            id: 'memory-agent-alpha',
            agentId: 'agent:alpha',
            threadId: 'topic-7',
            key: 'decision:alpha',
            value: 'Alpha agent memory must not leak.',
          },
          {
            id: 'memory-agent-bravo',
            agentId: 'agent:bravo',
            threadId: 'topic-7',
            key: 'decision:bravo',
            value: 'Bravo agent memory is in scope.',
          },
        ].filter((item) => item.agentId === session.agentId),
      );
    const extractFacts = vi.fn(() => []);

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:shared-thread',
      trigger: 'session-end',
      repositories,
      defaultScope: 'group',
      extractFacts,
    });

    expect(repositories.memory.listPriorMemoryItems).toHaveBeenCalledWith({
      session: expect.objectContaining({
        appId: 'default',
        agentId: 'agent:bravo',
        conversationId: 'conversation:sl:C123',
        threadId: 'thread:sl:C123:topic-7',
        userId: 'user:shared',
      }),
      limit: 10,
      defaultScope: 'group',
    });
    const extractionInput = extractFacts.mock.calls[0]?.[0] as {
      retrievedItems: Array<{ id: string; key: string; value: string }>;
    };
    expect(extractionInput.retrievedItems).toEqual([
      {
        id: 'memory-agent-bravo',
        key: 'decision:bravo',
        value: 'Bravo agent memory is in scope.',
      },
    ]);
  });

  it('redacts secret-like turn content and omits raw tool_result bodies in persisted session digests', async () => {
    const { repositories, digests } = makeRepositories();
    const userToken = 'sk-ant-abcdeabcdeabcdeabcdeabcde';
    const toolToken = 'ghp_abcdeabcdeabcdeabcdeabcde';
    repositories.messages.listRecentMessages = vi.fn().mockResolvedValue([
      {
        id: 'message:1',
        appId: 'default',
        conversationId: 'conversation:tg-1',
        direction: 'inbound',
        parts: [
          {
            kind: 'text',
            text: `Please keep this secret api_key=${userToken}`,
          },
          {
            kind: 'tool_result',
            toolId: 'fetch_credentials',
            value: {
              access_token: toolToken,
              payload: 'raw secret tool output should never persist',
            },
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      extractFacts: () => [
        {
          scope: 'user',
          kind: 'fact',
          key: 'fact:token',
          value: `The provided key was ${userToken}.`,
          why: 'The user provided a key.',
          confidence: 0.9,
        },
      ],
    });

    expect(digests).toHaveLength(1);
    const persistedDigest = (digests[0] as { digest: string }).digest;
    expect(persistedDigest).toContain('[REDACTED_SECRET]');
    expect(persistedDigest).toContain('[tool_result fetch_credentials');
    expect(persistedDigest).not.toContain(userToken);
    expect(persistedDigest).not.toContain(toolToken);
    expect(persistedDigest).not.toContain(
      'raw secret tool output should never persist',
    );
    expect(persistedDigest).not.toContain('access_token');
  });

  it('applies per-part, per-turn, and total extraction budgets with structural summaries', async () => {
    const { repositories } = makeRepositories();
    const longText = 'x'.repeat(8_000);
    const longCode = `function build() {\n${'  return "y";\n'.repeat(800)}}`;
    const hugeToolPayload = {
      nested: {
        details: 'z'.repeat(10_000),
      },
    };
    repositories.messages.listRecentMessages = vi.fn().mockResolvedValue([
      {
        id: 'message:budget-1',
        appId: 'default',
        conversationId: 'conversation:tg-1',
        direction: 'inbound',
        parts: [
          { kind: 'text', text: longText },
          { kind: 'code', language: 'ts', code: longCode },
          {
            kind: 'tool_result',
            toolId: 'expensive_fetch',
            value: hugeToolPayload,
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const extractFacts = vi.fn(() => []);

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      extractFacts,
    });

    expect(extractFacts).toHaveBeenCalledOnce();
    const extractionInput = extractFacts.mock.calls[0]?.[0] as {
      turns: Array<{ role: 'user' | 'assistant'; text: string }>;
    };
    const combined = extractionInput.turns.map((turn) => turn.text).join('\n');
    expect(
      extractionInput.turns.every((turn) => turn.text.length <= 2200),
    ).toBe(true);
    expect(combined.length).toBeLessThanOrEqual(16_000);
    expect(combined).toContain('[code:ts');
    expect(combined).toContain('[tool_result expensive_fetch payload=');
    expect(combined).not.toContain(longCode);
    expect(combined).not.toContain(hugeToolPayload.nested.details);
  });

  it('bounds retrieved memory items inside the total extraction prompt budget', async () => {
    const { repositories } = makeRepositories();
    const secretToken = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';
    const rawToolResultBody = 'raw-tool-result-body '.repeat(1_000);
    repositories.messages.listRecentMessages = vi.fn().mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `message:budget-turn-${index}`,
        appId: 'default',
        conversationId: 'conversation:tg-1',
        direction: index % 2 === 0 ? 'inbound' : 'outbound',
        parts: [
          {
            kind: 'text',
            text: `Turn ${index} ${'session text '.repeat(800)}`,
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
    );
    repositories.memory.listPriorMemoryItems = vi.fn().mockResolvedValue([
      {
        id: 'memory-item:oversized',
        key: `preference:${'oversized-key-'.repeat(400)}`,
        value: `tool_result fetch_credentials ${rawToolResultBody} api_key=${secretToken}`,
        isDeleted: false,
      },
    ]);
    const extractFacts = vi.fn(() => []);

    await collectDurableMemoryFromRepositories({
      agentSessionId: 'agent-session:1',
      trigger: 'session-end',
      repositories,
      extractFacts,
    });

    expect(extractFacts).toHaveBeenCalledOnce();
    const extractionInput = extractFacts.mock.calls[0]?.[0] as {
      trigger: 'session-end';
      turns: Array<{ role: 'user' | 'assistant'; text: string }>;
      retrievedItems: Array<{ id: string; key: string; value: string }>;
    };
    const combinedTurns = extractionInput.turns
      .map((turn) => turn.text)
      .join('\n');
    const serializedPayload = JSON.stringify(
      {
        session_arc: extractionInput.turns,
        trigger: extractionInput.trigger,
        retrieved_items: extractionInput.retrievedItems,
      },
      null,
      2,
    );

    expect(
      extractionInput.turns.every((turn) => turn.text.length <= 2200),
    ).toBe(true);
    expect(combinedTurns.length).toBeLessThanOrEqual(16_000);
    expect(serializedPayload.length).toBeLessThanOrEqual(16_000);
    expect(extractionInput.retrievedItems).toHaveLength(1);
    expect(extractionInput.retrievedItems[0]).toMatchObject({
      id: 'memory-item:oversized',
    });
    expect(extractionInput.retrievedItems[0]?.key).toContain(
      '[memory_key chars=',
    );
    expect(extractionInput.retrievedItems[0]?.value).toContain(
      '[memory_value chars=',
    );
    expect(serializedPayload).not.toContain(secretToken);
    expect(serializedPayload).not.toContain(rawToolResultBody);
    expect(serializedPayload).not.toContain('raw-tool-result-body');
  });
});
