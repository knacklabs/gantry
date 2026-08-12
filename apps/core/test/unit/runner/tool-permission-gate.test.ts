import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const { attributedSkillActionRules } =
  await import('@core/adapters/llm/anthropic-claude-agent/runner/protected-capability-hook.js');
const { WORKSPACE_FOLDER_OPTION_KEY } =
  await import('@core/adapters/llm/anthropic-claude-agent/runner/types.js');
const { evaluatePermissionDeterministicRails } =
  await import('@core/domain/permission-deterministic-rails.js');
const { stripShellCommandEnvPrefix } =
  await import('@core/runtime/ipc-shell-command-prefix.js');
const { appendLiveToolRules } = await import('@core/shared/live-tool-rules.js');
const GANTRY_SKILL_ACTIONS_ENV = 'GANTRY_SKILL_ACTIONS_JSON';

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
    recordPermissionApprovalContext: vi.fn(),
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

function decideWrappedReadOnlyRequest(request: {
  toolInput?: unknown;
  hostInjectedCommandPrefix?: string;
}) {
  const toolInput = stripShellCommandEnvPrefix(
    'RunCommand',
    request.toolInput,
    request.hostInjectedCommandPrefix,
  );
  const decision = evaluatePermissionDeterministicRails({
    request: {
      requestId: 'permission-test',
      sourceAgentFolder: 'main_agent',
      toolName: 'RunCommand',
      toolInput,
    },
    approvedCapabilityIds: ['filesystem.read'],
  });
  return decision?.railOutcome === 'allow'
    ? decision
    : {
        approved: false,
        mode: 'cancel' as const,
        reason: 'wrapped command was not deterministically read-only',
        decidedBy: 'deterministic_rails',
      };
}

