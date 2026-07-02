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
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    const output = combinedConsoleOutput();
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

  it('routes timed-grant prompts to the active thread while scoping grants to the conversation', async () => {
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
        threadId: 'topic-7',
        allowedTools: [],
        yoloMode: {
          enabled: true,
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
    await canUseTool(
      'Read',
      { file_path: 'package.json' },
      makePermissionOptions() as never,
    );

    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'topic-7' }),
    );
    const output = combinedConsoleOutput();
    expect(output).toContain('conversationJid=tg:test');
    expect(output).not.toContain('threadId=topic-7');
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

  it('denies parentless SandboxNetworkAccess after an allow-once approved Bash tool call', async () => {
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
    expect(network).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('suppresses SandboxNetworkAccess only when it carries the approved parent tool-use id', async () => {
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
      { host: 'registry.npmjs.org', parentToolUseID: 'toolu_bash_1' },
      makePermissionOptions({
        toolUseID: 'toolu_network_1',
        parentToolUseID: 'toolu_bash_1',
        agentID: 'subagent-a',
      }) as never,
    );

    expect(bash.behavior).toBe('allow');
    expect(network).toEqual({
      behavior: 'allow',
      updatedInput: {
        host: 'registry.npmjs.org',
        parentToolUseID: 'toolu_bash_1',
      },
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
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );
    expect(permissionMock.requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('suppresses parentless scheduled SandboxNetworkAccess for reviewed local CLI command bindings', async () => {
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
        runtimeAccess: [
          {
            selectedCapabilityId: 'acme.records.get',
            sourceType: 'local_cli',
            auditLabel: 'Fixture Records get',
            commandRules: ['RunCommand(/opt/homebrew/bin/acme records get *)'],
            credentialDirs: [],
            networkBindings: [
              {
                commandRules: [
                  'RunCommand(/opt/homebrew/bin/acme records get *)',
                ],
                hosts: ['oauth2.googleapis.com'],
              },
            ],
          },
        ],
        allowedTools: ['RunCommand(/opt/homebrew/bin/acme records get *)'],
        yoloMode: {
          enabled: true,
          denylist: [],
          denylistPaths: [],
        },
      } as never,
    });
    const bash = await canUseTool(
      'Bash',
      {
        command:
          '/opt/homebrew/bin/acme records get fixture_sheet_001 "Fixture Leads!A1:Z1" --json --account operator@example.test',
      },
      makePermissionOptions({
        toolUseID: 'toolu_bash_1',
        agentID: 'agent:test',
      }) as never,
    );
    const network = await canUseTool(
      'SandboxNetworkAccess',
      { host: 'oauth2.googleapis.com' },
      makePermissionOptions({
        toolUseID: 'toolu_network_1',
        agentID: 'agent:test',
      }) as never,
    );

    expect(bash.behavior).toBe('allow');
    expect(network).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'oauth2.googleapis.com' },
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

  it('omits timed access from autonomous job prompts with persistent suggestions', async () => {
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
