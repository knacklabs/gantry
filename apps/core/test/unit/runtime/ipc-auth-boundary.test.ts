import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { signIpcRequestPayload } from '@core/infrastructure/ipc/request-signing.js';
import {
  computeBrowserIpcAuthToken,
  computeIpcAuthToken,
  computeMemoryIpcAuthToken,
} from '@core/runtime/ipc-auth.js';
import { stopIpcWatcher, validateIpcAuthRequest } from '@core/runtime/ipc.js';
import {
  parseBrowserIpcRequest,
  parseMemoryIpcRequest,
} from '@core/runtime/ipc-parsing.js';
import { parseTaskIpcData } from '@core/runtime/ipc-task-parsing.js';

function signedPayload(
  payload: Record<string, unknown>,
  sourceAgentFolder = 'team',
  threadId?: string,
): Record<string, unknown> {
  const signingKey = computeIpcAuthToken(sourceAgentFolder, threadId);
  return {
    ...payload,
    signature: signIpcRequestPayload(signingKey, payload),
  };
}

function signedBrowserPayload(
  payload: Record<string, unknown>,
  sourceAgentFolder = 'team',
  chatJid = 'tg:team',
  threadId?: string,
): Record<string, unknown> {
  const signingKey = computeBrowserIpcAuthToken(
    sourceAgentFolder,
    chatJid,
    threadId,
  );
  return {
    ...payload,
    signature: signIpcRequestPayload(signingKey, payload),
  };
}

function signedMemoryPayload(
  payload: Record<string, unknown>,
  sourceAgentFolder = 'team',
  input: {
    userId?: string;
    defaultScope?: 'user' | 'group';
    threadId?: string;
  } = {},
): Record<string, unknown> {
  const signingKey = computeMemoryIpcAuthToken(sourceAgentFolder, input);
  return {
    ...payload,
    signature: signIpcRequestPayload(signingKey, payload),
  };
}

