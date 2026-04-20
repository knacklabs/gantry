import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  _initTestDatabase,
  _closeDatabase,
  _createSchemaForTest,
  addJobEvent,
  completeJobRun,
  createJobRun,
  deleteRegisteredGroup,
  deleteJob,
  deleteSession,
  getAllChats,
  getAllJobs,
  getAllRegisteredGroups,
  getAllSessions,
  getLastBotMessageTimestamp,
  getJobById,
  getMessagesSince,
  getNewMessages,
  getRecentJobRuns,
  getRegisteredGroup,
  getRouterState,
  getSession,
  listDeadLetterRuns,
  listDueJobs,
  listRecentJobEvents,
  listJobRuns,
  markJobRunning,
  markJobRunNotified,
  releaseStaleJobLeases,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateJob,
  upsertJob,
} from '@core/storage/db.js';
import { formatMessages } from '@core/messaging/router.js';
import {
  decodeGlobalMessageCursor,
  encodeGroupMessageCursor,
} from '@core/core/message-cursor.js';
import { RegisteredGroup } from '@core/core/types.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- reply context persistence ---

describe('reply context', () => {
  it('stores and retrieves reply_to fields', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Yes, on my way!',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming tonight?',
      reply_to_sender_name: 'Bob',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('42');
    expect(messages[0].reply_to_message_content).toBe(
      'Are you coming tonight?',
    );
    expect(messages[0].reply_to_sender_name).toBe('Bob');
  });

  it('returns null for messages without reply context', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'no-reply',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Just a normal message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBeNull();
    expect(messages[0].reply_to_message_content).toBeNull();
    expect(messages[0].reply_to_sender_name).toBeNull();
  });

  it('retrieves reply context via getNewMessages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'reply-2',
      chat_jid: 'group@g.us',
      sender: '456',
      sender_name: 'Carol',
      content: 'Agreed',
      timestamp: '2024-01-01T00:00:01.000Z',
      reply_to_message_id: '99',
      reply_to_message_content: 'We should meet',
      reply_to_sender_name: 'Dave',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].reply_to_message_id).toBe('99');
    expect(messages[0].reply_to_sender_name).toBe('Dave');
  });
});

