import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import {
  stopIpcWatcher,
  validateIpcAuthRequest,
  validatePermissionIpcJobExecutionTarget,
  validateUserQuestionIpcJobExecutionTarget,
} from '@core/runtime/ipc.js';
import {
  parseBrowserIpcRequest,
  parseIpcMessage,
  parseMemoryIpcRequest,
  parsePermissionIpcRequest,
  parseRichInteractionIpcRequest,
  parseUserQuestionIpcRequest,
} from '@core/runtime/ipc-parsing.js';
import { parseTaskIpcData } from '@core/runtime/ipc-task-parsing.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import {
  appendOwnedFileArtifactDegradeText,
  resolveOwnedFileArtifactMessage,
} from '@core/runtime/ipc-message-files.js';

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
    clearConsumedIpcRequestIds({ durable: 'consumed' });
    stopIpcWatcher();
  });

  it('accepts signed rich interaction IPC with required fallback text', () => {
    const payload = {
      requestId: 'rich-1',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      targetJid: 'tg:team',
      context: { threadId: 'thread-1', appId: 'app-1', agentId: 'agent-1' },
      interaction: {
        id: 'brief',
        title: 'Brief',
        fallbackText: 'Status: ready',
        rich: {
          kind: 'status',
          payload: { state: 'ready' },
        },
      },
    };

    expect(
      parseRichInteractionIpcRequest(
        signedPayload(payload, 'team', 'thread-1'),
        'team',
      ),
    ).toMatchObject({
      requestId: 'rich-1',
      appId: 'app-1',
      agentId: 'agent-1',
      targetJid: 'tg:team',
      threadId: 'thread-1',
      descriptor: {
        rich: {
          kind: 'status',
          fallbackText: 'Status: ready',
          payload: { state: 'ready' },
        },
      },
    });
  });

  it('rejects unsigned or malformed rich interaction IPC', () => {
    const payload = {
      requestId: 'rich-bad',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      interaction: {
        id: 'brief',
        title: 'Brief',
        rich: {
          kind: 'unknown',
          payload: {},
        },
      },
    };

    expect(() => parseRichInteractionIpcRequest(payload, 'team')).toThrow(
      /signature/i,
    );
    expect(() =>
      parseRichInteractionIpcRequest(signedPayload(payload), 'team'),
    ).toThrow('Invalid rich interaction kind');
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
        workspaceKey: 'team',
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
        workspaceKey: 'team',
      },
      modelAlias: null,
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
        workspaceKey: 'team',
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
      ).toThrow(
        /Unsupported (scheduler job fields|scheduler job field|IPC task fields|IPC task field)/,
      );
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
    const assertRejectedWith = (
      extra: Record<string, unknown>,
      message: string,
    ) => {
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
      ).toThrow(message);
    };
    assertRejectedWith(
      { group_scope: 'team' },
      'group_scope is no longer accepted. Use workspace_key.',
    );
    assertRejectedWith(
      { groupScope: 'team' },
      'groupScope is no longer accepted. Use workspaceKey.',
    );
    assertRejected({ required_mcp_servers: ['mcp:legacy'] });
    assertRejected({ required_tools: ['Browser'] });
    assertRejected({
      capability_requirements: [
        { capabilityId: 'acme.records.append', reason: 'required' },
      ],
    });
  });

  it('rejects deprecated scheduler requiredTools at task parsing boundary', () => {
    const payload = signedPayload(
      {
        requestId: 'task-required-tools-cutover',
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
          workspaceKey: 'team',
        },
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: 'thread-1',
            label: 'primary',
          },
        ],
        requiredTools: ['Browser'],
      },
      'team',
      'thread-1',
    );

    expect(() => parseTaskIpcData(payload, 'team')).toThrow(
      /requiredTools.*Use accessRequirements/,
    );
  });

  it('rejects scheduler job allowedTools because jobs inherit agent capabilities', () => {
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
      allowedTools: ['Read', 'mcp__browser' + '_' + 'backend' + '__*'],
    });

    expect(() => parseTaskIpcData(createPayload, 'team')).toThrow(
      /Unsupported scheduler job fields: allowedTools/,
    );
    expect(() => parseTaskIpcData(replacePayload, 'team')).toThrow(
      /Unsupported scheduler job fields: allowedTools/,
    );
  });

  it('preserves scheduler required MCP server assertions at the IPC boundary', () => {
    const payload = signedPayload({
      requestId: 'task-required-mcp-servers',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_upsert_job',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
      name: 'Job',
      prompt: 'Run',
      scheduleType: 'interval',
      scheduleValue: '60000',
      accessRequirements: [
        { target: { kind: 'tool_rule', rule: 'Browser' } },
        { target: { kind: 'mcp_server', server: 'mcp:company-crm' } },
      ],
    });

    expect(parseTaskIpcData(payload, 'team')).toMatchObject({
      type: 'scheduler_upsert_job',
      accessRequirements: [
        { target: { kind: 'tool_rule', rule: 'Browser' } },
        { target: { kind: 'mcp_server', server: 'mcp:company-crm' } },
      ],
    });
  });

  it('preserves scheduler capability requirements at the IPC boundary', () => {
    const payload = signedPayload({
      requestId: 'task-capability-requirements',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_upsert_job',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
      name: 'Job',
      prompt: 'Run',
      scheduleType: 'interval',
      scheduleValue: '60000',
      accessRequirements: [
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'Sheets CLI',
              executablePath: '/usr/local/bin/sheet-write',
              executableVersion: 'v0.9.0',
              executableHash: 'sha256:abc123',
              commandTemplate: '/usr/local/bin/sheet-write append *',
              protectedPaths: ['/tmp'],
              networkHosts: ['sheets.example.test'],
            },
          },
          reason: 'Need spreadsheet',
        },
      ],
    });

    expect(parseTaskIpcData(payload, 'team')).toMatchObject({
      type: 'scheduler_upsert_job',
      accessRequirements: [
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'Sheets CLI',
              executablePath: '/usr/local/bin/sheet-write',
              executableVersion: 'v0.9.0',
              executableHash: 'sha256:abc123',
              commandTemplate: '/usr/local/bin/sheet-write append *',
              protectedPaths: ['/tmp'],
              networkHosts: ['sheets.example.test'],
            },
          },
          reason: 'Need spreadsheet',
        },
      ],
    });
  });

  it('rejects malformed scheduler accessRequirements at the IPC boundary', () => {
    const basePayload = {
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'scheduler_upsert_job',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
      name: 'Job',
      prompt: 'Run',
      scheduleType: 'interval',
      scheduleValue: '60000',
    };

    expect(() =>
      parseTaskIpcData(
        signedPayload({
          ...basePayload,
          requestId: 'task-access-non-array',
          accessRequirements: {
            target: { kind: 'tool_rule', rule: 'Browser' },
          },
        }),
        'team',
      ),
    ).toThrow(/accessRequirements must be an array/);

    expect(() =>
      parseTaskIpcData(
        signedPayload({
          ...basePayload,
          requestId: 'task-access-missing-target',
          accessRequirements: [{}],
        }),
        'team',
      ),
    ).toThrow(/accessRequirements entries require a target object/);

    expect(() =>
      parseTaskIpcData(
        signedPayload({
          ...basePayload,
          requestId: 'task-access-invalid-kind',
          accessRequirements: [
            { target: { kind: 'raw_tool', rule: 'Browser' } },
          ],
        }),
        'team',
      ),
    ).toThrow(
      /accessRequirements target\.kind must be tool_rule, capability, or mcp_server/,
    );
  });

  it('requires browser IPC signatures to match the chat-scoped token', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const payload = {
      requestId: 'browser-1',
      nonce: randomUUID(),
      expiresAt,
      action: 'status',
      payload: { profile_name: 'c-team-abc123abc123' },
      context: { chatJid: 'tg:team', responseKeyId: TEST_RESPONSE_KEY_ID },
    };

    expect(
      parseBrowserIpcRequest(signedBrowserPayload(payload), 'team'),
    ).toMatchObject({
      requestId: 'browser-1',
      chatJid: 'tg:team',
      action: 'status',
      deadlineAtMs: Date.parse(expiresAt),
    });
    expect(() =>
      parseBrowserIpcRequest(signedPayload(payload), 'team'),
    ).toThrow(/Invalid browser IPC signature/);
  });

  it('parses neutral backend browser actions at the IPC boundary', () => {
    const payload = {
      requestId: 'browser-public-tool-name',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: 'navigate',
      payload: { url: 'https://example.test' },
      context: {
        chatJid: 'tg:team',
        responseKeyId: TEST_RESPONSE_KEY_ID,
        publicToolName: 'browser_act',
      },
    };

    expect(
      parseBrowserIpcRequest(signedBrowserPayload(payload), 'team'),
    ).toMatchObject({
      requestId: 'browser-public-tool-name',
      action: 'navigate',
      publicToolName: 'browser_act',
      payload: { url: 'https://example.test' },
    });
  });

  it('rejects unsupported public browser gateway names at the IPC boundary', () => {
    const payload = {
      requestId: 'browser-unsupported-public-tool-name',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      action: 'navigate',
      payload: { url: 'https://example.test' },
      context: {
        chatJid: 'tg:team',
        responseKeyId: TEST_RESPONSE_KEY_ID,
        publicToolName: 'browser_fake',
      },
    };

    expect(() =>
      parseBrowserIpcRequest(signedBrowserPayload(payload), 'team'),
    ).toThrow(/Unsupported browser public tool/);
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
      agentConfig: { model: 'kimi-2.6' },
    });
  });

  it('preserves delegated parent task ids from IPC task requests', () => {
    const payload = signedPayload({
      requestId: 'task-parent-task-id',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'async_run_command',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
      parentTaskId: 'task_parent',
    });

    expect(parseTaskIpcData(payload, 'team')).toMatchObject({
      type: 'async_run_command',
      parentTaskId: 'task_parent',
    });
  });

  it('preserves memory user ids from signed task requests', () => {
    const payload = signedPayload({
      requestId: 'task-memory-user-id',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      type: 'pattern_candidate_decision',
      context: { responseKeyId: TEST_RESPONSE_KEY_ID },
      memoryUserId: 'sl:U123',
    });

    expect(parseTaskIpcData(payload, 'team')).toMatchObject({
      type: 'pattern_candidate_decision',
      memoryUserId: 'sl:U123',
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

  it('accepts user question IPC signed with scoped app and agent context', () => {
    const run = createIpcAuthEnvelope('main_agent', 'thread:123', {
      appId: 'app:telegram',
      agentId: 'agent:main',
    });
    const payload = {
      requestId: 'userq-1234567890-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceAgentFolder: 'main_agent',
      questions: [
        {
          header: 'Creds',
          question: 'How should I handle the credential readiness gate?',
          options: [
            {
              label: 'Retry',
              description: 'Try the operation again now.',
            },
            {
              label: 'Wait',
              description: 'Wait for more input.',
            },
          ],
          multiSelect: false,
        },
      ],
      context: {
        appId: 'app:telegram',
        agentId: 'agent:main',
        chatJid: 'tg:team',
        threadId: 'thread:123',
        jobId: 'job:daily',
        runId: 'run:daily',
        runLeaseToken: 'lease-token',
        runLeaseFencingVersion: 3,
        responseKeyId: run.responseKeyId,
      },
    };

    const parsed = parseUserQuestionIpcRequest(
      {
        ...payload,
        signature: signIpcRequestPayload(run.authToken, payload),
      },
      'main_agent',
    );

    expect(parsed).toMatchObject({
      requestId: payload.requestId,
      sourceAgentFolder: 'main_agent',
      appId: 'app:telegram',
      agentId: 'agent:main',
      targetJid: 'tg:team',
      threadId: 'thread:123',
      jobId: 'job:daily',
      runId: 'run:daily',
      runLeaseToken: 'lease-token',
      runLeaseFencingVersion: 3,
      responseKeyId: run.responseKeyId,
      questions: [
        {
          header: 'Creds',
          question: 'How should I handle the credential readiness gate?',
        },
      ],
    });
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

  it('parses signed permission IPC approval targets from the request context', () => {
    const payload = {
      requestId: 'perm-target-jid',
      responseNonce: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceAgentFolder: 'team',
      targetJid: 'tg:team',
      jobId: 'job-1',
      runId: 'run-1',
      runLeaseToken: 'lease-token-1',
      runLeaseFencingVersion: 1,
      toolName: 'Bash',
      decisionOptions: [
        'allow_once',
        'allow_persistent_rule',
        'cancel',
        'allow_timed_grant',
        'not_real',
        'allow_once',
      ],
      closestRule: {
        rule: 'RunCommand(npm run build)',
        reason: 'Bash leaf npm test did not match any scoped rule.',
      },
      context: {
        responseKeyId: TEST_RESPONSE_KEY_ID,
        appId: 'app:one',
        agentId: 'agent:team',
        chatJid: 'tg:team',
        jobId: 'job-1',
        runId: 'run-1',
        runLeaseToken: 'lease-token-1',
        runLeaseFencingVersion: 1,
      },
    };

    expect(parsePermissionIpcRequest(signedPayload(payload), 'team')).toEqual(
      expect.objectContaining({
        targetJid: 'tg:team',
        jobId: 'job-1',
        runId: 'run-1',
        runLeaseToken: 'lease-token-1',
        runLeaseFencingVersion: 1,
        appId: 'app:one',
        agentId: 'agent:team',
        decisionOptions: [
          'allow_once',
          'allow_persistent_rule',
          'cancel',
          'allow_timed_grant',
        ],
        closestRule: {
          rule: 'RunCommand(npm run build)',
          reason: 'Bash leaf npm test did not match any scoped rule.',
        },
      }),
    );
  });

  it('caps wide signed permission tool input during parsing', () => {
    const toolInput: Record<string, unknown> = {
      command: 'npm test',
      apiToken: 'secret-token-value',
    };
    for (let index = 0; index < 100; index += 1) {
      toolInput[`extra_${index}`] = `value_${index}`;
    }
    const payload = {
      requestId: 'perm-wide-tool-input',
      responseNonce: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceAgentFolder: 'team',
      toolName: 'mcp__thirdparty__unknown',
      toolInput,
      context: {
        responseKeyId: TEST_RESPONSE_KEY_ID,
        appId: 'app:one',
        agentId: 'agent:team',
      },
    };

    const parsed = parsePermissionIpcRequest(signedPayload(payload), 'team');

    expect(parsed.toolInput).toMatchObject({
      command: 'npm test',
      apiToken: '[REDACTED]',
      __omitted_keys: 'more',
    });
    expect(parsed.toolInput).not.toHaveProperty('extra_99');
  });

  it('rejects permission IPC approval target mismatches', () => {
    const payload = {
      requestId: 'perm-target-jid-mismatch',
      responseNonce: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceAgentFolder: 'team',
      targetJid: 'tg:other',
      toolName: 'Bash',
      context: {
        responseKeyId: TEST_RESPONSE_KEY_ID,
        appId: 'app:one',
        chatJid: 'tg:team',
      },
    };

    expect(() =>
      parsePermissionIpcRequest(signedPayload(payload), 'team'),
    ).toThrow(/targetJid mismatch/);
  });

  it('rejects permission IPC job and run context mismatches', () => {
    const base = {
      requestId: 'perm-job-mismatch',
      responseNonce: randomUUID(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceAgentFolder: 'team',
      targetJid: 'tg:team',
      toolName: 'Bash',
      context: {
        responseKeyId: TEST_RESPONSE_KEY_ID,
        appId: 'app:one',
        chatJid: 'tg:team',
        jobId: 'job-1',
        runId: 'run-1',
      },
    };
    const withFreshEnvelope = (extra: Record<string, unknown>) => ({
      ...base,
      requestId: `perm-job-mismatch-${randomUUID()}`,
      nonce: randomUUID(),
      ...extra,
    });

    expect(() =>
      parsePermissionIpcRequest(
        signedPayload(withFreshEnvelope({ jobId: 'job-2' }), 'team'),
        'team',
      ),
    ).toThrow(/jobId mismatch/);
    expect(() =>
      parsePermissionIpcRequest(
        signedPayload(withFreshEnvelope({ runId: 'run-2' }), 'team'),
        'team',
      ),
    ).toThrow(/runId mismatch/);
  });

  it('validates scheduled permission IPC against the stored job execution context', async () => {
    const deps = {
      opsRepository: {
        getJobById: async (id: string) =>
          id === 'job-1'
            ? {
                id: 'job-1',
                workspace_key: 'team',
                execution_context: {
                  conversationJid: 'tg:team',
                  threadId: 'topic-1',
                  workspaceKey: 'team',
                },
              }
            : undefined,
        getJobRunById: async (id: string) =>
          id === 'run-1' ? { run_id: 'run-1', job_id: 'job-1' } : undefined,
      },
    };
    const request = {
      requestId: 'perm-job-target',
      appId: 'app:one',
      responseKeyId: TEST_RESPONSE_KEY_ID,
      sourceAgentFolder: 'team',
      targetJid: 'tg:team',
      threadId: 'topic-1',
      jobId: 'job-1',
      runId: 'run-1',
      toolName: 'Bash',
    };

    await expect(
      validatePermissionIpcJobExecutionTarget({
        request,
        sourceAgentFolder: 'team',
        deps: deps as never,
      }),
    ).resolves.toBeUndefined();
    await expect(
      validatePermissionIpcJobExecutionTarget({
        request: { ...request, targetJid: 'tg:other' },
        sourceAgentFolder: 'team',
        deps: deps as never,
      }),
    ).rejects.toThrow(/target does not match job execution context/);
    await expect(
      validatePermissionIpcJobExecutionTarget({
        request: { ...request, threadId: 'topic-2' },
        sourceAgentFolder: 'team',
        deps: deps as never,
      }),
    ).rejects.toThrow(/thread does not match job execution context/);
    await expect(
      validatePermissionIpcJobExecutionTarget({
        request: { ...request, runId: 'run-2' },
        sourceAgentFolder: 'team',
        deps: deps as never,
      }),
    ).rejects.toThrow(/run does not match job/);
  });

  it('validates scheduled user-question IPC against the stored job execution context', async () => {
    const deps = {
      opsRepository: {
        getJobById: async (id: string) =>
          id === 'job-1'
            ? {
                id: 'job-1',
                workspace_key: 'team',
                execution_context: {
                  conversationJid: 'tg:team',
                  threadId: 'topic-1',
                  workspaceKey: 'team',
                },
              }
            : undefined,
        getJobRunById: async (id: string) =>
          id === 'run-1' ? { run_id: 'run-1', job_id: 'job-1' } : undefined,
      },
    };
    const request = {
      requestId: 'userq-job-target',
      appId: 'app:one',
      responseKeyId: TEST_RESPONSE_KEY_ID,
      sourceAgentFolder: 'team',
      targetJid: 'tg:team',
      threadId: 'topic-1',
      jobId: 'job-1',
      runId: 'run-1',
      questions: [
        {
          header: 'Mode',
          question: 'Pick one',
          options: [
            { label: 'Retry', description: 'Try again' },
            { label: 'Stop', description: 'Stop now' },
          ],
          multiSelect: false,
        },
      ],
    };

    await expect(
      validateUserQuestionIpcJobExecutionTarget({
        request,
        sourceAgentFolder: 'team',
        deps: deps as never,
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateUserQuestionIpcJobExecutionTarget({
        request: { ...request, targetJid: 'tg:other' },
        sourceAgentFolder: 'team',
        deps: deps as never,
      }),
    ).rejects.toThrow(/target does not match job execution context/);
    await expect(
      validateUserQuestionIpcJobExecutionTarget({
        request: { ...request, sourceAgentFolder: 'other' },
        sourceAgentFolder: 'other',
        deps: deps as never,
      }),
    ).rejects.toThrow(/source does not match job execution context/);
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
    clearConsumedIpcRequestIds({ durable: false });
    expect(() =>
      validateIpcAuthRequest(signed, 'team', 'permission IPC'),
    ).toThrow(/replay/);

    const restartReplay = signedPayload({
      requestId: 'perm-restart',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(() =>
      validateIpcAuthRequest(restartReplay, 'team', 'permission IPC'),
    ).not.toThrow();
    stopIpcWatcher();
    expect(() =>
      validateIpcAuthRequest(restartReplay, 'team', 'permission IPC'),
    ).toThrow(/replay/);
  });
});

describe('parseIpcMessage', () => {
  afterEach(() => {
    clearConsumedIpcRequestIds({ durable: 'consumed' });
    stopIpcWatcher();
  });

  it('keeps signed app scope and bounded FileArtifact refs', () => {
    const payload = {
      type: 'message',
      requestId: 'msg-1',
      chatJid: 'tg:team',
      text: 'See attached report.',
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      context: { appId: 'app:test', agentId: 'agent:test' },
      files: [
        { scope: 'reports', path: 'daily.md', version: 2 },
        { path: 'summary.txt' },
        { scope: 'ignored' },
      ],
    };

    expect(parseIpcMessage(signedPayload(payload), 'team')).toMatchObject({
      appId: 'app:test',
      chatJid: 'tg:team',
      text: 'See attached report.',
      files: [
        { scope: 'reports', path: 'daily.md', version: 2 },
        { path: 'summary.txt' },
      ],
    });
  });
});

describe('appendOwnedFileArtifactDegradeText', () => {
  it('resolves owned file artifacts into message attachments', async () => {
    const listFileArtifacts = vi.fn(async () => [
      {
        id: 'artifact-1',
        virtualScope: 'reports',
        virtualPath: 'daily.md',
        version: 2,
        contentHash: 'sha256:abc',
        sizeBytes: 1_024,
        contentType: 'text/markdown',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
    ]);
    const readFileArtifact = vi.fn(async () => ({
      artifact: {
        id: 'artifact-1',
        virtualScope: 'reports',
        virtualPath: 'daily.md',
        version: 2,
        contentHash: 'sha256:abc',
        sizeBytes: 1_024,
        contentType: 'text/markdown',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
      content: '# report',
    }));

    await expect(
      resolveOwnedFileArtifactMessage({
        deps: {
          getFileArtifactStore: () =>
            ({
              listFileArtifacts,
              readFileArtifact,
            }) as never,
        },
        appId: 'app:test',
        sourceAgentFolder: 'team',
        text: 'See attached report.',
        files: [{ scope: 'reports', path: 'daily.md' }],
      }),
    ).resolves.toMatchObject({
      text: 'See attached report.\n\nAttachments:\n- daily.md (text/markdown, 1024 bytes)',
      files: [
        {
          filename: 'daily.md',
          contentType: 'text/markdown',
          sizeBytes: 1_024,
        },
      ],
    });

    expect(listFileArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        virtualScope: 'reports',
        virtualPath: 'daily.md',
        limit: 1,
      }),
    );
    expect(readFileArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        virtualScope: 'reports',
        virtualPath: 'daily.md',
        version: 2,
      }),
    );
  });

  it('does not read oversized file artifact content into memory', async () => {
    const listFileArtifacts = vi.fn(async () => [
      {
        id: 'artifact-large',
        virtualScope: 'reports',
        virtualPath: 'large.bin',
        version: 1,
        contentHash: 'sha256:large',
        sizeBytes: 26 * 1024 * 1024,
        contentType: 'application/octet-stream',
        createdAt: '2026-06-23T00:00:00.000Z',
      },
    ]);
    const readFileArtifact = vi.fn();

    await expect(
      resolveOwnedFileArtifactMessage({
        deps: {
          getFileArtifactStore: () =>
            ({
              listFileArtifacts,
              readFileArtifact,
            }) as never,
        },
        appId: 'app:test',
        sourceAgentFolder: 'team',
        text: 'See attached report.',
        files: [{ scope: 'reports', path: 'large.bin' }],
      }),
    ).resolves.toEqual({
      text: 'See attached report.\n\nAttachments:\n- Attachment unavailable.',
    });
    expect(readFileArtifact).not.toHaveBeenCalled();
  });

  it('keeps the base message when file artifact storage is unavailable', async () => {
    await expect(
      appendOwnedFileArtifactDegradeText({
        deps: {},
        appId: 'app:test',
        sourceAgentFolder: 'team',
        text: 'Ship the note.',
        files: [{ path: 'daily.md' }],
      }),
    ).resolves.toBe(
      'Ship the note.\n\nAttachments:\n- Attachment unavailable.',
    );
  });

  it('keeps the base message when a file reference is invalid', async () => {
    await expect(
      appendOwnedFileArtifactDegradeText({
        deps: {
          getFileArtifactStore: () => ({ readFileArtifact: vi.fn() }) as never,
        },
        appId: 'app:test',
        sourceAgentFolder: 'team',
        text: 'Ship the note.',
        files: [{ path: '../secret.txt' }],
      }),
    ).resolves.toBe(
      'Ship the note.\n\nAttachments:\n- Attachment unavailable.',
    );
  });
});
