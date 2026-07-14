import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
const sendCoreMessageSpy = vi.hoisted(() => vi.fn());

vi.mock(
  '@core/application/core-tools/send-message.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@core/application/core-tools/send-message.js')
      >();
    sendCoreMessageSpy.mockImplementation(actual.sendCoreMessage);
    return { ...actual, sendCoreMessage: sendCoreMessageSpy };
  },
);

import { createCoreToolRegistry } from '@core/runtime/core-tools/registry.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import { deliverIpcMessage } from '@core/runtime/ipc-message-delivery.js';
import { createCoreToolSchemas } from '@core/runtime/core-tools/schemas.js';
import {
  evaluateNeutralToolPolicy,
  evaluateNeutralToolPreChecks,
} from '@core/runner/tool-gate-core.js';
import {
  formatMemoryToolResponse,
  formatMemoryWriteResponse,
} from '@core/runner/mcp/formatting.js';

afterEach(() => {
  vi.restoreAllMocks();
  sendCoreMessageSpy.mockClear();
});

describe('shared core tool handlers', () => {
  it('uses the same send_message application handler for IPC and direct calls', async () => {
    const sendMessage = vi.fn(async () => undefined);

    await deliverIpcMessage({
      deps: { sendMessage } as never,
      sourceAgentFolder: 'main_agent',
      data: {
        type: 'message',
        chatJid: 'conversation:test',
        text: 'from IPC',
      },
      targetJid: 'conversation:test',
    });
    await createCoreToolRegistry({
      context: {
        sourceAgentFolder: 'main_agent',
        conversationId: 'conversation:test',
        permissionMode: 'ask',
      },
      sendMessage,
      requestUserAnswer: vi.fn(),
      evaluateToolPreChecks: evaluateNeutralToolPreChecks,
      evaluateToolPolicy: evaluateNeutralToolPolicy,
      formatMemorySearchResponse: formatMemoryToolResponse,
      formatMemoryWriteResponse,
      schemas: createCoreToolSchemas(z),
    }).execute('send_message', { text: 'direct' });

    expect(sendCoreMessageSpy).toHaveBeenCalledTimes(2);
    expect(
      sendCoreMessageSpy.mock.calls.map(([input]) => input.message.text),
    ).toEqual(['from IPC', 'direct']);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('returns model-visible retry metadata for a failing core tool', async () => {
    sendCoreMessageSpy.mockRejectedValueOnce(new Error('Delivery unavailable'));

    const result = await createCoreToolRegistry({
      context: {
        sourceAgentFolder: 'main_agent',
        conversationId: 'conversation:test',
        permissionMode: 'ask',
      },
      sendMessage: vi.fn(),
      requestUserAnswer: vi.fn(),
      evaluateToolPreChecks: evaluateNeutralToolPreChecks,
      evaluateToolPolicy: evaluateNeutralToolPolicy,
      formatMemorySearchResponse: formatMemoryToolResponse,
      formatMemoryWriteResponse,
      schemas: createCoreToolSchemas(z),
    }).execute('send_message', { text: 'direct' });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Delivery unavailable' }],
      isError: true,
      error: {
        category: 'transient',
        isRetryable: true,
        message: 'Delivery unavailable',
      },
    });
  });

  it('round-trips memory_save and memory_search through AppMemoryService', async () => {
    const memory = {
      save: vi.fn(async (input) => ({
        id: 'mem-1',
        appId: input.appId,
        agentId: input.agentId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        kind: input.kind ?? 'fact',
        key: input.key,
        value: input.value,
        confidence: input.confidence ?? 1,
        isPinned: false,
        version: 1,
        source: input.source ?? 'mcp-tool',
        evidenceIds: [],
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      })),
      searchReadOnly: vi.fn(async () => [
        {
          item: {
            id: 'mem-1',
            subjectType: 'group',
            subjectId: 'main_agent',
            kind: 'fact',
            key: 'timezone',
            value: 'Asia/Kolkata',
            confidence: 1,
            isPinned: false,
            version: 1,
            source: 'mcp-tool',
            evidenceIds: [],
            createdAt: '2026-07-10T00:00:00.000Z',
            updatedAt: '2026-07-10T00:00:00.000Z',
          },
          score: 1,
          lexicalScore: 1,
          vectorScore: 0,
          reasons: ['key_match'],
        },
      ]),
    };
    vi.spyOn(AppMemoryService, 'getInstance').mockReturnValue(memory as never);
    const registry = createCoreToolRegistry({
      context: {
        sourceAgentFolder: 'main_agent',
        conversationId: 'conversation:test',
        permissionMode: 'ask',
      },
      sendMessage: vi.fn(),
      requestUserAnswer: vi.fn(),
      requestId: (prefix) => `${prefix}-1`,
      evaluateToolPreChecks: evaluateNeutralToolPreChecks,
      evaluateToolPolicy: evaluateNeutralToolPolicy,
      formatMemorySearchResponse: formatMemoryToolResponse,
      formatMemoryWriteResponse,
      schemas: createCoreToolSchemas(z),
    });

    const saved = await registry.execute('memory_save', {
      key: 'timezone',
      value: 'Asia/Kolkata',
    });
    const searched = await registry.execute('memory_search', {
      query: 'timezone',
    });

    expect(memory.save).toHaveBeenCalledOnce();
    expect(memory.searchReadOnly).toHaveBeenCalledOnce();
    expect(saved.content[0]?.text).toBe(
      'Memory saved: fact:timezone = Asia/Kolkata',
    );
    expect(searched.content[0]?.text).toContain('1. timezone: Asia/Kolkata');
  });
});
