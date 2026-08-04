import { describe, expect, it } from 'vitest';

import { mapSession } from '@core/adapters/storage/postgres/schema/control-plane-canonical.postgres.js';

describe('control-plane canonical mappers', () => {
  it('exposes workspaceKey from the canonical session mapping', () => {
    expect(
      mapSession({
        session_id: 'session-1',
        app_id: 'app-one',
        external_conversation_id: 'conv-1',
        agent_id: 'agent:fallback-folder',
        external_ref_json: JSON.stringify({
          chatJid: 'app:app-one:conv-1',
          workspaceFolder: 'agent-folder',
        }),
        default_response_mode: 'sse',
        default_webhook_id: null,
        created_at: '2026-04-24T00:00:00.000Z',
        updated_at: '2026-04-24T00:00:00.000Z',
      }),
    ).toMatchObject({
      workspaceFolder: 'agent-folder',
      workspaceKey: 'agent-folder',
    });
    expect(
      mapSession({
        session_id: 'session-2',
        app_id: 'app-one',
        external_conversation_id: 'conv-2',
        agent_id: 'agent:fallback-folder',
        external_ref_json: '{}',
        default_response_mode: 'sse',
        default_webhook_id: null,
        created_at: '2026-04-24T00:00:00.000Z',
        updated_at: '2026-04-24T00:00:00.000Z',
      }).workspaceKey,
    ).toBe('fallback-folder');
  });

  it('falls back to camelCase external conversation id for Drizzle rows', () => {
    expect(
      mapSession({
        sessionId: 'session-3',
        appId: 'app-one',
        externalConversationId: 'conv-3',
        agentId: 'agent:fallback-folder',
        externalRefJson: '{}',
        defaultResponseMode: 'sse',
        defaultWebhookId: null,
        createdAt: '2026-04-24T00:00:00.000Z',
        updatedAt: '2026-04-24T00:00:00.000Z',
      }),
    ).toMatchObject({
      chatJid: 'conv-3',
      conversationId: 'conv-3',
    });
  });
});
