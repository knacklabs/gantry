import dns from 'node:dns/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { WORKSPACE_FOLDER_OPTION_KEY } =
  await import('@core/adapters/llm/anthropic-claude-agent/runner/types.js');

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

function combinedConsoleOutput(): string {
  return [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]
    .map((call) => String(call[0]))
    .join('');
}

describe('createCanUseToolCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '104.16.30.34', family: 4 },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows direct-mode SDK network access to a public host through the egress gateway', async () => {
    const host = 'registry.npmjs.org';
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: false,
        appId: 'default',
        agentId: 'agent:test',
        runId: 'run-1',
        chatJid: 'tg:test',
        allowedTools: [],
        egressDenylist: ['blocked.example'],
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
    });

    const network = await canUseTool(
      'SandboxNetworkAccess',
      { host },
      makePermissionOptions({
        toolUseID: 'toolu_network_1',
        agentID: 'agent:test',
      }) as never,
    );

    expect(network).toEqual({
      behavior: 'allow',
      updatedInput: { host },
    });
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
    expect(dns.lookup).toHaveBeenCalledWith(host, {
      all: true,
      verbatim: true,
    });
  });

  it('denies direct-mode SDK network access to localhost by name', async () => {
    const network = await makeCallback()(
      'SandboxNetworkAccess',
      { host: 'LOCALHOST.' },
      makePermissionOptions({ toolUseID: 'toolu_network_localhost' }) as never,
    );

    expect(network).toEqual({
      behavior: 'deny',
      message: 'Host localhost is a loopback hostname.',
      interrupt: false,
    });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '10.20.30.40', '169.254.169.254'])(
    'denies direct-mode SDK network access when DNS resolves to %s',
    async (address) => {
      vi.mocked(dns.lookup).mockResolvedValueOnce([{ address, family: 4 }]);

      const network = await makeCallback()(
        'SandboxNetworkAccess',
        { host: 'private-target.example' },
        makePermissionOptions({
          toolUseID: 'toolu_network_resolved_private',
        }) as never,
      );

      expect(network).toEqual({
        behavior: 'deny',
        message: `Host private-target.example resolved to non-public address ${address}.`,
        interrupt: false,
      });
    },
  );

  it('strips an authority port before resolving and denies a private destination', async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([
      { address: '10.20.30.40', family: 4 },
    ]);

    const network = await makeCallback()(
      'SandboxNetworkAccess',
      { host: 'private-target.example:8443' },
      makePermissionOptions({ toolUseID: 'toolu_network_authority' }) as never,
    );

    expect(network).toEqual({
      behavior: 'deny',
      message:
        'Host private-target.example resolved to non-public address 10.20.30.40.',
      interrupt: false,
    });
    expect(dns.lookup).toHaveBeenCalledWith('private-target.example', {
      all: true,
      verbatim: true,
    });
  });

  it('denies direct-mode SDK network access when DNS resolution fails', async () => {
    vi.mocked(dns.lookup).mockRejectedValueOnce(new Error('lookup failed'));

    const network = await makeCallback()(
      'SandboxNetworkAccess',
      { host: 'unresolvable.example' },
      makePermissionOptions({ toolUseID: 'toolu_network_unresolved' }) as never,
    );

    expect(network).toEqual({
      behavior: 'deny',
      message:
        'SDK sandbox network access could not safely resolve unresolvable.example.',
      interrupt: false,
    });
  });

  it('denies direct-mode SDK network access when the target cannot be resolved safely', async () => {
    const network = await makeCallback()(
      'SandboxNetworkAccess',
      { host: 'https://invalid.example/path' },
      makePermissionOptions({ toolUseID: 'toolu_network_invalid' }) as never,
    );

    expect(network).toEqual({
      behavior: 'deny',
      message:
        'SDK sandbox network access could not safely resolve https://invalid.example/path.',
      interrupt: false,
    });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('denies direct-mode SDK network access to a non-public address', async () => {
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: false,
        appId: 'default',
        agentId: 'agent:test',
        runId: 'run-1',
        chatJid: 'tg:test',
        allowedTools: [],
        egressDenylist: [],
        yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
      } as never,
    });

    const network = await canUseTool(
      'SandboxNetworkAccess',
      { host: '10.0.0.7' },
      makePermissionOptions({ toolUseID: 'toolu_network_private' }) as never,
    );

    expect(network).toEqual({
      behavior: 'deny',
      message: 'Host 10.0.0.7 resolved to non-public address 10.0.0.7.',
      interrupt: false,
    });
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('denies direct-mode SDK network access to a denylisted WebFetch host', async () => {
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: false,
        appId: 'default',
        agentId: 'agent:test',
        runId: 'run-1',
        chatJid: 'tg:test',
        allowedTools: [],
        egressDenylist: ['blocked.example'],
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
    });

    const network = await canUseTool(
      'SandboxNetworkAccess',
      { host: 'blocked.example', parentToolUseID: 'toolu_webfetch_1' },
      makePermissionOptions({
        toolUseID: 'toolu_network_1',
        parentToolUseID: 'toolu_webfetch_1',
      }) as never,
    );

    expect(network).toEqual({
      behavior: 'deny',
      message:
        'Host blocked.example matched permissions.egress.denylist pattern blocked.example.',
      interrupt: false,
    });
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
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

  it('passes the workspace folder under the shared permission-IPC key', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_once',
      updatedPermissions: undefined,
      decidedBy: 'user',
    });

    const canUseTool = makeCallback({ workspaceFolder: '/repo' });
    await canUseTool(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions() as never,
    );

    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ [WORKSPACE_FOLDER_OPTION_KEY]: '/repo' }),
    );
  });

  it('prompts when a yolo denylist command matches an existing allow rule', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: false,
      reason: 'operator denied',
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
        allowedTools: ['RunCommand(npm test *)'],
        yoloMode: {
          enabled: true,
          denylist: ['npm test --danger *'],
          denylistPaths: [],
        },
      } as never,
    });

    const result = await canUseTool(
      'Bash',
      { command: 'npm test --danger now' },
      makePermissionOptions() as never,
    );

    expect(result).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('operator denied'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionReason: expect.stringContaining('YOLO-mode denylist'),
        // No "Allow for future": a persisted rule would never be honored
        // while the denylist keeps blocking rule-based auto-allows.
        suggestions: undefined,
      }),
    );
    expect(combinedConsoleOutput()).toContain(
      '"eventType":"permission.yolo_denylist_hit"',
    );
    expect(combinedConsoleOutput()).toContain(
      '"matchedPattern":"npm test --danger *"',
    );
  });

  it('auto-allows a non-denylisted command matching the same allow rule', async () => {
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
        allowedTools: ['RunCommand(npm test *)'],
        yoloMode: {
          enabled: true,
          denylist: ['npm test --danger *'],
          denylistPaths: [],
        },
      } as never,
    });

    const result = await canUseTool(
      'Bash',
      { command: 'npm test --safe now' },
      makePermissionOptions() as never,
    );

    expect(result).toEqual(
      expect.objectContaining({
        behavior: 'allow',
        updatedInput: expect.objectContaining({
          command: expect.stringContaining('npm test --safe now'),
        }),
      }),
    );
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
    expect(combinedConsoleOutput()).not.toContain(
      'permission.yolo_denylist_hit',
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
        { command: 'npm test' },
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

  it('allows scheduled jobs to read local time without a custom command grant', async () => {
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
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
    });

    await expect(
      canUseTool(
        'Bash',
        { command: 'TZ=Asia/Kolkata date +"%Y-%m-%d %H:%M"' },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: 'allow',
        updatedInput: expect.objectContaining({
          command: expect.stringContaining('date +"%Y-%m-%d %H:%M"'),
        }),
      }),
    );
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('offers persistent access in autonomous job prompts with suggestions', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_once',
      updatedPermissions: undefined,
      decidedBy: 'user',
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
        { command: 'npm test' },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(expect.objectContaining({ behavior: 'allow' }));

    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
      }),
    );
  });

  it('denies exact facade access in autonomous jobs without permission prompts', async () => {
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

    const decision = await canUseTool(
      'Read',
      { file_path: 'package.json' },
      makePermissionOptions({ displayName: 'Read' }) as never,
    );
    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
        message: expect.stringContaining(
          'Exact tool grants are not accepted as durable authority.',
        ),
      }),
    );

    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('returns nonpersistent autonomous Bash denials without pausing the job', async () => {
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
        allowedTools: [
          'RunCommand(/Users/example/runtime/scripts/append-lead.py *)',
        ],
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

  it('auto-denies un-provisioned tools for a locked agent without prompting', async () => {
    const canUseTool = makeCallback({
      capabilities: {
        allowedTools: [],
        alwaysAllowedTools: [],
        permissionMode: 'deny',
      } as never,
    });

    const decision = await canUseTool(
      'Bash',
      { command: 'npm install left-pad' },
      makePermissionOptions() as never,
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
        message: expect.stringContaining('capability not provisioned'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
    expect(combinedConsoleOutput()).toContain(
      'Permission auto-denied by locked access preset',
    );
  });

  it('auto-denies native Agent tools for a locked agent without prompting', async () => {
    const canUseTool = makeCallback({
      capabilities: {
        allowedTools: [],
        alwaysAllowedTools: [],
        permissionMode: 'deny',
      } as never,
    });

    const decision = await canUseTool(
      'Agent',
      { prompt: 'summarize this run' },
      makePermissionOptions({ displayName: 'Agent' }) as never,
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        interrupt: false,
        message: expect.stringContaining('capability not provisioned'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('does not auto-allow native Agent without the Gantry wrapper path', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: false,
      reason: 'Delegation executor unavailable.',
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
        allowedTools: ['AgentDelegation'],
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
      capabilities: {
        allowedTools: ['AgentDelegation'],
        alwaysAllowedTools: [],
        permissionMode: 'default',
      } as never,
    });

    const decision = await canUseTool(
      'Agent',
      { prompt: 'summarize this run' },
      makePermissionOptions({ displayName: 'Agent' }) as never,
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('Delegation executor unavailable.'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'AgentDelegation',
        displayName: 'AgentDelegation',
      }),
    );
  });

  it('hard-denies native Task subagent aliases without approval fallback', async () => {
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
        allowedTools: ['AgentDelegation'],
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
      capabilities: {
        allowedTools: ['AgentDelegation'],
        alwaysAllowedTools: [],
        permissionMode: 'default',
      } as never,
    });

    const decision = await canUseTool(
      'Task',
      { prompt: 'summarize this run' },
      makePermissionOptions({ displayName: 'Task' }) as never,
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('Use the Agent tool'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('still allows pre-provisioned tools for a locked agent', async () => {
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
        allowedTools: ['mcp__provisioned__lookup'],
        yoloMode: {
          enabled: false,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
      capabilities: {
        allowedTools: [],
        alwaysAllowedTools: [],
        permissionMode: 'deny',
      } as never,
    });

    const decision = await canUseTool(
      'mcp__provisioned__lookup',
      { query: 'order status' },
      makePermissionOptions({ displayName: 'lookup' }) as never,
    );

    expect(decision.behavior).toBe('allow');
    expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
  });
});
