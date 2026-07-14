import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const INLINE_DATA_DIR = vi.hoisted(
  () => `/tmp/gantry-inline-unit-${process.pid}`,
);
const revokeGatewayToken = vi.hoisted(() => vi.fn(async () => undefined));
const inlineAgentSettings = vi.hoisted(() => ({
  current: {} as {
    maxTurns?: number;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    configuredThinking?: { mode: 'off' | 'on'; budgetTokens?: number };
    maxOutputTokens?: number;
    permissionMode?: 'ask' | 'auto';
  },
}));

vi.mock('@core/config/index.js', () => ({
  DATA_DIR: INLINE_DATA_DIR,
}));

vi.mock('@core/runtime/agent-spawn-host.js', () => ({
  prepareInlineAgentHostContext: vi.fn(async () => ({
    ...inlineAgentSettings.current,
    dataDir: INLINE_DATA_DIR,
    defaultTimeoutMs: 10_000,
    idleTimeoutMs: 10_000,
    sandboxProvider: 'direct',
    compiledSystemPrompt: 'compiled system prompt',
    modelWorkload: 'chat',
    resolvedModel: {
      ok: true,
      value: {
        agentEngine: 'test-engine',
        executionProviderId: 'test-execution',
        runnerModel: 'test-model',
        modelEntry: { modelRoute: { id: 'test-route' } },
      },
    },
  })),
  getHostRuntimeCredentialEnv: vi.fn(async () => ({
    env: { GANTRY_TEST_MODEL_TOKEN: 'gtw_test' },
    credentialProviders: {},
    brokerApplied: true,
    brokerProfile: 'gantry',
    revoke: revokeGatewayToken,
  })),
}));