describe('validateIpcAuthRequest', () => {
  afterEach(() => {
    stopIpcWatcher();
  });

  it('accepts a signed fresh request and returns the trusted thread binding', () => {
    const payload = {
      requestId: 'perm-1',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      context: { threadId: 'thread-1' },
      threadId: 'thread-1',
    };

    const result = validateIpcAuthRequest(
      signedPayload(payload, 'team', 'thread-1'),
      'team',
      'permission IPC',
    );

    expect(result).toEqual({
      authThreadId: 'thread-1',
      payloadThreadId: 'thread-1',
    });
  });

  it('keeps authenticated thread context when a task payload clears threadId', () => {
    const payload = {
      requestId: 'perm-clear-thread',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_update_job',
      jobId: 'job-1',
      context: { threadId: 'thread-1' },
      threadId: null,
    };

    const result = validateIpcAuthRequest(
      signedPayload(payload, 'team', 'thread-1'),
      'team',
      'permission IPC',
    );

    expect(result).toEqual({
      authThreadId: 'thread-1',
      payloadThreadId: null,
    });
    expect(
      parseTaskIpcData(
        signedPayload(
          {
            ...payload,
            requestId: 'task-clear-thread',
            modelAlias: null,
            modelProfileId: null,
          },
          'team',
          'thread-1',
        ),
        'team',
      ),
    ).toMatchObject({
      type: 'scheduler_update_job',
      jobId: 'job-1',
      authThreadId: 'thread-1',
      threadId: null,
      modelAlias: null,
      modelProfileId: null,
    });
  });

  it('preserves scheduler job allowedTools creates, replaces, and clears', () => {
    const createPayload = signedPayload({
      requestId: 'task-allowed-tools-create',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_upsert_job',
      name: 'Job',
      prompt: 'Run',
      scheduleType: 'interval',
      scheduleValue: '60000',
      allowedTools: ['Read'],
    });
    const replacePayload = signedPayload({
      requestId: 'task-allowed-tools-replace',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_update_job',
      jobId: 'job-1',
      allowedTools: ['Read', 'mcp__agent_browser__*'],
    });
    const clearPayload = signedPayload({
      requestId: 'task-allowed-tools-clear',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_update_job',
      jobId: 'job-1',
      allowedTools: [],
    });

    expect(parseTaskIpcData(createPayload, 'team')).toMatchObject({
      type: 'scheduler_upsert_job',
      allowedTools: ['Read'],
    });
    expect(parseTaskIpcData(replacePayload, 'team')).toMatchObject({
      type: 'scheduler_update_job',
      jobId: 'job-1',
      allowedTools: ['Read', 'mcp__agent_browser__*'],
    });
    expect(parseTaskIpcData(clearPayload, 'team')).toMatchObject({
      type: 'scheduler_update_job',
      jobId: 'job-1',
      allowedTools: [],
    });
  });

  it('requires browser IPC signatures to match the chat-scoped token', () => {
    const payload = {
      requestId: 'browser-1',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: 'browser_status',
      payload: { profile_name: 'c-team-abc123abc123' },
      context: { chatJid: 'tg:team' },
    };

    expect(
      parseBrowserIpcRequest(signedBrowserPayload(payload), 'team'),
    ).toMatchObject({
      requestId: 'browser-1',
      chatJid: 'tg:team',
      action: 'browser_status',
    });
    expect(() =>
      parseBrowserIpcRequest(signedPayload(payload), 'team'),
    ).toThrow(/Invalid browser IPC signature/);
  });

  it('requires memory IPC signatures to match trusted user scope', () => {
    const payload = {
      requestId: 'mem-1',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: 'memory_search',
      payload: { query: 'travel' },
      context: { userId: 'u-1', defaultScope: 'user' },
    };

    expect(
      parseMemoryIpcRequest(
        signedMemoryPayload(payload, 'team', {
          userId: 'u-1',
          defaultScope: 'user',
        }),
        'team',
      ),
    ).toMatchObject({
      requestId: 'mem-1',
      context: { userId: 'u-1', defaultScope: 'user' },
    });
    expect(() => parseMemoryIpcRequest(signedPayload(payload), 'team')).toThrow(
      /Invalid memory IPC signature/,
    );
    expect(() =>
      parseMemoryIpcRequest(
        signedMemoryPayload(payload, 'team', {
          userId: 'u-2',
          defaultScope: 'user',
        }),
        'team',
      ),
    ).toThrow(/Invalid memory IPC signature/);
  });

  it('normalizes IPC agentConfig model overrides to catalog aliases', () => {
    const payload = signedPayload({
      requestId: 'task-agent-config-model',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'register_agent',
      agentConfig: { model: 'kimi 2.6' },
    });

    expect(parseTaskIpcData(payload, 'team')).toMatchObject({
      type: 'register_agent',
      agentConfig: { model: 'kimi' },
    });
  });

  it('rejects raw provider IDs in IPC agentConfig model overrides', () => {
    const payload = signedPayload({
      requestId: 'task-agent-config-raw-model',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'register_agent',
      agentConfig: { model: 'moonshotai/kimi-k2.6' },
    });

    expect(() => parseTaskIpcData(payload, 'team')).toThrow(
      /Invalid agentConfig\.model: Provider model ID/,
    );
  });

  it('rejects unsigned or tampered requests at the host boundary', () => {
    const payload = {
      requestId: 'perm-2',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    expect(() =>
      validateIpcAuthRequest(payload, 'team', 'permission IPC'),
    ).toThrow(/Invalid permission IPC signature/);

    const signed = signedPayload(payload);
    expect(() =>
      validateIpcAuthRequest(
        { ...signed, requestId: 'perm-2-tampered' },
        'team',
        'permission IPC',
      ),
    ).toThrow(/Invalid permission IPC signature/);
  });

  it('rejects expired requests and replayed request ids', () => {
    const expired = {
      requestId: 'perm-3',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    };

    expect(() =>
      validateIpcAuthRequest(signedPayload(expired), 'team', 'permission IPC'),
    ).toThrow(/expired request/);

    const fresh = {
      requestId: 'perm-4',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const signed = signedPayload(fresh);
    expect(() =>
      validateIpcAuthRequest(signed, 'team', 'permission IPC'),
    ).not.toThrow();
    expect(() =>
      validateIpcAuthRequest(signed, 'team', 'permission IPC'),
    ).toThrow(/replay/);
  });
});