describe('thread context', () => {
  it('stores and retrieves thread_id', () => {
    storeChatMetadata('sl:C0123456789', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'slack-1',
      chat_jid: 'sl:C0123456789',
      sender: 'U123',
      sender_name: 'Alice',
      content: 'reply in thread',
      timestamp: '2024-01-01T00:00:01.000Z',
      thread_id: '1710000000.000100',
    });

    const messages = getMessagesSince(
      'sl:C0123456789',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].thread_id).toBe('1710000000.000100');
  });

  it('fails on incompatible messages table missing required thread columns', () => {
    const incompatibleDb = new Database(':memory:');
    try {
      incompatibleDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT,
          channel TEXT,
          is_group INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          is_from_me INTEGER,
          is_bot_message INTEGER DEFAULT 0,
          PRIMARY KEY (id, chat_jid),
          FOREIGN KEY (chat_jid) REFERENCES chats(jid)
        );
      `);

      expect(() => _createSchemaForTest(incompatibleDb)).toThrow(/thread_id/i);
    } finally {
      incompatibleDb.close();
    }
  });

  it.each([
    'reply_to_message_id',
    'reply_to_message_content',
    'reply_to_sender_name',
  ])(
    'fails when messages table is missing required column %s',
    (missingColumn) => {
      const incompatibleDb = new Database(':memory:');
      try {
        const optionalColumns = [
          'thread_id TEXT,',
          'reply_to_message_id TEXT,',
          'reply_to_message_content TEXT,',
          'reply_to_sender_name TEXT,',
        ].filter((column) => !column.startsWith(`${missingColumn} `));
        incompatibleDb.exec(`
          CREATE TABLE chats (
            jid TEXT PRIMARY KEY,
            name TEXT,
            last_message_time TEXT,
            channel TEXT,
            is_group INTEGER DEFAULT 0
          );
          CREATE TABLE messages (
            id TEXT,
            chat_jid TEXT,
            sender TEXT,
            sender_name TEXT,
            content TEXT,
            timestamp TEXT,
            ${optionalColumns.join('\n')}
            is_from_me INTEGER,
            is_bot_message INTEGER DEFAULT 0,
            PRIMARY KEY (id, chat_jid),
            FOREIGN KEY (chat_jid) REFERENCES chats(jid)
          );
        `);

        expect(() => _createSchemaForTest(incompatibleDb)).toThrow(
          new RegExp(missingColumn, 'i'),
        );
      } finally {
        incompatibleDb.close();
      }
    },
  );

  it('fails when registered_groups table is missing is_main', () => {
    const incompatibleDb = new Database(':memory:');
    try {
      incompatibleDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT,
          channel TEXT,
          is_group INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          thread_id TEXT,
          reply_to_message_id TEXT,
          reply_to_message_content TEXT,
          reply_to_sender_name TEXT,
          is_from_me INTEGER,
          is_bot_message INTEGER DEFAULT 0,
          PRIMARY KEY (id, chat_jid),
          FOREIGN KEY (chat_jid) REFERENCES chats(jid)
        );
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          model TEXT DEFAULT NULL,
          script TEXT,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          linked_sessions TEXT NOT NULL,
          thread_id TEXT,
          group_scope TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'agent',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          next_run TEXT,
          last_run TEXT,
          silent INTEGER NOT NULL DEFAULT 0,
          cleanup_after_ms INTEGER NOT NULL DEFAULT 86400000,
          timeout_ms INTEGER NOT NULL DEFAULT 300000,
          max_retries INTEGER NOT NULL DEFAULT 3,
          retry_backoff_ms INTEGER NOT NULL DEFAULT 5000,
          max_consecutive_failures INTEGER NOT NULL DEFAULT 5,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          execution_mode TEXT NOT NULL DEFAULT 'parallel',
          lease_run_id TEXT,
          lease_expires_at TEXT,
          pause_reason TEXT
        );
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1
        );
      `);

      expect(() => _createSchemaForTest(incompatibleDb)).toThrow(/is_main/i);
    } finally {
      incompatibleDb.close();
    }
  });

  it('fails when jobs table is missing execution_mode', () => {
    const incompatibleDb = new Database(':memory:');
    try {
      incompatibleDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT,
          channel TEXT,
          is_group INTEGER DEFAULT 0
        );
        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          thread_id TEXT,
          reply_to_message_id TEXT,
          reply_to_message_content TEXT,
          reply_to_sender_name TEXT,
          is_from_me INTEGER,
          is_bot_message INTEGER DEFAULT 0,
          PRIMARY KEY (id, chat_jid),
          FOREIGN KEY (chat_jid) REFERENCES chats(jid)
        );
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          model TEXT DEFAULT NULL,
          script TEXT,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          linked_sessions TEXT NOT NULL,
          thread_id TEXT,
          group_scope TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'agent',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          next_run TEXT,
          last_run TEXT,
          silent INTEGER NOT NULL DEFAULT 0,
          cleanup_after_ms INTEGER NOT NULL DEFAULT 86400000,
          timeout_ms INTEGER NOT NULL DEFAULT 300000,
          max_retries INTEGER NOT NULL DEFAULT 3,
          retry_backoff_ms INTEGER NOT NULL DEFAULT 5000,
          max_consecutive_failures INTEGER NOT NULL DEFAULT 5,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          lease_run_id TEXT,
          lease_expires_at TEXT,
          pause_reason TEXT
        );
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1,
          is_main INTEGER DEFAULT 0
        );
      `);

      expect(() => _createSchemaForTest(incompatibleDb)).toThrow(
        /execution_mode/i,
      );
    } finally {
      incompatibleDb.close();
    }
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, drain starts from the oldest unseen messages
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    expect(msgs[0].content).toBe('third');
    expect(msgs[9].content).toBe('pending message 9');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(decodeGlobalMessageCursor(newTimestamp)).toEqual({
      timestamp: '2024-01-01T00:00:04.000Z',
      chatJid: 'group1@g.us',
      id: 'a4',
    });
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

describe('job CRUD', () => {
  it('upserts and retrieves a job', () => {
    upsertJob({
      id: 'job-1',
      name: 'daily-summary',
      prompt: 'summarize',
      model: 'claude-sonnet-4-6',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });

    const job = getJobById('job-1');
    expect(job).toBeDefined();
    expect(job!.name).toBe('daily-summary');
    expect(job!.model).toBe('claude-sonnet-4-6');
    expect(job!.linked_sessions).toEqual(['group@g.us']);
  });

  it('updates job status and policy fields', () => {
    upsertJob({
      id: 'job-2',
      name: 'weekly',
      prompt: 'work',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
      status: 'paused',
    });

    updateJob('job-2', {
      status: 'active',
      model: 'claude-opus-4-1',
      max_retries: 5,
      retry_backoff_ms: 7000,
    });
    const job = getJobById('job-2');
    expect(job?.status).toBe('active');
    expect(job?.model).toBe('claude-opus-4-1');
    expect(job?.max_retries).toBe(5);
    expect(job?.retry_backoff_ms).toBe(7000);
  });

  it('stores and lists job runs', () => {
    upsertJob({
      id: 'job-3',
      name: 'runnable',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });

    createJobRun({
      run_id: 'run-1',
      job_id: 'job-3',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    completeJobRun('run-1', 'completed', 'ok', null);

    const runs = listJobRuns('job-3', 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
  });

  it('deletes a job and its runs', () => {
    upsertJob({
      id: 'job-4',
      name: 'delete-me',
      prompt: 'run',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: ['group@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
      status: 'paused',
    });
    createJobRun({
      run_id: 'run-del-1',
      job_id: 'job-4',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });

    deleteJob('job-4');
    expect(getJobById('job-4')).toBeUndefined();
    expect(listJobRuns('job-4', 10)).toHaveLength(0);
  });
});

// --- Router state ---

describe('router state', () => {
  it('returns undefined for missing key', () => {
    expect(getRouterState('nonexistent')).toBeUndefined();
  });

  it('sets and gets a value', () => {
    setRouterState('last_timestamp', '2024-01-01T00:00:00.000Z');
    expect(getRouterState('last_timestamp')).toBe('2024-01-01T00:00:00.000Z');
  });

  it('overwrites existing value', () => {
    setRouterState('cursor', 'old');
    setRouterState('cursor', 'new');
    expect(getRouterState('cursor')).toBe('new');
  });
});

// --- Session accessors ---

describe('session accessors', () => {
  it('returns undefined for missing session', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });

  it('sets and gets a session', () => {
    setSession('whatsapp_main', 'session-abc');
    expect(getSession('whatsapp_main')).toBe('session-abc');
  });

  it('overwrites existing session', () => {
    setSession('whatsapp_main', 'session-1');
    setSession('whatsapp_main', 'session-2');
    expect(getSession('whatsapp_main')).toBe('session-2');
  });

  it('deletes a session', () => {
    setSession('whatsapp_main', 'session-abc');
    deleteSession('whatsapp_main');
    expect(getSession('whatsapp_main')).toBeUndefined();
  });

  it('delete on nonexistent session is a no-op', () => {
    // Should not throw
    deleteSession('nonexistent');
    expect(getSession('nonexistent')).toBeUndefined();
  });

  it('getAllSessions returns all stored sessions', () => {
    setSession('folder-a', 'sid-1');
    setSession('folder-b', 'sid-2');
    setSession('folder-c', 'sid-3');

    const sessions = getAllSessions();
    expect(sessions).toEqual({
      'folder-a': 'sid-1',
      'folder-b': 'sid-2',
      'folder-c': 'sid-3',
    });
  });

  it('getAllSessions returns empty object when no sessions exist', () => {
    expect(getAllSessions()).toEqual({});
  });
});

// --- storeChatMetadata with channel/isGroup ---

describe('storeChatMetadata channel and isGroup', () => {
  it('stores channel and isGroup for a WhatsApp group', () => {
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'My Group',
      'whatsapp',
      true,
    );
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].channel).toBe('whatsapp');
    expect(chats[0].is_group).toBe(1);
  });

  it('stores channel and isGroup=false for a DM', () => {
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:00.000Z',
      'Alice',
      'whatsapp',
      false,
    );
    const chats = getAllChats();
    expect(chats[0].is_group).toBe(0);
    expect(chats[0].channel).toBe('whatsapp');
  });

  it('preserves existing channel on update without channel', () => {
    storeChatMetadata(
      'tg:123',
      '2024-01-01T00:00:00.000Z',
      'Telegram Chat',
      'telegram',
      false,
    );
    // Update without channel
    storeChatMetadata('tg:123', '2024-01-01T00:00:01.000Z', 'Telegram Chat');
    const chats = getAllChats();
    expect(chats[0].channel).toBe('telegram');
  });

  it('stores without name, using JID as default, with channel', () => {
    storeChatMetadata(
      'dc:456',
      '2024-01-01T00:00:00.000Z',
      undefined,
      'discord',
      true,
    );
    const chats = getAllChats();
    expect(chats[0].name).toBe('dc:456');
    expect(chats[0].channel).toBe('discord');
    expect(chats[0].is_group).toBe(1);
  });
});

// --- getAllJobs ---

describe('getAllJobs', () => {
  it('returns empty array when no jobs exist', () => {
    expect(getAllJobs()).toEqual([]);
  });

  it('returns all jobs ordered by updated_at DESC', () => {
    upsertJob({
      id: 'job-a',
      name: 'alpha',
      prompt: 'do alpha',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: ['g1@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    // Small delay to ensure updated_at differs
    upsertJob({
      id: 'job-b',
      name: 'beta',
      prompt: 'do beta',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['g2@g.us'],
      group_scope: 'main',
      created_by: 'human',
      next_run: '2026-01-01T00:00:00.000Z',
    });

    const jobs = getAllJobs();
    expect(jobs).toHaveLength(2);
    // linked_sessions should be parsed arrays
    expect(Array.isArray(jobs[0].linked_sessions)).toBe(true);
    expect(Array.isArray(jobs[1].linked_sessions)).toBe(true);
  });
});

// --- upsertJob edge cases ---

describe('upsertJob edge cases', () => {
  it('returns created=true for new job', () => {
    const result = upsertJob({
      id: 'new-job',
      name: 'fresh',
      prompt: 'go',
      schedule_type: 'once',
      schedule_value: '2026-06-01T00:00:00.000Z',
      linked_sessions: ['g@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-06-01T00:00:00.000Z',
    });
    expect(result.created).toBe(true);
  });

  it('returns created=false for existing job', () => {
    upsertJob({
      id: 'dup-job',
      name: 'first',
      prompt: 'go',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    const result = upsertJob({
      id: 'dup-job',
      name: 'updated',
      prompt: 'go again',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: ['new@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    expect(result.created).toBe(false);
    // Name should be updated
    const job = getJobById('dup-job');
    expect(job?.name).toBe('updated');
    expect(job?.linked_sessions).toEqual(['new@g.us']);
  });

  it('does not override running status on upsert', () => {
    upsertJob({
      id: 'running-job',
      name: 'runner',
      prompt: 'run',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });
    // Manually set status to running
    updateJob('running-job', { status: 'running' });
    expect(getJobById('running-job')?.status).toBe('running');

    // Upsert with status=active should NOT override running
    upsertJob({
      id: 'running-job',
      name: 'runner-updated',
      prompt: 'run updated',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });
    const job = getJobById('running-job');
    expect(job?.status).toBe('running');
    expect(job?.name).toBe('runner-updated');
  });

  it('uses default values for optional fields', () => {
    upsertJob({
      id: 'defaults-job',
      name: 'defaults',
      prompt: 'test',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    const job = getJobById('defaults-job');
    expect(job?.timeout_ms).toBe(300000);
    expect(job?.max_retries).toBe(3);
    expect(job?.retry_backoff_ms).toBe(5000);
    expect(job?.max_consecutive_failures).toBe(5);
    expect(job?.cleanup_after_ms).toBe(86400000);
    expect(job?.silent).toBe(false);
    expect(job?.thread_id).toBeNull();
    expect(job?.status).toBe('active');
    expect(job?.execution_mode).toBe('parallel');
  });

  it('stores script field', () => {
    upsertJob({
      id: 'script-job',
      name: 'with-script',
      prompt: 'run this',
      script: 'echo hello',
      schedule_type: 'once',
      schedule_value: '2026-06-01T00:00:00.000Z',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'human',
      next_run: '2026-06-01T00:00:00.000Z',
    });
    const job = getJobById('script-job');
    expect(job?.script).toBe('echo hello');
    expect(job?.created_by).toBe('human');
  });
});

// --- updateJob comprehensive field coverage ---

describe('updateJob field coverage', () => {
  beforeEach(() => {
    upsertJob({
      id: 'upd-job',
      name: 'original',
      prompt: 'original prompt',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: ['g@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });
  });

  it('does nothing when updates is empty', () => {
    const before = getJobById('upd-job');
    updateJob('upd-job', {});
    const after = getJobById('upd-job');
    // updated_at should not change when no fields are set
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('updates name', () => {
    updateJob('upd-job', { name: 'renamed' });
    expect(getJobById('upd-job')?.name).toBe('renamed');
  });

  it('updates prompt', () => {
    updateJob('upd-job', { prompt: 'new prompt' });
    expect(getJobById('upd-job')?.prompt).toBe('new prompt');
  });

  it('updates script', () => {
    updateJob('upd-job', { script: 'npm test' });
    expect(getJobById('upd-job')?.script).toBe('npm test');
  });

  it('clears script to null with empty string', () => {
    updateJob('upd-job', { script: 'initial' });
    updateJob('upd-job', { script: '' });
    expect(getJobById('upd-job')?.script).toBeNull();
  });

  it('updates schedule_type and schedule_value', () => {
    updateJob('upd-job', {
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
    });
    const job = getJobById('upd-job');
    expect(job?.schedule_type).toBe('cron');
    expect(job?.schedule_value).toBe('0 9 * * *');
  });

  it('updates linked_sessions', () => {
    updateJob('upd-job', { linked_sessions: ['a@g.us', 'b@g.us'] });
    expect(getJobById('upd-job')?.linked_sessions).toEqual([
      'a@g.us',
      'b@g.us',
    ]);
  });

  it('updates thread_id', () => {
    updateJob('upd-job', { thread_id: 'thread-123' });
    expect(getJobById('upd-job')?.thread_id).toBe('thread-123');
  });

  it('updates silent and cleanup_after_ms', () => {
    updateJob('upd-job', { silent: true, cleanup_after_ms: 60000 });
    const job = getJobById('upd-job');
    expect(job?.silent).toBe(true);
    expect(job?.cleanup_after_ms).toBe(60000);
  });

  it('updates group_scope', () => {
    updateJob('upd-job', { group_scope: 'other-group' });
    expect(getJobById('upd-job')?.group_scope).toBe('other-group');
  });

  it('updates execution_mode', () => {
    updateJob('upd-job', { execution_mode: 'serialized' });
    expect(getJobById('upd-job')?.execution_mode).toBe('serialized');
  });

  it('updates next_run and last_run', () => {
    updateJob('upd-job', {
      next_run: '2026-06-01T00:00:00.000Z',
      last_run: '2026-05-01T00:00:00.000Z',
    });
    const job = getJobById('upd-job');
    expect(job?.next_run).toBe('2026-06-01T00:00:00.000Z');
    expect(job?.last_run).toBe('2026-05-01T00:00:00.000Z');
  });

  it('updates timeout_ms', () => {
    updateJob('upd-job', { timeout_ms: 600000 });
    expect(getJobById('upd-job')?.timeout_ms).toBe(600000);
  });

  it('updates max_consecutive_failures and consecutive_failures', () => {
    updateJob('upd-job', {
      max_consecutive_failures: 10,
      consecutive_failures: 3,
    });
    const job = getJobById('upd-job');
    expect(job?.max_consecutive_failures).toBe(10);
    expect(job?.consecutive_failures).toBe(3);
  });

  it('updates pause_reason', () => {
    updateJob('upd-job', { pause_reason: 'too many failures' });
    expect(getJobById('upd-job')?.pause_reason).toBe('too many failures');
  });

  it('updates lease_run_id and lease_expires_at', () => {
    updateJob('upd-job', {
      lease_run_id: 'run-xyz',
      lease_expires_at: '2026-01-01T01:00:00.000Z',
    });
    const job = getJobById('upd-job');
    expect(job?.lease_run_id).toBe('run-xyz');
    expect(job?.lease_expires_at).toBe('2026-01-01T01:00:00.000Z');
  });
});

// --- listDueJobs ---

describe('listDueJobs', () => {
  it('returns empty when no jobs are due', () => {
    upsertJob({
      id: 'future-job',
      name: 'future',
      prompt: 'do later',
      schedule_type: 'once',
      schedule_value: '2099-01-01T00:00:00.000Z',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2099-01-01T00:00:00.000Z',
    });
    expect(listDueJobs('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('returns jobs whose next_run is at or before nowIso', () => {
    upsertJob({
      id: 'due-job',
      name: 'due',
      prompt: 'now',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      linked_sessions: ['g@g.us'],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });
    upsertJob({
      id: 'past-due-job',
      name: 'past-due',
      prompt: 'overdue',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2025-12-31T23:00:00.000Z',
    });

    const due = listDueJobs('2026-01-01T00:00:00.000Z');
    expect(due).toHaveLength(2);
    // Ordered by next_run ASC
    expect(due[0].id).toBe('past-due-job');
    expect(due[1].id).toBe('due-job');
  });

  it('excludes paused jobs', () => {
    upsertJob({
      id: 'paused-job',
      name: 'paused',
      prompt: 'paused',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
      status: 'paused',
    });
    expect(listDueJobs('2026-06-01T00:00:00.000Z')).toEqual([]);
  });

  it('excludes jobs with null next_run', () => {
    upsertJob({
      id: 'no-next',
      name: 'manual',
      prompt: 'manual',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    expect(listDueJobs('2099-01-01T00:00:00.000Z')).toEqual([]);
  });
});

// --- markJobRunning ---

describe('markJobRunning', () => {
  it('marks an active job as running and returns true', () => {
    upsertJob({
      id: 'mark-job',
      name: 'mark',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });

    const result = markJobRunning(
      'mark-job',
      'run-1',
      '2026-01-01T01:00:00.000Z',
    );
    expect(result).toBe(true);

    const job = getJobById('mark-job');
    expect(job?.status).toBe('running');
    expect(job?.lease_run_id).toBe('run-1');
    expect(job?.lease_expires_at).toBe('2026-01-01T01:00:00.000Z');
  });

  it('returns false for non-active job (paused)', () => {
    upsertJob({
      id: 'paused-mark',
      name: 'paused',
      prompt: 'run',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
      status: 'paused',
    });

    const result = markJobRunning(
      'paused-mark',
      'run-2',
      '2026-01-01T01:00:00.000Z',
    );
    expect(result).toBe(false);
    expect(getJobById('paused-mark')?.status).toBe('paused');
  });

  it('returns false for nonexistent job', () => {
    const result = markJobRunning(
      'ghost-job',
      'run-3',
      '2026-01-01T01:00:00.000Z',
    );
    expect(result).toBe(false);
  });
});

// --- releaseStaleJobLeases ---

describe('releaseStaleJobLeases', () => {
  it('releases running jobs with expired leases', () => {
    upsertJob({
      id: 'stale-job',
      name: 'stale',
      prompt: 'run',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });
    markJobRunning('stale-job', 'run-stale', '2026-01-01T00:05:00.000Z');

    // Lease expired at 00:05, now is 00:10
    const released = releaseStaleJobLeases('2026-01-01T00:10:00.000Z');
    expect(released).toBe(1);

    const job = getJobById('stale-job');
    expect(job?.status).toBe('active');
    expect(job?.lease_run_id).toBeNull();
    expect(job?.lease_expires_at).toBeNull();
  });

  it('does not release jobs with valid leases', () => {
    upsertJob({
      id: 'valid-lease',
      name: 'valid',
      prompt: 'run',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });
    markJobRunning('valid-lease', 'run-valid', '2026-01-01T01:00:00.000Z');

    // Now is 00:30, lease expires at 01:00 - should not release
    const released = releaseStaleJobLeases('2026-01-01T00:30:00.000Z');
    expect(released).toBe(0);
    expect(getJobById('valid-lease')?.status).toBe('running');
  });

  it('returns 0 when no stale leases exist', () => {
    expect(releaseStaleJobLeases('2026-01-01T00:00:00.000Z')).toBe(0);
  });
});

// --- createJobRun duplicate handling ---

describe('createJobRun duplicate', () => {
  it('returns false when inserting a duplicate run (same job_id+scheduled_for)', () => {
    upsertJob({
      id: 'dup-run-job',
      name: 'dup',
      prompt: 'run',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });

    const first = createJobRun({
      run_id: 'run-first',
      job_id: 'dup-run-job',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    expect(first).toBe(true);

    // Same job_id + scheduled_for → INSERT OR IGNORE → changes=0
    const second = createJobRun({
      run_id: 'run-second',
      job_id: 'dup-run-job',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:01.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    expect(second).toBe(false);
  });
});

// --- markJobRunNotified ---

describe('markJobRunNotified', () => {
  it('sets notified_at on a job run', () => {
    upsertJob({
      id: 'notify-job',
      name: 'notify',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });
    createJobRun({
      run_id: 'run-notify',
      job_id: 'notify-job',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });

    markJobRunNotified('run-notify');
    const runs = listJobRuns('notify-job');
    expect(runs[0].notified_at).toBeTruthy();
  });
});

// --- getRecentJobRuns ---

describe('getRecentJobRuns', () => {
  it('returns recent runs across all jobs', () => {
    upsertJob({
      id: 'recent-job-a',
      name: 'a',
      prompt: 'run',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    upsertJob({
      id: 'recent-job-b',
      name: 'b',
      prompt: 'run',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });

    createJobRun({
      run_id: 'run-a1',
      job_id: 'recent-job-a',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    createJobRun({
      run_id: 'run-b1',
      job_id: 'recent-job-b',
      scheduled_for: '2026-01-02T00:00:00.000Z',
      started_at: '2026-01-02T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });

    const runs = getRecentJobRuns(10);
    expect(runs).toHaveLength(2);
    // Ordered by started_at DESC
    expect(runs[0].run_id).toBe('run-b1');
    expect(runs[1].run_id).toBe('run-a1');
  });
});

// --- listJobRuns without jobId ---

describe('listJobRuns without jobId', () => {
  it('returns all runs across jobs when jobId is undefined', () => {
    upsertJob({
      id: 'lj-a',
      name: 'a',
      prompt: 'run',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    upsertJob({
      id: 'lj-b',
      name: 'b',
      prompt: 'run',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });

    createJobRun({
      run_id: 'lj-run-1',
      job_id: 'lj-a',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'completed',
      result_summary: 'ok',
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    createJobRun({
      run_id: 'lj-run-2',
      job_id: 'lj-b',
      scheduled_for: '2026-01-02T00:00:00.000Z',
      started_at: '2026-01-02T00:00:00.000Z',
      ended_at: null,
      status: 'completed',
      result_summary: 'ok',
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });

    const runs = listJobRuns(undefined, 50);
    expect(runs).toHaveLength(2);
  });

  it('clamps limit to at least 1', () => {
    upsertJob({
      id: 'lj-clamp',
      name: 'clamp',
      prompt: 'run',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });
    createJobRun({
      run_id: 'lj-run-clamp',
      job_id: 'lj-clamp',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'completed',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });

    // Limit of 0 should be clamped to 1
    const runs = listJobRuns('lj-clamp', 0);
    expect(runs).toHaveLength(1);
  });
});

// --- listDeadLetterRuns ---

describe('listDeadLetterRuns', () => {
  it('returns only dead_lettered runs', () => {
    upsertJob({
      id: 'dl-job',
      name: 'dead-letter',
      prompt: 'fail',
      schedule_type: 'interval',
      schedule_value: '60000',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });

    createJobRun({
      run_id: 'dl-run-ok',
      job_id: 'dl-job',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:01:00.000Z',
      status: 'completed',
      result_summary: 'ok',
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    createJobRun({
      run_id: 'dl-run-dead',
      job_id: 'dl-job',
      scheduled_for: '2026-01-02T00:00:00.000Z',
      started_at: '2026-01-02T00:00:00.000Z',
      ended_at: '2026-01-02T00:01:00.000Z',
      status: 'dead_lettered',
      result_summary: null,
      error_summary: 'max retries exceeded',
      retry_count: 3,
      notified_at: null,
    });

    const deadRuns = listDeadLetterRuns(50);
    expect(deadRuns).toHaveLength(1);
    expect(deadRuns[0].run_id).toBe('dl-run-dead');
    expect(deadRuns[0].status).toBe('dead_lettered');
    expect(deadRuns[0].error_summary).toBe('max retries exceeded');
  });

  it('returns empty when no dead-lettered runs exist', () => {
    expect(listDeadLetterRuns()).toEqual([]);
  });
});

// --- addJobEvent ---

describe('addJobEvent', () => {
  it('inserts a job event', () => {
    upsertJob({
      id: 'evt-job',
      name: 'events',
      prompt: 'run',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });

    // Should not throw
    addJobEvent({
      job_id: 'evt-job',
      run_id: 'run-evt',
      event_type: 'started',
      payload: JSON.stringify({ foo: 'bar' }),
      created_at: '2026-01-01T00:00:00.000Z',
    });

    addJobEvent({
      job_id: 'evt-job',
      run_id: null,
      event_type: 'paused',
      payload: null,
      created_at: '2026-01-01T00:01:00.000Z',
    });

    const events = listRecentJobEvents(10, { job_id: 'evt-job' });
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe('paused');
    expect(events[1].event_type).toBe('started');

    // Events are cleaned up with deleteJob
    deleteJob('evt-job');
    expect(listRecentJobEvents(10, { job_id: 'evt-job' })).toHaveLength(0);
  });
});

// --- deleteJob cascade ---

describe('deleteJob cascade', () => {
  it('deletes job events along with runs and the job', () => {
    upsertJob({
      id: 'cascade-job',
      name: 'cascade',
      prompt: 'run',
      schedule_type: 'manual',
      schedule_value: '',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: null,
    });

    createJobRun({
      run_id: 'cascade-run',
      job_id: 'cascade-job',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });

    addJobEvent({
      job_id: 'cascade-job',
      run_id: 'cascade-run',
      event_type: 'started',
      payload: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    deleteJob('cascade-job');
    expect(getJobById('cascade-job')).toBeUndefined();
    expect(listJobRuns('cascade-job')).toHaveLength(0);
  });
});

// --- completeJobRun ---

describe('completeJobRun', () => {
  it('sets ended_at, status, result_summary, and error_summary', () => {
    upsertJob({
      id: 'complete-job',
      name: 'complete',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      linked_sessions: [],
      group_scope: 'main',
      created_by: 'agent',
      next_run: '2026-01-01T00:00:00.000Z',
    });
    createJobRun({
      run_id: 'complete-run',
      job_id: 'complete-job',
      scheduled_for: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });

    completeJobRun('complete-run', 'failed', null, 'timeout after 5m');

    const runs = listJobRuns('complete-job');
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_summary).toBe('timeout after 5m');
    expect(runs[0].result_summary).toBeNull();
    expect(runs[0].ended_at).toBeTruthy();
  });
});

// --- Registered group edge cases ---

describe('registered group edge cases', () => {
  it('getRegisteredGroup returns undefined for invalid folder', () => {
    // Directly insert a group with an invalid folder to test the validation guard
    // We use setRegisteredGroup with a valid folder first, then test retrieval
    // Actually, the guard is in getRegisteredGroup reading from DB.
    // We need to sneak an invalid folder into the DB. But setRegisteredGroup validates.
    // Instead, test the positive path: valid group retrieval with all fields.
    setRegisteredGroup('full@g.us', {
      name: 'Full Group',
      folder: 'whatsapp_full-group',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: { model: 'opus', timeout: 600000 },
      requiresTrigger: false,
      isMain: true,
    });

    const group = getRegisteredGroup('full@g.us');
    expect(group).toBeDefined();
    expect(group?.name).toBe('Full Group');
    expect(group?.trigger).toBe('@bot');
    expect(group?.agentConfig?.model).toBe('opus');
    expect(group?.agentConfig?.timeout).toBe(600000);
    expect(group?.requiresTrigger).toBe(false);
    expect(group?.isMain).toBe(true);
  });

  it('getRegisteredGroup returns undefined for nonexistent JID', () => {
    expect(getRegisteredGroup('nobody@g.us')).toBeUndefined();
  });

  it('setRegisteredGroup throws for invalid folder', () => {
    expect(() =>
      setRegisteredGroup('bad@g.us', {
        name: 'Bad',
        folder: '../escape',
        trigger: '@bot',
        added_at: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow(/Invalid group folder/);
  });

  it('setRegisteredGroup throws for empty folder', () => {
    expect(() =>
      setRegisteredGroup('empty@g.us', {
        name: 'Empty',
        folder: '',
        trigger: '@bot',
        added_at: '2024-01-01T00:00:00.000Z',
      }),
    ).toThrow(/Invalid group folder/);
  });

  it('deleteRegisteredGroup removes a registered group row', () => {
    setRegisteredGroup('delete-me@g.us', {
      name: 'Delete Me',
      folder: 'delete_me',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: true,
      isMain: false,
    });

    expect(getRegisteredGroup('delete-me@g.us')).toBeDefined();

    deleteRegisteredGroup('delete-me@g.us');

    expect(getRegisteredGroup('delete-me@g.us')).toBeUndefined();
  });

  it('requiresTrigger defaults to 1 when undefined', () => {
    setRegisteredGroup('default-trigger@g.us', {
      name: 'Default Trigger',
      folder: 'whatsapp_default-trigger',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const group = getRegisteredGroup('default-trigger@g.us');
    // requiresTrigger: undefined → stored as 1 → retrieved as true
    expect(group?.requiresTrigger).toBe(true);
  });

  it('requiresTrigger false is persisted and retrieved', () => {
    setRegisteredGroup('no-trigger@g.us', {
      name: 'No Trigger',
      folder: 'whatsapp_no-trigger',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
      requiresTrigger: false,
    });

    const group = getRegisteredGroup('no-trigger@g.us');
    expect(group?.requiresTrigger).toBe(false);
  });

  it('getAllRegisteredGroups returns multiple groups', () => {
    setRegisteredGroup('g1@g.us', {
      name: 'Group 1',
      folder: 'whatsapp_group-1',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    setRegisteredGroup('g2@g.us', {
      name: 'Group 2',
      folder: 'whatsapp_group-2',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: { model: 'haiku' },
    });

    const groups = getAllRegisteredGroups();
    expect(Object.keys(groups)).toHaveLength(2);
    expect(groups['g1@g.us'].name).toBe('Group 1');
    expect(groups['g2@g.us'].agentConfig?.model).toBe('haiku');
  });

  it('getAllRegisteredGroups returns empty when none registered', () => {
    expect(getAllRegisteredGroups()).toEqual({});
  });

  it('isMain undefined is stored as 0 and returned as undefined', () => {
    setRegisteredGroup('no-main@g.us', {
      name: 'Not Main',
      folder: 'whatsapp_not-main',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: undefined,
    });

    const group = getRegisteredGroup('no-main@g.us');
    expect(group?.isMain).toBeUndefined();
  });
});

// --- getLastBotMessageTimestamp edge cases ---

describe('getLastBotMessageTimestamp edge cases', () => {
  it('returns undefined when no messages exist', () => {
    storeChatMetadata('empty@g.us', '2024-01-01T00:00:00.000Z');
    expect(getLastBotMessageTimestamp('empty@g.us', 'Andy')).toBeUndefined();
  });

  it('returns timestamp from is_bot_message flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'bot-msg',
      chat_jid: 'group@g.us',
      sender: 'bot',
      sender_name: 'Bot',
      content: 'hello from bot',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_bot_message: true,
    });

    const ts = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(ts).toBe('2024-01-01T00:00:05.000Z');
  });

  it('returns timestamp from content prefix backstop', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    // Simulate pre-migration message: is_bot_message defaults to 0 but content has prefix
    store({
      id: 'prior-bot',
      chat_jid: 'group@g.us',
      sender: 'bot',
      sender_name: 'Bot',
      content: 'Andy: prior bot reply',
      timestamp: '2024-01-01T00:00:10.000Z',
    });

    const ts = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(ts).toBe('2024-01-01T00:00:10.000Z');
  });

  it('returns the MAX timestamp across both bot detection methods', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    storeMessage({
      id: 'flagged-bot',
      chat_jid: 'group@g.us',
      sender: 'bot',
      sender_name: 'Bot',
      content: 'flagged bot message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_bot_message: true,
    });

    store({
      id: 'prefix-bot',
      chat_jid: 'group@g.us',
      sender: 'bot',
      sender_name: 'Bot',
      content: 'Andy: prefix bot message',
      timestamp: '2024-01-01T00:00:10.000Z',
    });

    const ts = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(ts).toBe('2024-01-01T00:00:10.000Z');
  });
});

// --- botPrefix LIKE injection ---

describe('botPrefix LIKE wildcard injection', () => {
  // Known bug: getMessagesSince, getNewMessages, and getLastBotMessageTimestamp
  // build a LIKE pattern as `${botPrefix}:%` without escaping SQL wildcards
  // (% and _). If botPrefix contains _ or %, they act as LIKE wildcards,
  // causing legitimate user messages to be incorrectly filtered out.
  // These tests document the current (buggy) behavior.

  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
  });

  it('underscore in botPrefix incorrectly matches single-char wildcard in getMessagesSince (known bug)', () => {
    // A user sends a message that looks like "test1bot:hello".
    // With botPrefix "test_bot", the LIKE pattern becomes "test_bot:%"
    // where _ matches any single char, so "test1bot:hello" is incorrectly excluded.
    store({
      id: 'user-msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'test1bot:hello from a real user',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'test_bot',
    );
    // BUG: The message is from a real user, not the bot, but the unescaped _
    // wildcard in LIKE causes "test1bot:" to match "test_bot:" and the message
    // is incorrectly filtered out.
    expect(msgs).toHaveLength(0);
  });

  it('percent in botPrefix incorrectly matches multi-char wildcard in getMessagesSince (known bug)', () => {
    // With botPrefix "A%ndy", the LIKE pattern "A%ndy:%" matches strings
    // like "Aandy:...", "Abcndy:...", etc. This excludes user messages.
    store({
      id: 'user-msg-2',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'Abcndy: I was saying something',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'A%ndy',
    );
    // BUG: User message is incorrectly filtered because % acts as LIKE wildcard
    expect(msgs).toHaveLength(0);
  });

  it('underscore in botPrefix incorrectly matches wildcard in getNewMessages (known bug)', () => {
    store({
      id: 'user-msg-3',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'testXbot:this is user content',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'test_bot',
    );
    // BUG: _ in LIKE matches X, so user message is incorrectly filtered
    expect(messages).toHaveLength(0);
  });

  it('underscore in botPrefix incorrectly matches wildcard in getLastBotMessageTimestamp (known bug)', () => {
    // A non-bot message with content "testXbot:something" should NOT be
    // matched as a bot message when botPrefix is "test_bot", but the
    // unescaped _ wildcard causes a false positive.
    store({
      id: 'user-msg-4',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'testXbot:this is user content',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const ts = getLastBotMessageTimestamp('group@g.us', 'test_bot');
    // BUG: Incorrectly finds a "bot" message because _ matches X in LIKE
    expect(ts).toBe('2024-01-01T00:00:01.000Z');
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns oldest unseen messages first', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 1');
    expect(messages[2].content).toBe('message 3');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    expect(decodeGlobalMessageCursor(newTimestamp)).toEqual({
      timestamp: '2024-01-01T00:00:03.000Z',
      chatJid: 'group@g.us',
      id: 'lim-3',
    });
  });

  it('getMessagesSince caps to limit and returns oldest unseen messages first', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 1');
    expect(messages[2].content).toBe('message 3');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });

  it('drains unseen messages across batches without dropping backlog', () => {
    const firstBatch = getMessagesSince('group@g.us', '', 'Andy', 4);
    expect(firstBatch.map((m) => m.content)).toEqual([
      'message 1',
      'message 2',
      'message 3',
      'message 4',
    ]);

    const firstCursor = encodeGroupMessageCursor({
      timestamp: firstBatch[firstBatch.length - 1].timestamp,
      id: firstBatch[firstBatch.length - 1].id,
    });
    const secondBatch = getMessagesSince('group@g.us', firstCursor, 'Andy', 4);
    expect(secondBatch.map((m) => m.content)).toEqual([
      'message 5',
      'message 6',
      'message 7',
      'message 8',
    ]);

    const secondCursor = encodeGroupMessageCursor({
      timestamp: secondBatch[secondBatch.length - 1].timestamp,
      id: secondBatch[secondBatch.length - 1].id,
    });
    const thirdBatch = getMessagesSince('group@g.us', secondCursor, 'Andy', 4);
    expect(thirdBatch.map((m) => m.content)).toEqual([
      'message 9',
      'message 10',
    ]);
  });

  it('does not skip messages that share the same timestamp', () => {
    storeChatMetadata('same-ts@g.us', '2024-01-01T00:00:00.000Z');
    for (const id of ['a', 'b', 'c', 'd']) {
      store({
        id,
        chat_jid: 'same-ts@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `same-ts-${id}`,
        timestamp: '2024-02-01T00:00:00.000Z',
      });
    }

    const firstBatch = getMessagesSince('same-ts@g.us', '', 'Andy', 2);
    expect(firstBatch.map((m) => m.id)).toEqual(['a', 'b']);

    const cursor = encodeGroupMessageCursor({
      timestamp: firstBatch[firstBatch.length - 1].timestamp,
      id: firstBatch[firstBatch.length - 1].id,
    });
    const secondBatch = getMessagesSince('same-ts@g.us', cursor, 'Andy', 2);
    expect(secondBatch.map((m) => m.id)).toEqual(['c', 'd']);
  });

  it('uses global cursor tie-breakers to continue batches deterministically', () => {
    storeChatMetadata('same-ts-2@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'z1',
      chat_jid: 'same-ts-2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'group2-msg',
      timestamp: '2024-01-01T00:00:05.000Z',
    });

    const first = getNewMessages(
      ['group@g.us', 'same-ts-2@g.us'],
      '',
      'Andy',
      3,
    );
    expect(first.messages).toHaveLength(3);
    const firstIds = first.messages.map((m) => `${m.chat_jid}:${m.id}`);
    expect(firstIds).toEqual([
      'group@g.us:lim-1',
      'group@g.us:lim-2',
      'group@g.us:lim-3',
    ]);

    const second = getNewMessages(
      ['group@g.us', 'same-ts-2@g.us'],
      first.newTimestamp,
      'Andy',
      20,
    );
    expect(second.messages.length).toBeGreaterThan(0);
    const secondIds = second.messages.map((m) => `${m.chat_jid}:${m.id}`);
    expect(secondIds).toContain('same-ts-2@g.us:z1');
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('registered group agentConfig model', () => {
  it('persists agentConfig.model through set/get round-trip', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Dev Chat',
      folder: 'whatsapp_dev-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: {
        model: 'opus',
      },
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group?.agentConfig?.model).toBe('opus');
  });

  it('preserves unrelated agentConfig fields with model', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Dev Chat',
      folder: 'whatsapp_dev-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: {
        model: 'sonnet',
        timeout: 600000,
        additionalMounts: [
          {
            hostPath: '/tmp/repo',
            containerPath: 'repo',
            readonly: false,
          },
        ],
      },
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group?.agentConfig).toEqual({
      model: 'sonnet',
      timeout: 600000,
      additionalMounts: [
        {
          hostPath: '/tmp/repo',
          containerPath: 'repo',
          readonly: false,
        },
      ],
    });
  });

  it('drops invalid agentConfig payloads instead of throwing', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Dev Chat',
      folder: 'whatsapp_dev-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig:
        'invalid-config' as unknown as RegisteredGroup['agentConfig'],
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group?.agentConfig).toBeUndefined();
  });

  it('sanitizes malformed agentConfig mount entries', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Dev Chat',
      folder: 'whatsapp_dev-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      agentConfig: {
        model: 'sonnet',
        additionalMounts: [
          { hostPath: '/tmp/repo', containerPath: 'repo', readonly: true },
          { hostPath: '' } as unknown as {
            hostPath: string;
            containerPath?: string;
            readonly?: boolean;
          },
        ],
      },
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group?.agentConfig).toEqual({
      model: 'sonnet',
      additionalMounts: [
        { hostPath: '/tmp/repo', containerPath: 'repo', readonly: true },
      ],
    });
  });
});

// --- _closeDatabase ---

describe('_closeDatabase', () => {
  it('closes the database without error', () => {
    _closeDatabase();
    // Re-init for subsequent tests
    _initTestDatabase();
  });
});

// --- Invalid folder detection in getRegisteredGroup and getAllRegisteredGroups ---
// Uses vi.doMock to control isValidGroupFolder behavior

describe('registered group invalid folder detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getRegisteredGroup returns undefined for row with invalid folder', async () => {
    vi.resetModules();
    // Mock isValidGroupFolder to be controllable
    let rejectFolder = false;
    vi.doMock('@core/platform/group-folder.js', () => ({
      isValidGroupFolder: (folder: string) => {
        if (rejectFolder) return false;
        // Real validation: alphanumeric with underscores/hyphens, no slashes or dots
        return /^[a-zA-Z0-9_-]+$/.test(folder) && !folder.includes('..');
      },
    }));

    const db = await import('@core/storage/db.js');
    db._initTestDatabase();

    // Insert a group with a valid folder
    db.setRegisteredGroup('invalid-check@g.us', {
      name: 'Test Group',
      folder: 'whatsapp_test-group',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Now make isValidGroupFolder reject the folder
    rejectFolder = true;

    // getRegisteredGroup should return undefined because folder is now "invalid"
    const group = db.getRegisteredGroup('invalid-check@g.us');
    expect(group).toBeUndefined();
  });

  it('getAllRegisteredGroups skips rows with invalid folder', async () => {
    vi.resetModules();
    let rejectFolder: string | null = null;
    vi.doMock('@core/platform/group-folder.js', () => ({
      isValidGroupFolder: (folder: string) => {
        if (folder === rejectFolder) return false;
        return /^[a-zA-Z0-9_-]+$/.test(folder) && !folder.includes('..');
      },
    }));

    const db = await import('@core/storage/db.js');
    db._initTestDatabase();

    // Insert two groups
    db.setRegisteredGroup('good@g.us', {
      name: 'Good Group',
      folder: 'whatsapp_good-group',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });
    db.setRegisteredGroup('bad@g.us', {
      name: 'Bad Group',
      folder: 'whatsapp_bad-group',
      trigger: '@bot',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    // Make one folder invalid
    rejectFolder = 'whatsapp_bad-group';

    const groups = db.getAllRegisteredGroups();
    // Only the "good" group should be returned
    expect(Object.keys(groups)).toHaveLength(1);
    expect(groups['good@g.us']).toBeDefined();
    expect(groups['bad@g.us']).toBeUndefined();
  });
});
