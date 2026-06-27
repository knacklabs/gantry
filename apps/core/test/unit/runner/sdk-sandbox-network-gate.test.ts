import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSdkSandboxNetworkGate,
  type SdkSandboxNetworkGate,
} from '@core/adapters/llm/anthropic-claude-agent/runner/sdk-sandbox-network-gate.js';
import type { AgentRunnerInput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';
import { log } from '@core/adapters/llm/anthropic-claude-agent/runner/logging.js';
import { writeOutput } from '@core/adapters/llm/anthropic-claude-agent/runner/output.js';

vi.mock('@core/adapters/llm/anthropic-claude-agent/runner/logging.js', () => ({
  log: vi.fn(),
}));

vi.mock('@core/adapters/llm/anthropic-claude-agent/runner/output.js', () => ({
  writeOutput: vi.fn(),
}));

const runnerInput: AgentRunnerInput = {
  prompt: 'Run tests',
  appId: 'app-1',
  agentId: 'agent-1',
  workspaceFolder: 'team',
  chatJid: 'sl:C123',
  runId: 'run-1',
  jobId: 'job-1',
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function networkHostHash(value: string): string {
  return sha256(value.includes(':') ? value : `${value}:443`);
}

function makeGate(
  nowRef: { value: number },
  input: AgentRunnerInput = runnerInput,
): SdkSandboxNetworkGate {
  return createSdkSandboxNetworkGate(input, {
    ttlMs: 300_000,
    nowMs: () => nowRef.value,
  });
}

function latestPayload(): Record<string, unknown> {
  const call = vi.mocked(writeOutput).mock.calls.at(-1)?.[0];
  const event = call?.runtimeEvents?.[0];
  return event?.payload as Record<string, unknown>;
}

function localCliRuntimeAccess(
  input: {
    commandRules?: string[];
    hosts?: string[];
    credentialDirs?: string[];
  } = {},
): NonNullable<AgentRunnerInput['runtimeAccess']> {
  const commandRules = input.commandRules ?? ['RunCommand(acme records get *)'];
  return [
    {
      selectedCapabilityId: 'acme.records.get',
      sourceType: 'local_cli',
      auditLabel: 'Fixture Records get',
      commandRules,
      credentialDirs: input.credentialDirs ?? [],
      networkBindings: [
        {
          commandRules,
          hosts: input.hosts ?? ['records.googleapis.com'],
        },
      ],
    },
  ];
}

function skillActionRuntimeAccess(
  input: { commandRules?: string[]; hosts?: string[] } = {},
): NonNullable<AgentRunnerInput['runtimeAccess']> {
  const commandRules = input.commandRules ?? [
    'RunCommand(skills/linkedin-posting/post.py *)',
  ];
  return [
    {
      selectedCapabilityId: 'skill.linkedin-posting.publish',
      sourceType: 'skill_action',
      auditLabel: 'LinkedIn Posting publish',
      skillId: 'skill:linkedin-posting',
      selectedAction: 'publish',
      declaredEnvRefs: [],
      commandRules,
      networkBindings: [
        {
          commandRules,
          hosts: input.hosts ?? ['api.linkedin.com:443'],
        },
      ],
    },
  ];
}

function mcpServerRuntimeAccess(
  input: { allowedTools?: string[]; hosts?: string[] } = {},
): NonNullable<AgentRunnerInput['runtimeAccess']> {
  return [
    {
      selectedCapabilityId: 'github.create_issue',
      sourceType: 'mcp_server',
      auditLabel: 'GitHub create issue',
      reviewedServerId: 'github',
      allowedTools: input.allowedTools ?? ['mcp__github__create_issue'],
      credentialRefs: [],
      networkHosts: input.hosts ?? ['api.github.com:443'],
    },
  ];
}

describe('sdk sandbox network gate', () => {
  beforeEach(() => {
    vi.mocked(log).mockReset();
    vi.mocked(writeOutput).mockReset();
  });

  it('allows one SDK network prompt for one approved non-Bash tool use', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'WebFetch',
      { url: 'https://docs.example.com/guide' },
      { toolUseID: 'toolu_web_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'docs.example.com', parentToolUseID: 'toolu_web_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        host: 'docs.example.com',
        parentToolUseID: 'toolu_web_1',
      },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_web_1'),
      approvedToolName: 'WebFetch',
      hostHash: networkHostHash('docs.example.com'),
      inputHash: sha256('{"url":"https://docs.example.com/guide"}'),
      tokenCreatedAtMs: 1_000,
      tokenExpiresAtMs: 301_000,
      tokenTtlMs: 300_000,
    });
  });

  it('suppresses parent-linked external MCP prompts for reviewed source hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: mcpServerRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_mcp_1'),
      approvedToolName: 'mcp__github__create_issue',
      hostHash: networkHostHash('api.github.com'),
    });
  });

  it('suppresses parent-linked MCP prompts for reviewed IPv6 source hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: mcpServerRuntimeAccess({
        hosts: ['[2606:4700:4700::1111]:443'],
      }),
    });

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: '[2606:4700:4700::1111]:443', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_mcp_1'),
      hostHash: sha256('2606:4700:4700::1111:443'),
    });
  });

  it('applies reviewed MCP network hosts when runtime access uses a wildcard tool rule', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: mcpServerRuntimeAccess({
        allowedTools: ['mcp__github__*'],
        hosts: ['api.github.com:443'],
      }),
    });

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'evil.example.com', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('outside the reviewed tool metadata'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_mcp_1'),
      hostHash: networkHostHash('evil.example.com'),
    });
  });

  it('suppresses parent-linked external MCP prompts when no host metadata is declared', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    // Declared MCP hosts are reviewed metadata, not durable network authority,
    // so an approved MCP operation is not blocked just because its source
    // server declared no hosts.
    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_mcp_1'),
      approvedToolName: 'mcp__github__create_issue',
      hostHash: networkHostHash('api.github.com'),
    });
  });

  it('denies parent-linked external MCP prompts for undeclared source ports', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: mcpServerRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com:8443', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_mcp_1'),
      hostHash: networkHostHash('api.github.com:8443'),
    });
  });

  it('denies parent-linked MCP prompts for undeclared explicit ports', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: mcpServerRuntimeAccess({
        hosts: ['api.github.com:443'],
      }),
    });

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com:80', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      hostHash: networkHostHash('api.github.com:80'),
    });
  });

  it('does not infer parentless host authority from raw curl commands when minting a network token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'curl https://api.github.com/repos/acme/roadmap' },
      { toolUseID: 'toolu_bash_1' },
    );

    const payload = latestPayload();
    expect(payload).toMatchObject({
      decision: 'sdk_network_gate_token_minted',
      parentToolUseIDHash: sha256('toolu_bash_1'),
      approvedToolName: 'Bash',
      inputHash: sha256(
        '{"command":"curl https://api.github.com/repos/acme/roadmap"}',
      ),
      tokenCreatedAtMs: 1_000,
      tokenExpiresAtMs: 301_000,
      tokenTtlMs: 300_000,
    });
  });

  it('suppresses SDK network prompts during a global approval window', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('agent-1', 301_000);
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'api.linkedin.com' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_global_approval_suppressed',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.linkedin.com'),
      tokenCreatedAtMs: 1_000,
      tokenExpiresAtMs: 301_000,
      tokenTtlMs: 300_000,
    });
  });

  it('falls back to normal network gating after global approval expires', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('agent-1', 301_000);
    now.value = 301_001;
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.linkedin.com'),
    });
  });

  it('does not suppress network prompts for a different timed-grant principal', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('subagent-a', 301_000);
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      { toolUseID: 'toolu_network_1' },
      'subagent-b',
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.linkedin.com'),
    });
  });

  it('keeps global approvals isolated per principal', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberGlobalApproval('subagent-a', 301_000);
    gate.rememberGlobalApproval('subagent-b', 301_000);

    const first = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api-a.example' },
      { toolUseID: 'toolu_network_a' },
      'subagent-a',
    );
    const second = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api-b.example' },
      { toolUseID: 'toolu_network_b' },
      'subagent-b',
    );

    expect(first?.behavior).toBe('allow');
    expect(second?.behavior).toBe('allow');
  });

  it('denies parentless SDK network prompts after an approved tool', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { cmd: 'npm test --runInBand' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('registry.npmjs.org'),
      expiredTokenCount: 0,
    });
  });

  it('denies parentless scheduled job network prompts after an approved curl command without a local CLI binding', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, { ...runnerInput, isScheduledJob: true });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'curl https://api.github.com/repos/acme/roadmap' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.github.com'),
      expiredTokenCount: 0,
    });
  });

  it('denies parentless scheduled job network prompts from curl --url argv without a local CLI binding', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, { ...runnerInput, isScheduledJob: true });

    gate.rememberAllowedTool(
      'Bash',
      {
        command:
          'curl --silent --url https://api.github.com/repos/acme/roadmap',
      },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.github.com'),
    });
  });

  it('does not bind parentless network approval to inert URLs in Bash text', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, { ...runnerInput, isScheduledJob: true });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'echo https://api.github.com/repos/acme/roadmap' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.github.com'),
    });
  });

  it('denies parentless scheduled job network prompts for hosts outside the reviewed command binding', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: localCliRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'GODEBUG=netdns=go acme records get leads --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('registry.npmjs.org'),
    });
  });

  it('does not reuse a parentless scheduled job network token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: localCliRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'acme records get leads --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const first = gate.decide(
      'SandboxNetworkAccess',
      { host: 'records.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );
    const second = gate.decide(
      'SandboxNetworkAccess',
      { host: 'records.googleapis.com' },
      { toolUseID: 'toolu_network_2' },
    );

    expect(first?.behavior).toBe('allow');
    expect(second).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_2'),
      hostHash: networkHostHash('records.googleapis.com'),
      expiredTokenCount: 0,
    });
  });

  it('denies parentless scheduled job network prompts when the approved command has no capability binding', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, { ...runnerInput, isScheduledJob: true });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'acme records get leads --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'records.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('records.googleapis.com'),
    });
  });

  it('suppresses parentless scheduled prompts for reviewed local CLI command-bound hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: localCliRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'acme records get leads --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'records.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'records.googleapis.com' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed_parentless_recent_tool',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_bash_1'),
      hostHash: networkHostHash('records.googleapis.com'),
    });
  });

  it('does not require typed local CLI host metadata for parentless scheduled suppression', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: [
        {
          selectedCapabilityId: 'acme.records.get',
          sourceType: 'local_cli',
          auditLabel: 'Fixture Records get',
          commandRules: ['RunCommand(/opt/homebrew/bin/acme records get *)'],
          credentialDirs: ['~/.config/acme'],
          networkBindings: [
            {
              commandRules: [
                'RunCommand(/opt/homebrew/bin/acme records get *)',
              ],
              hosts: ['oauth2.googleapis.com', 'records.googleapis.com'],
            },
          ],
        },
      ],
    });

    gate.rememberAllowedTool(
      'Bash',
      {
        command:
          '/opt/homebrew/bin/acme records get leads --json --account test@example.com',
      },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'oauth2.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'oauth2.googleapis.com' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed_parentless_recent_tool',
      hostHash: networkHostHash('oauth2.googleapis.com'),
    });
  });

  it('denies parentless scheduled prompts when the local CLI command binding does not match', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: localCliRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'acme drive get leads --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'records.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('records.googleapis.com'),
    });
  });

  it('denies parentless scheduled prompts when a matching local CLI command is combined with another command', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: localCliRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      {
        command:
          'acme records get leads --json && curl https://records.googleapis.com',
      },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'records.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('records.googleapis.com'),
    });
  });

  it('denies parentless scheduled prompts when host metadata does not match', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: localCliRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'acme records get leads --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'oauth2.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('oauth2.googleapis.com'),
    });
  });

  it('suppresses parentless scheduled prompts for reviewed skill action command-bound hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: skillActionRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'skills/linkedin-posting/post.py --file out.md --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual({
      behavior: 'allow',
      updatedInput: { host: 'api.linkedin.com' },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed_parentless_recent_tool',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_bash_1'),
      hostHash: networkHostHash('api.linkedin.com'),
    });
  });

  it('denies parentless scheduled prompts for skill action undeclared hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: skillActionRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'skills/linkedin-posting/post.py --file out.md --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'evil.example.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('evil.example.com'),
    });
  });

  it('denies parentless scheduled prompts for skill action hosts on undeclared ports', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: true,
      runtimeAccess: skillActionRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'skills/linkedin-posting/post.py --file out.md --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com:8443' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.linkedin.com:8443'),
    });
  });

  it('suppresses parent-linked prompts for reviewed skill action declared hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: skillActionRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'skills/linkedin-posting/post.py --file out.md --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com', parentToolUseID: 'toolu_bash_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_bash_1'),
      hostHash: networkHostHash('api.linkedin.com'),
    });
  });

  it('denies parent-linked prompts for reviewed skill action undeclared hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: skillActionRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'skills/linkedin-posting/post.py --file out.md --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'evil.example.com', parentToolUseID: 'toolu_bash_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_bash_1'),
      hostHash: networkHostHash('evil.example.com'),
    });
  });

  it('suppresses parent-linked prompts when a reviewed skill action declares no hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      runtimeAccess: skillActionRuntimeAccess({ hosts: [] }),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'skills/linkedin-posting/post.py --file out.md --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.linkedin.com', parentToolUseID: 'toolu_bash_1' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      networkToolUseIDHash: sha256('toolu_network_1'),
      parentToolUseIDHash: sha256('toolu_bash_1'),
      hostHash: networkHostHash('api.linkedin.com'),
    });
  });

  it('denies interactive parentless prompts even for reviewed local CLI command-bound hosts', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now, {
      ...runnerInput,
      isScheduledJob: false,
      runtimeAccess: localCliRuntimeAccess(),
    });

    gate.rememberAllowedTool(
      'Bash',
      { command: 'acme records get leads --json' },
      { toolUseID: 'toolu_bash_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'records.googleapis.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('records.googleapis.com'),
    });
  });

  it('does not mint a network token without a tool-use id', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool('Bash', { command: 'npm test' }, {});
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      expiredTokenCount: 0,
    });
  });

  it('does not mint fallback network tokens for local-only SDK tools', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Read',
      { file_path: 'package.json' },
      { toolUseID: 'toolu_read_1' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      reason:
        'SDK requested sandbox network access without a parent tool-use id.',
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.github.com'),
      expiredTokenCount: 0,
    });
  });

  it('denies parent tool-use token suppression for a different principal', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'mcp__github__create_issue',
      { owner: 'acme', repo: 'roadmap' },
      { toolUseID: 'toolu_mcp_1' },
      'subagent-a',
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'api.github.com', parentToolUseID: 'toolu_mcp_1' },
      { toolUseID: 'toolu_network_1' },
      'subagent-b',
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('did not approve'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      parentToolUseIDHash: sha256('toolu_mcp_1'),
      networkToolUseIDHash: sha256('toolu_network_1'),
      hostHash: networkHostHash('api.github.com'),
      expiredTokenCount: 0,
    });
  });

  it('requires a matching parent id even when another principal also has an active token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm install' },
      { toolUseID: 'toolu_bash_a' },
      'subagent-a',
    );
    gate.rememberAllowedTool(
      'Bash',
      { command: 'git fetch' },
      { toolUseID: 'toolu_bash_b' },
      'subagent-b',
    );

    const parentless = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_a' },
      'subagent-a',
    );

    expect(parentless).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );

    const matched = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org', parentToolUseID: 'toolu_bash_a' },
      { toolUseID: 'toolu_network_a' },
      'subagent-a',
    );

    expect(matched).toEqual({
      behavior: 'allow',
      updatedInput: {
        host: 'registry.npmjs.org',
        parentToolUseID: 'toolu_bash_a',
      },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      parentToolUseIDHash: sha256('toolu_bash_a'),
      approvedToolName: 'Bash',
      networkToolUseIDHash: sha256('toolu_network_a'),
      hostHash: networkHostHash('registry.npmjs.org'),
    });
  });

  it('denies parentless SDK network prompts for a principal with no approved token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm install' },
      { toolUseID: 'toolu_bash_a' },
      'subagent-a',
    );

    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_b' },
      'subagent-b',
    );

    expect(decision).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      reason:
        'SDK requested sandbox network access without a parent tool-use id.',
      networkToolUseIDHash: sha256('toolu_network_b'),
      hostHash: networkHostHash('registry.npmjs.org'),
      expiredTokenCount: 0,
    });
  });

  it('denies parentless prompts instead of guessing the most recent approved tool', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test first' },
      { toolUseID: 'toolu_bash_1' },
    );
    now.value = 2_000;
    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test second' },
      { toolUseID: 'toolu_bash_2' },
    );

    const ambiguous = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );
    expect(ambiguous).toEqual(
      expect.objectContaining({
        behavior: 'deny',
        message: expect.stringContaining('without a parent tool-use id'),
      }),
    );
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      expiredTokenCount: 0,
    });

    const matched = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org', parent_tool_use_id: 'toolu_bash_2' },
      { toolUseID: 'toolu_network_2' },
    );
    expect(matched).toEqual({
      behavior: 'allow',
      updatedInput: {
        host: 'registry.npmjs.org',
        parent_tool_use_id: 'toolu_bash_2',
      },
    });
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      parentToolUseIDHash: sha256('toolu_bash_2'),
      approvedToolName: 'Bash',
      networkToolUseIDHash: sha256('toolu_network_2'),
    });
  });

  it('denies expired tokens and records that pruning happened', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test --runInBand' },
      { toolUseID: 'toolu_bash_1' },
    );
    now.value = 301_001;
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('deny');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_denied',
      networkToolUseIDHash: sha256('toolu_network_1'),
      expiredTokenCount: 1,
    });
  });

  it('prunes expired tokens and uses an explicitly matched unexpired token', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test first' },
      { toolUseID: 'toolu_bash_expired' },
    );
    now.value = 301_001;
    gate.rememberAllowedTool(
      'Bash',
      { command: 'npm test second' },
      { toolUseID: 'toolu_bash_active' },
    );
    const decision = gate.decide(
      'SandboxNetworkAccess',
      { host: 'registry.npmjs.org', parentToolUseID: 'toolu_bash_active' },
      { toolUseID: 'toolu_network_1' },
    );

    expect(decision?.behavior).toBe('allow');
    expect(latestPayload()).toMatchObject({
      decision: 'sdk_network_gate_suppressed',
      parentToolUseIDHash: sha256('toolu_bash_active'),
      approvedToolName: 'Bash',
      inputHash: sha256('{"command":"npm test second"}'),
      expiredTokenCount: 1,
    });
  });

  it('does not log raw host or command values', () => {
    const now = { value: 1_000 };
    const gate = makeGate(now);

    gate.rememberAllowedTool(
      'Bash',
      { command: 'curl https://secret-host.example/path?token=abc123' },
      { toolUseID: 'toolu_bash_1' },
    );
    gate.decide(
      'SandboxNetworkAccess',
      { host: 'secret-host.example' },
      { toolUseID: 'toolu_network_1' },
    );

    const logText = JSON.stringify(vi.mocked(log).mock.calls);
    const outputText = JSON.stringify(vi.mocked(writeOutput).mock.calls);
    expect(logText).not.toContain('secret-host.example');
    expect(logText).not.toContain('curl https://secret-host.example');
    expect(logText).not.toContain('toolu_bash_1');
    expect(logText).not.toContain('toolu_network_1');
    expect(outputText).not.toContain('secret-host.example');
    expect(outputText).not.toContain('curl https://secret-host.example');
    expect(outputText).not.toContain('toolu_bash_1');
    expect(outputText).not.toContain('toolu_network_1');
  });
});
