import { describe, expect, it } from 'vitest';

import { processConversationHistoryRequest } from '../../../src/runtime/ipc-conversation-history.js';
import type { IpcDeps } from '../../../src/runtime/ipc-domain-types.js';
import type { ParsedConversationHistoryIpcRequest } from '../../../src/runtime/ipc-parsing.js';

const baseRequest: ParsedConversationHistoryIpcRequest = {
  requestId: 'convhist_test',
  chatJid: 'teams:conversation-1',
  threadId: 'thread-1',
  responseKeyId: 'key-1',
};

describe('processConversationHistoryRequest', () => {
  it('returns bounded sanitized current-thread history', async () => {
    const captured: Array<{
      sourceAgentFolder: string;
      chatJid: string;
      threadId: string;
      limit: number;
    }> = [];
    const deps = {
      getConversationThreadHistory: async (input) => {
        captured.push(input);
        return {
          messages: [
            {
              id: 'm1',
              createdAt: '2026-06-22T10:00:00.000Z',
              direction: 'inbound',
              senderDisplayName: 'Asha',
              text: '  First   message  ',
            },
            {
              id: 'm2',
              createdAt: '2026-06-22T10:01:00.000Z',
              direction: 'outbound',
              text: 'x'.repeat(5_000),
            },
          ],
        };
      },
    } satisfies Partial<IpcDeps>;

    const response = await processConversationHistoryRequest({
      request: { ...baseRequest, limit: 500, maxChars: 1_200 },
      sourceAgentFolder: 'agent-a',
      deps: deps as IpcDeps,
    });

    expect(captured).toEqual([
      {
        sourceAgentFolder: 'agent-a',
        chatJid: 'teams:conversation-1',
        threadId: 'thread-1',
        limit: 100,
      },
    ]);
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('convhist_test');
    expect(response.data).toMatchObject({
      schema: 'gantry.conversation_thread_history.v1',
      trust: 'untrusted_user_generated_conversation_data',
      scope: {
        chatJid: 'teams:conversation-1',
        threadId: 'thread-1',
      },
      limit: 100,
      maxChars: 1200,
      truncated: true,
    });
    const data = response.data as {
      messages: Array<{ id: string; text: string }>;
    };
    expect(data.messages[0]).toEqual({
      id: 'm1',
      createdAt: '2026-06-22T10:00:00.000Z',
      direction: 'inbound',
      senderDisplayName: 'Asha',
      text: 'First message',
    });
    expect(data.messages[1]?.text).toContain('[message truncated]');
  });

  it('fails closed when the host service is not available', async () => {
    const response = await processConversationHistoryRequest({
      request: baseRequest,
      sourceAgentFolder: 'agent-a',
      deps: {} as IpcDeps,
    });

    expect(response).toEqual({
      ok: false,
      requestId: 'convhist_test',
      error: 'Conversation history service is unavailable',
    });
  });
});
