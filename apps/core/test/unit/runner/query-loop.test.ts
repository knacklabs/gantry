import fs from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.GANTRY_WORKSPACE_GROUP_DIR ??= '/tmp';
  process.env.GANTRY_WORKSPACE_EXTRA_DIR ??= '/tmp';
  process.env.GANTRY_IPC_DIR ??= '/tmp';
  process.env.GANTRY_IPC_INPUT_DIR ??= '/tmp';
});

import { usageEventIdForMessage } from '@core/adapters/llm/anthropic-claude-agent/runner/query-usage-event-id.js';
import { recordSuccessfulToolUse } from '@core/adapters/llm/anthropic-claude-agent/runner/query-loop.js';
import { composeAgentCapabilities } from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import { createPostToolUseHook } from '@core/adapters/llm/anthropic-claude-agent/runner/query-tool-activity-hook.js';
import { terminalToolActivityRuntimeEvent } from '@core/adapters/llm/anthropic-claude-agent/runner/tool-permission-events.js';
import { createInlineToolActivity } from '@core/adapters/llm/inline-lane-tool-activity.js';
import {
  privateToolActivityInvocationIdFromResult,
  withPrivateToolActivityInvocationId,
} from '@core/domain/events/tool-activity.js';
import { createPermissionApprovalContextChannel } from '@core/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.js';
import { canonicalGantryToolRuleName } from '@core/shared/gantry-tool-facades.js';
import { RunScopedToolSuccessLedger } from '@core/runner/tool-gate-core.js';

