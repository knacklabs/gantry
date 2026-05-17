import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const permissionMock = vi.hoisted(() => ({
  requestPermissionApproval: vi.fn(),
}));

vi.mock('@core/runner/claude/permission-callback.js', () => ({
  requestPermissionApproval: permissionMock.requestPermissionApproval,
}));

const { createCanUseToolCallback } =
  await import('@core/runner/claude/tool-permission-gate.js');

function makePermissionOptions(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Run command',
    displayName: 'Bash',
    description: 'Run a command',
    decisionReason: 'Needs approval',
    suggestions: [],
    toolUseID: 'tool-use-1',
    signal: new AbortController().signal,
    ...overrides,
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
      yoloMode: {
        enabled: true,
        denylist: [],
        denylistPaths: [],
      },
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

  it('scopes timed grants to all tools and keeps protected guards non-bypassable', async () => {
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
      'Read',
      { file_path: 'package.json' },
      makePermissionOptions() as never,
    );
    const network = await canUseTool(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      makePermissionOptions() as never,
    );
    const protectedPath = await canUseTool(
      'Bash',
      { command: 'cat > .mcp.json' },
      makePermissionOptions() as never,
    );

    expect(first.behavior).toBe('allow');
    expect(second.behavior).toBe('allow');
    expect(network.behavior).toBe('allow');
    expect(protectedPath).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('protected capability target'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('re-prompts after a timed tool grant expires', async () => {
    vi.useFakeTimers();
    permissionMock.requestPermissionApproval
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_timed_grant',
        timedGrantExpiresAtMs: Date.now() + 300_000,
        updatedPermissions: undefined,
        decidedBy: 'user',
      })
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_once',
        updatedPermissions: undefined,
        decidedBy: 'user',
      });

    const canUseTool = makeCallback();
    const first = await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );
    vi.setSystemTime(Date.now() + 301_000);
    const second = await canUseTool(
      'Bash',
      { command: 'npm run build' },
      makePermissionOptions() as never,
    );

    expect(first.behavior).toBe('allow');
    expect(second.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('re-prompts denylisted Bash commands during an active timed grant and audits the hit', async () => {
    permissionMock.requestPermissionApproval
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_timed_grant',
        timedGrantExpiresAtMs: Date.now() + 60_000,
        updatedPermissions: undefined,
        decidedBy: 'user',
      })
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_once',
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
      { command: 'rm -rf /' },
      makePermissionOptions() as never,
    );

    expect(first.behavior).toBe('allow');
    expect(second.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(2);
    expect(permissionMock.requestPermissionApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decisionReason: expect.stringContaining(
          'YOLO-mode denylist rule matched "rm -rf /"',
        ),
      }),
    );
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('');
    expect(output).toContain('permission.yolo_denylist_hit');
    expect(output).toContain('"matchedPattern":"rm -rf /"');
    expect(output).toContain('"principal":"agent:test"');
    expect(output).toContain('"conversationId":"tg:test"');
  });

  it('auto-approves non-denylisted Bash commands during an active timed grant', async () => {
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
      { command: 'ls' },
      makePermissionOptions() as never,
    );

    expect(first.behavior).toBe('allow');
    expect(second.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('re-prompts denylisted file paths during an active timed grant', async () => {
    permissionMock.requestPermissionApproval
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_timed_grant',
        timedGrantExpiresAtMs: Date.now() + 60_000,
        updatedPermissions: undefined,
        decidedBy: 'user',
      })
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_once',
        updatedPermissions: undefined,
        decidedBy: 'user',
      });

    const canUseTool = makeCallback();
    await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );
    const write = await canUseTool(
      'Write',
      { file_path: '/etc', content: 'x' },
      makePermissionOptions({ displayName: 'Write' }) as never,
    );

    expect(write.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(2);
    expect(permissionMock.requestPermissionApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decisionReason: expect.stringContaining(
          'YOLO-mode denylist rule matched "/etc/*"',
        ),
      }),
    );
  });

  it('auto-approves non-denylisted file paths during an active timed grant', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_timed_grant',
      timedGrantExpiresAtMs: Date.now() + 60_000,
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback();
    await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );
    const write = await canUseTool(
      'Write',
      { file_path: '~/x', content: 'x' },
      makePermissionOptions({ displayName: 'Write' }) as never,
    );

    expect(write.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('does not apply the YOLO denylist when disabled', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_timed_grant',
      timedGrantExpiresAtMs: Date.now() + 60_000,
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback({
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
        yoloMode: {
          enabled: false,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
    });
    await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );
    const deniedByDefault = await canUseTool(
      'Bash',
      { command: 'rm -rf /' },
      makePermissionOptions() as never,
    );

    expect(deniedByDefault.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('scopes timed grants to the Gantry agent even when SDK agent ids differ', async () => {
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
      makePermissionOptions({ agentID: 'subagent-a' }) as never,
    );
    const second = await canUseTool(
      'Read',
      { file_path: 'package.json' },
      makePermissionOptions({ agentID: 'subagent-b' }) as never,
    );

    expect(first.behavior).toBe('allow');
    expect(second.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('ignores overlong timed grant expiries from permission responses', async () => {
    permissionMock.requestPermissionApproval
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_timed_grant',
        timedGrantExpiresAtMs: Date.now() + 3_600_000,
        updatedPermissions: undefined,
        decidedBy: 'user',
      })
      .mockResolvedValueOnce({
        approved: true,
        mode: 'allow_once',
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
      'Read',
      { file_path: 'package.json' },
      makePermissionOptions() as never,
    );

    expect(first.behavior).toBe('allow');
    expect(second.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(2);
  });

  it('suppresses parentless SandboxNetworkAccess after an allow-once approved Bash tool call', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_once',
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback();
    const bash = await canUseTool(
      'Bash',
      { command: 'npm install' },
      makePermissionOptions({
        toolUseID: 'toolu_bash_1',
        agentID: 'subagent-a',
      }) as never,
    );
    const network = await canUseTool(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      makePermissionOptions({
        toolUseID: 'toolu_network_1',
        agentID: 'subagent-a',
      }) as never,
    );

    expect(bash.behavior).toBe('allow');
    expect(network).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'registry.npmjs.org' },
    });
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('does not suppress parentless SandboxNetworkAccess across SDK agent principals', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_once',
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback();
    const bash = await canUseTool(
      'Bash',
      { command: 'npm install' },
      makePermissionOptions({
        toolUseID: 'toolu_bash_1',
        agentID: 'subagent-a',
      }) as never,
    );
    const network = await canUseTool(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      makePermissionOptions({
        toolUseID: 'toolu_network_1',
        agentID: 'subagent-b',
      }) as never,
    );

    expect(bash.behavior).toBe('allow');
    expect(network).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('before any tool call was allowed'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('passes the runner conversation as the interactive permission target', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_once',
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback();
    await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );

    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'tg:test',
      }),
    );
  });

  it('denies wait-only Bash monitoring instead of asking for permission', async () => {
    const canUseTool = makeCallback();
    const result = await canUseTool(
      'Bash',
      {
        command:
          'echo "waiting for run completion..."; until_done() { while true; do sleep 30; done; }; echo "Will use scheduler tools to poll instead."',
      },
      makePermissionOptions() as never,
    );

    expect(result).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
        message: expect.stringContaining('scheduler_wait_for_events'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('does not deny Bash commands that perform work before sleeping', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_once',
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback();
    const result = await canUseTool(
      'Bash',
      { command: 'npm test; sleep 1' },
      makePermissionOptions() as never,
    );

    expect(result.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('interrupts autonomous runs when permission is denied', async () => {
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

  it('returns ungrantable autonomous Bash denials without pausing the job', async () => {
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
        allowedTools: ['Bash(/Users/example/runtime/scripts/append-lead.py *)'],
      } as never,
    });

    await expect(
      canUseTool(
        'Bash',
        {
          command:
            'python3 -c "import subprocess; subprocess.run([\\"/Users/example/runtime/scripts/append-lead.py\\", \\"[]\\"])"',
        },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
        message: expect.stringContaining(
          'cannot be durably approved for autonomous runs',
        ),
      }),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('');
    expect(output).toContain('"phase":"permission_denied"');
    expect(output).toContain('"terminal":false');
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });
});
