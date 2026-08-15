import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_ENGINE } from '../../../src/shared/agent-engine.js';

const permissionMock = vi.hoisted(() => ({
  requestPermissionApproval: vi.fn(),
}));

vi.mock(
  '@core/adapters/llm/anthropic-claude-agent/runner/permission-callback.js',
  () => ({
    requestPermissionApproval: permissionMock.requestPermissionApproval,
  }),
);

const { createCanUseToolCallback } =
  await import('@core/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.js');

const SUPPRESSED_MEMORY =
  '<gantry_memory_context>[suppressed: instruction-like memory content]</gantry_memory_context>';

describe('Anthropic scheduled denial guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('emits a typed terminal denial for removed native Task tools', async () => {
    const output: unknown[] = [];
    vi.mocked(console.log).mockImplementation((value) => {
      if (typeof value === 'string' && value.startsWith('{')) {
        output.push(JSON.parse(value));
      }
    });
    const canUseTool = createCanUseToolCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: true,
        appId: 'default',
        agentId: 'agent:test',
        runId: 'run-1',
        jobId: 'job-1',
        chatJid: 'tg:test',
        allowedTools: ['AgentDelegation'],
        yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
      } as never,
      sdkEnv: {},
      workspaceFolder: '/repo',
      memoryBlock: '',
      capabilities: {
        allowedTools: ['AgentDelegation'],
        alwaysAllowedTools: [],
      },
      primeToolAttempts: [],
      getNewSessionId: () => undefined,
      emitInteractionBoundary: vi.fn(),
      recordToolActivity: vi.fn(),
      recordPermissionApprovalContext: vi.fn(),
    });

    await expect(
      canUseTool('Task', { prompt: 'summarize this run' }, {
        title: 'Delegate',
        displayName: 'Task',
        description: 'Delegate work',
        decisionReason: 'Needs delegation',
        suggestions: [],
        toolUseID: 'tool-use-1',
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({ behavior: 'deny', interrupt: true });

    expect(output).toContainEqual(
      expect.objectContaining({
        runtimeEvents: [
          expect.objectContaining({
            payload: expect.objectContaining({
              phase: 'permission_denied',
              tool: 'Task',
              terminal: true,
              action: expect.objectContaining({ kind: 'instruction' }),
              denial_kind: 'rule_denied',
              provenance_lane: DEFAULT_AGENT_ENGINE,
              provenance_seam: 'gate',
            }),
          }),
        ],
      }),
    );
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'protected capability',
      toolName: 'Config',
      publicToolName: 'Config',
      toolInput: { setting: 'permissions.defaultMode' },
      memoryBlock: '',
      reason: 'Denied by Gantry tool execution policy',
    },
    {
      name: 'memory boundary',
      toolName: 'Bash',
      publicToolName: 'RunCommand',
      toolInput: { command: 'echo bearer token' },
      memoryBlock: SUPPRESSED_MEMORY,
      reason: 'Denied by Gantry memory boundary',
    },
  ])(
    'emits a typed terminal denial for the $name guard',
    async ({ toolName, publicToolName, toolInput, memoryBlock, reason }) => {
      const output: unknown[] = [];
      vi.mocked(console.log).mockImplementation((value) => {
        if (typeof value === 'string' && value.startsWith('{')) {
          output.push(JSON.parse(value));
        }
      });
      const canUseTool = createCanUseToolCallback({
        agentInput: {
          runMode: 'normal',
          isScheduledJob: true,
          appId: 'default',
          agentId: 'agent:test',
          runId: 'run-1',
          jobId: 'job-1',
          chatJid: 'tg:test',
          allowedTools: [],
          yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
        } as never,
        sdkEnv: {},
        workspaceFolder: '/repo',
        memoryBlock,
        capabilities: { allowedTools: [], alwaysAllowedTools: [] },
        primeToolAttempts: [],
        getNewSessionId: () => undefined,
        emitInteractionBoundary: vi.fn(),
        recordToolActivity: vi.fn(),
        recordPermissionApprovalContext: vi.fn(),
      });

      await expect(
        canUseTool(toolName, toolInput, {
          title: toolName,
          displayName: toolName,
          description: 'Guard test',
          decisionReason: 'Guard test',
          suggestions: [],
          toolUseID: 'tool-use-1',
          signal: new AbortController().signal,
        } as never),
      ).resolves.toMatchObject({
        behavior: 'deny',
        interrupt: true,
        message: expect.stringContaining(reason),
      });
      expect(output).toContainEqual(
        expect.objectContaining({
          runtimeEvents: [
            expect.objectContaining({
              payload: expect.objectContaining({
                phase: 'permission_denied',
                tool: publicToolName,
                terminal: true,
                denial_kind: 'rule_denied',
                provenance_lane: DEFAULT_AGENT_ENGINE,
                provenance_seam: 'gate',
                action: expect.objectContaining({
                  kind: 'instruction',
                  text: expect.stringContaining(reason),
                }),
              }),
            }),
          ],
        }),
      );
      expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
    },
  );
});
