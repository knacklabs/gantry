import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { signIpcRequestPayload } from '@core/infrastructure/ipc/request-signing.js';
import {
  computeBrowserIpcAuthToken,
  computeIpcAuthToken,
  computeMemoryIpcAuthToken,
  createIpcAuthEnvelope,
  getIpcResponseSigningPrivateKey,
  revokeIpcResponseSigningKey,
} from '@core/runtime/ipc-auth.js';
import {
  signIpcResponsePayload,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { stopIpcWatcher, validateIpcAuthRequest } from '@core/runtime/ipc.js';
import {
  parseBrowserIpcRequest,
  parseMemoryIpcRequest,
  parsePermissionIpcRequest,
} from '@core/runtime/ipc-parsing.js';
import { parseTaskIpcData } from '@core/runtime/ipc-task-parsing.js';

const TEST_RESPONSE_KEY_ID = 'test-response-key';

function signedPayload(
  payload: Record<string, unknown>,
  sourceAgentFolder = 'team',
  threadId?: string,
): Record<string, unknown> {
  const context =
    payload.context &&
    typeof payload.context === 'object' &&
    !Array.isArray(payload.context)
      ? (payload.context as Record<string, unknown>)
      : {};
  const signingKey = computeIpcAuthToken(sourceAgentFolder, threadId, {
    appId:
      typeof context.appId === 'string'
        ? context.appId
        : typeof payload.appId === 'string'
          ? payload.appId
          : undefined,
    agentId:
      typeof context.agentId === 'string'
        ? context.agentId
        : typeof payload.agentId === 'string'
          ? payload.agentId
          : undefined,
  });
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
    chatJid?: string;
    userId?: string;
    defaultScope?: 'user' | 'group';
    threadId?: string;
    allowedActions?: readonly string[];
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

  it('keeps authenticated thread context when scheduler payload uses executionContext thread routing', () => {
    const payload = {
      requestId: 'perm-clear-thread',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_update_job',
      jobId: 'job-1',
      context: { threadId: 'thread-1', responseKeyId: TEST_RESPONSE_KEY_ID },
      executionContext: {
        conversationJid: 'tg:team',
        threadId: null,
        groupScope: 'team',
      },
    };

    const result = validateIpcAuthRequest(
      signedPayload(payload, 'team', 'thread-1'),
      'team',
      'permission IPC',
    );

    expect(result).toEqual({
      authThreadId: 'thread-1',
      responseKeyId: TEST_RESPONSE_KEY_ID,
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
      executionContext: {
        conversationJid: 'tg:team',
        threadId: null,
        groupScope: 'team',
      },
      modelAlias: null,
      modelProfileId: null,
    });
  });

  it('rejects non-canonical scheduler job routing fields at task parsing boundary', () => {
    const basePayload = {
      requestId: 'task-non-canonical-job-fields',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_upsert_job',
      context: { threadId: 'thread-1', responseKeyId: TEST_RESPONSE_KEY_ID },
      name: 'Job',
      prompt: 'Run it',
      scheduleType: 'interval',
      scheduleValue: '60000',
      executionContext: {
        conversationJid: 'tg:team',
        threadId: 'thread-1',
        groupScope: 'team',
      },
      notificationRoutes: [
        {
          conversationJid: 'tg:team',
          threadId: 'thread-1',
          label: 'primary',
        },
      ],
    };

    const assertRejected = (extra: Record<string, unknown>) => {
      const requestId = `task-non-canonical-job-fields-${Math.random().toString(36).slice(2)}`;
      expect(() =>
        parseTaskIpcData(
          signedPayload(
            {
              ...basePayload,
              requestId,
              nonce: randomUUID(),
              ...extra,
            },
            'team',
            'thread-1',
          ),
          'team',
        ),
      ).toThrow(/Unsupported (scheduler job fields|IPC task fields)/);
    };

    assertRejected({ linked_sessions: ['tg:team'] });
    assertRejected({ linkedSessions: ['tg:team'] });
    assertRejected({ deliver_to: ['tg:team'] });
    assertRejected({ deliverTo: ['tg:team'] });
    assertRejected({ notificationTarget: { linkedSessions: ['tg:team'] } });
    assertRejected({ thread_id: 'thread-1' });
    assertRejected({ threadId: 'thread-1' });
    assertRejected({ session_id: 'session-1' });
    assertRejected({ sessionId: 'session-1' });
    assertRejected({ group_scope: 'team' });
    assertRejected({ groupScope: 'team' });
  });

  it('preserves scheduler job allowedTools creates, replaces, and clears', () => {
    const createPayload = signedPayload({
      requestId: 'task-allowed-tools-create',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_upsert_job',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
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
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
      jobId: 'job-1',
      allowedTools: ['Read', 'mcp__agent_browser__*'],
    });
    const clearPayload = signedPayload({
      requestId: 'task-allowed-tools-clear',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_update_job',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
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
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const payload = {
      requestId: 'browser-1',
      nonce: randomUUID(),
      expiresAt,
      action: 'browser_status',
      payload: { profile_name: 'c-team-abc123abc123' },
      context: { chatJid: 'tg:team', responseKeyId: TEST_RESPONSE_KEY_ID },
    };

    expect(
      parseBrowserIpcRequest(signedBrowserPayload(payload), 'team'),
    ).toMatchObject({
      requestId: 'browser-1',
      chatJid: 'tg:team',
      action: 'browser_status',
      deadlineAtMs: Date.parse(expiresAt),
    });
    expect(() =>
      parseBrowserIpcRequest(signedPayload(payload), 'team'),
    ).toThrow(/Invalid browser IPC signature/);
  });

  it('requires memory IPC signatures to match trusted user scope', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const payload = {
      requestId: 'mem-1',
      nonce: randomUUID(),
      expiresAt,
      action: 'memory_search',
      payload: { query: 'travel' },
      context: {
        userId: 'u-1',
        defaultScope: 'user',
        allowedActions: ['memory_search'],
        responseKeyId: TEST_RESPONSE_KEY_ID,
      },
    };

    expect(
      parseMemoryIpcRequest(
        signedMemoryPayload(payload, 'team', {
          userId: 'u-1',
          defaultScope: 'user',
          allowedActions: ['memory_search'],
        }),
        'team',
      ),
    ).toMatchObject({
      requestId: 'mem-1',
      context: { userId: 'u-1', defaultScope: 'user' },
      allowedActions: ['memory_search'],
      deadlineAtMs: Date.parse(expiresAt),
    });
    expect(() => parseMemoryIpcRequest(signedPayload(payload), 'team')).toThrow(
      /Invalid memory IPC signature/,
    );
    expect(() =>
      parseMemoryIpcRequest(
        signedMemoryPayload(payload, 'team', {
          userId: 'u-2',
          defaultScope: 'user',
          allowedActions: ['memory_search'],
        }),
        'team',
      ),
    ).toThrow(/Invalid memory IPC signature/);
  });

  it('rejects memory IPC actions outside the host-signed action allowlist', () => {
    const payload = {
      requestId: 'mem-denied-action',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: 'memory_patch',
      payload: { id: 'mem-1', expected_version: 1 },
      context: {
        chatJid: 'tg:team',
        defaultScope: 'group',
        allowedActions: ['memory_search', 'memory_save'],
        responseKeyId: TEST_RESPONSE_KEY_ID,
      },
    };

    expect(() =>
      parseMemoryIpcRequest(
        signedMemoryPayload(payload, 'team', {
          chatJid: 'tg:team',
          defaultScope: 'group',
          allowedActions: ['memory_search', 'memory_save'],
        }),
        'team',
      ),
    ).toThrow(/Memory IPC action is not allowed: memory_patch/);
    expect(() =>
      parseMemoryIpcRequest(
        signedMemoryPayload(
          {
            ...payload,
            context: {
              ...(payload.context as Record<string, unknown>),
              allowedActions: ['memory_search', 'memory_save', 'memory_patch'],
            },
          },
          'team',
          {
            chatJid: 'tg:team',
            defaultScope: 'group',
            allowedActions: ['memory_search', 'memory_save'],
          },
        ),
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
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
      agentConfig: { model: 'kimi 2.6' },
    });

    expect(parseTaskIpcData(payload, 'team')).toMatchObject({
      type: 'register_agent',
      agentConfig: { model: 'kimi' },
    });
  });

  it('rejects response-bearing IPC requests that omit the run response key id', () => {
    const payload = signedPayload({
      requestId: 'task-missing-response-key',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_list_jobs',
      taskId: 'task-1',
    });

    expect(() => parseTaskIpcData(payload, 'team')).toThrow(
      /responseKeyId is required/,
    );
  });

  it('keeps delayed task responses bound to the run response key that requested them', () => {
    const firstRun = createIpcAuthEnvelope('team', 'thread-1');
    const firstPayload = {
      requestId: 'task-run-1',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_wait_for_events',
      taskId: 'wait-1',
      context: {
        threadId: 'thread-1',
        responseKeyId: firstRun.responseKeyId,
      },
    };
    const parsed = parseTaskIpcData(
      {
        ...firstPayload,
        signature: signIpcRequestPayload(firstRun.authToken, firstPayload),
      },
      'team',
    );

    const secondRun = createIpcAuthEnvelope('team', 'thread-1');
    expect(secondRun.responseKeyId).not.toBe(firstRun.responseKeyId);

    const privateKey = getIpcResponseSigningPrivateKey(
      'team',
      parsed.authThreadId,
      parsed.responseKeyId,
    );
    expect(privateKey).toBeTruthy();

    const responsePayload = {
      taskId: 'wait-1',
      ok: true,
      message: 'Listed 0 scheduler event(s).',
      timestamp: '2026-05-07T14:58:39.000Z',
    };
    const signature = signIpcResponsePayload(privateKey, responsePayload);

    expect(
      verifyIpcResponsePayload(
        firstRun.responseVerifyKey,
        responsePayload,
        signature,
      ),
    ).toBe(true);
    expect(
      verifyIpcResponsePayload(
        secondRun.responseVerifyKey,
        responsePayload,
        signature,
      ),
    ).toBe(false);
  });

  it('revokes response signing keys only for the matching run scope', () => {
    const run = createIpcAuthEnvelope('team', 'thread-1');

    expect(
      getIpcResponseSigningPrivateKey('team', 'thread-1', run.responseKeyId),
    ).toBeTruthy();
    expect(
      revokeIpcResponseSigningKey(run.responseKeyId, 'team', 'other-thread'),
    ).toBe(false);
    expect(
      revokeIpcResponseSigningKey(run.responseKeyId, 'team', 'thread-1'),
    ).toBe(true);
    expect(
      getIpcResponseSigningPrivateKey('team', 'thread-1', run.responseKeyId),
    ).toBeUndefined();
  });

  it('rejects raw provider IDs in IPC agentConfig model overrides', () => {
    const payload = signedPayload({
      requestId: 'task-agent-config-raw-model',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'register_agent',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
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

  it('requires signed app scope for permission IPC payloads', () => {
    const base = {
      requestId: 'perm-app-scope',
      responseNonce: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceAgentFolder: 'team',
      toolName: 'Bash',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
    };

    expect(() =>
      parsePermissionIpcRequest(signedPayload(base), 'team'),
    ).toThrow(/context\.appId is required/);

    const scoped = {
      ...base,
      requestId: 'perm-app-scope-mismatch',
      appId: 'app:one',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID, appId: 'app:two' },
    };
    expect(() =>
      parsePermissionIpcRequest(signedPayload(scoped), 'team'),
    ).toThrow(/appId mismatch/);
  });

  it('rejects permission IPC app scope tampering after signing', () => {
    const payload = {
      requestId: 'perm-app-signed',
      responseNonce: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceAgentFolder: 'team',
      toolName: 'Bash',
      context: {
        responseKeyId: TEST_RESPONSE_KEY_ID,
        appId: 'app:one',
        agentId: 'agent:one',
      },
    };
    const signed = signedPayload(payload);

    expect(() =>
      parsePermissionIpcRequest(
        {
          ...signed,
          context: {
            responseKeyId: TEST_RESPONSE_KEY_ID,
            appId: 'app:two',
            agentId: 'agent:one',
          },
        },
        'team',
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
