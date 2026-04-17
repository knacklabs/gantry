import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getRouterState,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from '../storage/db.js';
import { decodeGroupMessageCursor } from '../core/message-cursor.js';
import { createRuntimeApp } from './runtime-app.js';

describe('createRuntimeApp', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('resets corrupted cursor state on load', () => {
    setRouterState('last_agent_timestamp', '{bad-json');

    const app = createRuntimeApp({
      onecli: {
        ensureAgent: vi.fn(async () => ({ created: false })),
      } as any,
    });

    app.loadState();

    expect(app.getOrRecoverCursor('group@g.us')).toBe('');
  });

  it('recovers cursor from last bot message and persists it', () => {
    const timestamp = '2026-01-01T01:02:03.000Z';
    storeChatMetadata('group@g.us', timestamp, 'Group', 'telegram', true);
    storeMessage({
      id: 'bot-1',
      chat_jid: 'group@g.us',
      sender: 'assistant',
      sender_name: 'MyClaw',
      content: 'MyClaw: hello',
      timestamp,
      is_bot_message: true,
    });

    const app = createRuntimeApp({
      onecli: {
        ensureAgent: vi.fn(async () => ({ created: false })),
      } as any,
    });

    app.loadState();
    const recovered = app.getOrRecoverCursor('group@g.us');

    expect(decodeGroupMessageCursor(recovered)).toEqual({
      timestamp,
      id: 'bot-1',
    });

    const serialized = getRouterState('last_agent_timestamp');
    expect(serialized).toBeTruthy();
    expect(
      decodeGroupMessageCursor(JSON.parse(serialized || '{}')['group@g.us']),
    ).toEqual({
      timestamp,
      id: 'bot-1',
    });
  });
});