it('toolact-anthropic', async () => {
  const agentInput = {
    appId: 'app-1',
    agentId: 'agent-1',
    runId: 'run-live',
    chatJid: 'conversation-1',
    workspaceFolder: '/tmp',
    permissionMode: 'default' as const,
  };
  const events: NonNullable<
    ReturnType<typeof terminalToolActivityRuntimeEvent>
  >[] = [];
  const capabilityProfile = composeAgentCapabilities({
    mcpServerPath: '/tmp/ipc-mcp-stdio.js',
    chatJid: 'conversation-1',
    workspaceFolder: '/tmp',
    configuredAllowedTools: ['mcp__gantry__capability_run'],
    externalMcpServers: {
      crm: { command: 'crm-mcp' },
    },
    externalMcpAllowedTools: ['mcp__crm__capability_run'],
  });
  expect(capabilityProfile.allowedTools).toContain('mcp__crm__capability_run');
  expect(capabilityProfile.gantryOwnedTools).toContain(
    'mcp__gantry__capability_run',
  );
  expect(capabilityProfile.gantryOwnedTools).not.toContain(
    'mcp__crm__capability_run',
  );
  let seq = 0;
  const trustedGantryFamilies = new Map([
    ['provider-capability', 'capability' as const],
    ['provider-browser', 'browser' as const],
  ]);
  const postToolUse = vi.fn(async () => ({ continue: true as const }));
  const hook = createPostToolUseHook({
    postToolUse: postToolUse as never,
    takeGantryOwnedToolActivityFamily: (providerInvocationId) => {
      const family = trustedGantryFamilies.get(providerInvocationId);
      trustedGantryFamilies.delete(providerInvocationId);
      return family;
    },
    emitTerminalToolOutcome: (outcome) => {
      const event = terminalToolActivityRuntimeEvent({
        agentInput,
        ...outcome,
        seq: ++seq,
      });
      if (event) events.push(event);
    },
  });
  const invoke = (hookInput: Record<string, unknown>, toolUseID?: string) =>
    hook(hookInput as never, toolUseID, {
      signal: new AbortController().signal,
    });

  await invoke({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__crm__read',
    tool_use_id: 'provider-success',
    tool_response: {
      invocationId: 'caller-visible-spoof',
      _meta: { invocationId: 'private-spoof' },
    },
  });
  await invoke(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'WebSearch',
      tool_response: { isError: true, invocationId: 'structural-spoof' },
    },
    'provider-structural-failure',
  );
  await invoke({
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_use_id: 'provider-hook-failure',
    error: 'command failed',
  });
  await invoke({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__gantry__capability_run',
    tool_use_id: 'provider-third-party-capability',
    tool_response: { _meta: { invocationId: 'third-party-spoof' } },
  });
  await invoke({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__gantry__capability_run',
    tool_use_id: 'provider-capability',
    tool_response: { _meta: { invocationId: 'capability-request' } },
  });
  await invoke({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__gantry__browser_open',
    tool_use_id: 'provider-browser',
    tool_response: { _meta: { invocationId: 'browser-request' } },
  });

  expect(
    events.map((event) => ({
      correlationId: event.correlationId,
      payload: event.payload,
    })),
  ).toEqual([
    {
      correlationId: 'provider-success',
      payload: expect.objectContaining({
        phase: 'success',
        tool: 'mcp__crm__read',
        invocationId: 'provider-success',
      }),
    },
    {
      correlationId: 'provider-structural-failure',
      payload: expect.objectContaining({
        phase: 'failure',
        tool: 'WebSearch',
        invocationId: 'provider-structural-failure',
      }),
    },
    {
      correlationId: 'provider-hook-failure',
      payload: expect.objectContaining({
        phase: 'failure',
        tool: 'RunCommand',
        invocationId: 'provider-hook-failure',
      }),
    },
    {
      correlationId: 'provider-third-party-capability',
      payload: expect.objectContaining({
        phase: 'success',
        tool: 'capability_run',
        invocationId: 'provider-third-party-capability',
      }),
    },
    {
      correlationId: 'capability-request',
      payload: expect.objectContaining({
        family: 'capability',
        phase: 'success',
        tool: 'capability_run',
        invocationId: 'capability-request',
      }),
    },
    {
      correlationId: 'browser-request',
      payload: expect.objectContaining({
        family: 'browser',
        phase: 'success',
        tool: 'Browser',
        invocationId: 'browser-request',
      }),
    },
  ]);
  expect(events[3]?.payload).not.toHaveProperty('family');
  expect(postToolUse).toHaveBeenCalledTimes(6);

  expect(
    privateToolActivityInvocationIdFromResult({
      invocationId: 'direct-id',
      structuredContent: { _meta: { invocationId: 'nested-id' } },
    }),
  ).toBeUndefined();
  const visibleResult = {
    content: [{ type: 'text', text: 'done' }],
    _meta: { traceId: 'trace-1' },
  };
  const correlated = withPrivateToolActivityInvocationId(
    visibleResult,
    'gantry-owned-id',
  );
  expect(correlated).not.toBe(visibleResult);
  expect(visibleResult._meta).toEqual({ traceId: 'trace-1' });
  expect(Object.keys(correlated)).toEqual(Object.keys(visibleResult));
  expect(privateToolActivityInvocationIdFromResult(correlated)).toBe(
    'gantry-owned-id',
  );
  expect((correlated as typeof visibleResult)._meta).toEqual({
    traceId: 'trace-1',
    invocationId: 'gantry-owned-id',
  });
  expect(JSON.parse(JSON.stringify(correlated))).toEqual({
    content: visibleResult.content,
    _meta: { traceId: 'trace-1', invocationId: 'gantry-owned-id' },
  });
  expect(correlated).not.toHaveProperty('invocationId');
  const transportedCorrelation = withPrivateToolActivityInvocationId(
    { content: visibleResult.content },
    'transported-id',
  );
  expect(JSON.parse(JSON.stringify(transportedCorrelation))).toEqual({
    content: visibleResult.content,
    _meta: { invocationId: 'transported-id' },
  });
  expect(Object.keys(transportedCorrelation)).not.toContain('invocationId');

  // Both inline provider lanes share this activity seam. Generic results
  // cannot replace provider identity; Gantry-owned results may correlate via
  // their private metadata.
  const inlineTerminalCorrelations: Array<string | undefined> = [];
  const inlineToolActivity = createInlineToolActivity({
    input: { chatJid: 'conversation-1' },
    coreTools: {
      tools: [{ name: 'mcp__crm__read' }, { name: 'capability_run' }],
    },
    emitOutput: async (output) => {
      for (const event of output.runtimeEvents ?? []) {
        if (event.payload.phase === 'success') {
          inlineTerminalCorrelations.push(event.correlationId);
        }
      }
    },
  });
  await inlineToolActivity.run(
    'mcp__crm__read',
    async () => ({ _meta: { invocationId: 'inline-private-spoof' } }),
    'inline-provider-generic',
  );
  await inlineToolActivity.run(
    'capability_run',
    async () => ({ _meta: { invocationId: 'inline-third-party-spoof' } }),
    'inline-provider-third-party-capability',
  );
  await inlineToolActivity.run(
    'capability_run',
    async () => ({ _meta: { invocationId: 'inline-capability-request' } }),
    'inline-provider-capability',
    'gantry',
  );
  expect(inlineTerminalCorrelations).toEqual([
    'inline-provider-generic',
    'inline-provider-third-party-capability',
    'inline-capability-request',
  ]);

  const concurrentCorrelations: Array<string | undefined> = [];
  const concurrentActivity = createInlineToolActivity({
    input: { chatJid: 'conversation-1' },
    coreTools: { tools: [{ name: 'capability_run' }] },
    emitOutput: async (output) => {
      for (const event of output.runtimeEvents ?? []) {
        if (event.payload.phase === 'success') {
          concurrentCorrelations.push(event.correlationId);
        }
      }
    },
  });
  const firstBinding = concurrentActivity.bindProviderInvocation(
    'inline-provider-first',
  );
  concurrentActivity.bindProviderInvocation('inline-provider-never-started');
  const secondBinding = concurrentActivity.bindProviderInvocation(
    'inline-provider-second',
  );
  if (!firstBinding || !secondBinding) {
    throw new Error('Provider invocation bindings were not created.');
  }
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const secondRun = concurrentActivity.run(
    'capability_run',
    async () => {
      await secondGate;
      return {};
    },
    concurrentActivity.takeProviderInvocation(secondBinding),
    'gantry',
  );
  const firstRun = concurrentActivity.run(
    'capability_run',
    async () => {
      await firstGate;
      return {};
    },
    concurrentActivity.takeProviderInvocation(firstBinding),
    'gantry',
  );
  releaseFirst();
  await firstRun;
  releaseSecond();
  await secondRun;
  await concurrentActivity.run('capability_run', async () => ({}));
  expect(concurrentCorrelations.slice(0, 2)).toEqual([
    'inline-provider-first',
    'inline-provider-second',
  ]);
  expect(concurrentCorrelations).not.toContain('inline-provider-never-started');
  concurrentActivity.close();
  inlineToolActivity.close();

  expect(
    terminalToolActivityRuntimeEvent({
      agentInput: { ...agentInput, parentTaskId: 'task-1' },
      invocationId: 'toolu-nested',
      toolName: 'Bash',
      outcome: 'success',
      seq: 6,
    }),
  ).toBeNull();
});

