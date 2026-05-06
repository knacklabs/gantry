import { describe, expect, it } from 'vitest';
import type {
  CreateJobInput,
  UpdateJobInput,
} from '../../../sdk/src/job-model-types.js';

import {
  AgentResponseSchema,
  AgentConversationBindingRequestSchema,
  AgentConversationBindingListResponseSchema,
  AgentConversationBindingResponseSchema,
  BROWSER_IPC_ACTIONS,
  BrowserProfileResponseSchema,
  ProviderConnectionListResponseSchema,
  ProviderConnectionResponseSchema,
  ProviderListResponseSchema,
  ProviderResponseSchema,
  ContractMetadataSchema,
  ConversationListResponseSchema,
  ConversationResponseSchema,
  ConversationThreadListResponseSchema,
  ConversationThreadResponseSchema,
  CreateAgentRequestSchema,
  CreateJobRequestSchema,
  CreateSessionRequestSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
  JobResponseSchema,
  JobScheduleSchema,
  LlmProfileRefSchema,
  MEMORY_IPC_ACTIONS,
  MemoryItemResponseSchema,
  MemorySearchRequestSchema,
  MessageListResponseSchema,
  MessageResponseSchema,
  PageRequestSchema,
  RuntimeLimitSchema,
  SchemaDescriptorSchema,
  StreamEventSchema,
  UpdateJobRequestSchema,
  createCursorPageResponseSchema,
  createPageResponseSchema,
} from '@contracts-src/index.js';

function expectInvalid(
  schema: { safeParse: (input: unknown) => { success: boolean } },
  input: unknown,
) {
  expect(schema.safeParse(input).success).toBe(false);
}

const iso = '2026-04-27T00:00:00.000Z';

const message = {
  id: 'message-1',
  appId: 'app-1',
  conversationId: 'conversation-1',
  direction: 'outbound',
  trust: 'trusted',
  parts: [{ ordinal: 0, kind: 'text', payload: { text: 'hello' } }],
  createdAt: iso,
};

const runEvent = {
  id: 'run-event-1',
  appId: 'app-1',
  runId: 'run-1',
  type: 'model.output',
  payload: { text: 'hello' },
  createdAt: iso,
};

const permissionDecision = {
  id: 'decision-1',
  appId: 'app-1',
  ruleIds: ['rule-1'],
  effect: 'allow',
  reason: 'Matched allow rule',
  createdAt: iso,
};

