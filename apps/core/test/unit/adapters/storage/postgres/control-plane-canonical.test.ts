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
          groupFolder: 'agent-folder',
        }),
        default_response_mode: 'sse',
        default_webhook_id: null,
        created_at: '2026-04-24T00:00:00.000Z',
        updated_at: '2026-04-24T00:00:00.000Z',
      }),
    ).toMatchObject({
      groupFolder: 'agent-folder',
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
});