describe('Claude query loop usage event IDs', () => {
  it('uses stable provider IDs when present', () => {
    expect(
      usageEventIdForMessage({ request_id: 'req-1' }, 'session-1', 1, 'run-a'),
    ).toBe('req-1');
  });

  it('keeps fallback usage IDs unique across resumed query runs', () => {
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-a')).toBe(
      'session-1:run:run-a:result:1',
    );
    expect(usageEventIdForMessage({}, 'session-1', 1, 'run-b')).toBe(
      'session-1:run:run-b:result:1',
    );
  });
});

describe('Claude query loop declarative tool names', () => {
  it('keeps one-shot scheduled input open only for an accepted finish nudge', () => {
    const source = [
      'query-loop-phases-setup.ts',
      'query-loop-phases-messages.ts',
    ]
      .map((fileName) =>
        fs.readFileSync(
          new URL(
            `../../../src/adapters/llm/anthropic-claude-agent/runner/${fileName}`,
            import.meta.url,
          ),
          'utf8',
        ),
      )
      .join('\n');

    expect(source).toContain(
      'if (!enableIpcFollowups && !agentInput.isScheduledJob) stream.end();',
    );
    expect(source).toContain('const nudgeDeliveredThisTurn =');
    expect(source).toContain(
      'if (scheduledOneShot && !nudgeDeliveredThisTurn) stream.end();',
    );
  });

  it('does not pass allowedTools while retaining canUseTool in SDK query options', () => {
    const source = fs.readFileSync(
      new URL(
        '../../../src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts',
        import.meta.url,
      ),
      'utf8',
    );
    const queryOptions = source.slice(
      source.indexOf('const sdkQuery = query({'),
      source.indexOf('const sdkQueryIteratorMs'),
    );

    expect(queryOptions).not.toMatch(/\n\s*allowedTools:/);
    expect(queryOptions).toMatch(/\n\s*canUseTool:/);
  });

  it('canonicalizes first-party Gantry MCP names to bare rule names', () => {
    expect(canonicalGantryToolRuleName('mcp__gantry__send_message')).toBe(
      'send_message',
    );
  });

  it.each([
    'mcp__gantry__delegate_task',
    'mcp__gantry__task_message',
    'delegate_task',
    'task_message',
  ])('canonicalizes %s as AgentDelegation', (toolName) => {
    expect(canonicalGantryToolRuleName(toolName)).toBe('AgentDelegation');
  });

  it('canonicalizes synthetic delegation only with Gantry or manifest provenance', () => {
    expect(
      canonicalGantryToolRuleName('mcp__gantry__delegate_to_reviewer_hash'),
    ).toBe('AgentDelegation');
    expect(
      canonicalGantryToolRuleName('delegate_to_reviewer_hash', {
        callableAgentToolNames: new Set(['delegate_to_reviewer_hash']),
      }),
    ).toBe('AgentDelegation');
    expect(canonicalGantryToolRuleName('delegate_to_cleanup')).toBe(
      'delegate_to_cleanup',
    );
  });

  it('keeps non-Gantry MCP names unchanged', () => {
    expect(canonicalGantryToolRuleName('mcp__crm__delete')).toBe(
      'mcp__crm__delete',
    );
  });

  it('keeps native tool names unchanged', () => {
    expect(canonicalGantryToolRuleName('Bash')).toBe('Bash');
  });
});