describe('createCanUseToolCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionMock.requestPermissionApproval.mockResolvedValue({
      approved: true,
      mode: 'allow_once',
    });
    vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '104.16.30.34', family: 4 },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.GANTRY_IPC_DIR;
    delete process.env.GANTRY_AGENT_RUN_HANDLE;
    delete process.env[GANTRY_SKILL_ACTIONS_ENV];
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
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
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

  it('passes the SDK tool-use abort signal into the permission wait', async () => {
    const controller = new AbortController();

    await makeCallback()(
      'Bash',
      { command: 'npm test' },
      makePermissionOptions({ signal: controller.signal }) as never,
    );

    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
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

  it.each([
    {
      provenance: {},
      message: 'Permission denied: operator denied',
    },
    {
      provenance: { decidedBy: 'human' },
      message: 'Permission denied (decided by: human): operator denied',
    },
    {
      provenance: { decidedBy: 'human', risk_level: 'high' },
      message:
        'Permission denied (decided by: human; risk: high): operator denied',
    },
    {
      provenance: {
        decidedBy: 'human',
        risk_level: 'high',
        risk_category: 'secret',
      },
      message:
        'Permission denied (decided by: human; risk: high/secret): operator denied',
    },
  ])(
    'omits absent provenance from a denied tool result: $message',
    async ({ provenance, message }) => {
      permissionMock.requestPermissionApproval.mockResolvedValueOnce({
        approved: false,
        mode: 'cancel',
        reason: 'operator denied',
        ...provenance,
      });

      const result = await makeCallback()(
        'Bash',
        { command: 'npm test' },
        makePermissionOptions() as never,
      );

      expect(result).toEqual(
        expect.objectContaining({
          behavior: 'deny',
          message,
        }),
      );
    },
  );

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

  it('routes a non-denylisted matching rule through the host coordinator', async () => {
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
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
    expect(combinedConsoleOutput()).not.toContain(
      'permission.yolo_denylist_hit',
    );
  });

  it('wraps and declares a fresh command for permission and execution', async () => {
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: false,
        appId: 'default',
        agentId: 'agent:test',
        runId: 'run-1',
        chatJid: 'tg:test',
        allowedTools: [],
        toolNetworkEnv: {
          HTTP_PROXY: 'http://127.0.0.1:18790/',
        },
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
    });

    const result = await canUseTool(
      'Bash',
      { command: 'curl https://example.test' },
      makePermissionOptions() as never,
    );
    const hostInjectedCommandPrefix =
      "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18790/'";

    const approvalRequest =
      permissionMock.requestPermissionApproval.mock.calls[0]?.[0];
    expect(approvalRequest).toMatchObject({
      toolInput: {
        command: `${hostInjectedCommandPrefix} curl https://example.test`,
      },
      hostInjectedCommandPrefix,
    });
    expect(result).toEqual(
      expect.objectContaining({
        behavior: 'allow',
        updatedInput: {
          command: `${hostInjectedCommandPrefix} curl https://example.test`,
        },
      }),
    );
  });

  it.each([
    {
      lane: 'job subagent lane',
      isScheduledJob: true,
      jobId: 'job-1',
      agentID: 'subagent-1',
    },
    {
      lane: 'interactive retry',
      isScheduledJob: false,
      jobId: undefined,
      agentID: undefined,
    },
  ])(
    'declares an already-wrapped read-only command on the $lane without double-wrapping',
    async ({ isScheduledJob, jobId, agentID }) => {
      const hostInjectedCommandPrefix =
        "GODEBUG=netdns=go HTTP_PROXY='http://127.0.0.1:18790/'";
      permissionMock.requestPermissionApproval.mockImplementationOnce(
        decideWrappedReadOnlyRequest,
      );
      const canUseTool = makeCallback({
        agentInput: {
          runMode: 'normal',
          isScheduledJob,
          appId: 'default',
          agentId: 'agent:test',
          runId: 'run-1',
          jobId,
          chatJid: 'tg:test',
          threadId: undefined,
          allowedTools: [],
          toolNetworkEnv: {
            HTTP_PROXY: 'http://127.0.0.1:18790/',
          },
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
          { command: `${hostInjectedCommandPrefix} uname -s` },
          makePermissionOptions({ ...(agentID ? { agentID } : {}) }) as never,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          behavior: 'allow',
          updatedInput: {
            command: `${hostInjectedCommandPrefix} uname -s`,
          },
        }),
      );
      expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolInput: {
            command: `${hostInjectedCommandPrefix} uname -s`,
          },
          hostInjectedCommandPrefix,
          ...(agentID ? { agentID } : {}),
        }),
      );
    },
  );

  it('does not silently allow a tool listed in allowedTools — the coordinator still decides', async () => {
    // PERM-2 Task F: a rule on the agent's configured allowedTools must not
    // mint a worker-side `allow` that skips the host coordinator. Even with a
    // matching allowedTools rule, the operator's coordinator decision governs:
    // deny it and the tool is denied.
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
        yoloMode: { enabled: false, denylist: [], denylistPaths: [] },
      } as never,
      capabilities: {
        allowedTools: ['RunCommand(npm test *)'],
        alwaysAllowedTools: ['RunCommand(npm test *)'],
        permissionMode: 'default',
      } as never,
    });

    const result = await canUseTool(
      'Bash',
      { command: 'npm test --safe now' },
      makePermissionOptions() as never,
    );

    expect(result).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('operator denied'),
      }),
    );
    // The coordinator was consulted exactly once for this "pre-allowed" tool.
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it.each(['mcp__gantry__mcp_call_tool', 'mcp__gantry__async_mcp_call'])(
    'passes %s to host-side target authorization without requesting wrapper approval',
    async (toolName) => {
      const decision = await makeCallback()(
        toolName,
        {
          serverName: 'ats-mcp-bearer',
          toolName: 'ats_list_positions',
          arguments: {},
        },
        makePermissionOptions({ displayName: toolName }) as never,
      );

      expect(decision).toEqual({
        behavior: 'allow',
        updatedInput: {
          serverName: 'ats-mcp-bearer',
          toolName: 'ats_list_positions',
          arguments: {},
        },
      });
      expect(permissionMock.requestPermissionApproval).not.toHaveBeenCalled();
    },
  );

  it('does not treat a non-Gantry MCP tool as a host-authorized dispatcher', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: false,
      reason: 'Denied by operator',
    });
    const decision = await makeCallback()(
      'mcp__third_party__mcp_call_tool',
      { serverName: 'ats-mcp-bearer', toolName: 'ats_list_positions' },
      makePermissionOptions({ displayName: 'mcp_call_tool' }) as never,
    );

    expect(decision).toEqual(expect.objectContaining({ behavior: 'deny' }));
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
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
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('allows a host-selected scheduled skill action at its generated runtime path', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-action-ipc-'));
    const runHandle = 'ats-source-sync-run';
    const concreteRule =
      'RunCommand(skills/ATS_Skills/scripts/cutshort-worker.mjs sync)';
    process.env.GANTRY_IPC_DIR = ipcDir;
    process.env.GANTRY_AGENT_RUN_HANDLE = runHandle;
    appendLiveToolRules({ ipcDir, runHandle, rules: [concreteRule] });
    process.env[GANTRY_SKILL_ACTIONS_ENV] = JSON.stringify([
      {
        capabilityId: 'skill.ats-source-sync.cutshort',
        displayName: 'Synchronize Cutshort candidates',
        category: 'ATS_Skills',
        risk: 'write',
        can: 'run the reviewed Cutshort sync worker',
        cannot: 'run other commands',
        credentialSource: 'skill_secret',
        implementationBindings: [{ kind: 'tool_rule', rule: concreteRule }],
        preflight: { kind: 'none' },
        sandboxProfile: {
          network: 'required',
          filesystem: 'workspace_write',
        },
        source: {
          kind: 'skill_action',
          skillId: 'skill-ats',
          skillName: 'ATS_Skills',
          actionId: 'sync_cutshort',
        },
      },
    ]);
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: true,
        appId: 'default',
        agentId: 'agent:ats-source-sync',
        runId: 'run-ats-source-sync',
        jobId: 'job-ats-source-sync',
        chatJid: 'app:default:ats-source-sync-dev',
        allowedTools: [concreteRule],
        yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
      } as never,
    });

    try {
      await expect(
        canUseTool(
          'Bash',
          {
            command:
              '/srv/reagent/home/agents/ats-source-sync/.llm-runtime/claude/skills/ATS_Skills/scripts/cutshort-worker.mjs sync',
          },
          makePermissionOptions() as never,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          behavior: 'allow',
          updatedInput: expect.objectContaining({
            command: expect.stringContaining('cutshort-worker.mjs sync'),
          }),
        }),
      );
      expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('allows a scheduled action selected by reviewed semantic alias without a transient live rule', async () => {
    const concreteRule =
      'RunCommand(skills/ATS_Skills/scripts/cutshort-worker.mjs sync)';
    process.env[GANTRY_SKILL_ACTIONS_ENV] = JSON.stringify([
      {
        capabilityId: 'skill.ats-source-sync.cutshort',
        displayName: 'Synchronize Cutshort candidates',
        category: 'ATS_Skills',
        risk: 'write',
        can: 'run the reviewed Cutshort sync worker',
        cannot: 'run other commands',
        credentialSource: 'skill_secret',
        implementationBindings: [{ kind: 'tool_rule', rule: concreteRule }],
        preflight: { kind: 'none' },
        sandboxProfile: {
          network: 'required',
          filesystem: 'workspace_write',
        },
        source: {
          kind: 'skill_action',
          skillId: 'skill-ats',
          skillName: 'ATS_Skills',
          actionId: 'sync_cutshort',
        },
      },
    ]);
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: true,
        appId: 'default',
        agentId: 'agent:ats-source-sync',
        runId: 'run-ats-source-sync',
        jobId: 'job-ats-source-sync',
        chatJid: 'app:default:ats-source-sync-dev',
        allowedTools: ['capability:skill.ats-source-sync.cutshort'],
        yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
      } as never,
    });

    await expect(
      canUseTool(
        'Bash',
        {
          command:
            '/srv/reagent/home/agents/ats-source-sync/.llm-runtime/claude/skills/ATS_Skills/scripts/cutshort-worker.mjs sync',
        },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        behavior: 'allow',
        updatedInput: expect.objectContaining({
          command: expect.stringContaining('cutshort-worker.mjs sync'),
        }),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('allows the live runner shape with a selected definition and expanded concrete rule', async () => {
    const concreteRule =
      'RunCommand(skills/ATS_Skills/scripts/cutshort-worker.mjs sync)';
    const capability = {
      capabilityId: 'skill.ats-source-sync.cutshort',
      displayName: 'Synchronize Cutshort candidates',
      category: 'ATS_Skills',
      risk: 'write',
      can: 'run the reviewed Cutshort sync worker',
      cannot: 'run other commands',
      credentialSource: 'skill_secret',
      implementationBindings: [{ kind: 'tool_rule', rule: concreteRule }],
      preflight: { kind: 'none' },
      sandboxProfile: {
        network: 'required',
        filesystem: 'workspace_write',
      },
      source: {
        kind: 'skill_action',
        skillId: 'skill-ats',
        skillName: 'ATS_Skills',
        actionId: 'sync_cutshort',
      },
    };
    process.env[GANTRY_SKILL_ACTIONS_ENV] = JSON.stringify([capability]);
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: true,
        appId: 'default',
        agentId: 'agent:ats-source-sync',
        runId: 'run-ats-source-sync',
        jobId: 'job-ats-source-sync',
        chatJid: 'app:default:ats-source-sync-dev',
        allowedTools: [concreteRule],
        semanticCapabilities: [capability],
        yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
      } as never,
    });

    await expect(
      canUseTool(
        'Bash',
        {
          command:
            '/srv/reagent/home/agents/ats-source-sync/.llm-runtime/claude/skills/ATS_Skills/scripts/cutshort-worker.mjs sync',
        },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(expect.objectContaining({ behavior: 'allow' }));
  });

  it('does not trust an expanded concrete rule without the host-selected definition', async () => {
    const concreteRule =
      'RunCommand(skills/ATS_Skills/scripts/cutshort-worker.mjs sync)';
    process.env[GANTRY_SKILL_ACTIONS_ENV] = JSON.stringify([
      {
        capabilityId: 'skill.ats-source-sync.cutshort',
        displayName: 'Synchronize Cutshort candidates',
        category: 'ATS_Skills',
        risk: 'write',
        can: 'run the reviewed Cutshort sync worker',
        cannot: 'run other commands',
        credentialSource: 'skill_secret',
        implementationBindings: [{ kind: 'tool_rule', rule: concreteRule }],
        preflight: { kind: 'none' },
        source: {
          kind: 'skill_action',
          skillId: 'skill-ats',
          skillName: 'ATS_Skills',
          actionId: 'sync_cutshort',
        },
      },
    ]);
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: true,
        appId: 'default',
        agentId: 'agent:ats-source-sync',
        runId: 'run-ats-source-sync',
        jobId: 'job-ats-source-sync',
        chatJid: 'app:default:ats-source-sync-dev',
        allowedTools: [concreteRule],
        semanticCapabilities: [],
        hideAuthorityTools: true,
        yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
      } as never,
    });

    await expect(
      canUseTool(
        'Bash',
        {
          command:
            '/srv/reagent/home/agents/ats-source-sync/.llm-runtime/claude/skills/ATS_Skills/scripts/cutshort-worker.mjs sync',
        },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(expect.objectContaining({ behavior: 'deny' }));
  });

  it('does not authorize an unselected reviewed skill action', async () => {
    const concreteRule =
      'RunCommand(skills/ATS_Skills/scripts/cutshort-worker.mjs sync)';
    process.env[GANTRY_SKILL_ACTIONS_ENV] = JSON.stringify([
      {
        capabilityId: 'skill.ats-source-sync.cutshort',
        displayName: 'Synchronize Cutshort candidates',
        category: 'ATS_Skills',
        risk: 'write',
        can: 'run the reviewed Cutshort sync worker',
        cannot: 'run other commands',
        credentialSource: 'skill_secret',
        implementationBindings: [{ kind: 'tool_rule', rule: concreteRule }],
        preflight: { kind: 'none' },
        source: {
          kind: 'skill_action',
          skillId: 'skill-ats',
          skillName: 'ATS_Skills',
          actionId: 'sync_cutshort',
        },
      },
    ]);
    const canUseTool = makeCallback({
      agentInput: {
        runMode: 'normal',
        isScheduledJob: true,
        appId: 'default',
        agentId: 'agent:ats-source-sync',
        runId: 'run-ats-source-sync',
        jobId: 'job-ats-source-sync',
        chatJid: 'app:default:ats-source-sync-dev',
        allowedTools: ['capability:skill.ats-source-sync.instahyre'],
        hideAuthorityTools: true,
        yoloMode: { enabled: true, denylist: [], denylistPaths: [] },
      } as never,
    });

    await expect(
      canUseTool(
        'Bash',
        {
          command:
            '/srv/reagent/home/agents/ats-source-sync/.llm-runtime/claude/skills/ATS_Skills/scripts/cutshort-worker.mjs sync',
        },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(expect.objectContaining({ behavior: 'deny' }));
  });

  it('does not let a skill definition add commands missing from host live rules', () => {
    const cutshortRule =
      'RunCommand(skills/ATS_Skills/scripts/cutshort-worker.mjs sync)';
    const instahyreRule =
      'RunCommand(skills/ATS_Skills/scripts/instahyre-worker.mjs sync)';
    const capabilities = [
      {
        capabilityId: 'skill.ats-source-sync.combined',
        displayName: 'Synchronize sources',
        category: 'ATS_Skills',
        risk: 'write',
        can: 'run both reviewed source workers',
        cannot: 'run other commands',
        credentialSource: 'skill_secret',
        implementationBindings: [
          { kind: 'tool_rule', rule: cutshortRule },
          { kind: 'tool_rule', rule: instahyreRule },
        ],
        preflight: { kind: 'none' },
        sandboxProfile: {
          network: 'required',
          filesystem: 'workspace_write',
        },
        source: {
          kind: 'skill_action',
          skillId: 'skill-ats',
          skillName: 'ATS_Skills',
          actionId: 'sync_sources',
        },
      },
    ] as never;

    expect(attributedSkillActionRules([cutshortRule], capabilities)).toEqual([
      cutshortRule,
    ]);
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

  it.each([
    [
      'classifier',
      {
        decidedBy: 'auto_classifier',
        risk_level: 'medium',
        risk_category: 'network',
      },
      'decided by: auto_classifier; risk: medium/network',
    ],
    ['human', { decidedBy: 'owner' }, 'decided by: owner'],
  ] as const)(
    'records %s approval provenance for model-visible post-tool context',
    async (_label, approval, expectedProvenance) => {
      permissionMock.requestPermissionApproval.mockResolvedValueOnce({
        approved: true,
        mode: 'allow_once',
        ...approval,
      });
      const recordPermissionApprovalContext = vi.fn();
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
        recordPermissionApprovalContext,
      });

      await expect(
        canUseTool(
          'Bash',
          { command: 'npm test' },
          makePermissionOptions() as never,
        ),
      ).resolves.toEqual(expect.objectContaining({ behavior: 'allow' }));

      expect(recordPermissionApprovalContext).toHaveBeenCalledWith(
        'tool-use-1',
        `Permission allowed (${expectedProvenance})`,
      );
      expect(recordPermissionApprovalContext.mock.calls[0]?.[1]).not.toContain(
        'unknown',
      );
    },
  );

  it.each([
    ['birthright', 'birthright'],
    ['deterministic_read_only', 'deterministic_policy'],
  ] as const)(
    'keeps %s approvals silent in model-visible post-tool context',
    async (decidedBy, source) => {
      permissionMock.requestPermissionApproval.mockResolvedValueOnce({
        approved: true,
        mode: 'allow_once',
        decidedBy,
        source,
      });
      const recordPermissionApprovalContext = vi.fn();
      const canUseTool = makeCallback({ recordPermissionApprovalContext });

      await expect(
        canUseTool(
          'Bash',
          { command: 'npm test' },
          makePermissionOptions() as never,
        ),
      ).resolves.toEqual(expect.objectContaining({ behavior: 'allow' }));

      expect(recordPermissionApprovalContext).not.toHaveBeenCalled();
    },
  );

  it('does not silence a human approver whose name collides with a silent decider', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValueOnce({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'birthright',
      source: 'human_once',
      repeatableForFutureRuns: false,
    });
    const recordPermissionApprovalContext = vi.fn();
    const canUseTool = makeCallback({ recordPermissionApprovalContext });

    await expect(
      canUseTool(
        'Bash',
        { command: 'npm test' },
        makePermissionOptions() as never,
      ),
    ).resolves.toEqual(expect.objectContaining({ behavior: 'allow' }));

    expect(recordPermissionApprovalContext).toHaveBeenCalled();
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
    permissionMock.requestPermissionApproval.mockResolvedValue({
      approved: false,
      reason: 'capability not provisioned: locked access preset',
    });
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
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('auto-denies native Agent tools for a locked agent without prompting', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValue({
      approved: false,
      reason: 'capability not provisioned: locked access preset',
    });
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
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
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

  it('lets locked authority beat a pre-provisioned rule', async () => {
    permissionMock.requestPermissionApproval.mockResolvedValue({
      approved: false,
      reason: 'capability not provisioned: locked access preset',
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

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('locked access preset'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });
});