describe('contracts package', () => {
  it('exports memory IPC actions from the canonical memory module', () => {
    expect(MEMORY_IPC_ACTIONS).toEqual([
      'memory_search',
      'memory_save',
      'memory_patch',
      'memory_consolidate',
      'memory_dream',
      'procedure_save',
      'procedure_patch',
    ]);
  });

  it('exports browser IPC actions from the canonical browser module', () => {
    expect(BROWSER_IPC_ACTIONS).toEqual([
      'browser_profile_list',
      'browser_launch',
      'browser_close',
      'browser_status',
    ]);
  });

  it('exports and validates contract primitives', () => {
    expect(IsoDateTimeSchema.parse(iso)).toBe(iso);
    expectInvalid(IsoDateTimeSchema, '2026-04-27T00:00:00');

    expect(ContractMetadataSchema.parse({ provider: 'sdk' })).toEqual({
      provider: 'sdk',
    });
    expect(ExternalReferenceSchema.parse({ id: 'external-1' })).toMatchObject({
      id: 'external-1',
    });

    expect(RuntimeLimitSchema.parse({ timeoutMs: 1000 })).toEqual({
      timeoutMs: 1000,
    });
    expectInvalid(RuntimeLimitSchema, { timeoutMs: 0 });
    expectInvalid(RuntimeLimitSchema, { maxTurns: 1.5 });

    expect(SchemaDescriptorSchema.parse({ schema: {} })).toEqual({
      format: 'unknown',
      schema: {},
    });
    expectInvalid(SchemaDescriptorSchema, { format: 'protobuf', schema: {} });

    expect(LlmProfileRefSchema.parse({ modelAlias: 'opus' })).toEqual({
      modelAlias: 'opus',
    });
  });

  it('validates representative canonical DTOs and rejects constrained invalid input', () => {
    expect(
      CreateSessionRequestSchema.parse({
        conversationId: 'conversation-1',
      }),
    ).toMatchObject({ conversationId: 'conversation-1' });
    expectInvalid(CreateSessionRequestSchema, {
      conversationId: 'conversation-1',
      unexpectedField: 'sonnet',
    });

    expect(
      AgentResponseSchema.parse({
        id: 'agent-1',
        appId: 'app-1',
        name: 'Operator',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ id: 'agent-1', appId: 'app-1' });
    expectInvalid(AgentResponseSchema, {
      id: 'agent-1',
      appId: 'app-1',
      name: 'Operator',
      status: 'bad',
      createdAt: iso,
      updatedAt: iso,
    });
    expectInvalid(CreateAgentRequestSchema, { appId: 'app-1', name: '' });

    const sdkCreatePayload = {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      sessionId: 'session-1',
      kind: 'recurring',
      schedule: { type: 'cron', value: '0 9 * * *' },
      modelAlias: 'sonnet',
    } satisfies CreateJobInput;
    expect(CreateJobRequestSchema.parse(sdkCreatePayload)).toMatchObject({
      name: 'Daily summary',
      sessionId: 'session-1',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: '',
      prompt: 'Summarize open work',
      sessionId: 'session-1',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: '',
      sessionId: 'session-1',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      sessionId: 'session-1',
      modelAlias: 'sonnet',
      modelProfileId: 'anthropic:sonnet-4.6',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      sessionId: 'session-1',
      model: 'claude-sonnet-4-6',
    });
    expectInvalid(CreateJobRequestSchema, {
      name: 'Daily summary',
      prompt: 'Summarize open work',
      sessionId: 'session-1',
      providerModelId: 'sonnet',
    });

    const sdkUpdatePayload = {
      modelAlias: null,
      status: 'paused',
    } satisfies UpdateJobInput;
    expect(UpdateJobRequestSchema.parse(sdkUpdatePayload)).toEqual({
      modelAlias: null,
      status: 'paused',
    });
    expectInvalid(UpdateJobRequestSchema, {
      modelAlias: 'sonnet',
      modelProfileId: 'anthropic:sonnet-4.6',
    });
    expectInvalid(UpdateJobRequestSchema, {
      model: 'claude-sonnet-4-6',
    });
    expect(
      JobResponseSchema.parse({
        jobId: 'job-1',
        name: 'Daily summary',
        kind: 'once',
        status: 'active',
        schedule: { type: 'once', runAt: iso },
        linkedSessions: ['app:app-one:session-1'],
        nextRun: iso,
        lastRun: null,
        staleness: 'missed_window',
        executionMode: 'parallel',
        modelAlias: null,
        modelProfileId: null,
        model: null,
        threadId: null,
        groupScope: 'app:app-one:session-1',
        sessionId: null,
      }),
    ).toMatchObject({ staleness: 'missed_window' });
    expectInvalid(JobResponseSchema, {
      jobId: 'job-1',
      name: 'Daily summary',
      kind: 'once',
      status: 'active',
      schedule: { type: 'once', runAt: iso },
      linkedSessions: ['app:app-one:session-1'],
      nextRun: iso,
      lastRun: null,
      staleness: 'delayed',
      executionMode: 'parallel',
      modelAlias: null,
      modelProfileId: null,
      model: null,
      threadId: null,
      groupScope: 'app:app-one:session-1',
      sessionId: null,
    });

    expect(
      MemoryItemResponseSchema.parse({
        id: 'memory-1',
        appId: 'app-1',
        subject: { type: 'common', id: 'common' },
        kind: 'fact',
        key: 'timezone',
        value: 'Asia/Kolkata',
        confidence: 1,
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ key: 'timezone' });
    expectInvalid(MemoryItemResponseSchema, {
      id: 'memory-1',
      appId: 'app-1',
      subject: { type: 'common', id: 'common' },
      kind: 'fact',
      key: 'timezone',
      value: 'Asia/Kolkata',
      confidence: 1.0001,
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    });
    expectInvalid(MemorySearchRequestSchema, { limit: 101 });

    expect(
      BrowserProfileResponseSchema.parse({
        id: 'browser-1',
        appId: 'app-1',
        name: 'default',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ name: 'default' });
    expectInvalid(BrowserProfileResponseSchema, {
      id: 'browser-1',
      appId: 'app-1',
      name: 'default',
      status: 'bad',
      createdAt: iso,
      updatedAt: iso,
    });

    expect(
      ProviderResponseSchema.parse({
        id: 'slack',
        displayName: 'Slack',
        capabilities: ['threads'],
        status: 'available',
        createdAt: iso,
      }),
    ).toMatchObject({ id: 'slack' });
    expect(
      ProviderListResponseSchema.parse({
        providers: [
          {
            id: 'teams',
            displayName: 'Teams',
            capabilities: ['placeholder'],
            status: 'unavailable',
            placeholder: true,
            createdAt: iso,
          },
        ],
      }),
    ).toMatchObject({ providers: [{ id: 'teams' }] });
    expectInvalid(ProviderResponseSchema, {
      id: 'slack',
      displayName: 'Slack',
      capabilities: ['threads'],
    });

    expect(
      ProviderConnectionResponseSchema.parse({
        id: 'installation-1',
        appId: 'app-1',
        providerId: 'slack',
        label: 'Workspace',
        status: 'active',
        config: { teamId: 'T123' },
        runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ providerId: 'slack' });
    expect(
      ProviderConnectionListResponseSchema.parse({
        providerConnections: [
          {
            id: 'installation-1',
            appId: 'app-1',
            providerId: 'slack',
            label: 'Workspace',
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ providerConnections: [{ id: 'installation-1' }] });
    expectInvalid(ProviderConnectionResponseSchema, {
      id: 'installation-1',
      appId: 'app-1',
      providerId: 'slack',
      label: 'Workspace',
      status: 'bad',
      createdAt: iso,
      updatedAt: iso,
    });

    expect(
      AgentConversationBindingRequestSchema.parse({
        triggerMode: 'keyword',
        memoryScope: 'conversation',
        permissionPolicyIds: [],
      }),
    ).toMatchObject({ triggerMode: 'keyword' });
    expectInvalid(AgentConversationBindingRequestSchema, {
      triggerMode: 'sometimes',
    });
    expect(
      AgentConversationBindingResponseSchema.parse({
        id: 'binding-1',
        appId: 'app-1',
        agentId: 'agent-1',
        providerConnectionId: 'installation-1',
        conversationId: 'conversation-1',
        displayName: 'Engineering',
        status: 'active',
        triggerMode: 'always',
        requiresTrigger: false,
        isAdminBinding: false,
        memoryScope: 'conversation',
        permissionPolicyIds: [],
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ status: 'active', triggerMode: 'always' });
    expect(
      AgentConversationBindingListResponseSchema.parse({
        bindings: [
          {
            id: 'binding-1',
            appId: 'app-1',
            agentId: 'agent-1',
            providerConnectionId: 'installation-1',
            conversationId: 'conversation-1',
            displayName: 'Engineering',
            status: 'disabled',
            triggerMode: 'manual',
            requiresTrigger: false,
            isAdminBinding: false,
            memoryScope: 'app',
            permissionPolicyIds: ['policy-1'],
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ bindings: [{ status: 'disabled' }] });

    expect(
      ConversationResponseSchema.parse({
        id: 'conversation-1',
        appId: 'app-1',
        providerConnectionId: 'installation-1',
        kind: 'channel',
        title: 'Engineering',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ kind: 'channel' });
    expect(
      ConversationListResponseSchema.parse({
        conversations: [
          {
            id: 'conversation-1',
            appId: 'app-1',
            providerConnectionId: 'installation-1',
            kind: 'dm',
            title: null,
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ conversations: [{ kind: 'dm' }] });
    expect(
      ConversationThreadResponseSchema.parse({
        id: 'thread-1',
        appId: 'app-1',
        conversationId: 'conversation-1',
        title: 'Deploy',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      }),
    ).toMatchObject({ id: 'thread-1' });
    expect(
      ConversationThreadListResponseSchema.parse({
        threads: [
          {
            id: 'thread-1',
            appId: 'app-1',
            conversationId: 'conversation-1',
            title: null,
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
      }),
    ).toMatchObject({ threads: [{ id: 'thread-1' }] });
    expect(
      MessageListResponseSchema.parse({ messages: [message] }),
    ).toMatchObject({ messages: [{ id: 'message-1' }] });

    expectInvalid(MessageResponseSchema, {
      ...message,
      parts: [{ ordinal: -1, kind: 'text', payload: { text: 'hello' } }],
    });
  });

  it('validates pagination request and response schema constraints', () => {
    expect(PageRequestSchema.parse({ page: 1, pageSize: 25 })).toEqual({
      page: 1,
      pageSize: 25,
    });
    expectInvalid(PageRequestSchema, { page: 0 });
    expectInvalid(PageRequestSchema, { page: 1, pageSize: 501 });

    const pageResponse = createPageResponseSchema(AgentResponseSchema);
    expect(
      pageResponse.parse({
        data: [
          {
            id: 'agent-1',
            appId: 'app-1',
            name: 'Operator',
            status: 'active',
            createdAt: iso,
            updatedAt: iso,
          },
        ],
        page: 1,
        pageSize: 25,
        total: 1,
        hasNext: false,
      }),
    ).toMatchObject({ page: 1, hasNext: false });
    expectInvalid(pageResponse, {
      data: [],
      page: 0,
      pageSize: 25,
      hasNext: false,
    });
    expectInvalid(pageResponse, { data: [], page: 1, pageSize: 25 });
    expectInvalid(pageResponse, {
      data: [{ id: 'agent-1' }],
      page: 1,
      pageSize: 25,
      hasNext: false,
    });

    const cursorResponse = createCursorPageResponseSchema(AgentResponseSchema);
    expect(
      cursorResponse.parse({
        data: [],
        nextCursor: 'next',
        hasNext: true,
      }),
    ).toMatchObject({ hasNext: true });
    expectInvalid(cursorResponse, { data: [] });
    expectInvalid(cursorResponse, {
      data: [{ id: 'agent-1' }],
      hasNext: false,
    });
  });

  it.each([
    ['manual', { type: 'manual' }],
    ['once', { type: 'once', runAt: iso }],
    ['cron', { type: 'cron', value: '0 9 * * *' }],
    ['interval', { type: 'interval', value: '60000' }],
  ])('validates %s job schedules', (_name, schedule) => {
    expect(JobScheduleSchema.parse(schedule)).toEqual(schedule);
  });

  it.each([
    ['once without runAt', { type: 'once' }],
    ['once with naive runAt', { type: 'once', runAt: '2026-04-27T00:00:00' }],
    ['cron with empty value', { type: 'cron', value: '' }],
    ['interval with empty value', { type: 'interval', value: '' }],
  ])('rejects invalid job schedule: %s', (_name, schedule) => {
    expectInvalid(JobScheduleSchema, schedule);
  });

  it.each([
    ['heartbeat', { type: 'heartbeat', id: 'event-1', createdAt: iso }, {}],
    [
      'run.event',
      { type: 'run.event', event: runEvent },
      { type: 'run.event' },
    ],
    [
      'message.delta',
      { type: 'message.delta', messageId: 'message-1', delta: 'hello' },
      { type: 'message.delta', messageId: 'message-1' },
    ],
    [
      'message.completed',
      { type: 'message.completed', message },
      { type: 'message.completed' },
    ],
    [
      'progress',
      { type: 'progress', label: 'Running', detail: 'Step 1', done: false },
      { type: 'progress', detail: 'Step 1' },
    ],
    [
      'tool.requested',
      { type: 'tool.requested', toolCallId: 'call-1', name: 'search' },
      { type: 'tool.requested', name: 'search' },
    ],
    [
      'tool.completed',
      { type: 'tool.completed', toolCallId: 'call-1', output: { ok: true } },
      { type: 'tool.completed', output: { ok: true } },
    ],
    [
      'permission.decision',
      { type: 'permission.decision', decision: permissionDecision },
      { type: 'permission.decision' },
    ],
    [
      'error',
      { type: 'error', error: { code: 'INVALID_REQUEST', message: 'Nope' } },
      { type: 'error' },
    ],
    [
      'completed',
      { type: 'completed', status: 'completed', resultSummary: 'Done' },
      { type: 'completed' },
    ],
  ])('validates stream event variant %s', (_name, valid, invalid) => {
    expect(StreamEventSchema.parse(valid)).toMatchObject(valid);
    if (Object.keys(invalid).length > 0) {
      expectInvalid(StreamEventSchema, invalid);
    }
  });
});