describe('Claude query loop declarative tool success ledger', () => {
  it.each([
    ['is_error', { is_error: true }],
    ['isError', { isError: true }],
    ['structured error envelope', { error: { category: 'business' } }],
  ])(
    'does not record %s tool responses as successes',
    (_label, toolResponse) => {
      const ledger = new RunScopedToolSuccessLedger();

      recordSuccessfulToolUse(
        { tool_name: 'mcp__gantry__send_message', tool_response: toolResponse },
        ledger,
      );

      expect(ledger.hasSuccess('send_message')).toBe(false);
    },
  );

  it('records successful tool responses', () => {
    const ledger = new RunScopedToolSuccessLedger();

    recordSuccessfulToolUse(
      {
        tool_name: 'mcp__gantry__send_message',
        tool_response: { content: [{ type: 'text', text: 'sent' }] },
      },
      ledger,
    );

    expect(ledger.hasSuccess('send_message')).toBe(true);
  });
});

describe('Claude query loop permission approval context', () => {
  it.each([
    [
      'classifier',
      'Permission allowed (decided by: auto_classifier; risk: low)',
    ],
    ['human', 'Permission allowed (decided by: owner)'],
  ])(
    'returns %s provenance as model-visible additionalContext',
    async (_label, provenance) => {
      const channel = createPermissionApprovalContextChannel();
      channel.record('tool-use-1', provenance);

      await expect(
        channel.postToolUse(
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            tool_response: 'ok',
            tool_use_id: 'tool-use-1',
          } as never,
          'tool-use-1',
          { signal: new AbortController().signal },
        ),
      ).resolves.toEqual({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: provenance,
        },
      });
    },
  );

  it('adds no context for a silent birthright allow', async () => {
    const channel = createPermissionApprovalContextChannel();

    await expect(
      channel.postToolUse(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__gantry__render_table',
          tool_input: {},
          tool_response: 'rendered',
          tool_use_id: 'tool-use-birthright',
        } as never,
        'tool-use-birthright',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ continue: true });
  });

  it('removes approval context after the matching tool result', async () => {
    const channel = createPermissionApprovalContextChannel();
    channel.record(
      'tool-use-1',
      'Permission allowed (decided by: auto_classifier; risk: low)',
    );
    const hookInput = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: 'ok',
      tool_use_id: 'tool-use-1',
    } as const;

    await channel.postToolUse(hookInput as never, 'tool-use-1', {
      signal: new AbortController().signal,
    });

    await expect(
      channel.postToolUse(hookInput as never, 'tool-use-1', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ continue: true });
  });

  it('surfaces and consumes approval context when an allowed tool fails', async () => {
    const channel = createPermissionApprovalContextChannel();
    const provenance = 'Permission allowed (decided by: owner)';
    channel.record('tool-use-failed', provenance);
    const hookInput = {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'tool-use-failed',
      error: 'command failed',
    } as const;

    await expect(
      channel.postToolUse(hookInput as never, 'tool-use-failed', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: provenance,
      },
    });

    await expect(
      channel.postToolUse(hookInput as never, 'tool-use-failed', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ continue: true });
  });
});