vi.mock('@core/runtime/agent-spawn-admission.js', () => ({
  validateAgentPreSpawnAdmission: vi.fn(() => null),
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import type { ConversationRoute } from '@core/domain/types.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import {
  INLINE_AGENT_LOOP_NOT_AVAILABLE,
  InMemoryInlineRunnerControlPort,
  configureDefaultInlineAgentLoopLane,
  runInlineAgent,
  type InlineAgentLoopLane,
} from '@core/runtime/agent-inline.js';
import type {
  AgentInput,
  AgentOutput,
} from '@core/runtime/agent-spawn-types.js';
import { GroupQueue } from '@core/runtime/group-queue.js';

const group: ConversationRoute = {
  name: 'Inline Test',
  folder: 'inline-test',
  trigger: '@inline',
  added_at: new Date(0).toISOString(),
};

const agentInput: AgentInput = {
  prompt: 'hello',
  workspaceFolder: group.folder,
  chatJid: 'conversation-1',
  runtime: 'inline',
};

function options(inlineAgentLoopLane?: InlineAgentLoopLane) {
  return {
    runnerSandboxProvider: { id: 'direct', enforcing: true } as never,
    ...(inlineAgentLoopLane ? { inlineAgentLoopLane } : {}),
  };
}

const settleWhenAborted: InlineAgentLoopLane = ({ signal }) =>
  new Promise<AgentOutput>((resolve) => {
    const settle = () => resolve({ status: 'success', result: null });
    if (signal.aborted) settle();
    else signal.addEventListener('abort', settle, { once: true });
  });

describe('runInlineAgent', () => {
  beforeEach(() => {
    revokeGatewayToken.mockClear();
    inlineAgentSettings.current = {};
    fs.rmSync(INLINE_DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    configureDefaultInlineAgentLoopLane(undefined);
    fs.rmSync(INLINE_DATA_DIR, { recursive: true, force: true });
  });

  it('preserves every AgentOutput terminal field on success', async () => {
    const terminal = {
      status: 'success',
      result: 'done',
      error: 'non-terminal detail',
      providerSession: { externalSessionId: 'provider-session-1' },
      newSessionId: 'provider-session-1',
      sessionInit: true,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalBillableInputTokens: 11,
        cacheProvider: 'none',
        cacheStatus: 'not_supported',
        at: new Date(0).toISOString(),
      },
      usageEventId: 'usage-1',
      contextUsage: {
        totalTokens: 15,
        maxTokens: 100,
        percentage: 15,
        categories: [{ name: 'input', tokens: 15 }],
      },
      runtimeEvents: [{ eventType: 'test.event', payload: { ok: true } }],
      compactBoundary: true,
      interactionBoundary: 'user_interaction',
      continuedByFollowup: true,
    } as AgentOutput;

    const output = await runInlineAgent(
      group,
      agentInput,
      vi.fn(),
      undefined,
      options(async () => terminal),
    );

    expect(output).toEqual(terminal);
    expect(revokeGatewayToken).toHaveBeenCalledOnce();
  });

  it('preserves a structured error returned by the lane seam', async () => {
    const terminal: AgentOutput = {
      status: 'error',
      result: null,
      error: 'model failed',
      newSessionId: 'provider-session-2',
      interactionBoundary: 'user_interaction',
    };

    await expect(
      runInlineAgent(
        group,
        agentInput,
        vi.fn(),
        undefined,
        options(async () => terminal),
      ),
    ).resolves.toEqual({
      ...terminal,
      providerSession: { externalSessionId: 'provider-session-2' },
    });
  });

  it('converts a thrown lane error into terminal AgentOutput semantics', async () => {
    const output = await runInlineAgent(
      group,
      agentInput,
      vi.fn(),
      undefined,
      options(() => {
        throw new Error('lane exploded');
      }),
    );

    expect(output).toEqual({
      status: 'error',
      result: null,
      error: 'Inline agent loop failed: lane exploded',
    });
    expect(revokeGatewayToken).toHaveBeenCalledOnce();
  });

  it('returns worker-compatible abort semantics and revokes credentials', async () => {
    const output = await runInlineAgent(
      group,
      agentInput,
      (handle) => handle.kill(),
      undefined,
      options(() => new Promise<AgentOutput>(() => {})),
    );

    expect(output).toEqual({
      status: 'error',
      result: null,
      error: 'Inline agent stopped because the run was aborted',
    });
    expect(revokeGatewayToken).toHaveBeenCalledOnce();
  });

  it('waits for the inline lane to acknowledge cancellation', async () => {
    let releaseLane: (() => void) | undefined;
    const lane = vi.fn(
      () =>
        new Promise<AgentOutput>((resolve) => {
          releaseLane = () => resolve({ status: 'success', result: null });
        }),
    );
    let handle: Parameters<Parameters<typeof runInlineAgent>[2]>[0] | undefined;
    const resultPromise = runInlineAgent(
      group,
      agentInput,
      (registeredHandle) => {
        handle = registeredHandle;
      },
      undefined,
      options(lane),
    );
    await vi.waitFor(() => expect(lane).toHaveBeenCalledOnce());

    handle?.kill();
    const resolved = vi.fn();
    void resultPromise.then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    releaseLane?.();
    await expect(resultPromise).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('run was aborted'),
    });
  });

  it('times out a lane that does not settle', async () => {
    const output = await runInlineAgent(group, agentInput, vi.fn(), undefined, {
      ...options(settleWhenAborted),
      timeoutMs: 5,
    });

    expect(output.status).toBe('error');
    expect(output.result).toBeNull();
    expect(output.error).toContain('Inline agent timed out after');
  });

  it('returns a structured unavailable error from the unimplemented lane seam', async () => {
    const output = await runInlineAgent(
      group,
      agentInput,
      vi.fn(),
      undefined,
      options(),
    );

    expect(output).toEqual({
      status: 'error',
      result: null,
      error: `${INLINE_AGENT_LOOP_NOT_AVAILABLE}: Inline agent loop lanes are not available in this build.`,
    });
  });

  it('uses the configured default inline lane when no per-run override exists', async () => {
    const lane = vi.fn<InlineAgentLoopLane>(async () => ({
      status: 'success',
      result: 'default lane',
    }));
    configureDefaultInlineAgentLoopLane(lane);

    await expect(
      runInlineAgent(group, agentInput, vi.fn(), undefined, options()),
    ).resolves.toMatchObject({
      status: 'success',
      result: 'default lane',
    });
    expect(lane).toHaveBeenCalledOnce();
  });

  it('threads the selected inline agent iteration settings to the lane', async () => {
    inlineAgentSettings.current = {
      maxTurns: 7,
      effort: 'high',
      configuredThinking: { mode: 'on', budgetTokens: 2048 },
      maxOutputTokens: 4096,
    };
    const lane = vi.fn<InlineAgentLoopLane>(async () => ({
      status: 'success',
      result: null,
    }));

    await runInlineAgent(group, agentInput, vi.fn(), undefined, options(lane));

    expect(lane).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 7,
        effort: 'high',
        configuredThinking: { mode: 'on', budgetTokens: 2048 },
        maxOutputTokens: 4096,
      }),
    );
  });

  it('passes the host-resolved permission mode to the inline lane', async () => {
    inlineAgentSettings.current = { permissionMode: 'auto' };
    const lane = vi.fn<InlineAgentLoopLane>(async () => ({
      status: 'success',
      result: null,
    }));

    await runInlineAgent(
      group,
      { ...agentInput, permissionMode: 'ask' },
      vi.fn(),
      undefined,
      options(lane),
    );

    expect(lane).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ permissionMode: 'auto' }),
      }),
    );
  });

  it('threads skill storage dependencies to the lane', async () => {
    const lane = vi.fn<InlineAgentLoopLane>(async () => ({
      status: 'success',
      result: null,
    }));
    const skillRepository = {} as never;
    const skillArtifactStore = {} as never;
    const skillContext = { appId: 'app-1', agentId: 'agent-1' };

    await runInlineAgent(group, agentInput, vi.fn(), undefined, {
      ...options(lane),
      skillRepository,
      skillArtifactStore,
      skillContext,
    });

    expect(lane).toHaveBeenCalledWith(
      expect.objectContaining({
        skillRepository,
        skillArtifactStore,
        skillContext,
      }),
    );
  });

  it('emits a synthetic scheduled-job heartbeat', async () => {
    const streamed: AgentOutput[] = [];
    await runInlineAgent(
      group,
      {
        ...agentInput,
        appId: 'app-1',
        agentId: 'agent-1',
        isScheduledJob: true,
        jobId: 'job-1',
        runId: 'run-1',
      },
      vi.fn(),
      async (output) => {
        streamed.push(output);
      },
      options(async () => ({ status: 'success', result: null })),
    );

    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toMatchObject({
      status: 'success',
      result: null,
      runtimeEventOnly: true,
      runtimeEvents: [
        {
          eventType: RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
          appId: 'app-1',
          agentId: 'agent-1',
          jobId: 'job-1',
          runId: 'run-1',
          payload: {
            lastActivityAgoMs: expect.any(Number),
            pendingPermissionRequests: 0,
          },
        },
      ],
    });
  });

  it('keeps a scheduled run alive while an inline permission prompt is pending', async () => {
    vi.useFakeTimers();
    const previousIdleTimeout =
      process.env.GANTRY_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
    process.env.GANTRY_SCHEDULED_JOB_IDLE_TIMEOUT_MS = '60000';
    const streamed: AgentOutput[] = [];
    let releaseLane: (() => void) | undefined;
    let markLaneStarted: (() => void) | undefined;
    const laneStarted = new Promise<void>((resolve) => {
      markLaneStarted = resolve;
    });
    try {
      const run = runInlineAgent(
        group,
        {
          ...agentInput,
          appId: 'app-1',
          agentId: 'agent-1',
          isScheduledJob: true,
          jobId: 'job-1',
          runId: 'run-1',
        },
        vi.fn(),
        async (output) => {
          streamed.push(output);
        },
        options(async ({ jobActivity, emitOutput }) => {
          await emitOutput({
            status: 'success',
            result: null,
            runtimeEventOnly: true,
            runtimeEvents: [
              {
                eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
                payload: { phase: 'started', tool: 'AgentDelegation' },
              },
            ],
          });
          jobActivity.beginPermissionRequest('permission-1', 'AgentDelegation');
          markLaneStarted?.();
          await new Promise<void>((resolve) => {
            releaseLane = resolve;
          });
          jobActivity.finishPermissionRequest('permission-1');
          return { status: 'success', result: null };
        }),
      );
      let settled = false;
      void run.finally(() => {
        settled = true;
      });

      await laneStarted;
      await vi.advanceTimersByTimeAsync(75_000);

      expect(settled).toBe(false);
      expect(streamed.at(-1)).toMatchObject({
        runtimeEvents: [
          {
            eventType: RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
            payload: {
              lastTool: 'AgentDelegation',
              pendingPermissionRequests: 1,
              pendingPermissionToolNames: ['AgentDelegation'],
              totalToolCalls: 1,
            },
          },
        ],
      });

      releaseLane?.();
      await expect(run).resolves.toMatchObject({ status: 'success' });
    } finally {
      releaseLane?.();
      if (previousIdleTimeout === undefined) {
        delete process.env.GANTRY_SCHEDULED_JOB_IDLE_TIMEOUT_MS;
      } else {
        process.env.GANTRY_SCHEDULED_JOB_IDLE_TIMEOUT_MS = previousIdleTimeout;
      }
      vi.useRealTimers();
    }
  });

  it('narrows remote MCP projection to reviewed tool names', async () => {
    const record = {
      definition: {
        id: 'server-1',
        appId: 'app-1',
        name: 'crm',
        status: 'active',
        createdSource: 'admin',
        riskClass: 'low',
        transport: 'http',
        config: { transport: 'http', url: 'https://mcp.example.com' },
        allowedToolPatterns: ['read', 'write'],
        autoApproveToolPatterns: ['read', 'write'],
        credentialRefs: [],
        networkHosts: ['mcp.example.com:443'],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      binding: {
        id: 'binding-1',
        appId: 'app-1',
        agentId: 'agent-1',
        serverId: 'server-1',
        status: 'active',
        required: true,
        permissionPolicyIds: [],
        allowedToolPatterns: ['read', 'write'],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    };
    const repository = {
      listMaterializedServersForAgent: vi.fn(async () => [record]),
      appendAuditEvent: vi.fn(async () => undefined),
    };
    const lane = vi.fn<InlineAgentLoopLane>(async () => ({
      status: 'success',
      result: null,
    }));

    const exactScopeResult = await runInlineAgent(
      group,
      {
        ...agentInput,
        attachedMcpSourceIds: ['server-1'],
        runtimeAccess: [
          {
            selectedCapabilityId: 'crm.read',
            sourceType: 'mcp_server',
            auditLabel: 'CRM read',
            reviewedServerId: 'crm',
            allowedTools: ['mcp__crm__read'],
            credentialRefs: [],
            networkHosts: ['mcp.example.com:443'],
          },
        ],
      },
      vi.fn(),
      undefined,
      {
        ...options(lane),
        mcpServerRepository: repository as never,
        mcpContext: { appId: 'app-1', agentId: 'agent-1' },
        mcpHostnameLookup: vi.fn(async () => [
          { family: 4 as const, address: '93.184.216.34' },
        ]),
      },
    );

    expect(exactScopeResult).toEqual({ status: 'success', result: null });
    expect(lane).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [
          expect.objectContaining({
            name: 'crm',
            allowedToolNames: ['mcp__crm__read'],
            allowedToolPatterns: ['read'],
            autoApproveToolNames: ['mcp__crm__read'],
            autoApproveToolPatterns: ['read'],
          }),
        ],
      }),
    );

    record.definition.allowedToolPatterns = ['*'];
    record.definition.autoApproveToolPatterns = ['*'];
    record.binding.allowedToolPatterns = ['*'];
    lane.mockClear();
    await runInlineAgent(
      group,
      {
        ...agentInput,
        attachedMcpSourceIds: ['server-1'],
        runtimeAccess: [
          {
            selectedCapabilityId: 'crm.read',
            sourceType: 'mcp_server',
            auditLabel: 'CRM read',
            reviewedServerId: 'crm',
            allowedTools: ['mcp__crm__read'],
            credentialRefs: [],
            networkHosts: ['mcp.example.com:443'],
          },
        ],
      },
      vi.fn(),
      undefined,
      {
        ...options(lane),
        mcpServerRepository: repository as never,
        mcpContext: { appId: 'app-1', agentId: 'agent-1' },
        mcpHostnameLookup: vi.fn(async () => [
          { family: 4 as const, address: '93.184.216.34' },
        ]),
      },
    );

    expect(lane).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [
          expect.objectContaining({
            name: 'crm',
            allowedToolNames: ['mcp__crm__read'],
            allowedToolPatterns: ['read'],
            autoApproveToolNames: ['mcp__crm__read'],
            autoApproveToolPatterns: ['read'],
          }),
        ],
      }),
    );
  });

  it('creates only the sessions log layout for inline execution', async () => {
    await runInlineAgent(
      group,
      agentInput,
      vi.fn(),
      undefined,
      options(async () => ({ status: 'success', result: null })),
    );

    expect(
      fs
        .statSync(path.join(INLINE_DATA_DIR, 'sessions', group.folder, 'logs'))
        .isDirectory(),
    ).toBe(true);
    expect(fs.existsSync(path.join(INLINE_DATA_DIR, 'ipc'))).toBe(false);
    expect(fs.existsSync(path.join(INLINE_DATA_DIR, 'agents'))).toBe(false);
  });

  it('is stoppable after GroupQueue registers its inline run handle', async () => {
    const queue = new GroupQueue();
    let terminal: AgentOutput | undefined;
    const registered = vi.fn();
    queue.setProcessMessagesFn(async (groupJid) => {
      terminal = await runInlineAgent(
        group,
        agentInput,
        (handle, runHandle) => {
          queue.registerProcess(groupJid, handle, runHandle, group.folder);
          registered();
        },
        undefined,
        options(settleWhenAborted),
      );
      return true;
    });

    queue.enqueueMessageCheck(agentInput.chatJid);
    await vi.waitFor(() => expect(registered).toHaveBeenCalledOnce());
    expect(queue.stopGroup(agentInput.chatJid)).toBe(true);
    await vi.waitFor(() => expect(terminal?.status).toBe('error'));
    expect(terminal?.error).toContain('stopped by request');
  });
});

describe('InMemoryInlineRunnerControlPort', () => {
  it('delivers buffered continuation and close signals without filesystem IPC', () => {
    const port = new InMemoryInlineRunnerControlPort();
    const continuation = {
      workspaceFolder: group.folder,
      text: 'steer here',
      sequence: 7,
      threadId: 'thread-1',
    };
    port.writeContinuationInput(continuation);
    port.writeCloseSignal({ workspaceFolder: group.folder });

    const onContinuation = vi.fn();
    const onClose = vi.fn();
    port.subscribe({ onContinuation, onClose });

    expect(onContinuation).toHaveBeenCalledWith(continuation);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
