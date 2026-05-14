import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const permissionMock = vi.hoisted(() => ({
  requestPermissionApproval: vi.fn(),
}));

vi.mock('@core/runner/claude/permission-callback.js', () => ({
  requestPermissionApproval: permissionMock.requestPermissionApproval,
}));

const { createCanUseToolCallback } =
  await import('@core/runner/claude/tool-permission-gate.js');

function makePermissionOptions() {
  return {
    title: 'Run command',
    displayName: 'Bash',
    description: 'Run a command',
    decisionReason: 'Needs approval',
    suggestions: [],
    toolUseID: 'tool-use-1',
    signal: new AbortController().signal,
  };
}

function makeCallback(
  overrides: Partial<Parameters<typeof createCanUseToolCallback>[0]> = {},
) {
  return createCanUseToolCallback({
    agentInput: {
      runMode: 'normal',
      isScheduledJob: false,
      appId: 'default',
      agentId: 'agent:test',
      runId: 'run-1',
      jobId: undefined,
      chatJid: 'tg:test',
      threadId: undefined,
      allowedTools: [],
    } as never,
    sdkEnv: {},
    workspaceFolder: '/repo',
    memoryBlock: '',
    capabilities: {
      allowedTools: [],
      alwaysAllowedTools: [],
    },
    primeToolAttempts: [],
    getNewSessionId: () => undefined,
    emitInteractionBoundary: vi.fn(),
    recordToolActivity: vi.fn(),
    ...overrides,
  });
}

describe('createCanUseToolCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scopes timed grants to exact input and keeps protected guards non-bypassable', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_timed_grant',
      timedGrantExpiresAtMs: Date.now() + 60_000,
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback();
    const first = await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );
    const second = await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );
    const protectedPath = await canUseTool(
      'Bash',
      { command: 'cat > .mcp.json' },
      makePermissionOptions() as never,
    );

    expect(first.behavior).toBe('allow');
    expect(second.behavior).toBe('allow');
    expect(protectedPath).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('protected capability target'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('interrupts scheduled jobs when autonomous permission is denied', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: false,
      reason: 'Autonomous permission approval is disabled for unattended jobs.',
      decisionClassification: 'user_reject',
    });
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: true,
        appId: 'default',
        agentId: 'agent:test',
        runId: 'run-1',
        jobId: 'job-1',
        chatJid: 'tg:test',
        threadId: undefined,
        allowedTools: [],
      } as never,
    });

    await expect(
      canUseTool(
        'Bash',
        { command: 'python3 ~/myclaw/agents/main_agent/scripts/dedup.py' },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: true,
        message: expect.stringContaining(
          'Permission denied: Autonomous permission approval',
        ),
      }),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('');
    expect(output).toContain('"phase":"permission_denied"');
    expect(output).toContain('"jobId":"job-1"');
  });
});
